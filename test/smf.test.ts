import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseMidi } from "../src/midi/smf.js";

const vlq = (n: number) => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
const track = (events: number[]) => { const b = Buffer.from(events); const h = Buffer.alloc(8); h.write("MTrk", 0, "latin1"); h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
const header = (format: number, tracks: number, ppq: number) => { const h = Buffer.alloc(14); h.write("MThd", 0, "latin1"); h.writeUInt32BE(6, 4); h.writeUInt16BE(format, 8); h.writeUInt16BE(tracks, 10); h.writeUInt16BE(ppq, 12); return h; };
const name = (text: string) => [0, 0xff, 0x03, text.length, ...Buffer.from(text, "latin1")];

test("a format 1 file gives one part per track, with tempo, meter, running status and note-on velocity 0 as note-off", () => {
  const conductor = track([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xff, 0x58, 4, 3, 2, 24, 8, 0, 0xff, 0x2f, 0]); // 120 BPM, 3/4
  const bass = track([...name("Bass"), 0, 0x90, 33, 100, ...vlq(96), 0x80, 33, 0, 0, 0x90, 45, 90, ...vlq(48), 45, 0, 0, 0xff, 0x2f, 0]);
  const lead = track([...name("Lead"), ...vlq(192), 0x91, 72, 110, ...vlq(384), 0x81, 72, 0, 0, 0xff, 0x2f, 0]);
  const m = parseMidi(Buffer.concat([header(1, 3, 96), conductor, bass, lead]));
  assert.equal(m.bpm, 120);
  assert.deepEqual(m.timeSignature, [3, 4]);
  assert.deepEqual(m.parts.map((p) => p.name), ["Bass", "Lead"]);
  assert.deepEqual(m.parts[0].notes, [
    { pitch: 33, startTime: 0, duration: 1, velocity: 100 },
    { pitch: 45, startTime: 1, duration: 0.5, velocity: 90 },
  ]);
  assert.deepEqual(m.parts[1].notes, [{ pitch: 72, startTime: 2, duration: 4, velocity: 110 }]);
  assert.deepEqual(m.parts[1].channels, [2]);
  assert.equal(m.lengthBeats, 6);
});

test("a format 0 file with two channels splits into two parts; other files are refused", () => {
  const one = track([0, 0x90, 60, 100, 0, 0x99, 36, 120, ...vlq(480), 0x80, 60, 0, 0, 0x89, 36, 0, 0, 0xff, 0x2f, 0]);
  const m = parseMidi(Buffer.concat([header(0, 1, 480), one]));
  assert.deepEqual(m.parts.map((p) => [p.name, p.channels[0], p.notes.length]), [["Channel 1", 1, 1], ["Channel 10", 10, 1]]);
  assert.throws(() => parseMidi(Buffer.from("RIFF....")), /not a MIDI file/);
  const smpte = header(1, 0, 0); smpte.writeUInt16BE(0xe250, 12);
  assert.throws(() => parseMidi(smpte), /SMPTE/);
});

test("real MIDI files in the User Library parse, when there are any", { skip: !fs.existsSync(path.join(os.homedir(), "Music/Ableton/User Library/Clips/Photographic")) }, () => {
  const dir = path.join(os.homedir(), "Music/Ableton/User Library/Clips/Photographic");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".mid"))) {
    const m = parseMidi(fs.readFileSync(path.join(dir, f)));
    assert.ok(m.parts.length > 0 && m.lengthBeats > 0, f);
  }
});
