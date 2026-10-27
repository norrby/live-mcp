// stage.test.ts – an installed extension imports audio only from its own folder, so files elsewhere come over through
// the bridge first. A stand-in LiveRemote serves audio_read in small pieces.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { initialize } from "@ableton-extensions/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LiveAdapter } from "../src/live/adapter.js";
import { M4lRegistry } from "../src/m4l/registry.js";
import { Bridge } from "../src/bridge/client.js";
import { createServer } from "../src/mcp/server.js";
import { ChangeTracker } from "../src/live/changes.js";
import { smallSet } from "./fake-host.js";

test("an audio file outside the extension's folder is copied there through the bridge, imported and the copy removed", async (t) => {
  const source = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const asked: string[] = [];
  const fakeRemote = net.createServer((sock) => {
    sock.once("data", (line) => {
      const { cmd, args } = JSON.parse(String(line)) as { cmd: string; args: [string, number] };
      asked.push(`${cmd} ${args[0]} ${args[1]}`);
      const [file, offset] = args;
      const reply = file.endsWith("song.wav")
        ? { ok: true, result: { total: source.length, data: source.subarray(offset, offset + 300).toString("base64") } }
        : { ok: false, error: "ValueError: not an audio file" };
      sock.end(JSON.stringify(reply) + "\n");
    });
  });
  await new Promise<void>((r) => fakeRemote.listen(0, "127.0.0.1", r));
  t.after(() => fakeRemote.close());
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "live-mcp-temp-"));
  const fake = smallSet();
  const live = new LiveAdapter(initialize(fake.activation(), "1.0.0"));
  const server = createServer({
    live, registry: new M4lRegistry({ directories: [] }), bridge: new Bridge({ port: (fakeRemote.address() as net.AddressInfo).port }),
    changes: new ChangeTracker(live), version: "test", log: () => {}, ownFolders: [temp],
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  t.after(() => c.close());
  const call = async (args: Record<string, unknown>) => {
    const r = (await c.callTool({ name: "create_audio_clip", arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { ok: !r.isError, text: r.content[0].text };
  };

  const made = await call({ track: "t1", slot: 0, file: "/Users/someone/Music/song.wav" });
  assert.ok(made.ok, made.text);
  assert.deepEqual(asked, ["audio_read /Users/someone/Music/song.wav 0", "audio_read /Users/someone/Music/song.wav 300", "audio_read /Users/someone/Music/song.wav 600", "audio_read /Users/someone/Music/song.wav 900"]);
  const imported = fake.imports.at(-1)!;
  assert.ok(imported.path.startsWith(temp + path.sep) && imported.path.endsWith(`${path.sep}song.wav`), "Live gets a copy in the temp folder, under the file's own name");
  assert.deepEqual(imported.bytes, source, "the copy is the whole file");
  assert.deepEqual(fs.readdirSync(temp), [], "the copy is gone once Live has its own");

  const inside = path.join(temp, "here.wav");
  fs.writeFileSync(inside, "x");
  assert.ok((await call({ track: "t1", slot: 1, file: inside })).ok);
  assert.equal(fake.imports.at(-1)!.path, inside, "a file already in the folder is imported as it is");
  assert.equal(asked.length, 4);

  assert.match((await call({ track: "t1", slot: 99, file: "/Users/someone/Music/song.wav" })).text, /clip slot/);
  assert.equal(asked.length, 4, "a call that is wrong anyway copies nothing");

  const refused = await call({ track: "t1", start: 16, file: "/Users/someone/notes.txt" });
  assert.match(refused.text, /copies \/Users\/someone\/notes\.txt there first, and that failed: .*not an audio file/);
  assert.deepEqual(fs.readdirSync(temp), ["here.wav"], "nothing is left behind after a failed copy");
});
