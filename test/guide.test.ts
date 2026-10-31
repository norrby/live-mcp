import { test } from "node:test";
import assert from "node:assert/strict";
import { findSection, guideNameIn, parseGuide } from "../src/m4l/guide.js";
import { embeddedFiles, readAmxd } from "../src/m4l/amxd.js";

/** A frozen .amxd file the way Max writes it: header, "mx@c", the patcher JSON, the embedded files, then the "dlst". */
export function frozenAmxd(patcher: unknown, files: { name: string; type: string; data: Buffer }[]): Buffer {
  const be = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const chunk = (tag: string, payload: Buffer) => Buffer.concat([Buffer.from(tag, "latin1"), be(8 + payload.length), payload]);
  const padded = (s: string) => {
    const b = Buffer.from(s + "\0", "utf8");
    return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  };
  const json = Buffer.from(JSON.stringify(patcher));
  const entries = [{ name: "Device.amxd", type: "JSON", data: json }, ...files];
  const dires: Buffer[] = [];
  let offset = 16; // from the start of the "mx@c" header, which is 16 bytes
  for (const e of entries) {
    dires.push(chunk("dire", Buffer.concat([chunk("type", Buffer.from(e.type.padEnd(4), "latin1")), chunk("fnam", padded(e.name)), chunk("sz32", be(e.data.length)), chunk("of32", be(offset))])));
    offset += e.data.length;
  }
  const dlst = chunk("dlst", Buffer.concat(dires));
  const body = Buffer.concat([Buffer.from("mx@c", "latin1"), be(16), be(0), be(offset), ...entries.map((e) => e.data), dlst]);
  const head = Buffer.alloc(32);
  head.write("ampf", 0, "latin1");
  head.writeUInt32BE(4, 4);
  head.write("mmmm", 8, "latin1");
  head.write("meta", 12, "latin1");
  head.writeUInt32BE(4, 16);
  head.writeUInt32BE(7, 20);
  head.write("ptch", 24, "latin1");
  head.writeUInt32BE(body.length, 28);
  return Buffer.concat([head, body]);
}

test("a frozen device carries the guide its description names, and the dependency list is read as Max writes it", () => {
  const patcher = {
    patcher: {
      description: "An editor for a synth. The guide to the synth is embedded in the device as device-guide.md.",
      boxes: [{ box: { maxclass: "live.dial", saved_attribute_attributes: { valueof: { parameter_longname: "Cutoff", parameter_shortname: "Cut" } } } }],
    },
  };
  const raw = frozenAmxd(patcher, [
    { name: "sid.table.js", type: "TEXT", data: Buffer.from("// code") },
    { name: "device-guide.md", type: "TEXT", data: Buffer.from("# Synth\n\nIntro.\n\n## Tables\nSteps.\n") },
  ]);
  assert.deepEqual(
    embeddedFiles(raw).map((f) => [f.name, f.type, f.size]),
    [["Device.amxd", "JSON", JSON.stringify(patcher).length], ["sid.table.js", "TEXT", 7], ["device-guide.md", "TEXT", 34]],
  );
  const device = readAmxd("/lib/Synth.amxd", raw);
  assert.equal(device.frozen, true);
  assert.equal(device.parameters[1].longName, "Cutoff", "the patcher JSON is still read from the frozen file");
  assert.equal(device.guideName, "device-guide.md");
  assert.equal(device.guide?.title, "Synth");
  assert.deepEqual(device.guide?.sections, [{ name: "Tables", text: "Steps." }]);

  const without = readAmxd("/lib/Synth.amxd", frozenAmxd(patcher, []));
  assert.equal(without.guideName, "device-guide.md");
  assert.equal(without.guide, undefined, "a named guide that is not embedded is reported as missing, not invented");
  assert.deepEqual(embeddedFiles(Buffer.alloc(40)), [], "an unfrozen or short file has no embedded files");
});

test("a guide is split into title, introduction and sections", () => {
  const g = parseGuide("# Synth Editor\n\nAn editor for a synth.\nTwo lines.\n\n## Signal path\nOsc to filter.\n\n### Detail\nMore.\n\n## Tables ##\nSteps.\n", "/lib/Synth.md");
  assert.equal(g.title, "Synth Editor");
  assert.equal(g.intro, "An editor for a synth.\nTwo lines.");
  assert.deepEqual(
    g.sections.map((s) => s.name),
    ["Signal path", "Tables"],
  );
  assert.equal(g.sections[0].text, "Osc to filter.\n\n### Detail\nMore.", "a deeper heading stays inside its section");
  assert.equal(g.sections[1].text, "Steps.", "closing hashes are not part of the heading");
});

test("a guide without headings is all introduction, and Windows line ends are fine", () => {
  const g = parseGuide("Just a paragraph.\r\nAnd another.\r\n", "/lib/Plain.md");
  assert.equal(g.title, undefined);
  assert.equal(g.intro, "Just a paragraph.\nAnd another.");
  assert.deepEqual(g.sections, []);
});

test("a section is found by its heading, the start of it, or a word in it", () => {
  const g = parseGuide("## Signal path\nA\n## LFOs and modulation\nB\n## Patches: Push, Pull, Store\nC\n", "/lib/Synth.md");
  assert.deepEqual(findSection(g, "signal path").map((s) => s.text), ["A"]);
  assert.deepEqual(findSection(g, "LFO").map((s) => s.text), ["B"]);
  assert.deepEqual(findSection(g, "push").map((s) => s.text), ["C"]);
  assert.deepEqual(findSection(g, "  "), []);
  assert.deepEqual(findSection(g, "envelope"), []);
});

test("the description names the guide file", () => {
  assert.equal(guideNameIn("Edits a synth. The guide is embedded in the device as device-guide.md."), "device-guide.md");
  assert.equal(guideNameIn("See \"Synth Guide.md\" beside the device"), "Synth Guide.md", "a quoted name may have spaces");
  assert.equal(guideNameIn("Guide: synth-guide.MD"), "synth-guide.MD");
  assert.equal(guideNameIn("Read docs/guide.md"), undefined, "a path is not a name");
  assert.equal(guideNameIn("Edits a synth. Markdown is handy."), undefined);
});
