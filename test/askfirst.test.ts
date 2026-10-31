// askfirst.test.ts – the [ask first] marks come through the bridge; while it answers but the files are not all read,
// a device the registry does not know may be a marked one, so its changes wait.
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

async function setUp(t: { after: (fn: () => void) => void }, answers: boolean) {
  const fakeRemote = net.createServer((sock) => {
    sock.once("data", () => (answers ? sock.end(JSON.stringify({ ok: true, result: "pong" }) + "\n") : sock.destroy()));
  });
  await new Promise<void>((r) => fakeRemote.listen(0, "127.0.0.1", r));
  t.after(() => fakeRemote.close());
  const live = new LiveAdapter(initialize(smallSet().activation(), "1.0.0"));
  const bridge = new Bridge({ port: (fakeRemote.address() as net.AddressInfo).port });
  // The .amxd files cannot be listed: a timeout halfway, say.
  const registry = new M4lRegistry({ directories: ["/lib"], fallback: { list: async () => Promise.reject(new Error("no answer within 20000 ms")), read: async () => Buffer.alloc(0) } });
  registry.via = "bridge";
  const server = createServer({ live, registry, bridge, changes: new ChangeTracker(live), version: "test", log: () => {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  return async (changes: unknown[]) => {
    const r = (await c.callTool({ name: "set_parameters", arguments: { changes } })) as { isError?: boolean; content: { text: string }[] };
    return { ok: !r.isError, text: r.content[0].text };
  };
}

test("with the bridge answering but the marks unread, changes to an unknown device wait unless the user asked", async (t) => {
  const set = await setUp(t, true);
  const held = await set([{ address: "t0/d0/p1", value: 0.5 }]);
  assert.ok(!held.ok);
  assert.match(held.text, /Nothing was changed.*not all been read yet.*no answer within 20000 ms.*t0\/d0\/p1/s);
  assert.ok((await set([{ address: "t0/d0/p1", value: 0.5, userAsked: true }])).ok, "the user's own request goes through");
});

test("without a bridge the marks can never come, so changes are not held", async (t) => {
  const set = await setUp(t, false);
  assert.ok((await set([{ address: "t0/d0/p1", value: 0.5 }])).ok);
});
