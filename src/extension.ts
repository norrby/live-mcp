// extension.ts – entry point loaded by Live's Extension Host. Starts the MCP server on localhost.
import "./prelude.js";
import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { installedGlobals } from "./prelude.js";
import { connectLines, connectText, loadConfig, setToken, writeConnectFile } from "./config.js";
import { parseStatusAction, statusDialogUrl, statusHtml } from "./ui/status.js";
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
    const activity = { requests: 0, last: undefined as { at: number; what: string } | undefined };
    startHttp({
      port: config.port,
      token: () => config.token,
      onRequest: (what, status) => {
        if (what === "notifications/initialized" || status >= 400) return;
        activity.requests++;
        activity.last = { at: Date.now(), what };
      },
      log,
      makeServer: () => createServer({ live, registry, bridge, changes, version: VERSION, log }),
      health: () => ({ version: VERSION, tracks: live.song.tracks.length, knownDevices: registry.files().length }),
    });

    // "Live MCP status…" in the right-click menus of tracks, scenes and clip slots.
    const showStatus = async (notice?: string): Promise<void> => {
      const html = statusHtml({
        version: VERSION,
        url: `http://127.0.0.1:${config.port}/mcp`,
        token: config.token,
        bridge: (await bridge.ping()) ? "reachable" : "not reachable",
        maxForLive: { known: registry.files().length, via: registry.via, errors: registry.errors },
        lastRequest: activity.last && { secondsAgo: (Date.now() - activity.last.at) / 1000, what: activity.last.what },
        requests: activity.requests,
        connect: connectLines(config),
        notice,
      });
      const action = parseStatusAction(await context.ui.showModalDialog(statusDialogUrl(html), 620, 470));
      if (action.action === "close") return;
      setToken(config, action.action === "token_on", log);
      log(`token turned ${config.token ? "on" : "off"} from the status dialog`);
      return showStatus(
        config.token
          ? "Token on. Connected assistants must be connected again with the new lines below."
          : "Token off. Assistants connected with a token keep working; the token is simply no longer checked.",
      );
    };
    context.commands.registerCommand("live-mcp.status", () => {
      showStatus().catch((e) => log("status dialog failed:", String(e)));
    });
    for (const scope of ["MidiTrack", "AudioTrack", "Scene", "ClipSlot"] as const) {
      context.ui.registerContextMenuAction(scope, "Live MCP status…", "live-mcp.status").catch((e) => log(`cannot add the status menu item to ${scope}:`, String(e)));
    }
  } catch (e) {
    log("activation failed:", String((e as Error)?.stack ?? e));
  }
}
