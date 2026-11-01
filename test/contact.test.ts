import { test } from "node:test";
import assert from "node:assert/strict";
import { initialize } from "@ableton-extensions/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LiveAdapter } from "../src/live/adapter.js";
import { Bridge } from "../src/bridge/client.js";
import { createServer } from "../src/mcp/server.js";
import { ChangeTracker } from "../src/live/changes.js";
import { M4lRegistry } from "../src/m4l/registry.js";
import { M4lOrigins } from "../src/m4l/origins.js";
import { smallSet } from "./fake-host.js";

test("when Live does not answer, a tool says so instead of answering from the set as it was", async () => {
  const fake = smallSet();
  const live = new LiveAdapter(initialize(fake.activation(), "1.0.0"));
  const registry = new M4lRegistry({ directories: [] });
  const origins = new M4lOrigins(registry, () => Promise.reject(new Error("no bridge")), () => undefined);
  const server = createServer({ live, registry, origins, bridge: new Bridge({ port: 1 }), changes: new ChangeTracker(live), version: "test", log: () => {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  const call = async (name: string) => (await c.callTool({ name, arguments: {} })) as { isError?: boolean; content: { text: string }[] };

  assert.ok(!(await call("get_set")).isError);
  fake.silent = true;
  const r = await call("get_set");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Live does not answer/);
});
