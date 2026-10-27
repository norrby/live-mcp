import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseStatusAction, statusHtml, type StatusState } from "../src/ui/status.js";
import { connectLines, loadConfig, setToken } from "../src/config.js";
import { startHttp } from "../src/mcp/transport.js";

const quiet = () => {};
const base: StatusState = {
  version: "9.9.9",
  url: "http://127.0.0.1:9871/mcp",
  token: "",
  bridge: "not reachable",
  maxForLive: { known: 4, via: "bridge", errors: [] },
  requests: 0,
  connect: { claudeCode: "claude mcp add live", vsCode: `code --add-mcp '{"name":"live"}'` },
};

test("the status page says what runs, offers the token switch that fits, and escapes what it shows", () => {
  const off = statusHtml(base);
  assert.match(off, /Live MCP 9\.9\.9/);
  assert.match(off, /no assistant has connected yet/);
  assert.match(off, /not reachable: unzip LiveRemote/);
  assert.match(off, /4 devices known, read through the bridge/);
  assert.match(off, /send\('token_on'\)/);
  assert.doesNotMatch(off, /send\('token_off'\)/);
  assert.match(off, /code --add-mcp &#39;\{&quot;name&quot;:&quot;live&quot;\}&#39;/, "connect lines are escaped");

  const on = statusHtml({ ...base, token: "abc", bridge: "reachable", lastRequest: { secondsAgo: 75, what: "get_set({})" }, requests: 3, notice: "<b>hi</b>" });
  assert.match(on, /send\('token_off'\)/);
  assert.match(on, /1 min ago: get_set\(\{\}\) \(3 requests/);
  assert.match(on, /&lt;b&gt;hi&lt;\/b&gt;/);
  assert.match(on, /reachable: playback/);
});

test("the dialog's answer becomes an action; anything unexpected closes", () => {
  assert.deepEqual(parseStatusAction(JSON.stringify({ action: "token_on" })), { action: "token_on" });
  assert.deepEqual(parseStatusAction(JSON.stringify({ action: "token_off" })), { action: "token_off" });
  assert.deepEqual(parseStatusAction(JSON.stringify({ action: "rm -rf" })), { action: "close" });
  assert.deepEqual(parseStatusAction("not json"), { action: "close" });
  assert.deepEqual(parseStatusAction(undefined), { action: "close" });
});

test("switching the token on and off saves it, rewrites connect.txt, and the running server follows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-mcp-"));
  const config = loadConfig(dir, quiet);
  const server = startHttp({ port: 0, token: () => config.token, log: quiet, makeServer: () => new McpServer({ name: "t", version: "0" }) });
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const ping = (auth?: string) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }).then((r) => r.status);
  try {
    assert.equal(await ping(), 200);
    setToken(config, true, quiet);
    assert.ok(config.token.length >= 16);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).token, config.token);
    assert.match(fs.readFileSync(path.join(dir, "connect.txt"), "utf8"), new RegExp(config.token));
    assert.match(connectLines(config).claudeCode, /--header "Authorization: Bearer /);
    assert.equal(await ping(), 401, "the token applies at once");
    assert.equal(await ping(`Bearer ${config.token}`), 200);
    setToken(config, false, quiet);
    assert.equal(config.token, "");
    assert.equal(await ping(), 200);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true });
  }
});
