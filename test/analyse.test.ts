import { test } from "node:test";
import assert from "node:assert/strict";
import { measure, parseAudio } from "../src/audio/analyse.js";

const sine = (rate: number, seconds: number, amp: number, hz = 997) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

function wav(channels: Float32Array[], rate: number, bits: 16 | 32, float = false): Buffer {
  const frames = channels[0].length, bytes = bits / 8;
  const data = Buffer.alloc(frames * channels.length * bytes);
  for (let f = 0; f < frames; f++)
    channels.forEach((c, ch) => {
      const at = (f * channels.length + ch) * bytes;
      if (float) data.writeFloatLE(c[f], at);
      else data.writeInt16LE(Math.round(c[f] * 32767), at);
    });
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(float ? 3 : 1, 0); fmt.writeUInt16LE(channels.length, 2); fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * channels.length * bytes, 8); fmt.writeUInt16LE(channels.length * bytes, 12); fmt.writeUInt16LE(bits, 14);
  const chunk = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id, "latin1"), Buffer.from(Uint32Array.of(body.length).buffer), body]);
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), chunk("fmt ", fmt), chunk("data", data)]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from(Uint32Array.of(body.length).buffer), body]);
}

function aiff24(c: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(c.length * 3);
  c.forEach((v, i) => data.writeIntBE(Math.round(v * 8388607), i * 3, 3));
  const comm = Buffer.alloc(18);
  comm.writeUInt16BE(1, 0); comm.writeUInt32BE(c.length, 2); comm.writeUInt16BE(24, 6);
  const e = Math.floor(Math.log2(rate));
  comm.writeUInt16BE(16383 + e, 8);
  const m = rate / 2 ** e; // 1 <= m < 2
  comm.writeUInt32BE(Math.floor(m * 2 ** 31), 10);
  const chunk = (id: string, body: Buffer) => { const h = Buffer.alloc(8); h.write(id, 0, "latin1"); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]); };
  const ssnd = Buffer.concat([Buffer.alloc(8), data]);
  const body = Buffer.concat([Buffer.from("AIFF", "latin1"), chunk("COMM", comm), chunk("SSND", ssnd)]);
  const head = Buffer.alloc(8); head.write("FORM", 0, "latin1"); head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

test("a stereo sine at half scale measures -6 dBFS peak, -9 dBFS RMS and about -6 LUFS", () => {
  const s = sine(48000, 3, 0.5);
  const m = measure(parseAudio(wav([s, s], 48000, 16)));
  assert.equal(m.channels, 2);
  assert.equal(m.sampleRate, 48000);
  assert.equal(m.seconds, 3);
  assert.deepEqual(m.peakDbfs, [-6, -6]);
  assert.deepEqual(m.rmsDbfs, [-9, -9]);
  assert.ok(Math.abs((m.lufs ?? 0) - -6.0) <= 0.2, `lufs ${m.lufs}`);
  assert.equal(m.clippedSamples, 0);
  assert.equal(m.silent, false);
  assert.equal(m.envelopeDbfs.length, 32);
});

test("a mono 24-bit AIFF at 44.1 kHz reads the same way, and a full-scale float WAV counts its clipped samples", () => {
  const m = measure(parseAudio(aiff24(sine(44100, 2, 0.25), 44100)));
  assert.equal(m.sampleRate, 44100);
  assert.deepEqual(m.peakDbfs, [-12]);
  assert.ok(Math.abs((m.lufs ?? 0) - -15.05) <= 0.2, `lufs ${m.lufs}`);

  const hot = measure(parseAudio(wav([sine(48000, 1, 1)], 48000, 32, true)));
  assert.ok(hot.clippedSamples > 0);
  const quiet = measure(parseAudio(wav([new Float32Array(48000)], 48000, 16)));
  assert.equal(quiet.silent, true);
  assert.equal(quiet.lufs, null);
  assert.throws(() => parseAudio(Buffer.from("not audio at all")), /not a WAV or AIFF/);
});
