// fake-host.ts – an in-memory Live behind the SDK's low-level host API, so the real SDK classes, the adapter and the
// MCP server run in plain Node. Only what the server uses is implemented; anything else throws "not faked".
import type { ActivationContext, Handle } from "@ableton-extensions/sdk";

type Id = bigint;
interface Obj {
  id: Id;
  cls: string;
  parent: Id | null;
  deleted?: boolean;
  [key: string]: unknown;
}
export interface FakeParam {
  name: string;
  min?: number;
  max?: number;
  quantized?: boolean;
  items?: string[];
  value?: number;
  default?: number;
}

export class FakeLive {
  private objects = new Map<Id, Obj>();
  private nextId = 1n;
  readonly root: Id;
  readonly song: Id;
  transactions = 0;
  transactionDepth = 0;
  /** value writes that happened inside a transaction, per transaction */
  writesInTransaction: number[] = [];

  constructor() {
    this.root = this.add("Application", null);
    this.song = this.add("Song", this.root, { tempo: 120, tracks: [] as Id[], returnTracks: [] as Id[], scenes: [] as Id[] });
    this.get(this.song).mainTrack = this.addTrackObject("Track", "Main", this.song);
    for (let i = 0; i < 2; i++) (this.get(this.song).scenes as Id[]).push(this.add("Scene", this.song, { name: "" }));
  }

  private add(cls: string, parent: Id | null, fields: Record<string, unknown> = {}): Id {
    const id = this.nextId++;
    this.objects.set(id, { id, cls, parent, ...fields });
    return id;
  }
  private get(id: Id): Obj {
    const o = this.objects.get(id);
    if (!o || o.deleted) throw new TypeError("Invalid object reference");
    return o;
  }
  private addTrackObject(cls: string, name: string, parent: Id): Id {
    const id = this.add(cls, parent, { name, mute: false, solo: false, arm: false, devices: [] as Id[], slots: [] as Id[], arrangement: [] as Id[] });
    for (let i = 0; i < 2; i++) (this.get(id).slots as Id[]).push(this.add("ClipSlot", id, { clip: null }));
    const mixer = this.add("MixerDevice", id, {});
    this.get(mixer).volume = this.addParam(mixer, { name: "Track Volume", value: 0.85, default: 0.85 });
    this.get(mixer).panning = this.addParam(mixer, { name: "Track Panning", min: -1, max: 1, value: 0, default: 0 });
    this.get(mixer).sends = [] as Id[];
    this.get(id).mixer = mixer;
    return id;
  }
  private addParam(parent: Id, p: FakeParam): Id {
    return this.add("DeviceParameter", parent, {
      name: p.name,
      min: p.min ?? 0,
      max: p.max ?? (p.items ? p.items.length - 1 : 1),
      quantized: p.quantized ?? Boolean(p.items),
      items: p.items ?? [],
      value: p.value ?? 0,
      default: p.default ?? 0,
    });
  }

  addTrack(kind: "midi" | "audio" | "return", name: string): Id {
    const song = this.get(this.song);
    const id = this.addTrackObject(kind === "midi" ? "MidiTrack" : kind === "audio" ? "AudioTrack" : "Track", name, this.song);
    (kind === "return" ? (song.returnTracks as Id[]) : (song.tracks as Id[])).push(id);
    return id;
  }
  /** `holder` is a track or a chain */
  addDevice(holder: Id, name: string, params: FakeParam[], cls = "Device"): Id {
    const id = this.add(cls, holder, { name, params: [] as Id[], chains: [] as Id[] });
    const list = this.get(id).params as Id[];
    list.push(this.addParam(id, { name: "Device On", items: ["Off", "On"], value: 1 }));
    for (const p of params) list.push(this.addParam(id, p));
    (this.get(holder).devices as Id[]).push(id);
    return id;
  }
  addChain(rack: Id): Id {
    const id = this.add("Chain", rack, { devices: [] as Id[] });
    const mixer = this.add("ChainMixerDevice", id, { sends: [] as Id[] });
    this.get(mixer).volume = this.addParam(mixer, { name: "Chain Volume", value: 0.85 });
    this.get(mixer).panning = this.addParam(mixer, { name: "Chain Pan", min: -1, max: 1, value: 0 });
    this.get(id).mixer = mixer;
    (this.get(rack).chains as Id[]).push(id);
    return id;
  }
  addClip(track: Id, slot: number, name: string, duration = 4): Id {
    const slotId = (this.get(track).slots as Id[])[slot];
    const id = this.add("MidiClip", slotId, { name, duration, looping: true, muted: false, notes: [] as unknown[], start: 0 });
    this.get(slotId).clip = id;
    return id;
  }
  paramValue(id: Id): number {
    return this.get(id).value as number;
  }
  trackName(id: Id): string {
    return this.get(id).name as string;
  }

  private handles(ids: Id[]): Handle[] {
    return ids.map((id) => ({ id }));
  }

  /** The low-level data model, as the Extension Host provides it. */
  dataModel(): Record<string, unknown> {
    const h = (id: Id): Handle => ({ id });
    const self = this;
    const impl: Record<string, (...a: never[]) => unknown> = {
      getRoot: () => h(self.root),
      rootGetSong: () => h(self.song),
      getObjectIsOfClass: (handle: Handle, cls: string) => self.get(handle.id).cls === cls,
      getObjectCanonicalParent: (handle: Handle) => {
        const p = self.get(handle.id).parent;
        return p === null ? null : h(p);
      },
      songGetTempo: () => self.get(self.song).tempo as number,
      songSetTempo: (_s: Handle, v: number) => void (self.get(self.song).tempo = v),
      songGetTracks: () => self.handles(self.get(self.song).tracks as Id[]),
      songGetReturnTracks: () => self.handles(self.get(self.song).returnTracks as Id[]),
      songGetMainTrack: () => h(self.get(self.song).mainTrack as Id),
      songGetScenes: () => self.handles(self.get(self.song).scenes as Id[]),
      songCreateMidiTrack: (_s: Handle, ok: (x: Handle) => void) => ok(h(self.addTrack("midi", `${(self.get(self.song).tracks as Id[]).length + 1}-MIDI`))),
      songCreateAudioTrack: (_s: Handle, ok: (x: Handle) => void) => ok(h(self.addTrack("audio", `${(self.get(self.song).tracks as Id[]).length + 1}-Audio`))),
      songDeleteTrack: (_s: Handle, t: Handle, ok: () => void) => {
        const song = self.get(self.song);
        song.tracks = (song.tracks as Id[]).filter((x) => x !== t.id);
        self.get(t.id).deleted = true;
        ok();
      },
      trackGetName: (t: Handle) => self.get(t.id).name,
      trackSetName: (t: Handle, v: string) => void (self.get(t.id).name = v),
      trackGetMute: (t: Handle) => self.get(t.id).mute,
      trackSetMute: (t: Handle, v: boolean) => void (self.get(t.id).mute = v),
      trackGetSolo: (t: Handle) => self.get(t.id).solo,
      trackSetSolo: (t: Handle, v: boolean) => void (self.get(t.id).solo = v),
      trackGetArm: (t: Handle) => self.get(t.id).arm,
      trackSetArm: (t: Handle, v: boolean) => void (self.get(t.id).arm = v),
      trackGetGroupTrack: () => null,
      trackGetClipSlots: (t: Handle) => self.handles(self.get(t.id).slots as Id[]),
      clipslotGetClip: (s: Handle) => {
        const c = self.get(s.id).clip as Id | null;
        return c === null ? null : h(c);
      },
      clipGetName: (c: Handle) => self.get(c.id).name,
      clipSetName: (c: Handle, v: string) => void (self.get(c.id).name = v),
      clipGetStartTime: (c: Handle) => self.get(c.id).start,
      clipGetEndTime: (c: Handle) => (self.get(c.id).start as number) + (self.get(c.id).duration as number),
      clipGetStartMarker: () => 0,
      clipGetEndMarker: (c: Handle) => self.get(c.id).duration,
      clipGetLoopStart: () => 0,
      clipGetLoopEnd: (c: Handle) => self.get(c.id).duration,
      clipGetLooping: (c: Handle) => self.get(c.id).looping,
      clipSetLooping: (c: Handle, v: boolean) => void (self.get(c.id).looping = v),
      clipGetMuted: (c: Handle) => self.get(c.id).muted,
      clipSetMuted: (c: Handle, v: boolean) => void (self.get(c.id).muted = v),
      midiclipGetNotes: (c: Handle) => self.get(c.id).notes,
      midiclipSetNotes: (c: Handle, notes: unknown[]) => {
        if (self.transactionDepth > 0) self.writesInTransaction[self.writesInTransaction.length - 1]++;
        self.get(c.id).notes = notes.map((n) => ({ velocity: 100, muted: false, ...(n as object) }));
      },
      clipslotCreateMidiClip: (s: Handle, length: number, ok: (x: Handle) => void, err: () => void) => {
        const slot = self.get(s.id);
        if (slot.clip !== null) return err();
        const id = self.add("MidiClip", s.id, { name: "", duration: length, looping: true, muted: false, notes: [], start: 0 });
        slot.clip = id;
        ok(h(id));
      },
      clipslotCreateAudioClip: (s: Handle, args: { filePath: string }, ok: (x: Handle) => void) => {
        const id = self.add("AudioClip", s.id, { name: args.filePath.split("/").pop(), duration: 4, looping: false, muted: false, file: args.filePath, start: 0 });
        self.get(s.id).clip = id;
        ok(h(id));
      },
      clipslotDeleteClip: (s: Handle, ok: () => void) => {
        const slot = self.get(s.id);
        self.get(slot.clip as Id).deleted = true;
        slot.clip = null;
        ok();
      },
      audioclipGetFilePath: (c: Handle) => self.get(c.id).file,
      trackGetArrangementClips: (t: Handle) => self.handles(self.get(t.id).arrangement as Id[]),
      trackCreateMidiClip: (t: Handle, start: number, duration: number, ok: (x: Handle) => void) => {
        const id = self.add("MidiClip", t.id, { name: "", duration, looping: false, muted: false, notes: [], start });
        (self.get(t.id).arrangement as Id[]).push(id);
        ok(h(id));
      },
      trackDeleteClip: (t: Handle, c: Handle, ok: () => void) => {
        const tr = self.get(t.id);
        tr.arrangement = (tr.arrangement as Id[]).filter((x) => x !== c.id);
        self.get(c.id).deleted = true;
        ok();
      },
      trackGetDevices: (t: Handle) => self.handles(self.get(t.id).devices as Id[]),
      trackGetMixerDevice: (t: Handle) => h(self.get(t.id).mixer as Id),
      trackInsertDevice: (t: Handle, name: string, index: bigint, ok: (x: Handle) => void, err: () => void) => {
        if (!["Reverb", "Utility", "Operator"].includes(name)) return err();
        const id = self.addDevice(t.id, name, [{ name: "Dry/Wet", value: 1 }]);
        const list = self.get(t.id).devices as Id[];
        list.pop();
        list.splice(Number(index), 0, id);
        ok(h(id));
      },
      trackDeleteDevice: (t: Handle, d: Handle, ok: () => void) => {
        const tr = self.get(t.id);
        tr.devices = (tr.devices as Id[]).filter((x) => x !== d.id);
        self.get(d.id).deleted = true;
        ok();
      },
      chainGetDevices: (c: Handle) => self.handles(self.get(c.id).devices as Id[]),
      chainGetMixerDevice: (c: Handle) => h(self.get(c.id).mixer as Id),
      rackdeviceGetChains: (d: Handle) => self.handles(self.get(d.id).chains as Id[]),
      deviceGetName: (d: Handle) => self.get(d.id).name,
      deviceGetParameters: (d: Handle) => self.handles(self.get(d.id).params as Id[]),
      mixerdeviceGetVolume: (m: Handle) => h(self.get(m.id).volume as Id),
      mixerdeviceGetPanning: (m: Handle) => h(self.get(m.id).panning as Id),
      mixerdeviceGetSends: (m: Handle) => self.handles(self.get(m.id).sends as Id[]),
      chainmixerdeviceGetVolume: (m: Handle) => h(self.get(m.id).volume as Id),
      chainmixerdeviceGetPanning: (m: Handle) => h(self.get(m.id).panning as Id),
      chainmixerdeviceGetSends: (m: Handle) => self.handles(self.get(m.id).sends as Id[]),
      deviceParameterGetName: (p: Handle) => self.get(p.id).name,
      deviceParameterGetInternalMin: (p: Handle) => self.get(p.id).min,
      deviceParameterGetInternalMax: (p: Handle) => self.get(p.id).max,
      deviceParameterGetIsQuantized: (p: Handle) => self.get(p.id).quantized,
      deviceParameterGetDefaultValue: (p: Handle) => self.get(p.id).default,
      deviceParameterGetValueItems: (p: Handle) => (self.get(p.id).items as string[]).map((name) => ({ name, shortName: name })),
      deviceParameterGetInternalValue: (p: Handle, ok: (v: number) => void) => setImmediate(() => ok(self.get(p.id).value as number)),
      deviceParameterSetInternalValue: (p: Handle, v: number, ok: () => void, err: (e: string) => void) => {
        const o = self.get(p.id);
        if (self.transactionDepth > 0) self.writesInTransaction[self.writesInTransaction.length - 1]++;
        if (v < (o.min as number) || v > (o.max as number)) return setImmediate(() => err("1"));
        o.value = o.quantized ? Math.round(v) : v;
        setImmediate(ok);
      },
      withinTransaction: <T>(fn: () => T): T => {
        if (self.transactionDepth === 0) {
          self.transactions++;
          self.writesInTransaction.push(0);
        }
        self.transactionDepth++;
        try {
          return fn();
        } finally {
          self.transactionDepth--;
        }
      },
    };
    return new Proxy(impl, {
      get(target, key: string) {
        if (key in target) return target[key];
        return () => {
          throw new Error(`fake host: ${key} not faked`);
        };
      },
    });
  }

  activation(): ActivationContext {
    const api = {
      commands: { registerCommand() {}, executeCommand() {} },
      dataModel: this.dataModel(),
      environment: { storageDirectory: undefined, tempDirectory: undefined, language: "EN" },
      resources: {
        importIntoProject(filePath: string, ok: (p: string) => void, fail: (e: string) => void) {
          if (filePath.includes("missing")) fail(`no such file: ${filePath}`);
          else ok(`/project/Samples/Imported/${filePath.split("/").pop()}`);
        },
      },
      ui: {},
    };
    return { hostApiVersion: "1.0.0", initializeExtensionHost: () => api } as unknown as ActivationContext;
  }
}

/** A small set: a MIDI track with a Max for Live-like device, an audio track, a return track. */
export function smallSet(): FakeLive {
  const live = new FakeLive();
  const t0 = live.addTrack("midi", "1-MIDI");
  live.addDevice(t0, "QuadraDrei", [
    { name: "A", max: 127, value: 117 },
    { name: "Cutoff", max: 127, value: 127, default: 100 },
    { name: "Type", items: ["Lowp", "Band", "High"], value: 0 },
    { name: "Show", items: ["hidden", "shown"] },
  ]);
  live.addClip(t0, 1, "Intro", 8);
  const t1 = live.addTrack("audio", "2-Audio");
  const rack = live.addDevice(t1, "Audio Effect Rack", [], "RackDevice");
  live.addDevice(live.addChain(rack), "Saturator", [{ name: "Drive", value: 0.5 }]);
  live.addTrack("return", "A-Reverb");
  return live;
}
