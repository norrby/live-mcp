import { test } from "node:test";
import assert from "node:assert/strict";
import { initialize } from "@ableton-extensions/sdk";
import { LiveAdapter } from "../src/live/adapter.js";
import { ChangeTracker, MAX_PARAMETERS_PER_SNAPSHOT, diff, takeSnapshot } from "../src/live/changes.js";
import { smallSet } from "./fake-host.js";

test("diff reports parameter, mixer, track and device changes with addresses", async () => {
  const fake = smallSet();
  const live = new LiveAdapter(initialize(fake.activation(), "1.0.0"));
  const before = await takeSnapshot(live);
  await live.setValues([{ address: "t0/d0/p2", value: 10 }, { address: "t1/vol", value: 0.5 }]);
  live.track("t1").name = "Drums";
  live.track("t0").mute = true;
  await live.deviceHolder("t1").insertDevice("Utility", 0);
  const after = await takeSnapshot(live);
  const changes = diff(before, after);
  const whats = changes.map((c) => `${c.kind}:${c.address ?? ""}:${c.from ?? ""}->${c.to ?? ""}`);
  assert.ok(whats.includes("parameter:t0/d0/p2:127->10"), whats.join("\n"));
  assert.ok(whats.includes("mixer:t1/vol:0.85->0.5"));
  assert.ok(whats.includes("track:t1:2-Audio->Drums"));
  assert.ok(whats.includes("track:t0:false->true"));
  assert.ok(changes.some((c) => c.kind === "device" && /added/.test(c.what)));
});

test("ChangeTracker takes a first snapshot, then returns diffs per cursor", async () => {
  const fake = smallSet();
  const live = new LiveAdapter(initialize(fake.activation(), "1.0.0"));
  const tracker = new ChangeTracker(live);
  const first = await tracker.changesSince("a");
  assert.equal(first.first, true);
  await live.setValues([{ address: "t0/d0/p1", value: 3 }]);
  const second = await tracker.changesSince("a");
  assert.equal(second.first, false);
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0].address, "t0/d0/p1");
  const other = await tracker.changesSince("b");
  assert.equal(other.first, true);
  assert.equal((await tracker.changesSince("a")).changes.length, 0);
});

test("devices beyond the snapshot budget are reported as not read, never as unchanged", async () => {
  const fake = smallSet();
  const t = fake.addTrack("midi", "Big");
  fake.addDevice(t, "Huge", Array.from({ length: MAX_PARAMETERS_PER_SNAPSHOT + 1 }, (_, i) => ({ name: `p${i}`, max: 1 })));
  const live = new LiveAdapter(initialize(fake.activation(), "1.0.0"));
  const tracker = new ChangeTracker(live);
  const first = await tracker.changesSince("c");
  assert.deepEqual(first.notRead, ["t2/d0"]);
  assert.match(first.summary ?? "", /not read/);
  await live.setValues([{ address: "t2/d0/p3", value: 1 }]);
  const second = await tracker.changesSince("c");
  assert.deepEqual(second.notRead, ["t2/d0"]);
  assert.equal(second.changes.length, 0);
  assert.equal((await tracker.changesSince("c", "t0")).notRead, undefined, "a scoped watch fits the budget");
});
