// origins.ts – which .amxd file each Max for Live device in the set comes from, as far as anything says so.
// Live's API never tells which file a device was loaded from, so the registry otherwise has only the parameter
// fingerprint to go by, which cannot tell copies of one device apart and misses files outside the folders it reads.
// Three things do know: the saved set (it records each device's file), a load Live MCP made itself (it chose the
// file), and the folders under Places (where the user keeps devices). The LiveRemote bridge reads the first and
// the last; Live MCP remembers the second. The registry then reads those files too and prefers them.
import type { M4lRegistry } from "./registry.js";

/** What the bridge's m4l_sources answers. */
export interface M4lSources {
  /** the saved set's file, or null for a set never saved */
  set: string | null;
  /** the Max for Live devices as the saved set records them, at their addresses as of the last save */
  saved: { address: string; name: string; file: string | null }[];
  savedError?: string | null;
  /** the Max for Live devices in the set now */
  max: { address: string; name: string }[];
  /** the folders under Places in Live's browser */
  places: string[];
}

const SYNC_MS = 2_000;
/** A slow bridge (Live's main thread busy) does not hold up the tool; the answer is used once it arrives. */
const WAIT_MS = 3_000;

export class M4lOrigins {
  /** device id -> the file Live MCP loaded it from */
  private loaded = new Map<string, string>();
  /** device id -> the file the saved set names for the device at its address */
  private saved = new Map<string, string>();
  /** ids of the Max for Live devices in the set at the last look; undefined until the bridge has answered once */
  private maxIds?: Set<string>;
  private places: string[] = [];
  /** the saved set's file at the last look */
  setFile: string | null = null;
  private syncedAt = 0;
  private syncing?: Promise<void>;

  constructor(
    private readonly registry: M4lRegistry,
    private readonly fetch: () => Promise<M4lSources>,
    /** the device id at an address, or undefined when there is no device there */
    private readonly idAt: (address: string) => string | undefined,
  ) {}

  /** The file a device is known to come from, by its id. */
  originOf(id: string): string | undefined {
    return this.loaded.get(id) ?? this.saved.get(id);
  }

  /** Whether the device is a Max for Live device, as far as the last look through the bridge knows; undefined without one. */
  isMax(id: string): boolean | undefined {
    return this.maxIds?.has(id);
  }

  /** Remembers the file Live MCP just loaded a device from, and reads it, so the device is recognised at once. */
  async remember(id: string, file: string): Promise<void> {
    this.loaded.set(id, file);
    await this.apply();
  }

  /** Asks the bridge again (at most every two seconds, unless forced) and waits for the answer a short while. */
  async sync(force = false): Promise<void> {
    if (!this.syncing && (force || Date.now() - this.syncedAt >= SYNC_MS)) {
      this.syncing = this.fetch()
        .then((s) => this.take(s))
        .catch(() => undefined) // no bridge, or an older one: the fingerprint alone, as before
        .finally(() => {
          this.syncedAt = Date.now();
          this.syncing = undefined;
        });
    }
    if (this.syncing) await Promise.race([this.syncing, new Promise((r) => setTimeout(r, WAIT_MS))]);
  }

  private async take(s: M4lSources): Promise<void> {
    const ids = new Set<string>();
    for (const m of s.max ?? []) {
      const id = this.idAt(m.address);
      if (id) ids.add(id);
    }
    this.maxIds = ids;
    // A device deleted since is forgotten.
    for (const id of this.loaded.keys()) if (!ids.has(id)) this.loaded.delete(id);
    this.saved.clear();
    for (const d of s.saved ?? []) {
      const id = d.file ? this.idAt(d.address) : undefined;
      if (id && ids.has(id)) this.saved.set(id, d.file!);
    }
    this.places = s.places ?? [];
    this.setFile = s.set ?? null;
    await this.apply();
  }

  private apply(): Promise<void> {
    return this.registry.setExtra([...this.places, ...this.saved.values(), ...this.loaded.values()]);
  }
}
