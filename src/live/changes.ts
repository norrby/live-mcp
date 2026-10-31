// changes.ts – "what changed since I last looked": the Extensions API has no listeners, but the whole set reads in
// well under a millisecond and parameter values in parallel in tens of milliseconds, so a client can poll with a
// cursor and get a diff instead of the whole set. Snapshots are kept per cursor name in the long-lived extension.
import type { LiveAdapter } from "./adapter.js";
import { LiveError } from "./errors.js";

interface DeviceSnap {
  id: string;
  name: string;
  address: string;
  values: number[];
  names: string[];
}
interface TrackSnap {
  id: string;
  name: string;
  address: string;
  mute?: boolean;
  solo?: boolean;
  arm?: boolean;
  devices: DeviceSnap[];
  mixer: number[];
}
export interface Snapshot {
  at: number;
  tempo: number;
  scenes: number;
  tracks: TrackSnap[];
  /** devices whose values were not read because the snapshot budget ran out */
  truncated: string[];
}

export interface Change {
  kind: "tempo" | "scenes" | "track" | "device" | "parameter" | "mixer";
  what: string;
  address?: string;
  from?: unknown;
  to?: unknown;
}

export const MAX_PARAMETERS_PER_SNAPSHOT = 6000;

export async function takeSnapshot(live: LiveAdapter, scope?: string): Promise<Snapshot> {
  const song = live.song;
  const scopeId = scope ? live.id(live.track(scope)) : undefined;
  const tracks = live.tracks().filter((t) => !scopeId || t.id === scopeId);
  if (scope && tracks.length === 0) throw new LiveError(`${scope} is not a track in the set`);
  const snaps: TrackSnap[] = [];
  const truncated: string[] = [];
  let budget = MAX_PARAMETERS_PER_SNAPSHOT;
  for (const t of tracks) {
    const track = live.track(t.address);
    const devices: DeviceSnap[] = [];
    const walk = (list: { address: string; id: string; name: string; chains?: { devices: { address: string; id: string; name: string }[] }[] }[]) => {
      for (const d of list) {
        const dev = live.device(d.address);
        const params = dev.parameters;
        if (budget - params.length < 0) {
          truncated.push(d.address);
          devices.push({ id: d.id, name: d.name, address: d.address, values: [], names: [] });
        } else {
          budget -= params.length;
          devices.push({ id: d.id, name: d.name, address: d.address, values: [], names: params.map((p) => p.name) });
        }
        for (const c of d.chains ?? []) walk(c.devices);
      }
    };
    walk(t.devices);
    const mixer = [track.mixer.volume, track.mixer.panning, ...track.mixer.sends];
    snaps.push({ id: t.id, name: t.name, address: t.address, mute: t.mute, solo: t.solo, arm: t.arm, devices, mixer: await live.readValues(mixer) });
  }
  // values for every device at once
  await Promise.all(
    snaps.flatMap((t) => t.devices.filter((d) => d.names.length).map(async (d) => (d.values = await live.readValues(live.device(d.address).parameters)))),
  );
  return { at: Date.now(), tempo: song.tempo, scenes: song.scenes.length, tracks: snaps, truncated };
}

export function diff(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  if (before.tempo !== after.tempo) changes.push({ kind: "tempo", what: "tempo changed", from: before.tempo, to: after.tempo });
  if (before.scenes !== after.scenes) changes.push({ kind: "scenes", what: "scene count changed", from: before.scenes, to: after.scenes });
  const beforeTracks = new Map(before.tracks.map((t) => [t.id, t]));
  const afterTracks = new Map(after.tracks.map((t) => [t.id, t]));
  for (const t of before.tracks) if (!afterTracks.has(t.id)) changes.push({ kind: "track", what: `track "${t.name}" removed`, address: t.address });
  for (const t of after.tracks) {
    const b = beforeTracks.get(t.id);
    if (!b) {
      changes.push({ kind: "track", what: `track "${t.name}" added`, address: t.address });
      continue;
    }
    if (b.name !== t.name) changes.push({ kind: "track", what: "track renamed", address: t.address, from: b.name, to: t.name });
    if (b.address !== t.address) changes.push({ kind: "track", what: `track "${t.name}" moved`, from: b.address, to: t.address });
    for (const key of ["mute", "solo", "arm"] as const) if (b[key] !== t[key]) changes.push({ kind: "track", what: `${key} changed on "${t.name}"`, address: t.address, from: b[key], to: t[key] });
    const mixerNames = ["volume", "pan", ...t.mixer.slice(2).map((_, i) => `send${i}`)];
    t.mixer.forEach((v, i) => {
      if (b.mixer[i] !== undefined && b.mixer[i] !== v) changes.push({ kind: "mixer", what: `${mixerNames[i]} of "${t.name}"`, address: `${t.address}/${i === 0 ? "vol" : i === 1 ? "pan" : `send${i - 2}`}`, from: b.mixer[i], to: v });
    });
    const beforeDevices = new Map(b.devices.map((d) => [d.id, d]));
    const afterDevices = new Map(t.devices.map((d) => [d.id, d]));
    for (const d of b.devices) if (!afterDevices.has(d.id)) changes.push({ kind: "device", what: `device "${d.name}" removed from "${t.name}"`, address: d.address });
    for (const d of t.devices) {
      const bd = beforeDevices.get(d.id);
      if (!bd) {
        changes.push({ kind: "device", what: `device "${d.name}" added to "${t.name}"`, address: d.address });
        continue;
      }
      if (bd.name !== d.name) changes.push({ kind: "device", what: "device renamed", address: d.address, from: bd.name, to: d.name });
      if (bd.address !== d.address) changes.push({ kind: "device", what: `device "${d.name}" moved`, from: bd.address, to: d.address });
      if (!d.names.length || !bd.names.length) continue; // values not read on one side: nothing to compare
      d.values.forEach((v, i) => {
        if (bd.values[i] !== undefined && bd.values[i] !== v) changes.push({ kind: "parameter", what: `${d.names[i]} on "${d.name}"`, address: `${d.address}/p${i}`, from: bd.values[i], to: v });
      });
    }
  }
  return changes;
}

/** Snapshots per cursor, bounded. */
export class ChangeTracker {
  private snapshots = new Map<string, Snapshot>();
  constructor(private readonly live: LiveAdapter, private readonly max = 16) {}

  async changesSince(cursor: string, scope?: string): Promise<{ cursor: string; first: boolean; since?: number; changes: Change[]; summary?: string; notRead?: string[] }> {
    const now = await takeSnapshot(this.live, scope);
    // One snapshot per cursor and scope: compared with a snapshot of another scope, every track outside one of them
    // would look added or removed.
    const key = `${cursor}\u0000${scope ?? ""}`;
    const prev = this.snapshots.get(key);
    this.snapshots.delete(key);
    this.snapshots.set(key, now);
    while (this.snapshots.size > this.max) this.snapshots.delete(this.snapshots.keys().next().value as string);
    const notRead = now.truncated.length ? now.truncated : undefined;
    const note = notRead ? `; parameter values of ${notRead.length} device(s) were not read (snapshot budget of ${MAX_PARAMETERS_PER_SNAPSHOT} parameters): use scope to watch one track at a time` : "";
    if (!prev) return { cursor, first: true, changes: [], summary: "first call for this cursor and scope: snapshot taken, call again later to see what changed" + note, notRead };
    return { cursor, first: false, since: prev.at, changes: diff(prev, now), summary: note ? note.slice(2) : undefined, notRead };
  }
}
