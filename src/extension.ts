// extension.ts – entry point loaded by Live's Extension Host. Starts the MCP server on localhost.
import "./prelude.js";
import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { installedGlobals } from "./prelude.js";
import { connectText, loadConfig, writeConnectFile } from "./config.js";
import { LiveAdapter } from "./live/adapter.js";
import { M4lRegistry } from "./m4l/registry.js";
import { Bridge } from "./bridge/client.js";
import { ChangeTracker } from "./live/changes.js";
import { createServer } from "./mcp/server.js";
import { startHttp } from "./mcp/transport.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0";

export function activate(activation: ActivationContext) {
  const log = (...a: unknown[]) => console.log(...a);
  try {
    process.on("uncaughtException", (e) => log("uncaught exception:", String(e?.stack ?? e)));
    process.on("unhandledRejection", (e) => log("unhandled rejection:", String((e as Error)?.stack ?? e)));
  } catch (e) {
    log("cannot install process handlers:", String(e));
  }
  try {
    const context = initialize(activation, "1.0.0");
    const live = new LiveAdapter(context);
    const config = loadConfig(context.environment.storageDirectory, log);
    const bridge = new Bridge(config.bridge);
    const registry = new M4lRegistry({ directories: config.amxdDirectories, log, fallback: bridge.amxdSource() });
    const changes = new ChangeTracker(live);
    const installed = Boolean(context.environment.storageDirectory);
    const shownToken = !config.token ? "none (authentication off)" : installed ? config.token.slice(0, 4) + "…" + config.token.slice(-4) : config.token;
    log(`live-mcp ${VERSION}; globals installed: ${installedGlobals.length}; config ${config.file}; token ${shownToken}`);
    const connectFile = writeConnectFile(config, log);
    // The full connect command goes to the log only while developing; an installed extension logs into Live's log file, which users share.
    if (installed && connectFile) log(`connect a client with the lines in ${connectFile}`);
    else log(`connect a client with:\n${connectText(config)}`);
    try {
      registry.scan(true);
      if (registry.via === "files") log(`Max for Live devices known: ${registry.files().length} from ${config.amxdDirectories.join(", ")}${registry.errors.length ? `; errors: ${registry.errors.join("; ")}` : ""}`);
      else void registry.refresh().then(() => log(`Max for Live devices known through the bridge: ${registry.files().length}${registry.errors.length ? `; ${registry.errors.join("; ")}` : ""}`));
    } catch (e) {
      log("amxd scan failed:", String(e));
    }
    startHttp({
      port: config.port,
      token: config.token,
      log,
      makeServer: () => createServer({ live, registry, bridge, changes, version: VERSION, log }),
      health: () => ({ version: VERSION, tracks: live.song.tracks.length, knownDevices: registry.files().length }),
    });
  } catch (e) {
    log("activation failed:", String((e as Error)?.stack ?? e));
  }
}
