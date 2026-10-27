import { test } from "node:test";
import assert from "node:assert/strict";
import { refAddress, uriToFile } from "../src/mcp/server.js";
import { measure } from "../src/audio/analyse.js";
import { parseMidi } from "../src/midi/smf.js";

test("browser uris become files in the User Library or a Places folder, and nothing else", () => {
  assert.equal(uriToFile("query:UserLibrary#Clips:Photographic:PG%20Kick.mid", "/lib"), "/lib/Clips/Photographic/PG Kick.mid");
  assert.equal(uriToFile("userfolder:/Users/me/dist#Sub:My%20Device.amxd", "/lib"), "/Users/me/dist/Sub/My Device.amxd");
  assert.equal(uriToFile("query:AudioFx#Reverb", "/lib"), undefined);
  assert.equal(uriToFile("query:UserLibrary#..:..:etc:passwd.mid", "/lib"), undefined);
  assert.equal(uriToFile("query:UserLibrary#bad%E0%A4%A", "/lib"), undefined, "a broken escape is not an error");
});

test("bridge refs become addresses through racks and to the mixer", () => {
  assert.equal(refAddress("t2", { devices: [0], param: 5 }), "t2/d0/p5");
  assert.equal(refAddress("t2", { devices: [1, 0, 3], param: 2 }), "t2/d1/c0/d3/p2");
  assert.equal(refAddress("t2", { mixer: "volume" }), "t2/vol");
  assert.equal(refAddress("t2", { mixer: "send", index: 1 }), "t2/send1");
  assert.equal(refAddress("t2", null), undefined);
});

test("one loud click in a minute of silence is not silence", () => {
  const rate = 48000;
  const c = new Float32Array(rate * 60);
  c[rate * 30] = 1;
  const m = measure({ sampleRate: rate, channels: [c, c] });
  assert.equal(m.silent, false);
  assert.equal(m.peakDbfs[0], 0);
});

test("a MIDI file with 0 ticks per beat is refused instead of giving endless beats", () => {
  const h = Buffer.alloc(14);
  h.write("MThd", 0, "latin1"); h.writeUInt32BE(6, 4); h.writeUInt16BE(1, 8); h.writeUInt16BE(0, 10); h.writeUInt16BE(0, 12);
  assert.throws(() => parseMidi(h), /0 ticks per beat/);
});
