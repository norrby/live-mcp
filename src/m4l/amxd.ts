// amxd.ts – reads a Max for Live device file and lists its Live parameters the way Live orders them.
// Live only exposes the SHORT names of Max for Live parameters, so the long names, units, choices and help texts
// come from here. Container: "ampf" u32 "mmmm" | "meta" u32 u32 | "ptch" u32(len) then either the patcher JSON
// (unfrozen) or "mx@c" u32(16) u32(0) u32(dlst offset) and the JSON followed by the embedded files (frozen).
import * as fs from "node:fs";

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
  helpName?: string;
}

export interface M4lDevice {
  file: string;
  frozen: boolean;
  /** parameters visible to Live, in Live's order; index 0 is Live's own "Device On" */
  parameters: M4lParameter[];
  /** everything in the patcher, including the ones Live does not show */
  all: M4lParameter[];
}

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
        if (box.annotation) p.help = box.annotation;
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
  const { json, frozen } = bytes ? patcherJsonOf(bytes, file) : readPatcherJson(file);
  const all = parametersOf(json);
  return { file, frozen, all, parameters: liveOrder(all) };
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}
