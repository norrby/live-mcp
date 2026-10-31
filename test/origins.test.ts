import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { M4lRegistry } from "../src/m4l/registry.js";
import { M4lOrigins, type M4lSources } from "../src/m4l/origins.js";

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

const filter: [string, string][] = [["Cutoff Frequency", "Freq"], ["Resonance Amount", "Res"]];
const names = ["Device On", "Freq", "Res"];

test("the file the saved set, a load or Places names is read even outside the folders, and wins over copies with the same parameters", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-mcp-origins-"));
  const [library, downloads, places] = ["Library", "Downloads", "Places"].map((d) => path.join(root, d));
  for (const d of [library, downloads, places]) fs.mkdirSync(d);
  const release = path.join(library, "Filter.amxd");
  const dev = path.join(downloads, "Filter-dev.amxd");
  const other = path.join(downloads, "Other.amxd");
  fs.writeFileSync(release, amxd(filter));
  fs.writeFileSync(dev, amxd(filter));
  fs.writeFileSync(other, amxd([["Gain Amount", "Gain"], ["Mix Amount", "Mix"]]));
  fs.writeFileSync(path.join(places, "Echo.amxd"), amxd([["Echo Time", "Time"], ["Echo Feedback", "Fb"]]));

  const registry = new M4lRegistry({ directories: [library] });
  registry.scan(true);
  let sources: M4lSources = {
    set: path.join(root, "Set.als"),
    saved: [
      { address: "t0/d0", name: "FilterBass", file: dev },
      { address: "t0/d2", name: "", file: other }, // the set was saved with another device at this place
      { address: "t5/d0", name: "", file: release }, // a track deleted since the save
    ],
    max: [{ address: "t0/d0", name: "FilterBass" }, { address: "t0/d1", name: "Filter" }, { address: "t0/d2", name: "Filter" }],
    places: [places],
  };
  const ids: Record<string, string> = { "t0/d0": "#1", "t0/d1": "#2", "t0/d2": "#3" };
  const origins = new M4lOrigins(registry, async () => sources, (a) => ids[a]);

  try {
    assert.equal(registry.match(names, "FilterBass")?.file, release, "before: only the configured folder");
    await origins.sync(true);
    assert.deepEqual(registry.files().map((f) => path.basename(f.file)).sort(), ["Echo.amxd", "Filter-dev.amxd", "Filter.amxd", "Other.amxd"]);
    assert.equal(registry.match(names, "FilterBass", origins.originOf("#1"))?.file, dev, "the saved set names the copy in Downloads");
    assert.equal(origins.originOf("#2"), undefined);
    assert.deepEqual(registry.matches(names, "Lead", origins.originOf("#2")).map((m) => m.file).sort(), [dev, release].sort(), "no word on #2: both copies");
    assert.equal(origins.originOf("#3"), other);
    assert.deepEqual(registry.matches(names, "Lead", origins.originOf("#3")).map((m) => m.file).sort(), [dev, release].sort(), "a named file whose parameters differ is not taken");
    assert.equal(origins.isMax("#1"), true);
    assert.equal(origins.isMax("#9"), false);
    assert.equal(origins.setFile, path.join(root, "Set.als"));

    await origins.remember("#2", release);
    assert.equal(registry.match(names, "Filter", origins.originOf("#2"))?.file, release, "a device Live MCP loaded comes from the file it chose");

    const bare = path.join(places, "Bare.amxd");
    fs.writeFileSync(bare, amxd([]));
    await origins.remember("#4", bare);
    assert.equal(registry.match(["Device On"], "Bare")?.file, undefined, "no parameters of its own: nothing to fingerprint");
    assert.equal(registry.match(["Device On"], "Bare", origins.originOf("#4"))?.file, bare, "but the file it is known to come from names it");

    sources = { set: null, saved: [], max: [{ address: "t0/d0", name: "FilterBass" }], places: [] };
    await origins.sync(true);
    assert.equal(origins.originOf("#2"), undefined, "a device deleted since is forgotten");
    assert.equal(origins.originOf("#1"), undefined, "a set never saved names nothing");
    assert.deepEqual(registry.files().map((f) => f.file), [release], "files no longer named are no longer read");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("without a bridge the origins stay empty and the fingerprint decides as before", async () => {
  const registry = new M4lRegistry({ directories: [] });
  const origins = new M4lOrigins(registry, () => Promise.reject(new Error("LiveRemote is not reachable")), () => undefined);
  await origins.sync(true);
  assert.equal(origins.isMax("#1"), undefined, "unknown, not false: nothing can be said without the bridge");
  assert.equal(origins.setFile, null);
});
