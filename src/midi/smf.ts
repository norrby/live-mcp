// smf.ts – reads a Standard MIDI File (format 0 or 1) into parts with notes in beats, ready for a Live clip.
// A part is a track of the file (in format 0, a channel). Tempo and the first time signature come along so a clip
// length can be rounded up to whole bars.

export interface MidiNote {
  pitch: number;
  startTime: number;
  duration: number;
  velocity: number;
}

export interface MidiPart {
  index: number;
  name: string;
  channels: number[];
  notes: MidiNote[];
}

export interface MidiFile {
  format: number;
  ticksPerBeat: number;
  bpm?: number;
  timeSignature?: [number, number];
  parts: MidiPart[];
  /** end of the last note, in beats */
  lengthBeats: number;
}

class Reader {
  at = 0;
  constructor(readonly b: Buffer) {}
  u8() {
    if (this.at >= this.b.length) throw new Error("MIDI file ends in the middle of an event");
    return this.b[this.at++];
  }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error("bad variable-length number in MIDI file");
  }
}

export function parseMidi(buf: Buffer): MidiFile {
  if (buf.toString("latin1", 0, 4) !== "MThd") throw new Error("not a MIDI file (no MThd header)");
  const headerLength = buf.readUInt32BE(4);
  const format = buf.readUInt16BE(8);
  const tracks = buf.readUInt16BE(10);
  const division = buf.readUInt16BE(12);
  if (division & 0x8000) throw new Error("MIDI files timed in SMPTE frames are not supported");
  if (division === 0) throw new Error("MIDI file with 0 ticks per beat");
  if (format > 1) throw new Error(`MIDI file format ${format} is not supported (only 0 and 1)`);
  const ticksPerBeat = division;
  let at = 8 + headerLength;
  let bpm: number | undefined;
  let timeSignature: [number, number] | undefined;
  const raw: { name: string; notes: (MidiNote & { channel: number })[] }[] = [];

  // Other chunks (some files carry their own before the tracks) are skipped and do not count as tracks.
  for (let t = 0; t < tracks && at + 8 <= buf.length; ) {
    const id = buf.toString("latin1", at, at + 4);
    const length = buf.readUInt32BE(at + 4);
    const body = buf.subarray(at + 8, at + 8 + length);
    at += 8 + length;
    if (id !== "MTrk") continue;
    t++;
    const r = new Reader(body);
    let tick = 0;
    let status = 0;
    let name = "";
    const open = new Map<number, { tick: number; velocity: number }[]>();
    const notes: (MidiNote & { channel: number })[] = [];
    const close = (channel: number, pitch: number) => {
      const started = open.get(channel * 128 + pitch);
      const first = started?.shift();
      if (first) notes.push({ channel, pitch, velocity: first.velocity, startTime: first.tick / ticksPerBeat, duration: Math.max(1, tick - first.tick) / ticksPerBeat });
    };
    while (r.at < body.length) {
      tick += r.vlq();
      let byte = r.u8();
      if (byte === 0xff) {
        const type = r.u8();
        const len = r.vlq();
        const data = body.subarray(r.at, r.at + len);
        r.at += len;
        if (type === 0x03 && !name) name = data.toString("latin1").trim();
        else if (type === 0x51 && len === 3 && bpm === undefined) bpm = Math.round((60_000_000 / data.readUIntBE(0, 3)) * 100) / 100;
        else if (type === 0x58 && len >= 2 && !timeSignature) timeSignature = [data[0], 2 ** data[1]];
        else if (type === 0x2f) break;
        continue;
      }
      if (byte === 0xf0 || byte === 0xf7) {
        r.at += r.vlq();
        continue;
      }
      let first: number;
      if (byte & 0x80) {
        status = byte;
        first = r.u8();
      } else {
        if (!status) throw new Error("MIDI data without a status byte");
        first = byte;
        byte = status;
      }
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      if (kind === 0xc0 || kind === 0xd0) continue;
      const second = r.u8();
      if (kind === 0x90 && second > 0) {
        const key = channel * 128 + first;
        if (!open.has(key)) open.set(key, []);
        open.get(key)!.push({ tick, velocity: second });
      } else if (kind === 0x80 || kind === 0x90) close(channel, first);
    }
    for (const [key, list] of open) while (list.length) close(Math.floor(key / 128), key % 128); // notes never released end at the track's end
    raw.push({ name, notes });
  }

  const parts: MidiPart[] = [];
  const add = (name: string, notes: (MidiNote & { channel: number })[]) => {
    if (!notes.length) return;
    notes.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
    parts.push({
      index: parts.length,
      name,
      channels: [...new Set(notes.map((n) => n.channel + 1))],
      notes: notes.map(({ pitch, startTime, duration, velocity }) => ({ pitch, startTime, duration, velocity })),
    });
  };
  for (const track of raw) {
    const channels = [...new Set(track.notes.map((n) => n.channel))];
    if (format === 0 && channels.length > 1) for (const c of channels) add(`${track.name || "Channel"} ${c + 1}`.trim(), track.notes.filter((n) => n.channel === c));
    else add(track.name || `Track ${raw.indexOf(track) + 1}`, track.notes);
  }
  const lengthBeats = Math.max(0, ...parts.flatMap((p) => p.notes.map((n) => n.startTime + n.duration)));
  return { format, ticksPerBeat, bpm, timeSignature, parts, lengthBeats };
}
