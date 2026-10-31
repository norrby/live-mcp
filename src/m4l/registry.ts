// registry.ts – knows the .amxd files on disk and recognises them in the set by their parameter fingerprint:
// the short names Live reports, in Live's order, match exactly one file's liveOrder().
// A Markdown file beside an .amxd file with the same name is the author's guide to the device and travels with it.
// An installed extension may not read outside its own folder, so when the folders cannot be read directly the
// registry asks the LiveRemote bridge to list and read the files instead, in the background.
import * as fs from "node:fs";
import * as path from "node:path";
import { readAmxd, type M4lDevice } from "./amxd.js";
import { guideFileFor, parseGuide } from "./guide.js";

/** Lists and reads .amxd and .md files for the registry when it may not touch them itself (the LiveRemote bridge). */
export interface AmxdSource {
  list(directories: string[]): Promise<{ file: string; mtime: number }[]>;
  read(file: string): Promise<Buffer>;
}

export interface RegistryOptions {
  directories: string[];
  maxDepth?: number;
  maxFiles?: number;
  log?: (...a: unknown[]) => void;
  /** used once reading the folders directly turns out to be forbidden */
  fallback?: AmxdSource;
}

interface Entry {
  device: M4lDevice;
  mtimeMs: number;
  /** the guide file's modification time, or undefined when the device has none */
  guideMtimeMs?: number;
  fingerprint: string;
}

const isAmxd = (file: string) => file.toLowerCase().endsWith(".amxd");

const RESCAN_MS = 60_000;
const RETRY_MS = 5_000;

export class M4lRegistry {
  private entries = new Map<string, Entry>();
  private scannedAt = 0;
  private refreshing?: Promise<void>;
  /** "files" reads the folders directly; "bridge" goes through options.fallback */
  via: "files" | "bridge" = "files";
  /** through the bridge: every listed file has arrived (or was found unreadable), so the registry knows what it can */
  loaded = false;
  readonly errors: string[] = [];

  constructor(readonly options: RegistryOptions) {}

  /**
   * Rescans at most once a minute (it runs on the host's event loop); cheap when nothing changed (stat per file).
   * Through the bridge the rescan runs in the background and its result is used from the next call on.
   */
  scan(force = false): void {
    const now = Date.now();
    if (!force && now - this.scannedAt < RESCAN_MS) return;
    this.scannedAt = now;
    if (this.via === "bridge") {
      void this.refresh();
      return;
    }
    this.errors.length = 0;
    let forbidden = false;
    const seen = new Set<string>();
    let count = 0;
    const maxFiles = this.options.maxFiles ?? 500;
    const walk = (dir: string, depth: number) => {
      if (depth > (this.options.maxDepth ?? 6) || count >= maxFiles) return;
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        if (isForbidden(e)) forbidden = true;
        else this.errors.push(`${dir}: ${(e as Error).message}`);
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
    if (forbidden && this.options.fallback) {
      this.via = "bridge";
      this.options.log?.("Live does not let this extension read the Max for Live folders; asking the LiveRemote bridge instead");
      void this.refresh();
      return;
    }
    if (forbidden) this.errors.push("Live does not let this extension read the Max for Live folders");
    for (const key of this.entries.keys()) if (!seen.has(key)) this.entries.delete(key);
  }

  /** Lists and reads the files through the bridge; one refresh at a time. Resolves when it is done. */
  refresh(): Promise<void> {
    const source = this.options.fallback;
    if (!source) return Promise.resolve();
    this.refreshing ??= (async () => {
      const errors: string[] = [];
      try {
        const listed = await source.list(this.options.directories);
        const guides = new Map(listed.filter((f) => !isAmxd(f.file)).map((f) => [f.file, f.mtime]));
        const devices = listed.filter((f) => isAmxd(f.file)).slice(0, this.options.maxFiles ?? 500);
        const seen = new Set(devices.map((f) => f.file));
        for (const { file, mtime } of devices) {
          const have = this.entries.get(file);
          const guideFile = guideFileFor(file);
          const guideMtime = guides.get(guideFile);
          if (have && have.mtimeMs === mtime && have.guideMtimeMs === guideMtime) continue;
          try {
            // A bridge failure here ends the refresh as unfinished; an unreadable file is skipped with a note.
            const device = have && have.mtimeMs === mtime ? have.device : readAmxd(file, await source.read(file));
            if (guideMtime !== undefined) device.guide = parseGuide((await source.read(guideFile)).toString("utf8"), guideFile);
            else delete device.guide;
            this.put(file, mtime, device, guideMtime);
          } catch (e) {
            if (e instanceof Error && !/^[^:]*\.amxd: /.test(e.message) && !(e as NodeJS.ErrnoException).code) throw e;
            this.entries.delete(file);
            errors.push(`${file}: ${(e as Error).message}`);
          }
        }
        for (const key of this.entries.keys()) if (!seen.has(key)) this.entries.delete(key);
        this.loaded = true;
      } catch (e) {
        errors.push(`Max for Live files through the bridge: ${(e as Error).message}`);
        // The bridge was not there (Live still starting, say): try again soon rather than in a minute.
        this.scannedAt = Date.now() - RESCAN_MS + RETRY_MS;
      }
      this.errors.splice(0, this.errors.length, ...errors);
    })().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  /** Resolves once the registry knows the devices it can know: at once when it reads files itself or has loaded. */
  ready(): Promise<void> {
    if (this.via === "files" || this.loaded) return Promise.resolve();
    return this.refresh();
  }

  private load(file: string) {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      return;
    }
    const guideFile = guideFileFor(file);
    let guideMtimeMs: number | undefined;
    try {
      guideMtimeMs = fs.statSync(guideFile).mtimeMs;
    } catch {
      guideMtimeMs = undefined;
    }
    const have = this.entries.get(file);
    if (have && have.mtimeMs === mtimeMs && have.guideMtimeMs === guideMtimeMs) return;
    try {
      const device = have && have.mtimeMs === mtimeMs ? have.device : readAmxd(file);
      if (guideMtimeMs !== undefined) device.guide = parseGuide(fs.readFileSync(guideFile, "utf8"), guideFile);
      else delete device.guide;
      this.put(file, mtimeMs, device, guideMtimeMs);
    } catch (e) {
      this.entries.delete(file);
      this.errors.push(`${file}: ${(e as Error).message}`);
    }
  }

  private put(file: string, mtimeMs: number, device: M4lDevice, guideMtimeMs?: number) {
    this.entries.set(file, { device, mtimeMs, guideMtimeMs, fingerprint: fingerprint(device.parameters.map((p) => p.shortName)) });
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

/** Node's permission model, which Live applies to installed extensions, refuses with ERR_ACCESS_DENIED. */
export function isForbidden(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException;
  return err?.code === "ERR_ACCESS_DENIED" || /Access to this API has been restricted/.test(String(err?.message));
}

function fingerprint(names: string[]): string {
  return names.length + ":" + names.join("\u0000");
}
