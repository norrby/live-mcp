// install.ts – puts the LiveRemote control surface script into Live's User Library, so a user only has to pick it
// in Live's settings. A folder this extension did not write (a hand-made copy, say) is never touched; one it wrote
// is brought up to date when the script changes. Live loads the new script at its next start, or when the user
// picks the control surface again.
import * as fs from "node:fs";
import * as path from "node:path";
import { remoteScriptDirectory } from "../config.js";

/** Marks a LiveRemote folder as written by this extension; holds the version that wrote it. */
export const MARKER = ".installed-by-live-mcp";

export type InstallResult = "installed" | "updated" | "current" | "left alone" | "no user library" | "failed";

export function installRemoteScript(
  userLibrary: string,
  files: Record<string, string>,
  version: string,
  log: (...a: unknown[]) => void,
): InstallResult {
  const dir = remoteScriptDirectory(userLibrary);
  try {
    if (!fs.existsSync(userLibrary)) {
      log(`LiveRemote not installed: no User Library at ${userLibrary} (set userLibrary in config.json)`);
      return "no user library";
    }
    const exists = fs.existsSync(dir);
    if (exists && !fs.existsSync(path.join(dir, MARKER))) {
      log(`LiveRemote at ${dir} was not installed by this extension; left as it is`);
      return "left alone";
    }
    const same = exists && Object.entries(files).every(([name, text]) => readOrEmpty(path.join(dir, name)) === text);
    if (same) return "current";
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    fs.writeFileSync(path.join(dir, MARKER), version + "\n");
    log(
      exists
        ? `LiveRemote updated in ${dir}; Live uses the new version after a restart`
        : `LiveRemote installed in ${dir}; pick it as a Control Surface in Live's Settings, Link, Tempo & MIDI, to turn on the bridge`,
    );
    return exists ? "updated" : "installed";
  } catch (e) {
    log(`LiveRemote could not be installed in ${dir}: ${String(e)}`);
    return "failed";
  }
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
