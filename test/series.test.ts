import { test } from "node:test";
import assert from "node:assert/strict";
import { foldSeries } from "../src/mcp/series.js";

const row = (i: number, name: string, value = 0, extra: Record<string, unknown> = {}) => ({ address: `t0/d0/p${i}`, name, value, min: 0, max: 65535, ...extra });

test("a run of parameters whose names count up folds into one series with its values; short runs and the rest stay", () => {
  const steps = (osc: number, from: number) => Array.from({ length: 65 }, (_, k) => row(from + k, `Step ${String(k).padStart(2, "0")} Osc${osc}`, k === 0 ? 65280 : 4351, { longName: `Osc ${osc} Step ${String(k).padStart(2, "0")}` }));
  const rows = [row(0, "Device On", 1, { max: 1 }), ...steps(1, 1), ...steps(2, 66), row(131, "Env 1", 3), row(132, "Env 2", 4), row(133, "Poly", 0, { max: 1 })];
  const out = foldSeries(rows);
  assert.equal(out.length, 6);
  assert.deepEqual(out[1], {
    series: "Step 00..64 Osc1",
    addresses: "t0/d0/p1..p65",
    longName: "Osc 1 Step 00..64",
    count: 65,
    min: 0,
    max: 65535,
    values: [65280, ...Array(64).fill(4351)],
  });
  assert.equal(out[2].series, "Step 00..64 Osc2", "the oscillator number does not count, so the two tables stay apart");
  assert.equal(out[2].addresses, "t0/d0/p66..p130");
  assert.deepEqual(out.slice(3).map((r) => r.name), ["Env 1", "Env 2", "Poly"]);
});

test("a gap in the numbers or a different range ends a series", () => {
  const rows = Array.from({ length: 10 }, (_, k) => row(k, `Cell ${k < 5 ? k : k + 1}`));
  assert.equal(foldSeries(rows).length, 10, "two runs of five: each too short");
  const ranged = Array.from({ length: 10 }, (_, k) => row(k, `Cell ${k}`, 0, k === 9 ? { max: 7 } : {}));
  const out = foldSeries(ranged);
  assert.equal(out[0].count, 9);
  assert.equal(out[1].name, "Cell 9");
});
