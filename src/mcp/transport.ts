// transport.ts – MCP Streamable HTTP on node:http, stateless: every POST gets a fresh server, JSON in, JSON out.
// Written by hand because the SDK's own transport needs web Request/Response, which the Extension Host lacks.
// No sessions, no server-sent stream (GET is 405), batches answered in completion order.
import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpOptions {
  port: number;
  host?: string;
  path?: string;
  /** a token, or a function giving the current one (it can be switched on and off while running); "" means none */
  token?: string | (() => string);
  /** called once per answered request, with what was asked and the HTTP status */
  onRequest?: (what: string, status: number) => void;
  requestTimeoutMs?: number;
  log?: (...args: unknown[]) => void;
  makeServer: () => McpServer;
  health?: () => object;
}

const MAX_BODY = 4 * 1024 * 1024;
type Id = string | number;

class RequestTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly pending = new Set<Id>();
  readonly responses: JSONRPCMessage[] = [];
  constructor(private readonly done: (responses: JSONRPCMessage[]) => void) {}
  async start() {}
  async send(message: JSONRPCMessage) {
    if ("id" in message && message.id !== undefined && ("result" in message || "error" in message)) {
      this.responses.push(message);
      this.pending.delete(message.id);
      if (this.pending.size === 0) this.done(this.responses);
    }
    // server-initiated requests and notifications have nowhere to go in stateless mode
  }
  async close() {
    this.onclose?.();
  }
  feed(messages: JSONRPCMessage[]): boolean {
    for (const m of messages) if ("id" in m && m.id !== undefined && "method" in m) this.pending.add(m.id);
    const hasRequests = this.pending.size > 0;
    for (const m of messages) this.onmessage?.(m);
    return hasRequests;
  }
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BodyTooLarge("body too large"));
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.writableEnded || res.destroyed) return;
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

const rpcError = (id: Id | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function isLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A JSON-RPC 2.0 message: an object with jsonrpc "2.0" and either a method (request/notification) or a result/error. */
function isMessage(m: unknown): m is JSONRPCMessage {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return false;
  const o = m as Record<string, unknown>;
  if (o.jsonrpc !== "2.0") return false;
  if (o.params !== undefined && (typeof o.params !== "object" || o.params === null)) return false;
  if (typeof o.method === "string") return o.id === undefined || typeof o.id === "string" || typeof o.id === "number";
  return "result" in o || "error" in o;
}

export function startHttp(options: HttpOptions): http.Server {
  const path = options.path ?? "/mcp";
  const log = options.log ?? (() => {});
  const timeoutMs = options.requestTimeoutMs ?? 60_000;

  const server = http.createServer(async (req, res) => {
    try {
      const url = (req.url ?? "/").replace(/\?.*$/, "");
      if (!isLoopback(req.headers.host) || (req.headers.origin && !isLoopback(req.headers.origin.replace(/^https?:\/\//, "")))) {
        return reply(res, 403, { error: "loopback only" });
      }
      if (url === "/health" && req.method === "GET") return reply(res, 200, { ok: true, ...(options.health?.() ?? {}) });
      if (url !== path) return reply(res, 404, { error: "not found" });
      const token = typeof options.token === "function" ? options.token() : options.token;
      if (token && !tokenMatches(req.headers.authorization, token)) return reply(res, 401, { error: "bad or missing bearer token" });
      // Without a token every local program may call; browsers (which always send Origin) still may not.
      if (!token && req.headers.origin) return reply(res, 403, { error: "browser requests are refused while no token is configured" });
      if (req.method === "GET") return reply(res, 405, { error: "no server-sent stream in stateless mode" }, { allow: "POST" });
      if (req.method !== "POST") return reply(res, 405, { error: "POST only" }, { allow: "POST" });

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch (e) {
        if (e instanceof BodyTooLarge) return reply(res, 413, rpcError(null, -32600, `body larger than ${MAX_BODY} bytes`), { connection: "close" });
        return reply(res, 400, rpcError(null, -32700, `parse error: ${String(e)}`));
      }
      const batch = Array.isArray(parsed);
      const messages = batch ? (parsed as unknown[]) : [parsed];
      if (messages.length === 0 || !messages.every(isMessage)) return reply(res, 400, rpcError(null, -32600, "invalid request: expected JSON-RPC 2.0 message(s)"));
      const ids = (messages as JSONRPCMessage[]).filter((m) => "method" in m && "id" in m && m.id !== undefined).map((m) => (m as { id: Id }).id);
      if (new Set(ids).size !== ids.length) return reply(res, 400, rpcError(null, -32600, "invalid request: duplicate request ids in one batch"));

      const t0 = performance.now();
      const describe = (messages as JSONRPCMessage[])
        .filter((m) => "method" in m)
        .map((m) => {
          const r = m as { method: string; params?: { name?: string; arguments?: unknown; uri?: string } };
          if (r.method === "tools/call") return `${r.params?.name}(${JSON.stringify(r.params?.arguments ?? {})})`;
          return r.params?.uri ? `${r.method} ${r.params.uri}` : r.method;
        })
        .join(", ");
      let finished = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (status: number, body: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reply(res, status, body);
        const errors = ([] as unknown[]).concat(body ?? []).filter((b) => (b as { error?: unknown; result?: { isError?: boolean } })?.error || (b as { result?: { isError?: boolean } })?.result?.isError).length;
        log(`${status} ${describe} ${(performance.now() - t0).toFixed(0)} ms${errors ? ` (${errors} error)` : ""}`);
        options.onRequest?.(describe, status);
        void mcp.close().catch(() => {});
      };
      const transport = new RequestTransport((responses) => finish(200, batch ? responses : responses[0]));
      transport.onerror = (e) => log("mcp error:", String(e));
      const mcp = options.makeServer();
      res.on("close", () => finish(499, undefined));
      await mcp.connect(transport);
      timer = setTimeout(() => {
        const errors = [...transport.pending].map((id) => rpcError(id, -32000, `no answer from Live within ${timeoutMs} ms; the operation may still complete`));
        finish(200, batch ? [...transport.responses, ...errors] : errors[0]);
      }, timeoutMs);
      if (!transport.feed(messages as JSONRPCMessage[])) finish(202, undefined);
    } catch (e) {
      log("http error:", String(e));
      reply(res, 500, { error: String(e) });
    }
  });
  server.on("error", (e) => log("http server error:", String(e)));
  server.listen(options.port, options.host ?? "127.0.0.1", () => log(`MCP listening on http://${options.host ?? "127.0.0.1"}:${options.port}${path}`));
  return server;
}
