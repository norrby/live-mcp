// server.ts – the MCP server: tools and resources over the Live adapter, the Max for Live registry and the bridge.
// One instance per HTTP request (stateless), so everything here must be cheap to construct.
import * as path from "node:path";
import * as fs from "node:fs";
import { measure, parseAudio } from "../audio/analyse.js";
import { parseMidi } from "../midi/smf.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LiveAdapter, LiveError, type ParameterInfo, type TrackInfo } from "../live/adapter.js";
import { explain } from "../live/errors.js";
import { ChangeTracker } from "../live/changes.js";
import { M4lRegistry, isForbidden } from "../m4l/registry.js";
import type { M4lDevice, M4lParameter } from "../m4l/amxd.js";
import { AudioTrack, Device, Track } from "@ableton-extensions/sdk";
import { Bridge, BridgeError } from "../bridge/client.js";
import { capabilities } from "./capabilities.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Sent to every client on connect: how to work with Live through this server, in a few rules. */
export const INSTRUCTIONS = [
  "Live MCP reads and changes the Ableton Live set that is open right now. Work like this:",
  "- Start with get_set. Addresses (t0, t0/d1, t0/d1/p3, t0/s0, t0/a0) are positions and shift when things move; keep the #id a create answers with.",
  "- Before driving a Max for Live device, read list_parameters: m4l.about is its author's own instructions, follow them. Parameters under m4l.askFirst change only when the user asked for that very action; never set userAsked on your own.",
  "- When one parameter decides what others edit (a step, page or mode selector), set it in a call of its own first.",
  "- Each call is one undo step, so put related changes in one call; Live's undo (Cmd/Ctrl+Z) takes back a whole call. The exception: a new clip that also gets notes or a name takes two steps (the clip, then its contents).",
  "- A track that has played a session clip ignores its arrangement clips until transport back_to_arrangement.",
  "- Live sends no events: get_changes tells what the user changed since you last looked.",
  "- get_capabilities says what works now, what needs the LiveRemote bridge, and what no API in Live allows. When something cannot be done, tell the user instead of working around it.",
].join("\n");

const READ_ONLY_NOTE =
  "- The user has set Live MCP to read-only: you can look at the set but change nothing. If the user asks for a change, say that read-only mode is on and can be turned off under Live MCP status… in the right-click menu of a track or scene.";

const READ_ONLY = new Set(["get_set", "get_capabilities", "list_parameters", "find_parameters", "get_parameters", "get_changes", "browse", "get_scenes", "get_clips", "get_notes", "get_routing", "get_device_routing", "get_clip_automation", "measure_audio"]);
/** Tools that change the set without removing or overwriting what is there; any other tool that writes counts as destructive. */
const NOT_DESTRUCTIVE = new Set([
  "set_parameters", "set_parameter_display", "set_track", "set_tempo", "set_clip", "set_routing", "set_device_routing",
  "insert_device", "load_browser_item", "create_track", "create_clip", "create_audio_clip", "import_midi_file",
  "transport", "selection", "scenes", "fire", "undo", "redo",
]);
const IDEMPOTENT = new Set(["set_parameters", "set_parameter_display", "set_track", "set_tempo", "set_clip", "set_notes", "set_routing", "set_device_routing", "set_clip_automation", "clear_clip_automation"]);

/** MCP hints for a tool, from its name: what it reads, what it may destroy, whether repeating it changes anything. */
export function annotationsFor(name: string): ToolAnnotations {
  const title = name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (READ_ONLY.has(name)) return { title, readOnlyHint: true, openWorldHint: false };
  return { title, readOnlyHint: false, destructiveHint: !NOT_DESTRUCTIVE.has(name), idempotentHint: IDEMPOTENT.has(name), openWorldHint: false };
}

export interface ServerDeps {
  live: LiveAdapter;
  registry: M4lRegistry;
  bridge: Bridge;
  changes: ChangeTracker;
  version: string;
  log: (...a: unknown[]) => void;
  /** where browser items of the User Library live on disk */
  userLibrary?: string;
  /** only the tools that read are offered */
  readOnly?: boolean;
  /** the installed extension's temp and storage folders, the only places Live imports audio files from; none while developing */
  ownFolders?: string[];
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, bigintSafe) }] });
const fail = (e: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: e instanceof BridgeError ? e.message : explain(e) }] });
/** A bridge breakpoint, [time, value] or [time, value, x1, y1, x2, y2], in the shape set_clip_automation takes. */
const toPoint = ([time, value, x1, y1, x2, y2]: number[]) => (x1 === undefined ? { time, value } : { time, value, curve: { x1, y1, x2, y2 } });
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
  const server = new McpServer(
    { name: "live-mcp", version: deps.version },
    {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      instructions: deps.readOnly ? `${INSTRUCTIONS}\n${READ_ONLY_NOTE}` : INSTRUCTIONS,
    },
  );
  // Every tool gets its title and hints from annotationsFor, so none can be registered without them.
  const register = server.registerTool.bind(server);
  // In read-only mode a tool that changes anything is not offered at all.
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: { annotations?: ToolAnnotations }, cb: unknown) =>
    deps.readOnly && !READ_ONLY.has(name) ? undefined : register(name, { ...config, annotations: { ...annotationsFor(name), ...config.annotations } } as never, cb as never);

  const m4lFor = (deviceAddress: string): M4lDevice | undefined => registry.match(live.device(deviceAddress).parameters.map((p) => p.name));

  const overview = async () => {
    const song = live.song;
    const tracks = await withImplicitArm(live.tracks());
    for (const t of tracks) for (const d of t.devices) annotateDevice(d);
    return { tempo: song.tempo, scenes: song.scenes.length, tracks };
  };
  /**
   * Adds Live's implicit arm (the selected MIDI track records while no MIDI track is armed) from the bridge, which
   * alone can read it; without the bridge, or if it is slow, the tracks come back as they are.
   */
  const withImplicitArm = async <T extends TrackInfo>(tracks: T[]): Promise<T[]> => {
    let timer: Parameters<typeof clearTimeout>[0];
    const arms = await Promise.race([
      bridge.call<{ index: number; implicit_arm: boolean }[]>("arms").catch(() => undefined),
      new Promise<undefined>((r) => (timer = setTimeout(r, 1500))),
    ]).finally(() => clearTimeout(timer));
    if (!arms) return tracks;
    const regular = live.song.tracks.map((t) => live.id(t));
    for (const a of arms) {
      const info = tracks.find((t) => t.id === regular[a.index]);
      if (info && info.arm !== undefined) info.implicitArm = a.implicit_arm;
    }
    return tracks;
  };

  const arrangementIds = () => new Map(live.song.tracks.map((t) => [live.id(t), new Set(t.arrangementClips.map((c) => live.id(c)))]));
  /** What a take did: the clips it added per track, which tracks it was not meant for, and the clips that went. */
  const takeReport = () => {
    const take = takes.get(live);
    if (!take) return undefined;
    const { tracks, before } = take;
    const added: { track: string; clip: string; id: string; start: number; length: number; notes?: number }[] = [];
    const replaced: { track: string; id: string }[] = [];
    live.song.tracks.forEach((t, i) => {
      const was = before.get(live.id(t)) ?? new Set<string>();
      const now = t.arrangementClips;
      for (const c of now) {
        if (was.has(live.id(c))) continue;
        const info = live.clipInfo(c, `t${i}/a${now.indexOf(c)}`);
        added.push({ track: t.name, clip: info.address, id: info.id, start: c.startTime, length: info.length, ...(info.notes !== undefined ? { notes: info.notes } : {}) });
      }
      const nowIds = new Set(now.map((c) => live.id(c)));
      for (const id of was) if (!nowIds.has(id)) replaced.push({ track: t.name, id });
    });
    const warnings: string[] = [];
    const meant = new Set(tracks);
    for (const a of added) {
      const t = live.song.tracks.find((x) => x.name === a.track);
      if (t && !meant.has(live.id(t))) warnings.push(`${a.track} got a clip although the take was not meant for it`);
      if (a.notes === 0) warnings.push(`${a.clip} on ${a.track} has no notes`);
    }
    if (!added.length) warnings.push("the take added no clip");
    return { added, replaced, ...(warnings.length ? { warnings } : {}) };
  };
  const annotateDevice = (d: { address: string; kind: string; chains?: { devices: { address: string; kind: string }[] }[]; m4l?: string }) => {
    const m = m4lFor(d.address);
    if (m) d.kind = "Max for Live: " + path.basename(m.file, ".amxd");
    for (const c of d.chains ?? []) for (const dd of c.devices) annotateDevice(dd);
  };

  const viaBridge = " Needs the LiveRemote bridge (see get_capabilities).";

  /** Names a new clip and writes its notes in one step; if that fails, the empty clip is removed again. */
  const fillOrRemove = async (clip: { name: string }, address: string, fill: () => void) => {
    try {
      live.context.withinTransaction(fill);
    } catch (e) {
      await live.deleteClips([address]).catch(() => {});
      throw e;
    }
  };

  /** Starts every step synchronously inside one transaction, so Live keeps them as one undo step. */
  const inOneStep = (steps: (() => Promise<unknown>)[]) => live.context.withinTransaction(() => Promise.all(steps.map((step) => step())));
  /**
   * Live finds an object's position when a delete is sent and deletes at that position once the earlier deletes are
   * done, so deletes sent together go last-first: none of them then shifts the one after it.
   */
  const lastFirst = <T>(items: T[], position: (item: T) => number) => [...items].sort((a, b) => position(b) - position(a));

  /**
   * A Max for Live author can mark a parameter "[ask first]" (a Pull, Push or Store action, say). Changing it to
   * anything but its default needs userAsked: true; otherwise the whole call is refused, so nothing half happens.
   * value undefined means any change (set_parameter_display), which is refused as well.
   */
  const refuseUnasked = async (changes: { address: string; value?: number; userAsked?: boolean }[]) => {
    // Until the .amxd files have arrived through the bridge the marks are unknown; wait for them rather than let a
    // marked parameter through in the first seconds after Live starts.
    await registry.ready();
    // Reading them can fail halfway (a timeout, Live busy). While the bridge answers, the marks can still come, so a
    // device the registry does not know may be a marked one: hold its changes rather than guess. Without a bridge at
    // all they can never come, and then the guard cannot help.
    const unsure = registry.via === "bridge" && !registry.loaded && (await bridge.ping());
    const refused: string[] = [];
    const unknown: string[] = [];
    for (const c of changes) {
      if (c.userAsked) continue;
      const p = live.parameter(c.address);
      const device = p.parent;
      if (!(device instanceof Device)) continue;
      const deviceAddress = live.id(device);
      const index = device.parameters.indexOf(p);
      const known = m4lFor(deviceAddress);
      if (!known && unsure) unknown.push(c.address);
      const m = known?.parameters[index];
      if (!m?.askFirst) continue;
      const info = live.deviceParameters(deviceAddress)[index];
      if (c.value !== undefined && c.value === info?.default) continue;
      refused.push(`${m.longName} (${c.address})${m.help ? `: "${m.help}"` : ""}`);
    }
    if (unknown.length)
      throw new LiveError(
        `Nothing was changed. The Max for Live files that say which parameters wait for the user have not all been read yet (${registry.errors.join("; ") || "still reading"}), so ${unknown.join(", ")} cannot be checked. Try again in a few seconds; if it keeps failing, tell the user.`,
      );
    if (refused.length)
      throw new LiveError(
        `Nothing was changed. The device's author marked ${refused.join("; ")} as changed only when the user asks. Do not choose it on your own: ask the user, and repeat the call with userAsked: true on that change only if they asked for it in so many words.`,
      );
  };
  const capabilityState = async () => ({ bridgeReachable: await bridge.ping(), knownDevices: registry.files().length, amxdVia: registry.via, readOnly: deps.readOnly });

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
        "All parameters of a device: address, name, range, choices, current value. For recognised Max for Live devices also the long name, unit and help text, the device's own description (m4l.about: read it first, it is the author's word on how to drive the device), and the controls Live does not expose with the parameters that reach the same thing (m4l.notInLive). With display=true (needs the bridge) also the value as Live shows it, e.g. \"-12.0 dB\". Max for Live short names may repeat: address by index. A large device answers with a lot of text: narrow it with query, or leave out the help texts with help=false.",
      inputSchema: {
        device: address,
        values: z.boolean().default(true).describe("Include current values"),
        display: z.boolean().default(false).describe("Include Live's display strings via the bridge (built-in device units)"),
        query: z.string().optional().describe("Only parameters whose name or long name contains this (case-insensitive)"),
        help: z.boolean().default(true).describe("Include the help texts of Max for Live parameters"),
      },
    },
    guarded(async ({ device, values, display, query, help }) => {
      const d = live.device(device);
      const infos = live.deviceParameters(device);
      if (values) {
        const vals = await live.readValues(d.parameters);
        infos.forEach((p, i) => (p.value = vals[i]));
      }
      const m4l = m4lFor(device);
      const rows = infos.map((p, i) => compactParam(p, m4l?.parameters[i], help));
      if (display) {
        const strs = await bridge.call<{ index: number; str: string }[]>("param_strs", bridgeDeviceArgs(live, device));
        for (const s of strs) if (rows[s.index]) rows[s.index].display = s.str;
      }
      const q = query?.toLowerCase();
      const matches = (text: unknown) => !q || (typeof text === "string" && text.toLowerCase().includes(q));
      const out: Record<string, unknown> = { device, name: d.name };
      if (m4l) {
        const hidden = notInLive(m4l, device).filter((h) => matches(h.name) || h.seeInstead?.some(matches));
        const askFirst = m4l.parameters.flatMap((p, i) => (p.askFirst ? [`${device}/p${i} ${p.longName}`] : []));
        out.m4l = stripUndefined({
          file: m4l.file,
          frozen: m4l.frozen,
          about: m4l.description,
          askFirst: askFirst.length ? { parameters: askFirst, rule: "change these only when the user asks for it; set_parameters refuses them otherwise" } : undefined,
          notInLive: hidden.length ? hidden : undefined,
        });
      }
      out.parameters = q ? rows.filter((r) => matches(r.name) || matches(r.longName)) : rows;
      return out;
    }),
  );

  server.registerTool(
    "find_parameters",
    {
      description: "Find parameters by name across the set (case-insensitive substring of the short name, or of the long name for recognised Max for Live devices). Returns addresses to use with get_parameters/set_parameters, with range, choices and, for Max for Live devices, the help text.",
      inputSchema: { query: z.string().min(1), device: address.optional().describe("Limit to one device") },
    },
    guarded(({ query, device }) => {
      const q = query.toLowerCase();
      const hits: unknown[] = [];
      const search = (deviceAddress: string) => {
        const d = live.device(deviceAddress);
        const m4l = m4lFor(deviceAddress);
        const infos = live.deviceParameters(deviceAddress);
        infos.forEach((p, i) => {
          const long = m4l?.parameters[i]?.longName;
          if (p.name.toLowerCase().includes(q) || long?.toLowerCase().includes(q)) hits.push({ ...compactParam(p, m4l?.parameters[i]), device: d.name });
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
          if (m)
            for (const h of notInLive(m, a))
              if (h.name.toLowerCase().includes(q)) hidden.push(`${h.name} (in ${live.device(a).name}, ${a})${h.seeInstead ? `, reached instead through ${h.seeInstead.join(", ")}` : ""}`);
        }
        if (hidden.length) out.note = `no parameter in Live matches, but the Max for Live device has these controls that Live does not expose (buttons and stored data cannot be reached through any API): ${hidden.join("; ")}`;
      }
      return out;
    }),
  );

  server.registerTool(
    "get_parameters",
    { description: "Current values of parameters by address (device parameters, or track mixer: t0/vol, t0/pan, t0/send0). An address that is not a parameter gets an error of its own; the others are still read.", inputSchema: { addresses: z.array(address).min(1) } },
    guarded(async ({ addresses }) => {
      const found = addresses.map((a) => {
        try {
          return { address: a, param: live.parameter(a) };
        } catch (e) {
          return { address: a, error: explain(e) };
        }
      });
      const params = found.flatMap((f) => (f.param ? [f.param] : []));
      if (!params.length) throw new LiveError(found.map((f) => f.error).join("; "));
      const vals = await live.readValues(params);
      let i = 0;
      return found.map((f) => (f.param ? { address: f.address, name: f.param.name, value: vals[i++], min: f.param.min, max: f.param.max } : { address: f.address, error: f.error }));
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
      description: "Set one or more parameters in a single undo step. Values are in Live's internal units, within the min..max that list_parameters reports (quantized: the index of the choice). Every value is checked against its range first; if one is wrong, nothing is changed. Returns before/after per parameter. All changes in one call start at the same time, in no guaranteed order: when one parameter decides what others mean (a step or page selector, a mode), set it in a call of its own first. A parameter its device's author marked askFirst is refused unless the user asked for that change and the change says userAsked: true.",
      inputSchema: {
        changes: z
          .array(
            z.object({
              address,
              value: z.number(),
              userAsked: z.boolean().optional().describe("Only for a parameter marked askFirst: true when the user asked for this very change in so many words"),
            }),
          )
          .min(1),
      },
    },
    guarded(async ({ changes }) => {
      await refuseUnasked(changes);
      return live.setValues(changes.map(({ address, value }) => ({ address, value })));
    }),
  );

  server.registerTool(
    "set_parameter_display",
    {
      description:
        'Set one parameter by the value as Live displays it: "-6 dB", "440 Hz", "250 ms", "50 %", "C3", or a choice name. Live finds the internal value for it (bisection inside Live). Returns the resulting display string and how far it is from the target.' +
        viaBridge,
      inputSchema: {
        parameter: address.describe("A device parameter address (track/dN/pM)"),
        target: z.string().min(1),
        userAsked: z.boolean().optional().describe("Only for a parameter marked askFirst: true when the user asked for this very change"),
      },
    },
    guarded(async ({ parameter, target, userAsked }) => {
      await refuseUnasked([{ address: parameter, userAsked }]);
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
    guarded(async ({ track, name, mute, solo, arm }) => {
      const t = live.track(track);
      if (name !== undefined) t.name = name;
      if (mute !== undefined) t.mute = mute;
      if (solo !== undefined) t.solo = solo;
      if (arm !== undefined) t.arm = arm;
      return (await withImplicitArm([live.trackInfo(t, track)]))[0];
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
      description: 'List Live\'s browser: the roots when path is empty, else the children of a path such as "user_library/Presets/Instruments/External Instrument" or "Places/<folder>". The roots are Live\'s browser categories (sounds, drums, instruments, audio_effects, midi_effects, max_for_live, plugins, clips, samples, packs, user_library, current_project) and Places. Loadable items can be given to load_browser_item; it finds items by name under Places and every root but packs, samples, clips and current_project.' + viaBridge,
      inputSchema: { path: z.string().default("") },
    },
    guarded(({ path }) => bridge.call("browser", [path])),
  );

  server.registerTool(
    "load_browser_item",
    {
      description: "Load any loadable browser item onto a track by name: a saved preset (\"My Synth.adv\" keeps everything it was saved with, including an External Instrument's MIDI To / Audio From), a Max for Live device (\"My Device.amxd\"), a plug-in or a built-in device. Live places it after the track's selected device, or last, and selects the track while doing so. The first match across the browser roots wins; use browse to see what exists. A MIDI file (.mid) does not load this way: use import_midi_file." + viaBridge,
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
    {
      description: "Delete one device (device) or several (devices) from their tracks or chains, as one undo step. Every address is checked first; if one is wrong, nothing is deleted.",
      inputSchema: { device: address.optional(), devices: z.array(address).optional() },
    },
    guarded(async ({ device, devices }) => {
      // The same device can come under two addresses (t0/d0 and its #id); it is deleted once.
      const all = [...new Map(unique(listOf(device, devices, "device")).map((a) => live.locateDevice(a)).map((f) => [live.id(f.device), f] as const)).values()];
      // A device inside a rack that is deleted too goes with the rack; deleting it as well would fail half way.
      const ids = new Set(all.map((f) => live.id(f.device)));
      const found = all.filter((f) => !live.deviceAncestors(f.device).some((d) => ids.has(live.id(d))));
      const deleted = found.map((f) => f.device.name);
      // Deepest first, so no delete moves the rack another one is inside; then last first within each chain.
      const depth = (f: (typeof found)[number]) => live.deviceAncestors(f.device).length;
      await inOneStep(lastFirst(found, (f) => depth(f) * 100_000 + f.index).map((f) => () => f.holder.deleteDevice(f.device)));
      return { deleted: deleted.length === 1 ? deleted[0] : deleted };
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
    {
      description: "Delete one track (track) or several (tracks), as one undo step. Every address is checked first; if one is wrong, nothing is deleted.",
      inputSchema: { track: address.optional(), tracks: z.array(address).optional() },
    },
    guarded(async ({ track, tracks }) => {
      const all = [...new Set(unique(listOf(track, tracks, "track")).map((a) => live.track(a)))];
      if (all.includes(live.song.mainTrack)) throw new LiveError("Nothing was deleted: the main track cannot be deleted");
      // A track inside a group that is deleted too goes with the group.
      const ids = new Set(all.map((t) => live.id(t)));
      const found = all.filter((t) => !live.groupAncestors(t).some((g) => ids.has(live.id(g))));
      const remaining = live.song.tracks.filter((t) => !found.includes(t) && !live.groupAncestors(t).some((g) => found.includes(g)));
      if (found.some((t) => live.song.tracks.includes(t)) && remaining.length === 0) throw new LiveError("Nothing was deleted: a set keeps at least one track");
      const deleted = found.map((t) => t.name);
      // Return tracks have places of their own, after every regular track.
      const position = (t: (typeof found)[number]) => (live.song.tracks.includes(t) ? live.song.tracks.indexOf(t) : 100_000 + live.song.returnTracks.indexOf(t));
      await inOneStep(lastFirst(found, position).map((t) => () => live.song.deleteTrack(t)));
      return { deleted: deleted.length === 1 ? deleted[0] : deleted };
    }),
  );

  // ---- through the bridge --------------------------------------------------------------------------------------

  server.registerTool(
    "transport",
    {
      description: "Transport status (playing, recording, tempo, position, loop, metronome, would_record: the tracks Live records on now) and actions: play, stop, continue, stop_all_clips, record, record_off, metronome_on/off, loop_on/off, back_to_arrangement. Live applies play/stop a moment later: call again without an action to confirm. Once a session clip has been fired on a track, that track ignores its arrangement clips until Back to Arrangement (arrangement_overridden is then true): to hear the arrangement, stop_all_clips or back_to_arrangement, then play.\n" +
        "record records into the arrangement: give tracks (the ones to record on; arm them first with set_track) and optionally start (beats). In one step Live MCP checks that exactly those tracks would record, puts Live's start marker at start and plays from it with the record button on; Live must be stopped first. If any other track would record (Live also records on the selected MIDI track while no MIDI track is armed), nothing happens and the answer says why. stop or record_off afterwards answers with what the take added and replaced." + viaBridge,
      inputSchema: {
        action: z.enum(["play", "stop", "continue", "stop_all_clips", "record", "record_off", "metronome_on", "metronome_off", "loop_on", "loop_off", "back_to_arrangement"]).optional(),
        tracks: z.array(address).optional().describe("record only: the tracks to record on, all of them; required with record"),
        start: z.number().min(0).optional().describe("record only: where the take starts, in beats; default Live's start marker, where play would start now"),
      },
    },
    guarded(async ({ action, tracks, start }) => {
      if (action !== "record") {
        if (tracks || start !== undefined) throw new LiveError("tracks and start go with action record only");
        const status = await bridge.call<Record<string, unknown>>("transport", [], action ? { action } : {});
        if (!takes.has(live) || (action !== "stop" && action !== "record_off")) return status;
        const report = takeReport();
        if (action === "stop") takes.delete(live);
        return { ...status, take: report };
      }
      if (!tracks?.length) throw new LiveError("record needs tracks: every track to record on (arm them first with set_track)");
      const chosen = tracks.map((a) => live.track(a));
      const indices = chosen.map((t, n) => {
        const i = live.song.tracks.indexOf(t);
        if (i < 0) throw new LiveError(`${tracks[n]} cannot record: only MIDI and audio tracks can`);
        return i;
      });
      const before = arrangementIds();
      const started = await bridge.call<Record<string, unknown>>("record", [indices], start !== undefined ? { start } : {});
      takes.set(live, { tracks: chosen.map((t) => live.id(t)), before });
      return started;
    }),
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
      let state: { index: number; is_playing: boolean; is_triggered: boolean; is_recording: boolean }[];
      try {
        state = await bridge.call("clips", [bridgeTrackIndex(live, track)]);
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
        return { track, name: t.name, clips, arrangement, note: "playing state needs the LiveRemote bridge: " + e.message };
      }
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

  // ---- MIDI files ----------------------------------------------------------------------------------------------

  /** A browser item's file, from the uri Live gives it: the User Library and folders added under Places. */
  const browserItemFile = async (item: string): Promise<string> => {
    const found = await bridge.call<{ uri: string } | null>("browser_uri", [item]);
    if (!found) throw new LiveError(`no item named "${item}" in Live's browser; use browse to see what exists, or give the file's path`);
    const file = uriToFile(found.uri, deps.userLibrary ?? path.join(process.env.HOME ?? "", "Music", "Ableton", "User Library"));
    if (!file) throw new LiveError(`"${item}" is not in the User Library or a folder under Places, so it is not a file this server can read; save it to the User Library first`);
    return file;
  };

  /** The file's bytes: read directly while developing, through the bridge when Live's file permissions forbid it. */
  const readMidi = async (file: string): Promise<Buffer> => {
    if (!/\.midi?$/i.test(file)) throw new LiveError(`${file} is not a MIDI file (.mid or .midi)`);
    try {
      return fs.readFileSync(file);
    } catch (e) {
      if (!isForbidden(e)) throw new LiveError(`cannot read ${file}: ${(e as Error).message}`);
    }
    return Buffer.from(await bridge.call<string>("midi_read", [file]), "base64");
  };

  server.registerTool(
    "import_midi_file",
    {
      description:
        "Read a MIDI file (.mid) and, given a track, put its notes into a new MIDI clip: in a session slot (slot) or the arrangement (start, in beats). Name the file by its path (file) or by its name in Live's browser (item, e.g. \"Bass line.mid\" in the User Library). Without track, only describes the file: tempo, meter, length and its parts. A file with several parts needs part (index or name), or part \"all\" to merge them. The clip is as long as the notes, rounded up to whole bars, unless length is given. The set's tempo is not changed. Reading the file through the browser or under Live's file permissions needs the LiveRemote bridge.",
      inputSchema: {
        file: z.string().optional().describe("Absolute path to the .mid file"),
        item: z.string().optional().describe("The file's name in Live's browser"),
        track: address.optional().describe("A MIDI track; leave out to only describe the file"),
        slot: z.number().int().min(0).optional(),
        start: z.number().min(0).optional().describe("Arrangement position in beats; give slot or start"),
        part: z.union([z.number().int().min(0), z.string()]).optional(),
        length: z.number().positive().optional().describe("Clip length in beats"),
        name: z.string().optional().describe("Clip name; default the part's name"),
      },
    },
    guarded(async ({ file, item, track, slot, start, part, length, name }) => {
      if (!file === !item) throw new LiveError("give file (a path) or item (a name in Live's browser), one of them");
      const where = file ?? (await browserItemFile(item!));
      if (file && !path.isAbsolute(file)) throw new LiveError(`file must be an absolute path, not "${file}"`);
      let midi;
      try {
        midi = parseMidi(await readMidi(where));
      } catch (e) {
        if (e instanceof LiveError || e instanceof BridgeError) throw e;
        throw new LiveError(`${where}: ${(e as Error).message}`);
      }
      const parts = midi.parts.map((p) => ({ index: p.index, name: p.name, channels: p.channels, notes: p.notes.length, pitches: p.notes.length ? p.notes.reduce(([lo, hi], n) => [Math.min(lo, n.pitch), Math.max(hi, n.pitch)], [127, 0]) : [] }));
      const about = { file: where, bpm: midi.bpm, timeSignature: midi.timeSignature, lengthBeats: midi.lengthBeats, parts };
      if (!track) return about;
      if (!midi.parts.length) throw new LiveError(`${where} has no notes`);
      let chosen = midi.parts;
      const wanted = typeof part === "string" && /^\d+$/.test(part) ? Number(part) : part;
      if (wanted === "all") chosen = midi.parts;
      else if (wanted !== undefined) chosen = midi.parts.filter((p) => p.index === wanted || p.name === part);
      else if (midi.parts.length > 1) throw new LiveError(`${where} has ${midi.parts.length} parts (${midi.parts.map((p) => `${p.index} "${p.name}"`).join(", ")}): give part, or part "all"`);
      if (!chosen.length) throw new LiveError(`no part ${JSON.stringify(part)} in ${where}; parts: ${midi.parts.map((p) => `${p.index} "${p.name}"`).join(", ")}`);
      const notes = chosen.flatMap((p) => p.notes).map((n) => ({ ...n, velocity: Math.min(127, Math.max(1, n.velocity)) }));
      const end = notes.reduce((e, n) => Math.max(e, n.startTime + n.duration), 0);
      const bar = midi.timeSignature ? (midi.timeSignature[0] * 4) / midi.timeSignature[1] : 4;
      const clipLength = length ?? Math.max(bar, Math.ceil(end / bar - 1e-9) * bar);
      const { clip, address: a } = await live.createMidiClip(track, { slot, start, length: clipLength });
      await fillOrRemove(clip, a, () => {
        clip.name = name ?? (chosen.length === 1 ? chosen[0].name : path.basename(where, path.extname(where)));
        clip.notes = notes;
      });
      const beyond = notes.filter((n) => n.startTime >= clipLength).length;
      const notes2 = [midi.bpm ? `the file is at ${midi.bpm} BPM; the set's tempo was not changed` : "", beyond ? `${beyond} notes start after the clip's end and do not play; give a longer length to hear them` : ""].filter(Boolean);
      return { ...live.clipInfo(clip, a), from: where, parts: chosen.map((p) => p.name), notesImported: notes.length, fileBpm: midi.bpm, note: notes2.length ? notes2.join("; ") : undefined };
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
        await fillOrRemove(clip, a, () => {
          if (name !== undefined) clip.name = name;
          if (notes) clip.notes = notes;
        });
      }
      return live.clipInfo(clip, a);
    }),
  );

  /**
   * Live imports audio only from the installed extension's own folders, and the extension may not read files elsewhere,
   * so a file from anywhere else comes over through the bridge into a folder of its own under the temp folder (the
   * name stays, as Live names the clip after it). Answers with the copy's path, or undefined when no copy is needed.
   * Live has made its own copy in the project by the time the clip exists, so the caller removes this one.
   */
  const stageAudio = async (file: string): Promise<string | undefined> => {
    const [temp] = deps.ownFolders ?? [];
    if (!temp || !path.isAbsolute(file) || deps.ownFolders!.some((d) => !path.relative(d, file).startsWith(".."))) return undefined;
    const dir = fs.mkdtempSync(path.join(temp, "import-"));
    const copy = path.join(dir, path.basename(file));
    try {
      const out = fs.openSync(copy, "w");
      try {
        for (let offset = 0, total = Infinity; offset < total; ) {
          const piece = await bridge.call<{ total: number; data: string }>("audio_read", [file, offset]);
          const bytes = Buffer.from(piece.data, "base64");
          if (!bytes.length && offset < piece.total) throw new LiveError(`${file} ended early`);
          fs.writeSync(out, bytes);
          offset += bytes.length;
          total = piece.total;
        }
      } finally {
        fs.closeSync(out);
      }
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (e instanceof BridgeError) {
        const old = e.message.includes("unknown command") ? " (this LiveRemote is older than the server; install the LiveRemote that came with it)" : "";
        throw new LiveError(`Live imports audio only from Live MCP's own folder, so the LiveRemote bridge copies ${file} there first, and that failed: ${e.message}${old}`);
      }
      throw e;
    }
    return copy;
  };

  server.registerTool(
    "create_audio_clip",
    {
      description: "Create an audio clip from a file on an audio track: in a session slot (slot) or in the arrangement (start, with optional length in beats). file is an absolute path; Live copies the file into the set's project folder. A warped clip follows the set's tempo from the tempo Live guesses for the file; warped: false plays it at its own speed. Answers with the clip's address and id (keep the #id for arrangement clips). Files outside Live MCP's own folder are read through the LiveRemote bridge.",
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
      let staged: string | undefined;
      const stage = async (f: string) => (staged = await stageAudio(f)) ?? f;
      try {
        const { clip, address: a } = await live.createAudioClip(track, { slot, start, length, file, warped, stage });
        return live.clipInfo(clip, a);
      } finally {
        if (staged) fs.rmSync(path.dirname(staged), { recursive: true, force: true });
      }
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
    {
      description: "Delete one session or arrangement clip (clip) or several (clips), as one undo step. Every address is checked first; if one is wrong, nothing is deleted.",
      inputSchema: { clip: clipAddress.optional(), clips: z.array(clipAddress).optional() },
    },
    guarded(async ({ clip, clips }) => {
      const deleted = await live.deleteClips(unique(listOf(clip, clips, "clip")));
      return { deleted: deleted.length === 1 ? deleted[0] : deleted };
    }),
  );

  // ---- listening ---------------------------------------------------------------------------------------------

  server.registerTool(
    "measure_audio",
    {
      description:
        "Render part of an audio track's arrangement and measure it: sample peak and RMS per channel in dBFS, integrated loudness in LUFS (ITU-R BS.1770), clipped samples, whether it is silent, and a coarse loudness curve (32 slices, dBFS). Live renders the audio of the track's clips before its effects; MIDI tracks, effects and the master cannot be rendered by any API. start and end are in beats.",
      inputSchema: { track: address, start: z.number().min(0).describe("Beats"), end: z.number().positive().describe("Beats; at most 5 minutes after start") },
    },
    guarded(async ({ track, start, end }) => {
      const t = live.track(track);
      if (!(t instanceof AudioTrack)) throw new LiveError(`${track} is not an audio track; Live can render only audio tracks, and only the audio of their clips before any effect`);
      if (end <= start) throw new LiveError("end must come after start");
      const seconds = ((end - start) * 60) / live.song.tempo;
      if (seconds > 300) throw new LiveError(`render at most 5 minutes at a time; ${Math.round(seconds)} s asked for`);
      let file: string;
      try {
        file = await live.context.resources.renderPreFxAudio(t, start, end);
      } catch (e) {
        throw new LiveError(`Live could not render ${track} from beat ${start} to ${end}: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        if (fs.statSync(file).size > 200 * 1024 * 1024) throw new LiveError("the rendered file is larger than 200 MB; measure a shorter range");
        return { track, from: start, to: end, ...measure(parseAudio(fs.readFileSync(file))), note: "the track's clips before its effects; null dBFS or LUFS means no signal at all (minus infinity), unless lufsNote says the range was too short" };
      } finally {
        fs.rm(file, { force: true }, () => {});
      }
    }),
  );

  // ---- clip automation (through the bridge; Live keeps no reachable envelope for arrangement clips) -------------

  const point = z.object({
    time: z.number().min(0).describe("Beats from the clip start"),
    value: z.number().describe("In the parameter's own units, within the min..max list_parameters reports"),
    curve: z
      .object({ x1: z.number().min(0).max(1), y1: z.number().min(0).max(1), x2: z.number().min(0).max(1), y2: z.number().min(0).max(1) })
      .optional()
      .describe("Bezier control points of the segment that starts here; leave out for a straight ramp"),
  });

  /** A session clip's bridge coordinates; arrangement clips have no envelope any API can reach. */
  const sessionClip = (clip: string) => {
    const found = live.locateClip(clip);
    if (!found.slot) throw new LiveError(`${found.address} is an arrangement clip; Live gives no API access to arrangement automation, only to the envelopes of session clips`);
    return { ...found, trackIndex: bridgeTrackIndex(live, live.id(found.track)), slotIndex: found.track.clipSlots.indexOf(found.slot) };
  };

  server.registerTool(
    "get_clip_automation",
    {
      description:
        "The automation envelopes of a session clip: each automated parameter's address and its breakpoints in the shape set_clip_automation takes (time in beats, value, and curve when the segment after it is curved). For some built-in parameters Live reports values in the shown unit (Hz, linear gain) rather than the min..max of list_parameters; set_clip_automation takes values in min..max and Live converts them." +
        viaBridge,
      inputSchema: { clip: clipAddress },
    },
    guarded(async ({ clip }) => {
      const c = sessionClip(clip);
      const envelopes = await bridge.call<{ ref: never; name: string; events: number[][] }[]>("clip_envelopes", [c.trackIndex, c.slotIndex]);
      const trackAddress = live.trackAddress(c.track);
      return { clip: c.address, envelopes: envelopes.map((e) => ({ parameter: refAddress(trackAddress, e.ref), name: e.name, points: e.events.map(toPoint) })) };
    }),
  );

  server.registerTool(
    "set_clip_automation",
    {
      description:
        "Draw automation for one parameter in a session clip, as one undo step: breakpoints with time (beats from the clip start) and value (the parameter's own units, within the min..max list_parameters reports), joined by straight ramps or by a curve. The parameter must be on the clip's own track: a device parameter (t0/d1/p3, also inside racks) or its mixer (t0/vol, t0/pan, t0/send0). replace (default true) clears that parameter's envelope first. Arrangement automation is out of reach of every API in Live." +
        viaBridge,
      inputSchema: {
        clip: clipAddress,
        parameter: address,
        points: z.array(point).min(1),
        replace: z.boolean().default(true),
        userAsked: z.boolean().optional().describe("Only for a parameter marked askFirst: true when the user asked for this very automation"),
      },
    },
    guarded(async ({ clip, parameter, points, replace, userAsked }) => {
      const c = sessionClip(clip);
      const { track, ref } = live.parameterRef(parameter);
      if (live.id(track) !== live.id(c.track)) throw new LiveError(`${parameter} is on another track than ${c.address}; a clip automates only its own track's devices and mixer`);
      await refuseUnasked([{ address: parameter, userAsked }]);
      const p = live.parameter(parameter);
      const bad = points.filter((pt) => pt.value < p.min || pt.value > p.max);
      if (bad.length) throw new LiveError(`values must lie within ${p.min}..${p.max} for ${p.name}; not ${bad.map((b) => b.value).join(", ")}`);
      const info = live.clipInfo(c.clip, c.address);
      const end = Math.max(info.length, info.loopEnd ?? 0);
      const late = points.filter((pt) => pt.time > end);
      if (late.length) throw new LiveError(`times must lie within the clip, 0..${end} beats; not ${late.map((l) => l.time).join(", ")}`);
      const events = [...points].sort((a, b) => a.time - b.time).map((pt) => (pt.curve ? [pt.time, pt.value, pt.curve.x1, pt.curve.y1, pt.curve.x2, pt.curve.y2] : [pt.time, pt.value]));
      const result = await bridge.call<{ name: string; events: number[][] }>("set_clip_envelope", [c.trackIndex, c.slotIndex, ref, events], { replace });
      // Only the points just written count: with replace false the envelope also holds older ones.
      const converted = events.some(([time, value]) => result.events.some((e) => Math.abs(e[0] - time) < 1e-6 && Math.abs(e[1] - value) > 1e-6));
      return {
        clip: c.address, parameter, name: result.name, points: result.events.length,
        ...(converted && { note: `Live stores ${p.name} in its own unit (such as Hz or linear gain); get_clip_automation shows those values, set_clip_automation still takes ${p.min}..${p.max}` }),
      };
    }),
  );

  server.registerTool(
    "clear_clip_automation",
    {
      description: "Remove the automation of one parameter (parameter) or of every parameter in a session clip, as one undo step." + viaBridge,
      inputSchema: { clip: clipAddress, parameter: address.optional() },
    },
    guarded(async ({ clip, parameter }) => {
      const c = sessionClip(clip);
      let ref: unknown = null;
      if (parameter) {
        const found = live.parameterRef(parameter);
        if (live.id(found.track) !== live.id(c.track)) throw new LiveError(`${parameter} is on another track than ${c.address}`);
        ref = found.ref;
      }
      return { clip: c.address, cleared: await bridge.call("clear_clip_envelope", [c.trackIndex, c.slotIndex], ref ? { ref } : {}) };
    }),
  );

  server.registerTool(
    "fire",
    {
      description: "Launch a scene (scene only), a session clip (track + clip slot index), or stop a track's clips (track only)." + viaBridge,
      inputSchema: { track: address.optional(), clip: z.number().int().min(0).optional(), scene: z.number().int().min(0).optional() },
    },
    guarded(({ track, clip, scene }) => {
      if (track && scene !== undefined) throw new LiveError("give track and clip (the slot index) to launch a clip, or scene alone to launch a scene; track and scene together are not a target");
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

/**
 * The take in progress per Live: the tracks it was meant for and every track's arrangement clips when it started, by
 * id. It lives outside createServer because the HTTP transport makes a server per request, so record and stop meet
 * different servers.
 */
const takes = new WeakMap<LiveAdapter, { tracks: string[]; before: Map<string, Set<string>> }>();

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

/**
 * Controls a Max for Live device keeps away from Live: hidden buttons (invisible 2) and stored-only data (invisible 1).
 * No API reaches them, but a device often edits the same thing through visible parameters named alike ("Osc 1 Table
 * Data" is edited through "Osc 1 Table Step", "Osc 1 Table Wave" …), so those are listed as seeInstead.
 */
export function notInLive(m: M4lDevice, deviceAddress: string): { name: string; seeInstead?: string[] }[] {
  return m.all
    .filter((p) => p.invisible !== 0)
    .map((p) => {
      const words = p.longName.split(" ");
      const prefix = words.slice(0, -1).join(" ");
      const related = words.length > 1 && prefix.length >= 3
        ? m.parameters.flatMap((q, i) => (q.longName.startsWith(prefix + " ") ? [`${deviceAddress}/p${i} ${q.longName}`] : []))
        : [];
      return related.length ? { name: p.longName, seeInstead: related } : { name: p.longName };
    });
}

/** The file behind a browser item's uri: the User Library or a folder under Places; undefined for anything else. */
export function uriToFile(uri: string, userLibrary: string): string | undefined {
  const [where, rest = ""] = uri.split("#");
  let parts: string[];
  let folder: string;
  try {
    parts = rest.split(":").map(decodeURIComponent);
    folder = where.startsWith("userfolder:") ? decodeURIComponent(where.slice("userfolder:".length)) : "";
  } catch {
    return undefined;
  }
  if (parts.some((p) => p === ".." || p.includes("/../"))) return undefined;
  if (where === "query:UserLibrary") return path.join(userLibrary, ...parts);
  if (folder) return path.join(folder, ...parts);
  return undefined;
}

/** Our address for a parameter ref LiveRemote reports (see cmd_clip_envelopes). */
export function refAddress(trackAddress: string, ref: { devices?: number[]; param?: number; mixer?: string; index?: number } | null): string | undefined {
  if (!ref) return undefined;
  if (ref.mixer === "volume") return `${trackAddress}/vol`;
  if (ref.mixer === "panning") return `${trackAddress}/pan`;
  if (ref.mixer === "send") return `${trackAddress}/send${ref.index}`;
  const segs = (ref.devices ?? []).map((n, i) => (i % 2 === 0 ? `d${n}` : `c${n}`));
  return `${trackAddress}/${segs.join("/")}/p${ref.param}`;
}

/** One address or a list of them, as a list; at least one. */
function listOf(one: string | undefined, many: string[] | undefined, what: string): string[] {
  const all = [...(one ? [one] : []), ...(many ?? [])];
  if (all.length === 0) throw new LiveError(`give ${what} or ${what}s`);
  return all;
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function compactParam(p: ParameterInfo, m?: M4lParameter, help = true): Record<string, unknown> {
  const out: Record<string, unknown> = { address: p.address, name: p.name };
  if (m && m.longName !== p.name) out.longName = m.longName;
  if (p.value !== undefined) out.value = p.value;
  out.min = p.min;
  out.max = p.max;
  if (m?.unit) out.unit = m.unit;
  if (p.items) out.items = p.items;
  if (help && m?.help) out.help = m.help;
  if (m?.askFirst) out.askFirst = true;
  return out;
}
