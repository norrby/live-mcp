// config.ts – port, bearer token, Max for Live search folders and the LiveRemote bridge. Kept in Live's storage
// directory for the extension; in dev mode (no storage directory) in local/config.json next to the project.
// Missing keys get defaults written back. A new config has no token: the server is reachable from this computer only
// and refuses browsers, which is what a stdio MCP server offers too; a token can be set for more.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export interface Config {
  port: number;
  /** bearer token every request must carry; "" means no authentication */
  token: string;
  /** folders searched (recursively) for .amxd files, to recognise Max for Live devices in the set */
  amxdDirectories: string[];
  /** LiveRemote needs no token unless one was given to it; then the same token here, or the file that holds it */
  bridge: { port: number; tokenFile?: string; token?: string };
  /** Live's User Library: Max for Live devices are searched in its Presets folder */
  userLibrary: string;
  file: string;
}

export const DEFAULT_PORT = 9871;
export const DEFAULT_BRIDGE_PORT = 9870;

/** Where Live keeps the User Library unless the user moved it. */
export function defaultUserLibrary(home = os.homedir(), platform = process.platform): string {
  return path.join(home, platform === "win32" ? "Documents" : "Music", "Ableton", "User Library");
}

export function loadConfig(storageDirectory: string | undefined, log: (...a: unknown[]) => void): Config {
  const dir = storageDirectory ?? path.join(__dirname, "..", "local");
  const file = path.join(dir, "config.json");
  let data: Partial<Config> = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // first start, or unreadable: regenerate below
  }
  let changed = false;
  if (typeof data.port !== "number") (data.port = DEFAULT_PORT), (changed = true);
  // "" (the default) means no authentication; the loopback Host/Origin checks remain. A token shorter than 16
  // characters shows that one is wanted but is too weak, so a strong one replaces it.
  if (typeof data.token !== "string") (data.token = ""), (changed = true);
  else if (data.token !== "" && data.token.length < 16) (data.token = randomBytes(24).toString("base64url")), (changed = true);
  if (typeof data.userLibrary !== "string" || !data.userLibrary) (data.userLibrary = defaultUserLibrary()), (changed = true);
  if (!Array.isArray(data.amxdDirectories)) (data.amxdDirectories = [path.join(data.userLibrary, "Presets")]), (changed = true);
  if (!data.bridge || typeof data.bridge !== "object") (data.bridge = { port: DEFAULT_BRIDGE_PORT }), (changed = true);
  if (typeof data.bridge.port !== "number") (data.bridge.port = DEFAULT_BRIDGE_PORT), (changed = true);
  if (changed) {
    const { file: _f, ...toWrite } = data as Config;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(toWrite, null, 2) + "\n", { mode: 0o600 });
      log(`wrote ${file}`);
    } catch (e) {
      log(`cannot write ${file}: ${String(e)} (token lives only in this log)`);
    }
  }
  return { ...(data as Config), file };
}

/** The text a user pastes to connect a client: a Claude Code command and a VS Code (Copilot) command and mcp.json entry. */
export function connectText(config: Pick<Config, "port" | "token">): string {
  const url = `http://127.0.0.1:${config.port}/mcp`;
  const auth = config.token ? ` --header "Authorization: Bearer ${config.token}"` : "";
  const headers = config.token ? `, "headers": { "Authorization": "Bearer ${config.token}" }` : "";
  return [
    `# Live MCP is listening on ${url}`,
    config.token ? "" : "# No token: programs on this computer can connect; web pages cannot.",
    "",
    "## Claude Code",
    `claude mcp add -s user --transport http live ${url}${auth}`,
    "",
    "## VS Code / GitHub Copilot",
    `code --add-mcp '{"name":"live","type":"http","url":"${url}"${headers}}'`,
    "",
    "## or by hand in .vscode/mcp.json or the user mcp.json",
    `{ "servers": { "live": { "type": "http", "url": "${url}"${headers} } } }`,
    "",
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
}

/** Writes connect.txt next to config.json so the user copies one line instead of a token. Returns its path, or undefined. */
export function writeConnectFile(config: Config, log: (...a: unknown[]) => void): string | undefined {
  const file = path.join(path.dirname(config.file), "connect.txt");
  try {
    fs.writeFileSync(file, connectText(config), { mode: 0o600 });
    fs.chmodSync(file, 0o600); // the mode above applies only when the file is created
    return file;
  } catch (e) {
    log(`cannot write ${file}: ${String(e)}`);
    return undefined;
  }
}
