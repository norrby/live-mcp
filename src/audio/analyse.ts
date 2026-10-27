// analyse.ts – reads a WAV or AIFF file (what Live renders, depending on its Record File Type setting) and measures
// it: sample peak and RMS in dBFS, integrated loudness in LUFS (ITU-R BS.1770-4: K-weighting, 400 ms blocks,
// absolute and relative gates), clipped samples, silence, and a coarse loudness envelope over time.

export interface Audio {
  sampleRate: number;
  /** one Float32Array per channel, samples in -1..1 */
  channels: Float32Array[];
}

export interface Measurement {
  seconds: number;
  sampleRate: number;
  channels: number;
  peakDbfs: number[];
  rmsDbfs: number[];
  /** integrated loudness; -Infinity (reported as null) when everything is below the absolute gate */
  lufs: number | null;
  clippedSamples: number;
  /** nothing above -80 dBFS at any moment */
  silent: boolean;
  /** RMS in dBFS for equal slices of the range, all channels together */
  envelopeDbfs: number[];
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const round = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);

export function parseAudio(buf: Buffer): Audio {
  const tag = buf.toString("latin1", 0, 4);
  if (tag === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE") return parseWav(buf);
  if (tag === "FORM" && ["AIFF", "AIFC"].includes(buf.toString("latin1", 8, 12))) return parseAiff(buf);
  throw new Error("not a WAV or AIFF file");
}

function parseWav(buf: Buffer): Audio {
  let format = 0, channels = 0, rate = 0, bits = 0;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString("latin1", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, at + 8 + size);
    if (id === "fmt ") {
      format = body.readUInt16LE(0);
      channels = body.readUInt16LE(2);
      rate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
      if (format === 0xfffe && body.length >= 26) format = body.readUInt16LE(24); // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes
    } else if (id === "data") data = body;
    at += 8 + size + (size % 2);
  }
  if (!data || !channels) throw new Error("WAV file without fmt or data");
  if (format !== 1 && format !== 3) throw new Error(`WAV sample format ${format} is not PCM or float`);
  return { sampleRate: rate, channels: deinterleave(data, channels, bits, format === 3, true) };
}

function parseAiff(buf: Buffer): Audio {
  const aifc = buf.toString("latin1", 8, 12) === "AIFC";
  let channels = 0, bits = 0, rate = 0, float = false;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString("latin1", at, at + 4);
    const size = buf.readUInt32BE(at + 4);
    const body = buf.subarray(at + 8, at + 8 + size);
    if (id === "COMM") {
      channels = body.readUInt16BE(0);
      bits = body.readUInt16BE(6);
      rate = extended80(body.subarray(8, 18));
      if (aifc && body.length >= 22) {
        const kind = body.toString("latin1", 18, 22);
        float = kind === "fl32" || kind === "FL32";
        if (!["NONE", "sowt", "fl32", "FL32", "twos"].includes(kind)) throw new Error(`AIFC compression ${kind} is not supported`);
        if (kind === "sowt") throw new Error("little-endian AIFC is not supported");
      }
    } else if (id === "SSND") {
      const offset = body.readUInt32BE(0);
      data = body.subarray(8 + offset);
    }
    at += 8 + size + (size % 2);
  }
  if (!data || !channels) throw new Error("AIFF file without COMM or SSND");
  return { sampleRate: rate, channels: deinterleave(data, channels, bits, float, false) };
}

/** The 80-bit IEEE extended float AIFF stores its sample rate in. */
function extended80(b: Buffer): number {
  const exponent = ((b[0] & 0x7f) << 8) | b[1];
  const hi = b.readUInt32BE(2);
  const lo = b.readUInt32BE(6);
  const mantissa = hi * 2 ** -31 + lo * 2 ** -63;
  return mantissa * 2 ** (exponent - 16383) * (b[0] & 0x80 ? -1 : 1);
}

function deinterleave(data: Buffer, channels: number, bits: number, float: boolean, little: boolean): Float32Array[] {
  const bytes = bits / 8;
  if (![2, 3, 4].includes(bytes)) throw new Error(`${bits}-bit samples are not supported`);
  const frames = Math.floor(data.length / (bytes * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const at = (f * channels + c) * bytes;
      let v: number;
      if (float) v = little ? data.readFloatLE(at) : data.readFloatBE(at);
      else if (bytes === 2) v = (little ? data.readInt16LE(at) : data.readInt16BE(at)) / 32768;
      else if (bytes === 3) v = (little ? data.readIntLE(at, 3) : data.readIntBE(at, 3)) / 8388608;
      else v = (little ? data.readInt32LE(at) : data.readInt32BE(at)) / 2147483648;
      out[c][f] = v;
    }
  }
  return out;
}

/** A biquad run over a whole signal (direct form I). */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** BS.1770 K-weighting (high shelf, then high pass) for any sample rate, with the coefficients libebur128 derives. */
function kWeight(x: Float32Array, fs: number): Float64Array {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  const Q1 = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q1 + K * K;
  const shelf = biquad(x, (Vh + (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0);
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  return biquad(Float32Array.from(shelf), 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0);
}

export function integratedLufs(audio: Audio): number {
  const fs = audio.sampleRate;
  const weighted = audio.channels.slice(0, 2).map((c) => kWeight(c, fs)); // L and R weigh 1; more channels are ignored
  const block = Math.round(0.4 * fs);
  const step = Math.round(0.1 * fs);
  const n = weighted[0]?.length ?? 0;
  const powers: number[] = [];
  for (let start = 0; start + block <= n; start += step) {
    let sum = 0;
    for (const w of weighted) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += w[i] * w[i];
      sum += s / block;
    }
    powers.push(sum);
  }
  const loud = (p: number) => -0.691 + 10 * Math.log10(p);
  const gated = powers.filter((p) => loud(p) > -70);
  if (!gated.length) return -Infinity;
  const relative = loud(gated.reduce((a, b) => a + b, 0) / gated.length) - 10;
  const kept = gated.filter((p) => loud(p) > relative);
  return loud(kept.reduce((a, b) => a + b, 0) / kept.length);
}

export function measure(audio: Audio, slices = 32): Measurement {
  const frames = audio.channels[0]?.length ?? 0;
  const peak: number[] = [];
  const rms: number[] = [];
  let clipped = 0;
  for (const c of audio.channels) {
    let p = 0, s = 0;
    for (let i = 0; i < c.length; i++) {
      const v = Math.abs(c[i]);
      if (v > p) p = v;
      if (v >= 0.999) clipped++;
      s += c[i] * c[i];
    }
    peak.push(round(db(p)));
    rms.push(round(db(Math.sqrt(s / Math.max(1, c.length)))));
  }
  const envelope: number[] = [];
  const per = Math.max(1, Math.floor(frames / slices));
  for (let k = 0; k * per < frames && envelope.length < slices; k++) {
    let s = 0, count = 0;
    for (const c of audio.channels) for (let i = k * per; i < Math.min(frames, (k + 1) * per); i++) (s += c[i] * c[i]), count++;
    envelope.push(round(db(Math.sqrt(s / Math.max(1, count)))));
  }
  const lufs = integratedLufs(audio);
  return {
    seconds: Math.round((frames / audio.sampleRate) * 1000) / 1000,
    sampleRate: audio.sampleRate,
    channels: audio.channels.length,
    peakDbfs: peak,
    rmsDbfs: rms,
    lufs: Number.isFinite(lufs) ? round(lufs) : null,
    clippedSamples: clipped,
    silent: peak.every((p) => !(p > -80)),
    envelopeDbfs: envelope,
  };
}
