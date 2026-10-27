// registry.ts – knows the .amxd files on disk and recognises them in the set by their parameter fingerprint:
// the short names Live reports, in Live's order, match exactly one file's liveOrder().
import * as fs from "node:fs";
import * as path from "node:path";
import { readAmxd, type M4lDevice } from "./amxd.js";

export interface RegistryOptions {
  directories: string[];
  maxDepth?: number;
  maxFiles?: number;
  log?: (...a: unknown[]) => void;
}

interface Entry {
  device: M4lDevice;
  mtimeMs: number;
  fingerprint: string;
}

export class M4lRegistry {
  private entries = new Map<string, Entry>();
  private scannedAt = 0;
  readonly errors: string[] = [];

  constructor(readonly options: RegistryOptions) {}

  /** Rescans at most once a minute (it runs on the host's event loop); cheap when nothing changed (stat per file). */
  scan(force = false): void {
    const now = Date.now();
    if (!force && now - this.scannedAt < 60_000) return;
    this.scannedAt = now;
    this.errors.length = 0;
    const seen = new Set<string>();
    let count = 0;
    const maxFiles = this.options.maxFiles ?? 500;
    const walk = (dir: string, depth: number) => {
      if (depth > (this.options.maxDepth ?? 6) || count >= maxFiles) return;
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        this.errors.push(`${dir}: ${(e as Error).message}`);
        return;
      }
      for (const d of names) {
        if (d.name.startsWith(".")) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full, depth + 1);
        else if (d.isFile() && d.name.toLowerCase().endsWith(".amxd")) {
          count++;
          seen.add(full);
          this.load(full);
        }
      }
    };
    for (const dir of this.options.directories) walk(dir, 0);
    for (const key of this.entries.keys()) if (!seen.has(key)) this.entries.delete(key);
  }

  private load(file: string) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    const have = this.entries.get(file);
    if (have && have.mtimeMs === mtimeMs) return;
    try {
      const device = readAmxd(file);
      this.entries.set(file, { device, mtimeMs, fingerprint: fingerprint(device.parameters.map((p) => p.shortName)) });
    } catch (e) {
      this.entries.delete(file);
      this.errors.push(`${file}: ${(e as Error).message}`);
    }
  }

  /**
   * The file whose parameter fingerprint equals the names Live reports, or undefined. A device with no parameters of
   * its own is never matched (every such device looks the same). Several files with the same fingerprint count as a
   * match only when they describe the same parameters (a frozen and an unfrozen copy, say).
   */
  match(liveNames: string[]): M4lDevice | undefined {
    if (liveNames.length < 2) return undefined;
    this.scan();
    const key = fingerprint(liveNames);
    const hits = [...this.entries.values()].filter((e) => e.fingerprint === key);
    if (hits.length === 0) return undefined;
    const detail = (d: M4lDevice) => fingerprint(d.parameters.map((p) => `${p.longName}|${p.min}|${p.max}|${p.unit ?? ""}|${(p.choices ?? []).join(",")}`));
    const first = detail(hits[0].device);
    if (hits.every((h) => detail(h.device) === first)) return hits[0].device;
    this.options.log?.(`ambiguous Max for Live match: ${hits.map((h) => h.device.file).join(" vs ")}`);
    return undefined;
  }

  files(): { file: string; parameters: number; frozen: boolean }[] {
    this.scan();
    return [...this.entries.values()].map((e) => ({ file: e.device.file, parameters: e.device.parameters.length, frozen: e.device.frozen }));
  }
}

function fingerprint(names: string[]): string {
  return names.length + ":" + names.join("\u0000");
}
