// config.ts – port, bearer token, Max for Live search folders and the LiveRemote bridge. Kept in Live's storage
// directory for the extension; in dev mode (no storage directory) in local/config.json next to the project.
// Missing keys get defaults written back; the token is generated once and printed in the host log.
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
  bridge: { port: number; tokenFile?: string; token?: string };
  file: string;
}

export const DEFAULT_PORT = 9871;
export const DEFAULT_BRIDGE_PORT = 9870;

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
  // An explicit "" turns authentication off (loopback Host/Origin checks remain); anything else that is not a string is replaced.
  if (typeof data.token !== "string" || (data.token !== "" && data.token.length < 16)) (data.token = randomBytes(24).toString("base64url")), (changed = true);
  if (!Array.isArray(data.amxdDirectories)) (data.amxdDirectories = [path.join(os.homedir(), "Music", "Ableton", "User Library", "Presets")]), (changed = true);
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

/** The text a user pastes to connect a client: a Claude Code command and a VS Code (Copilot) mcp.json entry. */
export function connectText(config: Pick<Config, "port" | "token">): string {
  const url = `http://127.0.0.1:${config.port}/mcp`;
  const auth = config.token ? ` --header "Authorization: Bearer ${config.token}"` : "";
  const headers = config.token ? `, "headers": { "Authorization": "Bearer ${config.token}" }` : "";
  return [
    `# Live MCP is listening on ${url}`,
    config.token ? "" : "# Authentication is off (token is \"\" in config.json): any local program can use it; requests with an Origin header (browsers) are refused.",
    "",
    "## Claude Code",
    `claude mcp add -s user --transport http live ${url}${auth}`,
    "",
    "## VS Code / GitHub Copilot (.vscode/mcp.json or the user mcp.json)",
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
