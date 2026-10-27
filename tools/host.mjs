#!/usr/bin/env node
// host.mjs – runs the extension in Live's own Extension Host without the CLI (whose 10 s connect timeout kills it).
// Live must be running with Developer Mode on. Logs go to stdout; `npm run host > host.log &` keeps them.
import { spawn } from "node:child_process";
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
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
