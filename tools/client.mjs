#!/usr/bin/env node
// client.mjs – talks to the running server like an MCP client would:  node tools/client.mjs <tool> '<json args>'
//   node tools/client.mjs list            (lists tools)      node tools/client.mjs get_set
//   node tools/client.mjs set_parameters '{"changes":[{"address":"t0/d0/p2","value":64}]}'
// Reads the token from local/config.json (or Live's storage dir via CONFIG=path).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as fs from "node:fs";

const config = JSON.parse(fs.readFileSync(process.env.CONFIG ?? new URL("../local/config.json", import.meta.url), "utf8"));
const [tool, args] = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${config.token}` } } });
const client = new Client({ name: "live-mcp-cli", version: "0.0.0" });
await client.connect(transport);
const t0 = performance.now();
let result;
if (!tool || tool === "list") result = (await client.listTools()).tools.map((t) => `${t.name}: ${t.description}`);
else if (tool === "resources") result = await client.listResources();
else if (tool === "read") result = await client.readResource({ uri: args });
else result = await client.callTool({ name: tool, arguments: args ? JSON.parse(args) : {} });
const ms = (performance.now() - t0).toFixed(1);
if (result?.content) for (const c of result.content) console.log(c.type === "text" ? tryPretty(c.text) : c);
else console.log(typeof result === "string" ? result : JSON.stringify(result, null, 1));
if (result?.isError) console.error("(tool error)");
console.error(`${ms} ms`);
await client.close();
function tryPretty(text) { try { return JSON.stringify(JSON.parse(text), null, 1); } catch { return text; } }
