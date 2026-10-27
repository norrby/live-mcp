import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress } from "../src/live/address.js";

test("parseAddress reads tracks, devices, chains, parameters, mixer and handles", () => {
  assert.deepEqual(parseAddress("t0/d2/c1/d0/p17"), [
    { kind: "track", index: 0 }, { kind: "device", index: 2 }, { kind: "chain", index: 1 }, { kind: "device", index: 0 }, { kind: "param", index: 17 },
  ]);
  assert.deepEqual(parseAddress("r1/send2"), [{ kind: "return", index: 1 }, { kind: "mixer", which: "send", index: 2 }]);
  assert.deepEqual(parseAddress("main/vol"), [{ kind: "main" }, { kind: "mixer", which: "vol", index: 0 }]);
  assert.deepEqual(parseAddress("#42"), [{ kind: "handle", id: 42n }]);
});

test("parseAddress rejects nonsense with the offending segment", () => {
  assert.throws(() => parseAddress("d0"), /bad address segment "d0"/);
  assert.throws(() => parseAddress("t0/x9"), /bad address segment "x9"/);
  assert.throws(() => parseAddress(""), /empty/);
});
