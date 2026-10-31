import { test } from "node:test";
import assert from "node:assert/strict";
import { findSection, guideFileFor, parseGuide } from "../src/m4l/guide.js";

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

test("the guide file has the .amxd file's name", () => {
  assert.equal(guideFileFor("/lib/Max MIDI Effect/Synth.amxd"), "/lib/Max MIDI Effect/Synth.md");
  assert.equal(guideFileFor("/lib/Synth.AMXD"), "/lib/Synth.md");
});
