import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { connectText, defaultUserLibrary, loadConfig, writeConnectFile } from "../src/config.js";

const quiet = () => {};

test("loadConfig starts without a token, keeps a chosen one, defaults the User Library, and writes connect.txt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-mcp-"));
  const first = loadConfig(dir, quiet);
  assert.equal(first.token, "");
  assert.equal(first.userLibrary, defaultUserLibrary());
  assert.deepEqual(first.amxdDirectories, [path.join(first.userLibrary, "Presets")]);
  assert.equal(first.bridge.tokenFile, undefined, "LiveRemote needs no token by default");

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ token: "a-token-of-twenty-chars", bridge: { port: 1, tokenFile: "/x" } }));
  const kept = loadConfig(dir, quiet);
  assert.equal(kept.token, "a-token-of-twenty-chars");
  assert.equal(kept.bridge.tokenFile, "/x", "a configured bridge token file is kept");

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 9999, token: "" }));
  const open = loadConfig(dir, quiet);
  assert.equal(open.token, "");
  assert.equal(open.port, 9999);

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ token: "short" }));
  assert.ok(loadConfig(dir, quiet).token.length >= 16, "a short token is replaced");

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: 9999, token: "" }));
  fs.writeFileSync(path.join(dir, "connect.txt"), "old", { mode: 0o644 });
  const file = writeConnectFile(open, quiet);
  assert.ok(file);
  assert.equal(fs.statSync(file!).mode & 0o777, 0o600, "an existing connect.txt is made private");
  const text = fs.readFileSync(file!, "utf8");
  assert.match(text, /claude mcp add -s user --transport http live http:\/\/127\.0\.0\.1:9999\/mcp\n/);
  assert.match(text, /No token/);
  assert.match(text, /code --add-mcp '\{"name":"live","type":"http","url":"http:\/\/127\.0\.0\.1:9999\/mcp"\}'/);
  assert.doesNotMatch(text, /Authorization/);

  const withToken = connectText({ port: 9871, token: "abc" });
  assert.match(withToken, /--header "Authorization: Bearer abc"/);
  assert.match(withToken, /"headers": \{ "Authorization": "Bearer abc" \}/);
  fs.rmSync(dir, { recursive: true });
});

