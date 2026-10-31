// record.test.ts – arrangement recording is checked and started by the bridge in one step; the server names the tracks
// for it, reports Live's implicit arm, and says afterwards what the take added. A stand-in LiveRemote answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { initialize } from "@ableton-extensions/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LiveAdapter } from "../src/live/adapter.js";
import { M4lRegistry } from "../src/m4l/registry.js";
import { Bridge } from "../src/bridge/client.js";
import { createServer } from "../src/mcp/server.js";
import { ChangeTracker } from "../src/live/changes.js";
import { smallSet } from "./fake-host.js";

test("record names its tracks to the bridge, and stop reports what the take added", async (t) => {
  const asked: { cmd: string; args: unknown[]; kwargs: Record<string, unknown> }[] = [];
  const fakeRemote = net.createServer((sock) => {
    sock.once("data", (line) => {
      const call = JSON.parse(String(line));
      asked.push(call);
      const result =
        call.cmd === "arms" ? [{ index: 0, implicit_arm: true }, { index: 1, implicit_arm: false }]
        : call.cmd === "record" ? { recording: ["1-MIDI"], start: call.kwargs.start, warnings: [] }
        : { is_playing: false, record_mode: false };
      sock.end(JSON.stringify({ ok: true, result }) + "\n");
    });
  });
  await new Promise<void>((r) => fakeRemote.listen(0, "127.0.0.1", r));
  t.after(() => fakeRemote.close());
  const live = new LiveAdapter(initialize(smallSet().activation(), "1.0.0"));
  const bridge = new Bridge({ port: (fakeRemote.address() as net.AddressInfo).port });
  const changes = new ChangeTracker(live);
  // Over HTTP every request gets a server of its own, so every call here does too: record and stop meet different ones.
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const server = createServer({ live, registry: new M4lRegistry({ directories: [] }), bridge, changes, version: "test", log: () => {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(b);
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    await c.close();
    let data: unknown = r.content[0].text;
    try {
      data = JSON.parse(r.content[0].text);
    } catch {
      // plain text error
    }
    return { ok: !r.isError, data: data as any };
  };

  const set = (await call("get_set")).data;
  assert.equal(set.tracks[0].implicitArm, true, "the selected MIDI track records although arm is false");
  assert.equal(set.tracks[1].implicitArm, false);

  assert.match((await call("transport", { action: "record" })).data, /record needs tracks/);
  assert.match((await call("transport", { action: "record", tracks: ["r0"] })).data, /only MIDI and audio tracks/);
  assert.match((await call("transport", { action: "play", tracks: ["t0"] })).data, /with action record only/);

  const started = await call("transport", { action: "record", tracks: ["t0"], start: 64 });
  assert.ok(started.ok, JSON.stringify(started.data));
  const rec = asked.find((x) => x.cmd === "record")!;
  assert.deepEqual([rec.args, rec.kwargs], [[[0]], { start: 64 }], "the bridge gets track indices and the start");

  // What Live would have recorded: two new clips on the track asked for, both still without notes.
  await call("create_clip", { track: "t0", start: 64, length: 4, name: "take" });
  await call("create_clip", { track: "t0", start: 72, length: 4, name: "stray" });
  const stopped = (await call("transport", { action: "stop" })).data;
  assert.deepEqual(stopped.take.added.map((x: { clip: string; notes: number }) => [x.clip, x.notes]), [["t0/a0", 0], ["t0/a1", 0]]);
  assert.match(stopped.take.warnings.join("\n"), /t0\/a0 on 1-MIDI has no notes/);
  assert.equal((await call("transport", { action: "stop" })).data.take, undefined, "the report comes once");
});
