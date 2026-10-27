import { test } from "node:test";
import assert from "node:assert/strict";
import { M4lRegistry, type AmxdSource } from "../src/m4l/registry.js";

/** An unfrozen .amxd file: header, "ptch", then the patcher JSON. */
function amxd(params: [long: string, short: string][]): Buffer {
  const boxes = params.map(([long, short]) => ({ box: { maxclass: "live.dial", saved_attribute_attributes: { valueof: { parameter_longname: long, parameter_shortname: short } } } }));
  const json = Buffer.from(JSON.stringify({ patcher: { boxes } }));
  const head = Buffer.alloc(32);
  head.write("ampf", 0, "latin1");
  head.write("ptch", 24, "latin1");
  head.writeUInt32LE(json.length, 28);
  return Buffer.concat([head, json]);
}

test("when Live forbids reading the folders, the registry reads the .amxd files through the bridge", async () => {
  const files: Record<string, { mtime: number; bytes: Buffer }> = {
    "/lib/Filter.amxd": { mtime: 1, bytes: amxd([["Cutoff Frequency", "Freq"], ["Resonance Amount", "Res"]]) },
  };
  let reads = 0;
  const source: AmxdSource = {
    list: async (dirs) => (assert.deepEqual(dirs, ["/lib"]), Object.entries(files).map(([file, f]) => ({ file, mtime: f.mtime }))),
    read: async (file) => (reads++, files[file].bytes),
  };
  const registry = new M4lRegistry({ directories: ["/lib"], fallback: source });
  // Simulate Live's permission model: the first direct read is refused the way Node refuses it.
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.readdirSync;
  (fs as { readdirSync: unknown }).readdirSync = () => {
    throw Object.assign(new Error("Access to this API has been restricted"), { code: "ERR_ACCESS_DENIED" });
  };
  syncBuiltinESMExports();
  try {
    registry.scan(true);
  } finally {
    fs.readdirSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(registry.via, "bridge");
  await registry.refresh();
  const m = registry.match(["Device On", "Freq", "Res"]);
  assert.equal(m?.parameters[1].longName, "Cutoff Frequency");
  assert.equal(registry.errors.length, 0);

  await registry.refresh();
  assert.equal(reads, 1, "an unchanged file is not read again");
  files["/lib/Filter.amxd"].mtime = 2;
  await registry.refresh();
  assert.equal(reads, 2, "a changed file is read again");
  delete files["/lib/Filter.amxd"];
  await registry.refresh();
  assert.equal(registry.files().length, 0, "a removed file is forgotten");
});

test("an unreachable bridge leaves an explanation instead of an exception", async () => {
  const registry = new M4lRegistry({
    directories: ["/lib"],
    fallback: { list: async () => Promise.reject(new Error("LiveRemote is not reachable")), read: async () => Buffer.alloc(0) },
  });
  registry.via = "bridge";
  await registry.refresh();
  assert.match(registry.errors[0], /through the bridge: LiveRemote is not reachable/);
});
