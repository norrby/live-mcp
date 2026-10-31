// adapter.ts – everything the MCP layer needs from Live, on top of the Extensions SDK.
// Reads are synchronous in the SDK; parameter values are async. Objects are addressed by path (address.ts) or handle id.
import {
  AudioClip, AudioTrack, Chain, Clip, ClipSlot, DataModelObject, Device, DeviceParameter, MidiClip, MidiTrack, RackDevice, Track, TrackMixer,
  type ExtensionContext, type NoteDescription,
} from "@ableton-extensions/sdk";
import * as path from "node:path";
import { parseAddress, type Segment } from "./address.js";
import { LiveError } from "./errors.js";

export { LiveError };

export type V = "1.0.0";
export type Ctx = ExtensionContext<V>;

export interface ParameterInfo {
  address: string;
  index: number;
  name: string;
  min: number;
  max: number;
  quantized: boolean;
  default: number;
  items?: string[];
  value?: number;
}
export interface DeviceInfo {
  address: string;
  id: string;
  name: string;
  kind: string;
  parameters: number;
  chains?: ChainInfo[];
}
export interface ChainInfo {
  address: string;
  id: string;
  devices: DeviceInfo[];
}
export interface ClipInfo {
  address: string;
  id: string;
  slot?: number;
  name: string;
  kind: "midi" | "audio" | "clip";
  /** beats between start and end marker; for an unwarped audio clip, what it spans at the current tempo */
  length: number;
  /** audio clips: whether the clip follows the tempo; when not, its markers are in seconds */
  warped?: boolean;
  lengthSeconds?: number;
  /** arrangement clips: position in the arrangement, in beats */
  start?: number;
  end?: number;
  looping: boolean;
  loopStart?: number;
  loopEnd?: number;
  muted: boolean;
  notes?: number;
  file?: string;
}
export interface TrackInfo {
  address: string;
  id: string;
  name: string;
  kind: "midi" | "audio" | "return" | "main" | "group" | "track";
  mute?: boolean;
  solo?: boolean;
  arm?: boolean;
  /** Live records on the selected MIDI track while no MIDI track is armed (the pink arm button); from the bridge */
  implicitArm?: boolean;
  group?: string;
  clips?: ClipInfo[];
  devices: DeviceInfo[];
}

export class LiveAdapter {
  constructor(readonly context: Ctx) {}

  get song() {
    return this.context.application.song;
  }

  id(obj: DataModelObject<V>): string {
    return "#" + obj.handle.id.toString();
  }

  // ---- resolving addresses ------------------------------------------------------------------------------------

  resolve(address: string): DataModelObject<V> {
    const segs = parseAddress(address);
    let obj: DataModelObject<V> = this.resolveRoot(segs[0], address);
    for (const seg of segs.slice(1)) obj = this.step(obj, seg, address);
    return obj;
  }

  private resolveRoot(seg: Segment, address: string): DataModelObject<V> {
    const song = this.song;
    switch (seg.kind) {
      case "handle":
        try {
          return this.context.getObjectFromHandle({ id: seg.id }, DataModelObject);
        } catch (e) {
          throw new LiveError(`#${seg.id} no longer exists (${String(e)}); list the set again for current addresses`);
        }
      case "track":
        return at(song.tracks, seg.index, "track", address);
      case "return":
        return at(song.returnTracks, seg.index, "return track", address);
      case "main":
        return song.mainTrack;
      default:
        throw new LiveError(`address must start with a track, return track, main or #handle: "${address}"`);
    }
  }

  private step(obj: DataModelObject<V>, seg: Segment, address: string): DataModelObject<V> {
    switch (seg.kind) {
      case "device":
        if (obj instanceof Track || obj instanceof Chain) return at(obj.devices, seg.index, "device", address);
        break;
      case "chain":
        if (obj instanceof RackDevice) return at(obj.chains, seg.index, "chain", address);
        break;
      case "param":
        if (obj instanceof Device) return at(obj.parameters, seg.index, "parameter", address);
        break;
      case "slot":
        if (obj instanceof Track) return at(obj.clipSlots, seg.index, "clip slot", address);
        break;
      case "arrangement":
        if (obj instanceof Track) return at(obj.arrangementClips, seg.index, "arrangement clip", address);
        break;
      case "mixer":
        if (obj instanceof Track || obj instanceof Chain) {
          const mixer = obj.mixer;
          if (seg.which === "vol") return mixer.volume;
          if (seg.which === "pan") return mixer.panning;
          return at(mixer.sends, seg.index, "send", address);
        }
        break;
    }
    throw new LiveError(`"${address}": cannot take ${seg.kind} from a ${obj.constructor.name}`);
  }

  track(address: string): Track<V> {
    const obj = this.resolve(address);
    if (!(obj instanceof Track)) throw new LiveError(`"${address}" is a ${obj.constructor.name}, not a track`);
    return obj;
  }
  device(address: string): Device<V> {
    const obj = this.resolve(address);
    if (!(obj instanceof Device)) throw new LiveError(`"${address}" is a ${obj.constructor.name}, not a device`);
    return obj;
  }
  deviceHolder(address: string): Track<V> | Chain<V> {
    const obj = this.resolve(address);
    if (obj instanceof Track || obj instanceof Chain) return obj;
    throw new LiveError(`"${address}" is a ${obj.constructor.name}, not a track or chain`);
  }
  /** Where a device sits: its track or chain, and its index there. Works for #id addresses too. */
  locateDevice(address: string): { device: Device<V>; holder: Track<V> | Chain<V>; index: number } {
    const device = this.device(address);
    const holder = device.parent;
    if (!(holder instanceof Track) && !(holder instanceof Chain)) throw new LiveError(`${address} is not on a track or chain this server can reach`);
    const index = holder.devices.indexOf(device);
    if (index < 0) throw new LiveError(`${address} is no longer on its track or chain; call get_set for current addresses`);
    return { device, holder, index };
  }
  clipSlot(address: string): ClipSlot<V> {
    const obj = this.resolve(address);
    if (!(obj instanceof ClipSlot)) throw new LiveError(`"${address}" is a ${obj.constructor.name}, not a clip slot (use t0/s3)`);
    return obj;
  }
  /** A clip by its own address (#id or t0/a2) or by its slot (t0/s3). */
  clip(address: string): Clip<V> {
    const obj = this.resolve(address);
    if (obj instanceof Clip) return obj;
    if (obj instanceof ClipSlot) {
      const c = obj.clip;
      if (!c) throw new LiveError(`slot ${address} is empty`);
      return c;
    }
    throw new LiveError(`"${address}" is a ${obj.constructor.name}, not a clip or clip slot`);
  }
  midiClip(address: string): MidiClip<V> {
    const c = this.clip(address);
    if (!(c instanceof MidiClip)) throw new LiveError(`${address} is an audio clip; it has no notes`);
    return c;
  }
  /** Where a clip lives: the slot of a session clip, or the track of an arrangement clip. */
  locateClip(address: string): { clip: Clip<V>; slot?: ClipSlot<V>; track: Track<V>; address: string } {
    const clip = this.clip(address);
    const parent = clip.parent;
    if (parent instanceof ClipSlot) {
      const track = parent.parent;
      if (!(track instanceof Track)) throw new LiveError(`${address}: the clip's slot is not on a track`);
      return { clip, slot: parent, track, address: `${this.trackAddress(track)}/s${track.clipSlots.indexOf(parent)}` };
    }
    if (parent instanceof Track) return { clip, track: parent, address: `${this.trackAddress(parent)}/a${parent.arrangementClips.indexOf(clip)}` };
    throw new LiveError(`${address}: cannot find the clip's track`);
  }
  /**
   * Where a parameter sits, the way LiveRemote names it: its track, and either a device path (device index on the
   * track, then chain and device index for each rack level) with the parameter index, or a mixer control.
   */
  parameterRef(address: string): { track: Track<V>; ref: { devices: number[]; param: number } | { mixer: "volume" | "panning" } | { mixer: "send"; index: number } } {
    const p = this.parameter(address);
    const owner = p.parent;
    if (owner instanceof TrackMixer) {
      const track = owner.parent;
      if (!(track instanceof Track)) throw new LiveError(`${address}: the mixer is not on a track`);
      if (owner.volume === p) return { track, ref: { mixer: "volume" } };
      if (owner.panning === p) return { track, ref: { mixer: "panning" } };
      return { track, ref: { mixer: "send", index: owner.sends.indexOf(p) } };
    }
    if (!(owner instanceof Device)) throw new LiveError(`${address} is not a device or track mixer parameter`);
    const path: number[] = [];
    let device: Device<V> = owner;
    for (;;) {
      const holder = device.parent;
      if (holder instanceof Track) {
        path.unshift(holder.devices.indexOf(device));
        return { track: holder, ref: { devices: path, param: owner.parameters.indexOf(p) } };
      }
      if (!(holder instanceof Chain)) throw new LiveError(`${address}: cannot find the device's track`);
      path.unshift(holder.devices.indexOf(device));
      const rack = holder.parent;
      if (!(rack instanceof RackDevice)) throw new LiveError(`${address}: the chain is not in a rack`);
      path.unshift(rack.chains.indexOf(holder));
      device = rack;
    }
  }
  /** The racks a device sits in, innermost first. */
  deviceAncestors(device: Device<V>): Device<V>[] {
    const out: Device<V>[] = [];
    let holder = device.parent;
    while (holder instanceof Chain) {
      const rack = holder.parent;
      if (!(rack instanceof RackDevice)) break;
      out.push(rack);
      holder = rack.parent;
    }
    return out;
  }

  /** The group tracks a track sits in, innermost first; none where Live cannot tell. */
  groupAncestors(track: Track<V>): Track<V>[] {
    const out: Track<V>[] = [];
    try {
      for (let g = track.groupTrack; g; g = g.groupTrack) out.push(g);
    } catch {
      // not answered by this host
    }
    return out;
  }

  trackAddress(t: Track<V>): string {
    const song = this.song;
    let i = song.tracks.indexOf(t);
    if (i >= 0) return `t${i}`;
    i = song.returnTracks.indexOf(t);
    if (i >= 0) return `r${i}`;
    if (t === song.mainTrack) return "main";
    return this.id(t);
  }
  parameter(address: string): DeviceParameter<V> {
    const obj = this.resolve(address);
    if (!(obj instanceof DeviceParameter)) throw new LiveError(`"${address}" is a ${obj.constructor.name}, not a parameter`);
    return obj;
  }

  // ---- describing the set --------------------------------------------------------------------------------------

  tracks(): TrackInfo[] {
    const song = this.song;
    return [
      ...song.tracks.map((t, i) => this.trackInfo(t, `t${i}`)),
      ...song.returnTracks.map((t, i) => this.trackInfo(t, `r${i}`, "return")),
      this.trackInfo(song.mainTrack, "main", "main"),
    ];
  }

  trackInfo(t: Track<V>, address: string, kind?: TrackInfo["kind"]): TrackInfo {
    const info: TrackInfo = {
      address,
      id: this.id(t),
      name: t.name,
      kind: kind ?? (t instanceof MidiTrack ? "midi" : t instanceof AudioTrack ? "audio" : "track"),
      devices: t.devices.map((d, i) => this.deviceInfo(d, `${address}/d${i}`)),
    };
    if (kind !== "main") {
      info.mute = t.mute;
      info.solo = t.solo;
      info.arm = t.arm;
    }
    if (!kind) {
      const clips = this.clips(t, address);
      if (clips.length) info.clips = clips;
    }
    const group = t.groupTrack;
    if (group) info.group = group.name;
    return info;
  }

  /** Session clips of a track: only the filled slots. */
  clips(t: Track<V>, trackAddress: string): ClipInfo[] {
    const out: ClipInfo[] = [];
    t.clipSlots.forEach((slot, i) => {
      const c = slot.clip;
      if (c) out.push({ ...this.clipInfo(c, `${trackAddress}/s${i}`), slot: i });
    });
    return out;
  }
  arrangementClips(t: Track<V>, trackAddress: string): ClipInfo[] {
    return t.arrangementClips.map((c, i) => {
      const info = this.clipInfo(c, `${trackAddress}/a${i}`);
      info.start = c.startTime;
      info.end = c.endTime;
      return info;
    });
  }
  clipInfo(c: Clip<V>, address: string): ClipInfo {
    const info: ClipInfo = {
      address,
      id: this.id(c),
      name: c.name,
      kind: c instanceof MidiClip ? "midi" : c instanceof AudioClip ? "audio" : "clip",
      length: c.endMarker - c.startMarker,
      looping: c.looping,
      muted: c.muted,
    };
    if (c.looping) {
      info.loopStart = c.loopStart;
      info.loopEnd = c.loopEnd;
    }
    if (c instanceof MidiClip) info.notes = c.notes.length;
    if (c instanceof AudioClip) {
      info.file = c.filePath;
      info.warped = c.warping;
      if (!c.warping) {
        // An unwarped clip's markers are in seconds; in the arrangement its span in beats is known exactly.
        info.lengthSeconds = info.length;
        info.length = c.parent instanceof ClipSlot ? (info.length * this.song.tempo) / 60 : c.endTime - c.startTime;
      }
    }
    return info;
  }

  /** Creates a MIDI clip in a session slot, or in the arrangement when `start` is given. */
  async createMidiClip(track: string, opts: { slot?: number; start?: number; length: number }): Promise<{ clip: MidiClip<V>; address: string }> {
    const t = this.track(track);
    if (!(t instanceof MidiTrack)) throw new LiveError(`${track} is not a MIDI track`);
    if (opts.slot !== undefined && opts.start !== undefined) throw new LiveError("give slot (session) or start (arrangement), not both");
    if (opts.slot !== undefined) {
      const slot = at(t.clipSlots, opts.slot, "clip slot", `${track}/s${opts.slot}`);
      if (slot.clip) throw new LiveError(`slot ${track}/s${opts.slot} already holds "${slot.clip.name}"; delete it first or pick another slot`);
      const clip = await slot.createMidiClip(opts.length);
      return { clip, address: `${track}/s${opts.slot}` };
    }
    if (opts.start === undefined) throw new LiveError("give slot (session) or start (arrangement, in beats)");
    const clip = await t.createMidiClip(opts.start, opts.length);
    return { clip, address: this.arrangementAddress(t, track, clip) };
  }

  /** stage, if given, turns the file into one Live may import, once everything else has been checked. */
  async createAudioClip(
    track: string,
    opts: { slot?: number; start?: number; length?: number; file: string; warped?: boolean; stage?: (file: string) => Promise<string> },
  ): Promise<{ clip: AudioClip<V>; address: string }> {
    const t = this.track(track);
    if (!(t instanceof AudioTrack)) throw new LiveError(`${track} is not an audio track`);
    if (opts.slot !== undefined && opts.start !== undefined) throw new LiveError("give slot (session) or start (arrangement), not both");
    if (opts.slot !== undefined && opts.length !== undefined) throw new LiveError("length applies to arrangement clips only; a session clip takes the file's length");
    if (!path.isAbsolute(opts.file)) throw new LiveError(`file must be an absolute path, not "${opts.file}"`);
    const slot = opts.slot === undefined ? undefined : at(t.clipSlots, opts.slot, "clip slot", `${track}/s${opts.slot}`);
    if (slot?.clip) throw new LiveError(`slot ${track}/s${opts.slot} already holds "${slot.clip.name}"; delete it first or pick another slot`);
    if (opts.slot === undefined && opts.start === undefined) throw new LiveError("give slot (session) or start (arrangement, in beats)");
    // An extension may not read files outside its own folder; Live copies the file into the project on its behalf.
    const source = opts.stage ? await opts.stage(opts.file) : opts.file;
    let filePath: string;
    try {
      filePath = await this.context.resources.importIntoProject(source);
    } catch (e) {
      throw new LiveError(`Live could not import ${opts.file}: ${e instanceof Error ? e.message : e ? String(e) : "Live gave no reason (is it an audio file Live can read?)"}`);
    }
    if (slot) {
      const clip = await slot.createAudioClip({ filePath, isWarped: opts.warped });
      return { clip, address: `${track}/s${opts.slot}` };
    }
    const clip = await t.createAudioClip({ filePath, startTime: opts.start!, duration: opts.length, isWarped: opts.warped });
    return { clip, address: this.arrangementAddress(t, track, clip) };
  }

  /** t0/a3 when the clip is in the track's list, else its #id (the list is ordered by time and can lag). */
  private arrangementAddress(t: Track<V>, track: string, clip: Clip<V>): string {
    const i = t.arrangementClips.indexOf(clip);
    return i >= 0 ? `${track}/a${i}` : this.id(clip);
  }

  async deleteClip(address: string): Promise<string> {
    const { clip, slot, track } = this.locateClip(address);
    const name = clip.name;
    if (slot) await slot.deleteClip();
    else await track.deleteClip(clip);
    return name;
  }

  /** Deletes several clips as one undo step; every address is resolved first, so a wrong one deletes nothing. */
  async deleteClips(addresses: string[]): Promise<string[]> {
    const found = addresses.map((a) => this.locateClip(a));
    const ids = new Set<string>();
    const distinct = found.filter((f) => !ids.has(this.id(f.clip)) && ids.add(this.id(f.clip)));
    const names = distinct.map((f) => f.clip.name);
    // Live deletes an arrangement clip at the position it had when the delete was sent, so later clips go first.
    const position = (f: (typeof distinct)[number]) => (f.slot ? -1 : f.track.arrangementClips.indexOf(f.clip));
    const lastFirst = [...distinct].sort((a, b) => position(b) - position(a));
    await this.context.withinTransaction(() => Promise.all(lastFirst.map((f) => (f.slot ? f.slot.deleteClip() : f.track.deleteClip(f.clip)))));
    return names;
  }

  notes(address: string): NoteDescription[] {
    return this.midiClip(address).notes;
  }
  /** Replaces every note of the clip in one undo step. */
  setNotes(address: string, notes: NoteDescription[]): number {
    const clip = this.midiClip(address);
    this.context.withinTransaction(() => {
      clip.notes = notes;
    });
    return clip.notes.length;
  }

  deviceInfo(d: Device<V>, address: string): DeviceInfo {
    const info: DeviceInfo = { address, id: this.id(d), name: d.name, kind: d.constructor.name, parameters: d.parameters.length };
    if (d instanceof RackDevice) {
      info.chains = d.chains.map((c, i) => ({
        address: `${address}/c${i}`,
        id: this.id(c),
        devices: c.devices.map((dd, j) => this.deviceInfo(dd, `${address}/c${i}/d${j}`)),
      }));
    }
    return info;
  }

  parameterInfo(p: DeviceParameter<V>, address: string, index: number): ParameterInfo {
    const info: ParameterInfo = { address, index, name: p.name, min: p.min, max: p.max, quantized: p.isQuantized, default: p.defaultValue };
    if (p.isQuantized) info.items = p.valueItems.map((x) => x.name);
    return info;
  }

  deviceParameters(address: string): ParameterInfo[] {
    const d = this.device(address);
    return d.parameters.map((p, i) => this.parameterInfo(p, `${address}/p${i}`, i));
  }

  async readValues(params: DeviceParameter<V>[]): Promise<number[]> {
    return Promise.all(params.map((p) => p.getValue()));
  }

  // Several changes as one undo step: withinTransaction only groups what starts synchronously inside the callback,
  // so every setValue is started there and awaited afterwards.
  async setValues(changes: { address: string; value: number }[]): Promise<{ address: string; name: string; before: number; after: number; error?: string }[]> {
    const params = changes.map((c) => this.parameter(c.address));
    // By the parameter itself, since t0/d0/p1 and #id/p1 can name the same one.
    const seen = new Map<string, string>();
    changes.forEach((c, i) => {
      const id = this.id(params[i]);
      const first = seen.get(id);
      if (first !== undefined) throw new LiveError(`${first === c.address ? c.address : `${first} and ${c.address}`} name the same parameter twice in one batch; send one value per parameter`);
      seen.set(id, c.address);
    });
    // Check every value before setting any, so a batch is all or nothing as far as we can tell beforehand.
    const wrong = changes.flatMap((c, i) => {
      const p = params[i];
      if (!Number.isFinite(c.value) || c.value < p.min || c.value > p.max) return [`${c.address} "${p.name}": ${c.value} is outside ${p.min}..${p.max}`];
      if (p.isQuantized && !Number.isInteger(c.value)) return [`${c.address} "${p.name}": ${c.value} is not a whole number; choose one of ${p.valueItems.map((x, j) => `${j}=${x.name}`).join(", ")}`];
      return [];
    });
    if (wrong.length) throw new LiveError(`Nothing was changed: ${wrong.join("; ")}`);
    const before = await this.readValues(params);
    const start = (p: DeviceParameter<V>, value: number): Promise<void> => {
      try {
        return p.setValue(value);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    const settled = await this.context.withinTransaction(() => Promise.allSettled(params.map((p, i) => start(p, changes[i].value))));
    const after = await this.readValues(params);
    return changes.map((c, i) => {
      const r = settled[i];
      const row: { address: string; name: string; before: number; after: number; error?: string } = { address: c.address, name: params[i].name, before: before[i], after: after[i] };
      if (r.status === "rejected") row.error = this.rejectText(params[i], c.value);
      return row;
    });
  }

  private rejectText(p: DeviceParameter<V>, value: number): string {
    const items = p.isQuantized ? `, one of ${p.valueItems.map((x, i) => `${i}=${x.name}`).join(", ")}` : "";
    return `Live rejected ${value} for "${p.name}"; range ${p.min}..${p.max}${items}`;
  }

  async setValue(address: string, value: number): Promise<{ before: number; after: number }> {
    const p = this.parameter(address);
    const before = await p.getValue();
    try {
      await p.setValue(value);
    } catch {
      throw new LiveError(`${this.rejectText(p, value)} (${address})`);
    }
    return { before, after: await p.getValue() };
  }
}

function at<T>(list: T[], index: number, what: string, address: string): T {
  const item = list[index];
  if (item === undefined) throw new LiveError(`"${address}": no ${what} ${index} (there are ${list.length})`);
  return item;
}
