// server.ts – the MCP server: tools and resources over the Live adapter, the Max for Live registry and the bridge.
// One instance per HTTP request (stateless), so everything here must be cheap to construct.
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LiveAdapter, LiveError, type ParameterInfo } from "../live/adapter.js";
import { explain } from "../live/errors.js";
import { ChangeTracker } from "../live/changes.js";
import { M4lRegistry } from "../m4l/registry.js";
import type { M4lDevice, M4lParameter } from "../m4l/amxd.js";
import { Device, Track } from "@ableton-extensions/sdk";
import { Bridge, BridgeError } from "../bridge/client.js";
import { capabilities } from "./capabilities.js";

export interface ServerDeps {
  live: LiveAdapter;
  registry: M4lRegistry;
  bridge: Bridge;
  changes: ChangeTracker;
  version: string;
  log: (...a: unknown[]) => void;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, bigintSafe) }] });
const fail = (e: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: e instanceof BridgeError ? e.message : explain(e) }] });
const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);
const guarded = <A>(fn: (args: A) => Promise<unknown> | unknown) => async (args: A): Promise<ToolResult> => {
  try {
    return json(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

const address = z.string().describe('Address like "t0" (track), "t0/d1" (device), "t0/d1/p3" (parameter), "t0/vol", "r0", "main", or "#id"');
const clipAddress = z.string().describe('A clip: "t0/s3" (session slot 3 of track 0), "t0/a1" (arrangement clip 1), or the clip\'s "#id"');
const note = z.object({
  pitch: z.number().int().min(0).max(127),
  startTime: z.number().min(0).describe("Beats from the clip start"),
  duration: z.number().positive().describe("Beats"),
  velocity: z.number().min(1).max(127).optional().describe("Default 100"),
  muted: z.boolean().optional(),
  probability: z.number().min(0).max(1).optional(),
  velocityDeviation: z.number().min(-127).max(127).optional(),
  releaseVelocity: z.number().min(0).max(127).optional(),
});

export function createServer(deps: ServerDeps): McpServer {
  const { live, registry, bridge, changes } = deps;
  const server = new McpServer({ name: "live-mcp", version: deps.version }, { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } } });

  const m4lFor = (deviceAddress: string): M4lDevice | undefined => registry.match(live.device(deviceAddress).parameters.map((p) => p.name));

  const overview = () => {
    const song = live.song;
    const tracks = live.tracks();
    for (const t of tracks) for (const d of t.devices) annotateDevice(d);
    return { tempo: song.tempo, scenes: song.scenes.length, tracks };
  };
  const annotateDevice = (d: { address: string; kind: string; chains?: { devices: { address: string; kind: string }[] }[]; m4l?: string }) => {
    const m = m4lFor(d.address);
    if (m) d.kind = "Max for Live: " + path.basename(m.file, ".amxd");
    for (const c of d.chains ?? []) for (const dd of c.devices) annotateDevice(dd);
  };

  const viaBridge = " Needs the LiveRemote bridge (see get_capabilities).";
  const capabilityState = async () => ({ bridgeConfigured: bridge.configured, bridgeReachable: bridge.configured && (await bridge.ping()), knownDevices: registry.files().length });

  server.registerResource("set", "live://set", { description: "The open Live set: tracks, devices, addresses", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(overview(), bigintSafe) }],
  }));
  server.registerResource("capabilities", "live://capabilities", { description: "What this server can and cannot do in Live, and why", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(capabilities(await capabilityState())) }],
  }));

  // ---- reading -------------------------------------------------------------------------------------------------

  server.registerTool(
    "get_set",
    {
      description: "The open Live set: tempo, tracks (with mute/solo/arm and their session clips), devices with addresses and parameter counts; Max for Live devices are named after their .amxd file when recognised. Start here; addresses from this answer are used by every other tool.",
      inputSchema: {},
    },
    guarded(() => overview()),
  );

  server.registerTool(
    "get_capabilities",
    { description: "What this server can and cannot do in Live, with reasons, and whether the LiveRemote bridge (routing, transport, selection, undo) is reachable right now. Read before promising the user anything.", inputSchema: {} },
    guarded(async () => capabilities(await capabilityState())),
  );

  server.registerTool(
    "list_parameters",
    {
      description:
        "All parameters of a device: address, name, range, choices, current value. For recognised Max for Live devices also the long name, unit and help text. With display=true (needs the bridge) also the value as Live shows it, e.g. \"-12.0 dB\". Max for Live short names may repeat: address by index.",
      inputSchema: {
        device: address,
        values: z.boolean().default(true).describe("Include current values"),
        display: z.boolean().default(false).describe("Include Live's display strings via the bridge (built-in device units)"),
      },
    },
    guarded(async ({ device, values, display }) => {
      const d = live.device(device);
      const infos = live.deviceParameters(device);
      if (values) {
        const vals = await live.readValues(d.parameters);
        infos.forEach((p, i) => (p.value = vals[i]));
      }
      const m4l = m4lFor(device);
      const rows = infos.map((p, i) => compactParam(p, m4l?.parameters[i]));
      if (display) {
        const strs = await bridge.call<{ index: number; str: string }[]>("param_strs", bridgeDeviceArgs(live, device));
        for (const s of strs) if (rows[s.index]) rows[s.index].display = s.str;
      }
      const out: Record<string, unknown> = { device, name: d.name };
      if (m4l) out.m4l = { file: m4l.file, frozen: m4l.frozen, notInLive: hiddenNames(m4l) };
      out.parameters = rows;
      return out;
    }),
  );

  server.registerTool(
    "find_parameters",
    {
      description: "Find parameters by name across the set (case-insensitive substring of the short name, or of the long name for recognised Max for Live devices). Returns addresses to use with get_parameters/set_parameters.",
      inputSchema: { query: z.string().min(1), device: address.optional().describe("Limit to one device") },
    },
    guarded(({ query, device }) => {
      const q = query.toLowerCase();
      const hits: unknown[] = [];
      const search = (deviceAddress: string) => {
        const d = live.device(deviceAddress);
        const m4l = m4lFor(deviceAddress);
        d.parameters.forEach((p, i) => {
          const long = m4l?.parameters[i]?.longName;
          if (p.name.toLowerCase().includes(q) || long?.toLowerCase().includes(q)) {
            const row: Record<string, unknown> = { address: `${deviceAddress}/p${i}`, name: p.name, device: d.name };
            if (long && long !== p.name) row.longName = long;
            hits.push(row);
          }
        });
      };
      const walk = (devices: { address: string; chains?: { devices: { address: string }[] }[] }[]) => {
        for (const d of devices) {
          search(d.address);
          for (const c of d.chains ?? []) walk(c.devices);
        }
      };
      if (device) search(device);
      else for (const t of live.tracks()) walk(t.devices);
      const out: Record<string, unknown> = { query, hits: hits.slice(0, 200), total: hits.length };
      if (hits.length === 0) {
        const hidden: string[] = [];
        const devices = device ? [device] : live.tracks().flatMap((t) => t.devices.map((d) => d.address));
        for (const a of devices) {
          const m = m4lFor(a);
          if (m) for (const name of hiddenNames(m)) if (name.toLowerCase().includes(q)) hidden.push(`${name} (in ${live.device(a).name}, ${a})`);
        }
        if (hidden.length) out.note = `no parameter in Live matches, but the Max for Live device has these controls that Live does not expose (buttons and stored data cannot be reached through any API): ${hidden.join("; ")}`;
      }
      return out;
    }),
  );

  server.registerTool(
    "get_parameters",
    { description: "Current values of parameters by address (device parameters, or track mixer: t0/vol, t0/pan, t0/send0).", inputSchema: { addresses: z.array(address).min(1) } },
    guarded(async ({ addresses }) => {
      const params = addresses.map((a) => live.parameter(a));
      const vals = await live.readValues(params);
      return addresses.map((a, i) => ({ address: a, name: params[i].name, value: vals[i], min: params[i].min, max: params[i].max }));
    }),
  );

  server.registerTool(
    "get_changes",
    {
      description:
        "What changed in the set since the last call with the same cursor: tracks and devices added, removed, renamed or reordered, parameter and mixer values, tempo. The first call only takes a snapshot. Use this instead of re-reading the whole set; Live has no event stream, so this is the way to notice edits the user made.",
      inputSchema: { cursor: z.string().default("default").describe("A name for this watch; each cursor keeps its own snapshot"), scope: address.optional().describe("Only this track") },
    },
    guarded(({ cursor, scope }) => changes.changesSince(cursor, scope)),
  );

  // ---- writing -------------------------------------------------------------------------------------------------

  server.registerTool(
    "set_parameters",
    {
      description: "Set one or more parameters in a single undo step. Values are in Live's internal units, within the min..max that list_parameters reports (quantized: the index of the choice). Returns before/after per parameter; a rejected value does not stop the others.",
      inputSchema: { changes: z.array(z.object({ address, value: z.number() })).min(1) },
    },
    guarded(({ changes }) => live.setValues(changes)),
  );

  server.registerTool(
    "set_parameter_display",
    {
      description:
        'Set one parameter by the value as Live displays it: "-6 dB", "440 Hz", "250 ms", "50 %", "C3", or a choice name. Live finds the internal value for it (bisection inside Live). Returns the resulting display string and how far it is from the target.' +
        viaBridge,
      inputSchema: { parameter: address.describe("A device parameter address (track/dN/pM)"), target: z.string().min(1) },
    },
    guarded(({ parameter, target }) => {
      const p = live.parameter(parameter);
      const device = p.parent;
      if (!(device instanceof Device)) throw new LiveError(`${parameter} is not a device parameter; mixer parameters (volume, pan, sends) are not reachable this way`);
      const index = device.parameters.indexOf(p);
      return bridge.call("param_set_display", [...bridgeDeviceArgs(live, live.id(device)), index, target]);
    }),
  );

  server.registerTool(
    "set_track",
    { description: "Rename, mute, solo or arm a track.", inputSchema: { track: address, name: z.string().optional(), mute: z.boolean().optional(), solo: z.boolean().optional(), arm: z.boolean().optional() } },
    guarded(({ track, name, mute, solo, arm }) => {
      const t = live.track(track);
      if (name !== undefined) t.name = name;
      if (mute !== undefined) t.mute = mute;
      if (solo !== undefined) t.solo = solo;
      if (arm !== undefined) t.arm = arm;
      return live.trackInfo(t, track);
    }),
  );

  server.registerTool("set_tempo", { description: "Set the song tempo in BPM.", inputSchema: { bpm: z.number().min(20).max(999) } }, guarded(({ bpm }) => ((live.song.tempo = bpm), { tempo: live.song.tempo })));

  server.registerTool(
    "insert_device",
    {
      description: 'Insert a built-in Live device with its default preset by name ("Reverb", "Operator", "EQ Eight", "Auto Filter"...) into a track or rack chain. For a saved preset, a Max for Live device or a plug-in use load_browser_item.',
      inputSchema: { into: address.describe("Track or chain address"), device: z.string(), index: z.number().int().min(0).optional().describe("Position in the chain; end if omitted") },
    },
    guarded(async ({ into, device, index }) => {
      const holder = live.deviceHolder(into);
      const d = await holder.insertDevice(device, index ?? holder.devices.length);
      return live.deviceInfo(d, `${into}/d${holder.devices.indexOf(d)}`);
    }),
  );

  server.registerTool(
    "browse",
    {
      description: 'List Live\'s browser: the roots when path is empty, else the children of a path such as "user_library/Presets/Instruments/External Instrument" or "Places/<folder>". Loadable items can be given to load_browser_item.' + viaBridge,
      inputSchema: { path: z.string().default("") },
    },
    guarded(({ path }) => bridge.call("browser", [path])),
  );

  server.registerTool(
    "load_browser_item",
    {
      description: "Load any loadable browser item onto a track by name: a saved preset (\"My Synth.adv\" keeps everything it was saved with, including an External Instrument's MIDI To / Audio From), a Max for Live device (\"My Device.amxd\"), a plug-in or a built-in device. Live places it after the track's selected device, or last, and selects the track while doing so. The first match across the browser roots wins; use browse to see what exists." + viaBridge,
      inputSchema: { track: address, item: z.string().describe("Name as the browser shows it, with or without extension") },
    },
    guarded(async ({ track, item }) => {
      const holder = live.track(track);
      const before = holder.devices.map((d) => live.id(d));
      const loaded = await bridge.call<{ from: string; item: string; devices_after: string[] }>("add_device", [bridgeTrackIndex(live, track), item]);
      const added = holder.devices.findIndex((d) => !before.includes(live.id(d)));
      if (added < 0) return { loaded: loaded.item, from: loaded.from, note: "Live reported no new device on the track; it may have replaced the selected device or loaded a preset into it." };
      return { loaded: loaded.item, from: loaded.from, device: live.deviceInfo(holder.devices[added], `${track}/d${added}`) };
    }),
  );

  server.registerTool(
    "delete_device",
    { description: "Delete a device from its track or chain.", inputSchema: { device: address } },
    guarded(async ({ device }) => {
      const { device: d, holder } = live.locateDevice(device);
      const name = d.name;
      await holder.deleteDevice(d);
      return { deleted: name };
    }),
  );

  server.registerTool(
    "create_track",
    { description: "Create a MIDI or audio track (after the selected track).", inputSchema: { kind: z.enum(["midi", "audio"]), name: z.string().optional() } },
    guarded(async ({ kind, name }) => {
      const t = kind === "midi" ? await live.song.createMidiTrack() : await live.song.createAudioTrack();
      if (name) t.name = name;
      const i = live.song.tracks.indexOf(t);
      return live.trackInfo(t, i >= 0 ? `t${i}` : live.id(t));
    }),
  );

  server.registerTool(
    "delete_track",
    { description: "Delete a track.", inputSchema: { track: address } },
    guarded(async ({ track }) => {
      const t = live.track(track);
      const name = t.name;
      await live.song.deleteTrack(t);
      return { deleted: name };
    }),
  );

  // ---- through the bridge --------------------------------------------------------------------------------------

  server.registerTool(
    "transport",
    {
      description: "Transport status (playing, recording, tempo, position, loop, metronome) and actions: play, stop, continue, stop_all_clips, record_on/off, metronome_on/off, loop_on/off. Live applies play/stop a moment later: call again without an action to confirm." + viaBridge,
      inputSchema: { action: z.enum(["play", "stop", "continue", "stop_all_clips", "record_on", "record_off", "metronome_on", "metronome_off", "loop_on", "loop_off"]).optional() },
    },
    guarded(({ action }) => bridge.call("transport", [], action ? { action } : {})),
  );

  server.registerTool(
    "selection",
    {
      description: "The selected track, device and scene in Live's UI; pass any of them to select." + viaBridge,
      inputSchema: { track: address.optional(), device: address.optional().describe("Device address on that track"), scene: z.number().int().min(0).optional() },
    },
    guarded(({ track, device, scene }) => {
      const kwargs: Record<string, unknown> = {};
      if (device) {
        const [t, d] = bridgeDeviceArgs(live, device);
        if (track && bridgeTrackIndex(live, track) !== t) throw new LiveError(`${device} is not on ${track}; give the device alone, or the track alone`);
        kwargs.track = t;
        kwargs.device = d;
      } else if (track) kwargs.track = bridgeTrackIndex(live, track);
      if (scene !== undefined) kwargs.scene = scene;
      return bridge.call("selection", [], kwargs);
    }),
  );

  server.registerTool("get_scenes", { description: "Scenes with names and triggered state." + viaBridge, inputSchema: {} }, guarded(() => bridge.call("scenes")));

  server.registerTool(
    "get_clips",
    {
      description:
        "Clips: for the whole set the filled session slots per track; for one track also its arrangement clips, and with the bridge the playing/triggered/recording state per slot. Each clip has an address (t0/s3 session, t0/a1 arrangement) for get_notes, set_notes, set_clip and delete_clip.",
      inputSchema: { track: address.optional() },
    },
    guarded(async ({ track }) => {
      if (!track) return live.tracks().filter((t) => t.clips).map((t) => ({ track: t.address, name: t.name, clips: t.clips }));
      const t = live.track(track);
      const clips = live.clips(t, track);
      const arrangement = live.arrangementClips(t, track);
      if (!bridge.configured) return { track, name: t.name, clips, arrangement, note: "playing state needs the LiveRemote bridge" };
      const state = await bridge.call<{ index: number; is_playing: boolean; is_triggered: boolean; is_recording: boolean }[]>("clips", [bridgeTrackIndex(live, track)]);
      const byIndex = new Map(state.map((s) => [s.index, s]));
      const stateOf = (slot: number | undefined) => (slot === undefined ? undefined : byIndex.get(slot));
      return {
        track,
        name: t.name,
        clips: clips.map((c) => ({ ...c, playing: stateOf(c.slot)?.is_playing ?? false, triggered: stateOf(c.slot)?.is_triggered ?? false, recording: stateOf(c.slot)?.is_recording ?? false })),
        arrangement,
      };
    }),
  );

  server.registerTool(
    "create_clip",
    {
      description:
        "Create an empty MIDI clip on a MIDI track: in a session slot (slot) or in the arrangement (start, in beats). length in beats. Optional name and notes (same shape as set_notes; they form a second undo step after the creation). Answers with the clip's address and id; arrangement addresses (t0/a1) are ordered by time and shift when clips are added or deleted, so keep the #id. For an audio file use create_audio_clip.",
      inputSchema: {
        track: address,
        slot: z.number().int().min(0).optional().describe("Session slot index (scene row)"),
        start: z.number().min(0).optional().describe("Arrangement position in beats; give slot or start"),
        length: z.number().positive().describe("Beats"),
        name: z.string().optional(),
        notes: z.array(note).optional(),
      },
    },
    guarded(async ({ track, slot, start, length, name, notes }) => {
      const { clip, address: a } = await live.createMidiClip(track, { slot, start, length });
      if (name !== undefined || notes) {
        live.context.withinTransaction(() => {
          if (name !== undefined) clip.name = name;
          if (notes) clip.notes = notes;
        });
      }
      return live.clipInfo(clip, a);
    }),
  );

  server.registerTool(
    "create_audio_clip",
    {
      description: "Create an audio clip from a file on an audio track: in a session slot (slot) or in the arrangement (start, with optional length in beats). file is an absolute path. Answers with the clip's address and id (keep the #id for arrangement clips).",
      inputSchema: {
        track: address,
        file: z.string().describe("Absolute path to the audio file"),
        slot: z.number().int().min(0).optional(),
        start: z.number().min(0).optional().describe("Arrangement position in beats; give slot or start"),
        length: z.number().positive().optional().describe("Arrangement only: beats on the timeline"),
        warped: z.boolean().optional(),
      },
    },
    guarded(async ({ track, file, slot, start, length, warped }) => {
      const { clip, address: a } = await live.createAudioClip(track, { slot, start, length, file, warped });
      return live.clipInfo(clip, a);
    }),
  );

  server.registerTool(
    "get_notes",
    { description: "All notes of a MIDI clip: pitch (60 = C3), startTime and duration in beats from the clip start, velocity, muted, probability, velocityDeviation, releaseVelocity.", inputSchema: { clip: clipAddress } },
    guarded(({ clip }) => {
      const { address: a, clip: c } = live.locateClip(clip);
      return { clip: a, length: c.endMarker - c.startMarker, notes: live.notes(clip) };
    }),
  );

  server.registerTool(
    "set_notes",
    {
      description: "Replace every note of a MIDI clip with the given list, as one undo step. To change some notes: get_notes, edit the list, set_notes. Notes outside the clip's length are kept by Live but not played unless the end marker moves.",
      inputSchema: { clip: clipAddress, notes: z.array(note) },
    },
    guarded(({ clip, notes }) => {
      const { address: a } = live.locateClip(clip);
      return { clip: a, notes: live.setNotes(clip, notes) };
    }),
  );

  server.registerTool(
    "set_clip",
    { description: "Rename, loop or mute a clip. Omitted fields stay.", inputSchema: { clip: clipAddress, name: z.string().optional(), looping: z.boolean().optional(), muted: z.boolean().optional() } },
    guarded(({ clip, name, looping, muted }) => {
      const { clip: c, address: a } = live.locateClip(clip);
      live.context.withinTransaction(() => {
        if (name !== undefined) c.name = name;
        if (looping !== undefined) c.looping = looping;
        if (muted !== undefined) c.muted = muted;
      });
      return live.clipInfo(c, a);
    }),
  );

  server.registerTool(
    "delete_clip",
    { description: "Delete a session or arrangement clip.", inputSchema: { clip: clipAddress } },
    guarded(async ({ clip }) => ({ deleted: await live.deleteClip(clip) })),
  );

  server.registerTool(
    "fire",
    {
      description: "Launch a scene (scene only), a session clip (track + clip slot index), or stop a track's clips (track only)." + viaBridge,
      inputSchema: { track: address.optional(), clip: z.number().int().min(0).optional(), scene: z.number().int().min(0).optional() },
    },
    guarded(({ track, clip, scene }) => {
      const kwargs: Record<string, unknown> = {};
      if (track) kwargs.track = bridgeTrackIndex(live, track);
      if (clip !== undefined) kwargs.clip = clip;
      if (scene !== undefined) kwargs.scene = scene;
      return bridge.call("fire", [], kwargs);
    }),
  );

  server.registerTool("undo", { description: "Undo the last change in Live (also changes made by this server)." + viaBridge, inputSchema: {} }, guarded(() => bridge.call("undo")));
  server.registerTool("redo", { description: "Redo the last undone change in Live." + viaBridge, inputSchema: {} }, guarded(() => bridge.call("redo")));

  server.registerTool(
    "get_routing",
    { description: "A track's input/output routing, monitoring, and the options available for each." + viaBridge, inputSchema: { track: address } },
    guarded(async ({ track }) => {
      const i = bridgeTrackIndex(live, track);
      const [current, options] = await Promise.all([bridge.call("routing", [i]), bridge.call("routing_options", [i])]);
      return { track, current, options };
    }),
  );

  server.registerTool(
    "set_routing",
    {
      description: "Set a track's input/output routing by (part of) the option name as shown in Live, and monitoring (In/Auto/Off). Omitted fields stay. Use get_routing for the options." + viaBridge,
      inputSchema: { track: address, input_type: z.string().optional(), input_channel: z.string().optional(), output_type: z.string().optional(), output_channel: z.string().optional(), monitor: z.enum(["In", "Auto", "Off"]).optional() },
    },
    guarded(({ track, ...rest }) => bridge.call("routing", [bridgeTrackIndex(live, track)], stripUndefined(rest))),
  );

  server.registerTool(
    "get_device_routing",
    { description: "The MIDI/audio routing points of a device, with current and available routings. Live exposes them for Max for Live devices only. " + NO_DEVICE_IO + viaBridge, inputSchema: { device: address } },
    guarded(async ({ device }) => {
      const io = await bridge.call<Record<string, unknown>>("device_io", bridgeDeviceArgs(live, device));
      return Object.keys(io).length > 0 ? io : { device, routing: {}, note: "This device has no routing points Live exposes. " + NO_DEVICE_IO };
    }),
  );

  server.registerTool(
    "set_device_routing",
    {
      description: "Set one routing point of a Max for Live device: io is midi_inputs, midi_outputs, audio_inputs or audio_outputs; type and channel by (part of) the option name. " + NO_DEVICE_IO + viaBridge,
      inputSchema: { device: address, io: z.enum(["midi_inputs", "midi_outputs", "audio_inputs", "audio_outputs"]), type: z.string().optional(), channel: z.string().optional(), index: z.number().int().min(0).default(0) },
    },
    guarded(({ device, io, type, channel, index }) => bridge.call("device_routing", [...bridgeDeviceArgs(live, device), io], stripUndefined({ type, channel, index }))),
  );

  return server;
}

/** Neither Live's Python API nor the Extensions API reaches these fields; the model must ask the user. */
const NO_DEVICE_IO = "The MIDI To and Audio From of an External Instrument, and the Audio To/From of an External Audio Effect, are not in Live's APIs and can only be set in Live's window.";

/** LiveRemote counts tracks as regular + return + main. */
function bridgeTrackIndex(live: LiveAdapter, track: string): number {
  const t = live.track(track);
  const song = live.song;
  let i = song.tracks.indexOf(t);
  if (i >= 0) return i;
  i = song.returnTracks.indexOf(t);
  if (i >= 0) return song.tracks.length + i;
  if (t === song.mainTrack) return song.tracks.length + song.returnTracks.length;
  throw new LiveError(`${track} is not in the set`);
}

/** LiveRemote addresses devices as (track index, device index on that track); devices inside racks are out of reach. */
function bridgeDeviceArgs(live: LiveAdapter, device: string): [number, number] {
  const { holder, index } = live.locateDevice(device);
  if (!(holder instanceof Track)) throw new LiveError(`the bridge only reaches devices directly on a track, not ${device} inside a rack`);
  return [bridgeTrackIndex(live, live.id(holder)), index];
}

/** Controls a Max for Live device keeps away from Live: hidden buttons (invisible 2) and stored-only data (invisible 1). */
function hiddenNames(m: M4lDevice): string[] {
  return m.all.filter((p) => p.invisible !== 0).map((p) => p.longName);
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function compactParam(p: ParameterInfo, m?: M4lParameter): Record<string, unknown> {
  const out: Record<string, unknown> = { address: p.address, name: p.name };
  if (m && m.longName !== p.name) out.longName = m.longName;
  if (p.value !== undefined) out.value = p.value;
  out.min = p.min;
  out.max = p.max;
  if (m?.unit) out.unit = m.unit;
  if (p.items) out.items = p.items;
  if (m?.help) out.help = m.help;
  return out;
}
