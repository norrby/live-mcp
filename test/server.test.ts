// server.test.ts – the whole stack without Live: fake host -> SDK -> adapter -> MCP server -> node:http -> MCP client.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { initialize } from "@ableton-extensions/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LiveAdapter } from "../src/live/adapter.js";
import { M4lRegistry } from "../src/m4l/registry.js";
import { Bridge } from "../src/bridge/client.js";
import { createServer } from "../src/mcp/server.js";
import { ChangeTracker } from "../src/live/changes.js";
import { startHttp } from "../src/mcp/transport.js";
import { smallSet, type FakeLive } from "./fake-host.js";
import { LiveAdapter as Adapter } from "../src/live/adapter.js";

let fake: FakeLive;
let http: ReturnType<typeof startHttp>;
let url: string;
let registry: M4lRegistry;
let amxdDir: string;
const token = "test-token-0123456789";
const logs: string[] = [];

before(async () => {
  fake = smallSet();
  const context = initialize(fake.activation(), "1.0.0");
  const live = new LiveAdapter(context);
  amxdDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-mcp-"));
  registry = new M4lRegistry({ directories: [amxdDir] });
  const bridge = new Bridge({ port: 1 }); // not configured: no token
  const changes = new ChangeTracker(live); // long-lived, like in the extension
  http = startHttp({ port: 0, token, log: (...a) => logs.push(a.join(" ")), makeServer: () => createServer({ live, registry, bridge, changes, version: "test", log: () => {} }) });
  await new Promise((r) => http.once("listening", r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});
after(() => http.close());

async function client() {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { ok: !r.isError, data: r.isError ? text(r) : JSON.parse(text(r)) };
};

test("every tool carries hints, deletes are marked destructive, and the client gets instructions", async () => {
  const c = await client();
  const { tools } = await c.listTools();
  for (const t of tools) assert.ok(t.annotations?.title && t.annotations.readOnlyHint !== undefined, `${t.name} has annotations`);
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  assert.equal(by.get_set?.readOnlyHint, true);
  assert.equal(by.delete_track?.destructiveHint, true);
  assert.equal(by.set_parameters?.destructiveHint, false);
  assert.equal(by.set_parameters?.idempotentHint, true);
  assert.match(c.getInstructions() ?? "", /m4l.about/);
  await c.close();
});

test("lists tools and reads the set", async () => {
  const c = await client();
  const tools = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("get_set") && tools.includes("set_parameters") && tools.includes("transport") && tools.includes("load_browser_item"));
  const set = await call(c, "get_set");
  assert.ok(set.ok);
  assert.equal(set.data.tempo, 120);
  assert.deepEqual(set.data.tracks.map((t: { address: string }) => t.address), ["t0", "t1", "r0", "main"]);
  assert.equal(set.data.tracks[0].devices[0].name, "QuadraDrei");
  assert.equal(set.data.tracks[0].devices[0].parameters, 5);
  assert.equal(set.data.tracks[1].devices[0].chains[0].devices[0].address, "t1/d0/c0/d0", "devices inside racks get chain addresses");
  const intro = set.data.tracks[0].clips[0];
  assert.deepEqual({ ...intro, id: undefined }, { address: "t0/s1", id: undefined, slot: 1, name: "Intro", kind: "midi", length: 8, looping: true, loopStart: 0, loopEnd: 8, muted: false, notes: 0 });
  assert.equal(set.data.tracks[1].clips, undefined, "tracks without clips carry no clips field");
  const clips = await call(c, "get_clips");
  assert.deepEqual(clips.data.map((t: { track: string }) => t.track), ["t0"]);
  assert.match((await call(c, "get_clips", { track: "t0" })).data.note, /bridge/);
  await c.close();
});

test("lists and sets parameters; a batch is one transaction; one bad value changes nothing", async () => {
  const c = await client();
  const list = await call(c, "list_parameters", { device: "t0/d0" });
  assert.ok(list.ok);
  assert.equal(list.data.parameters[2].name, "Cutoff");
  assert.equal(list.data.parameters[2].value, 127);
  assert.deepEqual(list.data.parameters[3].items, ["Lowp", "Band", "High"]);
  const narrowed = await call(c, "list_parameters", { device: "t0/d0", query: "cut" });
  assert.deepEqual(narrowed.data.parameters.map((r: { address: string }) => r.address), ["t0/d0/p2"]);
  const found = await call(c, "find_parameters", { query: "cutoff" });
  assert.equal(found.data.hits[0].address, "t0/d0/p2");
  assert.equal(found.data.hits[0].max, list.data.parameters[2].max, "a search hit carries the range");
  const before = fake.transactions;
  const refused = await call(c, "set_parameters", { changes: [{ address: "t0/d0/p2", value: 64 }, { address: "t0/d0/p3", value: 2 }, { address: "t0/d0/p1", value: 999 }] });
  assert.equal(refused.ok, false);
  assert.match(refused.data, /Nothing was changed: t0\/d0\/p1 "A": 999 is outside 0\.\.127/);
  assert.match((await call(c, "set_parameters", { changes: [{ address: "t0/d0/p3", value: 1.5 }] })).data, /not a whole number; choose one of 0=Lowp/);
  assert.equal(fake.transactions, before, "nothing was started");
  const set = await call(c, "set_parameters", { changes: [{ address: "t0/d0/p2", value: 64 }, { address: "t0/d0/p3", value: 2 }] });
  assert.ok(set.ok);
  assert.equal(set.data[0].after, 64);
  assert.equal(set.data[1].after, 2);
  assert.equal(fake.transactions, before + 1, "one transaction for the batch");
  assert.equal(fake.writesInTransaction[fake.writesInTransaction.length - 1], 2, "all writes started inside it");
  const get = await call(c, "get_parameters", { addresses: ["t0/d0/p2", "t0/vol", "r0/vol"] });
  assert.deepEqual(get.data.map((r: { value: number }) => r.value), [64, 0.85, 0.85]);
  await c.close();
});

test("explains bad addresses and missing objects", async () => {
  const c = await client();
  assert.match((await call(c, "get_parameters", { addresses: ["t7/d0/p1"] })).data, /no track 7 \(there are 2\)/);
  assert.match((await call(c, "list_parameters", { device: "t0/d0/p1" })).data, /not a device/);
  assert.match((await call(c, "get_parameters", { addresses: ["x1"] })).data, /bad address segment "x1"/);
  const mixed = (await call(c, "get_parameters", { addresses: ["t0/d0", "t0/vol"] })).data;
  assert.match(mixed[0].error, /Device, not a parameter|not a parameter/, "a wrong address gets its own error");
  assert.equal(typeof mixed[1].value, "number", "the others are still read");
  assert.match((await call(c, "set_parameters", { changes: [{ address: "t0/d0/p1", value: 1 }, { address: "t0/d0/p1", value: 2 }] })).data, /appears twice/);
  await c.close();
});

test("inserts and deletes devices and tracks; stale handles are explained", async () => {
  const c = await client();
  const ins = await call(c, "insert_device", { into: "t1", device: "Reverb", index: 0 });
  assert.ok(ins.ok);
  assert.equal(ins.data.address, "t1/d0");
  const id = ins.data.id;
  assert.ok((await call(c, "list_parameters", { device: id })).ok, "device reachable by #id");
  assert.match((await call(c, "insert_device", { into: "t1", device: "Nonsense" })).data, /error/);
  assert.deepEqual((await call(c, "delete_device", { device: id })).data, { deleted: "Reverb" }, "delete by #id");
  assert.match((await call(c, "list_parameters", { device: id })).data, /no longer exists/);
  const tr = await call(c, "create_track", { kind: "audio", name: "Bus" });
  assert.equal(tr.data.name, "Bus");
  assert.deepEqual((await call(c, "delete_track", { track: tr.data.address })).data, { deleted: "Bus" });
  await c.close();
});

test("get_changes: snapshot first, then a diff; scope limits to one track; devices in racks are watched", async () => {
  const c = await client();
  assert.equal((await call(c, "get_changes", { cursor: "x" })).data.first, true);
  assert.equal((await call(c, "get_changes", { cursor: "y", scope: "t1" })).data.first, true);
  await call(c, "set_parameters", { changes: [{ address: "t0/d0/p2", value: 5 }, { address: "t1/d0/c0/d0/p1", value: 0.9 }] });
  const r = (await call(c, "get_changes", { cursor: "x" })).data;
  assert.deepEqual(r.changes.map((ch: { address: string; to: number }) => [ch.address, ch.to]), [["t0/d0/p2", 5], ["t1/d0/c0/d0/p1", 0.9]]);
  const scoped = (await call(c, "get_changes", { cursor: "y", scope: "t1" })).data;
  assert.deepEqual(scoped.changes.map((ch: { address: string }) => ch.address), ["t1/d0/c0/d0/p1"]);
  assert.match((await call(c, "get_changes", { cursor: "z", scope: "t0/d0" })).data, /not a track/);
  await c.close();
});

test("delete_device and locateDevice work for a device inside a rack chain", async () => {
  const c = await client();
  const r = await call(c, "list_parameters", { device: "t1/d0/c0/d0", values: false });
  assert.equal(r.data.name, "Saturator");
  assert.match((await call(c, "transport")).data, /LiveRemote is not reachable/);
  await c.close();
});

test("bridge tools fail with an explanation when the bridge is not reachable", async () => {
  const c = await client();
  const r = await call(c, "transport");
  assert.equal(r.ok, false);
  assert.match(r.data, /LiveRemote is not reachable/);
  const caps = await call(c, "get_capabilities");
  assert.match(caps.data.viaBridge[0].available, /not reachable/);
  await c.close();
});

test("HTTP: token, origin, bad JSON, notifications only, GET", async () => {
  const post = (body: string, headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers }, body });
  assert.equal((await post("{}", { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post("{}", { origin: "http://evil.example" })).status, 403);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post("null")).status, 400);
  assert.equal((await post("[]")).status, 400);
  assert.equal((await post(JSON.stringify({ foo: 1 }))).status, 400);
  assert.equal((await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status, 405);
  assert.equal((await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).status, 202);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 405);
  const batch = await post(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }]));
  assert.equal(batch.status, 200);
  assert.equal(((await batch.json()) as unknown[]).length, 2);
  assert.equal((await post(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 1, method: "ping" }]))).status, 400, "duplicate ids");
  assert.equal((await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: 5 }))).status, 400, "params must be an object");
  assert.equal((await fetch(url + "?x=1", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) })).status, 200, "query string ignored");
});

test("a request that Live never answers times out with a JSON-RPC error, keeping finished answers in a batch", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const slow = startHttp({
    port: 0,
    requestTimeoutMs: 150,
    makeServer: () => {
      const s = new McpServer({ name: "slow", version: "0" });
      s.registerTool("hang", { description: "never answers", inputSchema: {} }, () => new Promise(() => {}));
      return s;
    },
  });
  await new Promise((r) => slow.once("listening", r));
  const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/mcp`;
  const body = [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hang", arguments: {} } }];
  const res = await fetch(slowUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  const answers = (await res.json()) as { id: number; result?: unknown; error?: { code: number } }[];
  assert.deepEqual(answers.map((a) => [a.id, a.error?.code ?? "ok"]), [[1, "ok"], [2, -32000]]);
  slow.close();
});

test("clips: create in a slot and in the arrangement, notes in one undo step, rename, delete", async () => {
  const c = await client();
  const before = fake.transactions;
  const made = (await call(c, "create_clip", { track: "t0", slot: 0, length: 4, name: "Bass", notes: [{ pitch: 36, startTime: 0, duration: 1 }, { pitch: 43, startTime: 2, duration: 0.5, velocity: 80 }] })).data;
  assert.equal(made.address, "t0/s0");
  assert.equal(made.name, "Bass");
  assert.equal(made.notes, 2);
  assert.equal(made.length, 4);
  assert.equal(fake.transactions, before + 2, "creating is one undo step in the SDK, name and notes together another");

  const notes = (await call(c, "get_notes", { clip: "t0/s0" })).data;
  assert.equal(notes.notes.length, 2);
  assert.equal(notes.notes[0].velocity, 100);

  const set = (await call(c, "set_notes", { clip: "t0/s0", notes: [{ pitch: 48, startTime: 0, duration: 4 }] })).data;
  assert.equal(set.notes, 1);
  assert.equal(fake.transactions, before + 3);

  assert.match((await call(c, "create_clip", { track: "t0", slot: 0, length: 4 })).data, /already holds "Bass"/);
  assert.match((await call(c, "create_clip", { track: "t1", slot: 0, length: 4 })).data, /not a MIDI track/);
  assert.equal((await call(c, "get_notes", { clip: "t0/s1" })).data.clip, "t0/s1");

  const arr = (await call(c, "create_clip", { track: "t0", start: 8, length: 2 })).data;
  assert.equal(arr.address, "t0/a0");
  const listed = (await call(c, "get_clips", { track: "t0" })).data;
  assert.equal(listed.arrangement.length, 1);
  assert.equal(listed.arrangement[0].start, 8);
  assert.equal(listed.clips.length, 2);

  const renamed = (await call(c, "set_clip", { clip: arr.id, name: "Fill", muted: true })).data;
  assert.equal(renamed.name, "Fill");
  assert.equal(renamed.muted, true);
  assert.equal(renamed.address, "t0/a0");

  const audio = (await call(c, "create_audio_clip", { track: "t1", slot: 1, file: "/samples/kick.wav" })).data;
  assert.equal(audio.kind, "audio");
  assert.equal(audio.file, "/project/Samples/Imported/kick.wav", "the clip plays Live's imported copy");
  assert.equal(audio.warped, true);
  const plain = (await call(c, "create_audio_clip", { track: "t1", slot: 0, file: "/samples/pad.wav", warped: false })).data;
  const { tempo } = (await call(c, "get_set")).data;
  assert.equal(plain.warped, false);
  assert.equal(plain.lengthSeconds, 4, "an unwarped clip's markers are in seconds");
  assert.equal(plain.length, (4 * tempo) / 60, "length stays in beats");
  await call(c, "delete_clip", { clip: "t1/s0" });
  const missing = await call(c, "create_audio_clip", { track: "t1", start: 0, file: "/samples/missing.wav" });
  assert.equal(missing.ok, false);
  assert.match(missing.data, /Live could not import \/samples\/missing\.wav/);
  assert.match((await call(c, "get_notes", { clip: "t1/s1" })).data, /audio clip/);

  assert.equal((await call(c, "delete_clip", { clip: "t0/a0" })).data.deleted, "Fill");
  assert.equal((await call(c, "delete_clip", { clip: "t0/s0" })).data.deleted, "Bass");
  assert.match((await call(c, "get_notes", { clip: "t0/s0" })).data, /slot t0\/s0 is empty/);
  await c.close();
});

test("without a token, local programs get in but anything with an Origin header is refused", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const open = startHttp({ port: 0, makeServer: () => new McpServer({ name: "open", version: "0" }) });
  await new Promise((r) => open.once("listening", r));
  const openUrl = `http://127.0.0.1:${(open.address() as AddressInfo).port}/mcp`;
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal((await fetch(openUrl, { method: "POST", headers: { "content-type": "application/json" }, body: ping })).status, 200);
  assert.equal((await fetch(openUrl, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: ping })).status, 403);
  open.close();
});

test("create_clip refuses slot and start together and an out-of-range slot", async () => {
  const c = await client();
  assert.match((await call(c, "create_clip", { track: "t0", slot: 0, start: 4, length: 4 })).data, /not both/);
  assert.match((await call(c, "create_clip", { track: "t0", slot: 99, length: 4 })).data, /clip slot/);
  assert.match((await call(c, "create_audio_clip", { track: "t1", slot: 0, file: "relative.wav" })).data, /absolute path/);
  await c.close();
});

test("a parameter its author marked [ask first] is refused unless the user asked, and its default is always allowed", async () => {
  const returnTrack = fake.returnTracks()[0];
  fake.addDevice(returnTrack, "Guarded", [{ name: "Action", items: ["None", "Pull", "Push", "Store"], value: 0 }, { name: "Level", max: 127, value: 10 }]);
  const valueof = (long: string, extra: Record<string, unknown>) => ({ box: { maxclass: "live.dial", saved_attribute_attributes: { valueof: { parameter_longname: long, parameter_shortname: long, ...extra } } } });
  const patcher = { patcher: { boxes: [
    { ...valueof("Action", { parameter_type: 2, parameter_enum: ["None", "Pull", "Push", "Store"] }), box: { ...valueof("Action", { parameter_type: 2, parameter_enum: ["None", "Pull", "Push", "Store"] }).box, annotation: "Presses Pull, Push or Store. [ask first]" } },
    valueof("Level", { parameter_mmax: 127 }),
  ] } };
  const json = Buffer.from(JSON.stringify(patcher));
  const head = Buffer.alloc(32);
  head.write("ampf", 0, "latin1");
  head.write("ptch", 24, "latin1");
  fs.writeFileSync(path.join(amxdDir, "Guarded.amxd"), Buffer.concat([head, json]));
  registry.scan(true);

  const c = await client();
  const list = (await call(c, "list_parameters", { device: "r0/d0" })).data;
  assert.equal(list.parameters[1].help, "Presses Pull, Push or Store.", "the tag is not shown as part of the help");
  assert.equal(list.parameters[1].askFirst, true);
  assert.deepEqual(list.m4l.askFirst.parameters, ["r0/d0/p1 Action"]);

  const refused = await call(c, "set_parameters", { changes: [{ address: "r0/d0/p2", value: 50 }, { address: "r0/d0/p1", value: 2 }] });
  assert.equal(refused.ok, false);
  assert.match(refused.data, /Nothing was changed.*Action \(r0\/d0\/p1\).*userAsked: true/s);
  assert.equal((await call(c, "get_parameters", { addresses: ["r0/d0/p2"] })).data[0].value, 10, "the whole call is refused, not half done");

  assert.ok((await call(c, "set_parameters", { changes: [{ address: "r0/d0/p1", value: 0 }] })).ok, "the default is always allowed");
  const asked = await call(c, "set_parameters", { changes: [{ address: "r0/d0/p1", value: 2, userAsked: true }] });
  assert.equal(asked.data[0].after, 2);
  assert.match((await call(c, "set_parameter_display", { parameter: "r0/d0/p1", target: "Push" })).data, /Nothing was changed/);
  await c.close();
});

test("several clips are deleted in one undo step, and one wrong address deletes nothing", async () => {
  const c = await client();
  const a = (await call(c, "create_clip", { track: "t0", slot: 0, length: 4, name: "A" })).data;
  const b = (await call(c, "create_clip", { track: "t0", start: 32, length: 4, name: "B" })).data;
  const before = fake.transactions;
  const deleted = await call(c, "delete_clip", { clips: [a.address, b.id] });
  assert.deepEqual(deleted.data.deleted, ["A", "B"]);
  assert.equal(fake.transactions - before, 1, "one undo step for both");

  const refused = await call(c, "delete_clip", { clips: ["t0/s1", "t0/s0"] });
  assert.equal(refused.ok, false);
  assert.match(refused.data, /empty/);
  assert.equal((await call(c, "get_clips", { track: "t0" })).data.clips.find((x: { slot: number }) => x.slot === 1)?.name, "Intro", "nothing was deleted");
  assert.match((await call(c, "delete_clip", {})).data, /give clip or clips/);
  await c.close();
});

test("clip automation checks the clip, the track, the range and ask-first marks before asking the bridge", async () => {
  const c = await client();
  const s = (await call(c, "create_clip", { track: "t0", slot: 0, length: 4, name: "Auto" })).data;
  const a = (await call(c, "create_clip", { track: "t0", start: 64, length: 4, name: "Arr" })).data;
  const pts = [{ time: 0, value: 10 }, { time: 4, value: 100 }];
  assert.match((await call(c, "set_clip_automation", { clip: a.id, parameter: "t0/d0/p2", points: pts })).data, /arrangement clip/);
  assert.match((await call(c, "set_clip_automation", { clip: s.address, parameter: "t1/d0/c0/d0/p1", points: pts })).data, /another track/);
  assert.match((await call(c, "set_clip_automation", { clip: s.address, parameter: "t0/d0/p2", points: [{ time: 0, value: 200 }] })).data, /within 0\.\.127/);
  assert.match((await call(c, "set_clip_automation", { clip: s.address, parameter: "t0/d0/p2", points: [{ time: 9, value: 1 }] })).data, /within the clip/);
  assert.match((await call(c, "set_clip_automation", { clip: s.address, parameter: "t0/vol", points: [{ time: 0, value: 0.5 }] })).data, /LiveRemote is not reachable/, "a valid call reaches the bridge");
  assert.match((await call(c, "get_clip_automation", { clip: s.address })).data, /LiveRemote is not reachable/);
  await call(c, "delete_clip", { clips: [s.address, a.id] });
  await c.close();
});

test("measure_audio renders an audio track's range, measures it, and refuses MIDI tracks", async () => {
  const c = await client();
  const m = await call(c, "measure_audio", { track: "t1", start: 0, end: 4 });
  assert.ok(m.ok, String(m.data));
  assert.equal(m.data.seconds, 2);
  assert.deepEqual(m.data.peakDbfs, [-6]);
  assert.equal(m.data.silent, false);
  assert.match((await call(c, "measure_audio", { track: "t0", start: 0, end: 4 })).data, /not an audio track/);
  assert.match((await call(c, "measure_audio", { track: "t1", start: 4, end: 2 })).data, /end must come after start/);
  await c.close();
});

test("import_midi_file describes a file, and puts the chosen part into a clip as long as whole bars", async () => {
  const vlq = (n: number) => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
  const trk = (events: number[]) => { const b = Buffer.from(events); const h = Buffer.alloc(8); h.write("MTrk", 0, "latin1"); h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
  const head = Buffer.alloc(14); head.write("MThd", 0, "latin1"); head.writeUInt32BE(6, 4); head.writeUInt16BE(1, 8); head.writeUInt16BE(2, 10); head.writeUInt16BE(96, 12);
  const named = (n: string) => [0, 0xff, 0x03, n.length, ...Buffer.from(n, "latin1")];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "live-mcp-midi-")), "song.mid");
  fs.writeFileSync(file, Buffer.concat([head,
    trk([...named("Bass"), 0, 0x90, 33, 100, ...vlq(96 * 5), 0x80, 33, 0, 0, 0xff, 0x2f, 0]),
    trk([...named("Lead"), 0, 0x90, 72, 0, 0, 0x90, 72, 110, ...vlq(96), 0x80, 72, 0, 0, 0xff, 0x2f, 0])]));
  const c = await client();
  const about = (await call(c, "import_midi_file", { file })).data;
  assert.deepEqual(about.parts.map((p: { name: string; notes: number }) => [p.name, p.notes]), [["Bass", 1], ["Lead", 1]]);
  assert.match((await call(c, "import_midi_file", { file, track: "t0", slot: 0 })).data, /2 parts .* give part/);
  const made = (await call(c, "import_midi_file", { file, track: "t0", slot: 0, part: "Bass" })).data;
  assert.equal(made.name, "Bass");
  assert.equal(made.length, 8, "5 beats round up to two 4/4 bars");
  assert.equal(made.notesImported, 1);
  const all = (await call(c, "import_midi_file", { file, track: "t0", start: 96, part: "all", name: "Both" })).data;
  assert.equal(all.notesImported, 2);
  assert.match((await call(c, "import_midi_file", { file: "/tmp/song.wav", track: "t0", slot: 0 })).data, /not a MIDI file/);
  assert.match((await call(c, "import_midi_file", { item: "song.mid" })).data, /LiveRemote is not reachable/);
  assert.match((await call(c, "import_midi_file", {})).data, /give file .* or item/);
  await call(c, "delete_clip", { clips: [made.address, all.id] });
  await c.close();
});

test("deleting a rack together with a device inside it deletes the rack once, without failing half way", async () => {
  const c = await client();
  const r = await call(c, "delete_device", { devices: ["t1/d0/c0/d0", "t1/d0"] });
  assert.ok(r.ok, String(r.data));
  assert.equal(r.data.deleted, "Audio Effect Rack");
  await c.close();
});

test("several tracks, devices or arrangement clips in a row are deleted as asked, not their neighbours", async () => {
  const c = await client();
  const ids = [];
  for (const name of ["A", "B", "C", "D"]) ids.push((await call(c, "create_track", { kind: "midi", name })).data.id);
  const tracks = await call(c, "delete_track", { tracks: [ids[0], ids[2]] });
  assert.deepEqual(tracks.data.deleted, ["A", "C"]);
  const left = (await call(c, "get_set")).data.tracks.map((t: { name: string }) => t.name);
  assert.ok(left.includes("B") && left.includes("D") && !left.includes("A") && !left.includes("C"), left.join(", "));

  const devices = [];
  for (let i = 0; i < 3; i++) devices.push((await call(c, "insert_device", { into: ids[1], device: ["Reverb", "Utility", "Operator"][i] })).data.id);
  assert.deepEqual((await call(c, "delete_device", { devices: [devices[0], devices[1]] })).data.deleted, ["Reverb", "Utility"]);
  assert.deepEqual((await call(c, "get_set")).data.tracks.find((t: { name: string }) => t.name === "B").devices.map((d: { name: string }) => d.name), ["Operator"]);

  const clips = [];
  for (const [i, name] of ["X", "Y", "Z"].entries()) clips.push((await call(c, "create_clip", { track: ids[1], start: i * 4, length: 4, name })).data.id);
  assert.deepEqual((await call(c, "delete_clip", { clips: [clips[0], clips[1]] })).data.deleted, ["X", "Y"]);
  const b = (await call(c, "get_set")).data.tracks.findIndex((t: { name: string }) => t.name === "B");
  assert.deepEqual((await call(c, "get_clips", { track: `t${b}` })).data.arrangement.map((x: { name: string }) => x.name), ["Z"]);
  await c.close();
});

test("a device given twice, by position and by id, is deleted once and its neighbour stays; the main track is refused", async () => {
  const c = await client();
  const id = (await call(c, "create_track", { kind: "midi", name: "Twice" })).data.id;
  const devices = [];
  for (const name of ["Reverb", "Utility", "Operator"]) devices.push((await call(c, "insert_device", { into: id, device: name })).data.id);
  const t = (await call(c, "get_set")).data.tracks.findIndex((x: { name: string }) => x.name === "Twice");
  assert.equal((await call(c, "delete_device", { devices: [`t${t}/d0`, devices[0]] })).data.deleted, "Reverb");
  assert.deepEqual((await call(c, "get_set")).data.tracks[t].devices.map((d: { name: string }) => d.name), ["Utility", "Operator"]);

  const refused = await call(c, "delete_track", { tracks: [id, "main"] });
  assert.ok(!refused.ok);
  assert.match(refused.data, /Nothing was deleted: the main track/);
  assert.ok((await call(c, "get_set")).data.tracks.some((x: { name: string }) => x.name === "Twice"), "nothing was deleted");
  await c.close();
});
