import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { liveOrder, parametersOf, readAmxd } from "../src/m4l/amxd.js";

const box = (long: string, short: string, extra: Record<string, unknown> = {}, boxExtra: Record<string, unknown> = {}) => ({
  box: { maxclass: "live.dial", saved_attribute_attributes: { valueof: { parameter_longname: long, parameter_shortname: short, ...extra } }, ...boxExtra },
});

test("parametersOf walks subpatchers and reads units, choices, help", () => {
  const json = {
    patcher: {
      boxes: [
        box("Osc 1 Cutoff", "Cutoff", { parameter_type: 1, parameter_mmin: 0, parameter_mmax: 127, parameter_unitstyle: 3 }, { annotation: "Filter cutoff", annotation_name: "Cutoff" }),
        { box: { maxclass: "p", patcher: { boxes: [box("Wave", "Wave", { parameter_type: 2, parameter_enum: ["Tri", "Saw"], parameter_mmax: 1 })] } } },
        box("Table Data", "Table", { parameter_invisible: 1 }),
        box("Custom", "Cus", { parameter_unitstyle: 9, parameter_units: "steps", parameter_initial: [3] }),
      ],
    },
  };
  const all = parametersOf(json);
  assert.deepEqual(all.map((p) => p.longName), ["Osc 1 Cutoff", "Wave", "Table Data", "Custom"]);
  assert.equal(all[0].unit, "Hz");
  assert.equal(all[0].help, "Filter cutoff");
  assert.deepEqual(all[1].choices, ["Tri", "Saw"]);
  assert.equal(all[1].type, 2);
  assert.equal(all[3].unit, "steps");
  assert.equal(all[3].initial, 3);
});

test("[ask first] and [ready] in a help text become marks and leave the help", () => {
  const [push, ready] = parametersOf({
    patcher: { boxes: [box("Push", "Push", {}, { annotation: "Sends the patch. [ask first]" }), box("Ready", "Ready", {}, { annotation: "Set up and listening. [ready]" })] },
  });
  assert.deepEqual([push.help, push.askFirst, push.ready], ["Sends the patch.", true, undefined]);
  assert.deepEqual([ready.help, ready.askFirst, ready.ready], ["Set up and listening.", undefined, true]);
});

test("liveOrder puts Device On first and sorts visible parameters by long name in code-unit order", () => {
  const all = parametersOf({
    patcher: { boxes: [box("Legato", "Leg"), box("LFO1 Speed", "Speed"), box("Hidden", "H", { parameter_invisible: 2 }), box("Attack", "A")] },
  });
  assert.deepEqual(liveOrder(all).map((p) => p.longName), ["Device On", "Attack", "LFO1 Speed", "Legato"]);
});

// Optional check against a real device: the same device frozen and unfrozen, and a JSON dump
// ({ params: [{ name }] }) of the parameter names Live reports for it. Skipped unless all three are set.
const frozen = process.env.AMXD_FROZEN ?? "";
const unfrozen = process.env.AMXD_UNFROZEN ?? "";
const dump = process.env.AMXD_LIVE_PARAMS ?? "";

test("readAmxd reads a frozen and an unfrozen device and matches Live's order", { skip: ![frozen, unfrozen, dump].every((f) => f && fs.existsSync(f)) }, () => {
  const a = readAmxd(frozen);
  const b = readAmxd(unfrozen);
  assert.equal(a.frozen, true);
  assert.equal(b.frozen, false);
  assert.deepEqual(a.parameters.map((p) => p.longName), b.parameters.map((p) => p.longName));
  const live = JSON.parse(fs.readFileSync(dump, "utf8")).params.map((p: { name: string }) => p.name);
  assert.deepEqual(a.parameters.map((p) => p.shortName), live);
});
