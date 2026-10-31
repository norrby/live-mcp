// amxd.ts – reads a Max for Live device file and lists its Live parameters the way Live orders them.
// Live only exposes the SHORT names of Max for Live parameters, so the long names, units, choices and help texts
// come from here. Container: "ampf" u32 "mmmm" | "meta" u32 u32 | "ptch" u32(len) then either the patcher JSON
// (unfrozen) or "mx@c" u32(16) u32(0) u32(dlst offset) and the JSON followed by the embedded files (frozen).
// A frozen file ends with its dependency list "dlst": big-endian chunks, one "dire" per file with "type", "fnam",
// "sz32" (size) and "of32" (offset from the start of the "mx@c" header); the patcher JSON itself is the first entry.
import * as fs from "node:fs";
import { guideNameIn, parseGuide, type M4lGuide } from "./guide.js";

export interface M4lParameter {
  longName: string;
  shortName: string;
  varname?: string;
  /** 0 float, 1 int, 2 enum, 3 blob */
  type: number;
  min: number;
  max: number;
  /** Max's parameter_unitstyle: 0 int, 1 float, 2 ms, 3 Hz, 4 dB, 5 %, 6 pan, 7 semitones, 8 note, 9 custom, 10 native */
  unitStyle: number;
  unit?: string;
  choices?: string[];
  initial?: number;
  /** 0 normal, 1 stored only (not in Live), 2 hidden (not in Live) */
  invisible: number;
  help?: string;
  /** the author marked it "[ask first]" in its help text: change it only when the user asked for it */
  askFirst?: boolean;
  /** the author marked it "[ready]": it starts at 0 and the device sets it to its max when it is ready to be driven */
  ready?: boolean;
  helpName?: string;
}

export interface M4lDevice {
  file: string;
  frozen: boolean;
  /** the patcher's description (Patcher Inspector), where an author can say what the device is and how to drive it */
  description?: string;
  /** the guide file the description names (an .md file): embedded in a frozen device, beside an unfrozen one */
  guideName?: string;
  /** the author's guide, once read: from the frozen file here, from beside an unfrozen file by the registry */
  guide?: M4lGuide;
  /** parameters visible to Live, in Live's order; index 0 is Live's own "Device On" */
  parameters: M4lParameter[];
  /** everything in the patcher, including the ones Live does not show */
  all: M4lParameter[];
}

/** The tag an author puts in a parameter's Info View text to say that a program may change it only on request. */
export const ASK_FIRST = /\[ask first\]/gi;
/** The tag for the parameter a device sets to its max once it has set itself up after loading. */
export const READY = /\[ready\]/gi;

const UNIT_STYLES: Record<number, string | undefined> = { 0: undefined, 1: undefined, 2: "ms", 3: "Hz", 4: "dB", 5: "%", 6: "pan", 7: "st", 8: "note", 9: undefined, 10: undefined };

export function unitForStyle(style: number, custom?: string): string | undefined {
  if (style === 9) return custom;
  return UNIT_STYLES[style];
}

/** The patcher JSON of an .amxd file, frozen or not. */
export function readPatcherJson(file: string): { json: unknown; frozen: boolean } {
  return patcherJsonOf(fs.readFileSync(file), file);
}

/** The patcher JSON from the bytes of an .amxd file; `file` only names it in errors. */
export function patcherJsonOf(raw: Buffer, file: string): { json: unknown; frozen: boolean } {
  if (raw.length < 36 || raw.subarray(0, 4).toString("latin1") !== "ampf" || raw.subarray(24, 28).toString("latin1") !== "ptch") {
    throw new Error(`${file}: not an .amxd file`);
  }
  const frozen = raw.subarray(32, 36).toString("latin1") === "mx@c";
  const start = frozen ? 48 : 32;
  const end = jsonEnd(raw, start); // the "ptch" length covers trailing bytes too, so find the JSON's own end
  return { json: JSON.parse(raw.subarray(start, end).toString("utf8")), frozen };
}

export interface EmbeddedFile {
  name: string;
  /** Max's four-letter file type, such as "TEXT", "JSON" or "svg " */
  type: string;
  offset: number;
  size: number;
}

/** The files a frozen device carries, from its dependency list; none for an unfrozen file or an unreadable list. */
export function embeddedFiles(raw: Buffer): EmbeddedFile[] {
  if (raw.length < 48 || raw.subarray(32, 36).toString("latin1") !== "mx@c") return [];
  const base = 32;
  let at = base + raw.readUInt32BE(44);
  if (at + 8 > raw.length || raw.subarray(at, at + 4).toString("latin1") !== "dlst") at = raw.lastIndexOf("dlst", undefined, "latin1");
  if (at < 48 || at + 8 > raw.length) return [];
  const end = Math.min(raw.length, at + raw.readUInt32BE(at + 4));
  const out: EmbeddedFile[] = [];
  let pos = at + 8;
  while (pos + 8 <= end) {
    const size = raw.readUInt32BE(pos + 4);
    if (size < 8 || pos + size > end) break;
    if (raw.subarray(pos, pos + 4).toString("latin1") === "dire") {
      const entry: Partial<EmbeddedFile> = {};
      let q = pos + 8;
      while (q + 8 <= pos + size) {
        const tag = raw.subarray(q, q + 4).toString("latin1");
        const s = raw.readUInt32BE(q + 4);
        if (s < 8 || q + s > pos + size) break;
        const payload = raw.subarray(q + 8, q + s);
        if (tag === "type") entry.type = payload.toString("latin1");
        else if (tag === "fnam") entry.name = payload.toString("utf8").replace(/\0+$/, "");
        else if (tag === "sz32" && payload.length >= 4) entry.size = payload.readUInt32BE(0);
        else if (tag === "of32" && payload.length >= 4) entry.offset = base + payload.readUInt32BE(0);
        q += s;
      }
      if (entry.name && entry.size !== undefined && entry.offset !== undefined && entry.offset + entry.size <= raw.length) {
        out.push({ name: entry.name, type: entry.type ?? "", offset: entry.offset, size: entry.size });
      }
    }
    pos += size;
  }
  return out;
}

/** The text of an embedded file by name (case-insensitive), or undefined. */
export function embeddedText(raw: Buffer, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const f = embeddedFiles(raw).find((e) => e.name.toLowerCase() === wanted);
  return f ? raw.subarray(f.offset, f.offset + f.size).toString("utf8") : undefined;
}

/** Where the JSON object starting at `start` ends: brace matching that respects strings. */
function jsonEnd(buf: Buffer, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip the escaped byte
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b) depth++;
    else if (c === 0x7d && --depth === 0) return i + 1;
  }
  throw new Error("unterminated patcher JSON");
}

interface Box {
  maxclass?: string;
  varname?: string;
  patcher?: { boxes?: { box: Box }[] };
  annotation?: string;
  annotation_name?: string;
  saved_attribute_attributes?: { valueof?: Record<string, unknown> };
}

/** Every parameter-enabled object in the patcher and its subpatchers, in patcher order. */
export function parametersOf(json: unknown): M4lParameter[] {
  const out: M4lParameter[] = [];
  const walk = (patcher: { boxes?: { box: Box }[] } | undefined) => {
    for (const { box } of patcher?.boxes ?? []) {
      const v = box.saved_attribute_attributes?.valueof;
      if (v && typeof v.parameter_longname === "string" && (box as { parameter_enable?: number }).parameter_enable !== 0) {
        const choices = Array.isArray(v.parameter_enum) ? v.parameter_enum.map(String) : undefined;
        const type = num(v.parameter_type, choices ? 2 : 0);
        const p: M4lParameter = {
          longName: v.parameter_longname,
          shortName: typeof v.parameter_shortname === "string" ? v.parameter_shortname : v.parameter_longname,
          type,
          min: num(v.parameter_mmin, 0),
          max: num(v.parameter_mmax, choices ? choices.length - 1 : type === 2 ? 1 : 127),
          unitStyle: num(v.parameter_unitstyle, 0),
          invisible: num(v.parameter_invisible, 0),
        };
        if (box.varname) p.varname = box.varname;
        const unit = unitForStyle(p.unitStyle, typeof v.parameter_units === "string" ? v.parameter_units : undefined);
        if (unit) p.unit = unit;
        if (choices) p.choices = choices;
        if (Array.isArray(v.parameter_initial) && typeof v.parameter_initial[0] === "number") p.initial = v.parameter_initial[0];
        if (box.annotation) {
          const tagged = ASK_FIRST.test(box.annotation);
          const ready = READY.test(box.annotation);
          const help = box.annotation.replace(ASK_FIRST, " ").replace(READY, " ").replace(/\s+/g, " ").trim();
          if (help) p.help = help;
          if (tagged) p.askFirst = true;
          if (ready) p.ready = true;
        }
        if (box.annotation_name) p.helpName = box.annotation_name;
        out.push(p);
      }
      if (box.patcher) walk(box.patcher);
    }
  };
  walk((json as { patcher?: { boxes?: { box: Box }[] } }).patcher);
  return out;
}

/** Live's parameter order: "Device On", then the visible parameters sorted by long name in code-unit order. */
export function liveOrder(all: M4lParameter[]): M4lParameter[] {
  const visible = all.filter((p) => p.invisible === 0).sort((a, b) => (a.longName < b.longName ? -1 : a.longName > b.longName ? 1 : 0));
  const deviceOn: M4lParameter = { longName: "Device On", shortName: "Device On", type: 2, min: 0, max: 1, unitStyle: 0, choices: ["Off", "On"], invisible: 0 };
  return [deviceOn, ...visible];
}

export function readAmxd(file: string, bytes?: Buffer): M4lDevice {
  const raw = bytes ?? fs.readFileSync(file);
  const { json, frozen } = patcherJsonOf(raw, file);
  const all = parametersOf(json);
  const description = (json as { patcher?: { description?: unknown } }).patcher?.description;
  const device: M4lDevice = { file, frozen, all, parameters: liveOrder(all) };
  if (typeof description === "string" && description.trim()) device.description = description.trim();
  const guideName = device.description && guideNameIn(device.description);
  if (guideName) {
    device.guideName = guideName;
    // A frozen device carries its guide; an unfrozen one has it beside the file, which the registry reads.
    const text = frozen ? embeddedText(raw, guideName) : undefined;
    if (text !== undefined) device.guide = parseGuide(text, `${file}: ${guideName}`);
  }
  return device;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}
