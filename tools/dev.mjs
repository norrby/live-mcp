#!/usr/bin/env node
// dev.mjs – the development loop without restarting Live: builds, runs the extension through host.mjs, and on every
// saved change under src/ builds again and restarts the host; a saved remote/LiveRemote/LiveRemote.py is copied into
// the User Library's Remote Scripts and reloaded in Live. Live must be running with Developer Mode on.
//   npm run dev                    LIVEREMOTE_DIR=<folder> overrides where LiveRemote is installed
// A restart waits while LiveRemote is busy (a device loading, say): restarting the host then once crashed Live.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const project = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const remoteSource = path.join(project, "remote", "LiveRemote", "LiveRemote.py");
const remoteDir = process.env.LIVEREMOTE_DIR ?? path.join(os.homedir(), "Music", "Ableton", "User Library", "Remote Scripts", "LiveRemote");
const say = (...a) => console.log(`[dev ${new Date().toLocaleTimeString()}]`, ...a);

/** One request to LiveRemote: its answer, "absent" when nothing listens, "busy" when it does not answer in time. */
function bridge(cmd, timeoutMs) {
  return new Promise((resolve) => {
    let token;
    try {
      token = fs.readFileSync(path.join(remoteDir, ".liveremote-token"), "utf8").trim() || undefined;
    } catch {}
    const sock = net.createConnection({ host: "127.0.0.1", port: 9870 });
    let buf = "";
    const done = (r) => (sock.destroy(), resolve(r));
    sock.setTimeout(timeoutMs, () => done("busy"));
    sock.on("connect", () => sock.write(JSON.stringify(token ? { token, cmd } : { cmd }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) done(JSON.parse(buf.slice(0, buf.indexOf("\n"))));
    });
    sock.on("error", () => done("absent"));
  });
}

async function whenLiveIsFree() {
  for (let waited = 0; (await bridge("ping", 2000)) === "busy"; waited++) {
    if (waited === 0) say("LiveRemote is busy (loading something?); waiting before the restart");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function build() {
  const r = spawnSync(process.execPath, ["--import", "tsx", "build.mts"], { cwd: project, stdio: "inherit" });
  return r.status === 0;
}

let host;
function startHost() {
  const h = spawn(process.execPath, [path.join(project, "tools", "host.mjs")], { cwd: project, stdio: "inherit" });
  host = h;
  h.on("exit", (code, signal) => {
    if (!h.stopping) say(`the host exited (${signal ?? code}); it starts again on the next change`);
    if (host === h) host = undefined;
  });
}
function stopHost() {
  if (!host) return Promise.resolve();
  const h = host;
  h.stopping = true;
  return new Promise((resolve) => {
    h.once("exit", resolve);
    h.kill("SIGTERM");
  });
}

let running = Promise.resolve();
const queue = (job) => (running = running.then(job).catch((e) => say("failed:", e.message)));

async function rebuild() {
  say("building");
  if (!build()) return say("build failed; the running host keeps the last good build");
  await whenLiveIsFree();
  await stopHost();
  startHost();
  say("host restarted");
}

async function reloadRemote() {
  const check = spawnSync("python3", ["-I", "-m", "py_compile", remoteSource], { stdio: "inherit" });
  if (check.status !== 0) return say("LiveRemote.py does not compile; not copied");
  if (!fs.existsSync(remoteDir)) return say(`${remoteDir} does not exist; install LiveRemote there first (README)`);
  fs.copyFileSync(remoteSource, path.join(remoteDir, "LiveRemote.py"));
  const r = await bridge("reload", 10_000);
  say(r === "absent" ? "LiveRemote copied; it is not running in Live, so it takes effect when it starts" : r?.ok ? "LiveRemote copied and reloaded" : `LiveRemote copied; reload: ${JSON.stringify(r)}`);
}

// Editors save in bursts (temp file, rename); act once things are quiet.
function debounced(fn, ms = 300) {
  let t;
  return () => (clearTimeout(t), (t = setTimeout(() => queue(fn), ms)));
}

if (!build()) say("the first build failed; fix it and save");
else startHost();
fs.watch(path.join(project, "src"), { recursive: true }, debounced(rebuild));
const reloadSoon = debounced(reloadRemote);
fs.watch(path.dirname(remoteSource), (_, name) => name === "LiveRemote.py" && reloadSoon());
say("watching src/ and remote/LiveRemote/LiveRemote.py; Ctrl+C stops");
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stopHost().then(() => process.exit(0)));
