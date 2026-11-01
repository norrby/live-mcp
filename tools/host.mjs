#!/usr/bin/env node
// host.mjs – runs the extension in Live's own Extension Host without the CLI (whose 10 s connect timeout kills it).
// Live must be running with Developer Mode on. Logs go to stdout; `npm run host > host.log &` keeps them.
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const env = Object.fromEntries(fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const modulePath = process.env.EXTENSION_HOST_PATH ?? env.EXTENSION_HOST_PATH;
if (!modulePath) throw new Error("EXTENSION_HOST_PATH missing (.env)");
const node = path.join(path.dirname(modulePath), "node");
const project = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const script = `require(${JSON.stringify(modulePath)}).initialize({extensions:[{path:${JSON.stringify(project)}}]})`;
const child = spawn(node, ["-e", script], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

// Started outside Live, the Extension Host outlives a Live that quits and goes on answering from the set as it was;
// it is stopped then (exit code LIVE_QUIT), so nothing reads a set that is no longer open.
const LIVE_QUIT = 3;
const live = spawnSync("pgrep", ["-x", "Live"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
if (live.length) {
  setInterval(() => {
    if (live.some((pid) => alive(pid))) return;
    console.log("Live has quit; stopping the Extension Host");
    child.removeAllListeners("exit");
    child.once("exit", () => process.exit(LIVE_QUIT));
    child.kill("SIGTERM");
  }, 2000).unref();
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
