// client.ts – talks to the LiveRemote control surface script (TCP, one JSON line per call) for what the Extensions
// API cannot do: routing, transport, selection, scenes and clips, undo, and display strings for built-in devices.
// Optional: when the script is not running every bridge tool explains that instead of failing silently.
// LiveRemote needs no token unless the user gave it one (bridge.token or bridge.tokenFile here, then).
import * as net from "node:net";
import * as fs from "node:fs";

export interface BridgeOptions {
  port: number;
  host?: string;
  token?: string;
  tokenFile?: string;
  timeoutMs?: number;
}

export class BridgeError extends Error {}

export class Bridge {
  constructor(readonly options: BridgeOptions) {}

  /** The token LiveRemote asks for, or undefined: by default LiveRemote needs none. */
  private token(): string | undefined {
    if (this.options.token) return this.options.token;
    if (this.options.tokenFile) {
      try {
        return fs.readFileSync(this.options.tokenFile, "utf8").trim();
      } catch (e) {
        throw new BridgeError(`bridge token file ${this.options.tokenFile} cannot be read: ${(e as Error).message}`);
      }
    }
    return undefined;
  }

  call<T = unknown>(cmd: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<T> {
    const token = this.token();
    const { port, host = "127.0.0.1", timeoutMs = 20_000 } = this.options;
    return new Promise<T>((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      let buf = "";
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        sock.destroy();
        fn();
      };
      sock.setTimeout(timeoutMs);
      sock.on("connect", () => sock.write(JSON.stringify(token ? { token, cmd, args, kwargs } : { cmd, args, kwargs }) + "\n"));
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        finish(() => {
          let r: { ok?: boolean; result?: T; error?: string };
          try {
            r = JSON.parse(line);
          } catch {
            return reject(new BridgeError(`bridge sent something that is not JSON: ${line.slice(0, 200)}`));
          }
          if (!r.ok) return reject(new BridgeError(`LiveRemote ${cmd}: ${lastLine(r.error ?? "unknown error")}`));
          resolve(r.result as T);
        });
      });
      sock.on("timeout", () => finish(() => reject(new BridgeError(`LiveRemote ${cmd}: no answer within ${timeoutMs} ms`))));
      sock.on("error", (e: NodeJS.ErrnoException) =>
        finish(() => reject(new BridgeError(`LiveRemote is not reachable on ${host}:${port} (${e.code ?? e.message}). Is it installed in the User Library's Remote Scripts folder and picked as a Control Surface in Live's Settings, Link, Tempo & MIDI?`))),
      );
      sock.on("close", () => finish(() => reject(new BridgeError(`LiveRemote ${cmd}: connection closed without an answer`))));
    });
  }

  /** The bridge as the Max for Live registry's way to the .amxd files when it may not read them itself. */
  amxdSource() {
    return {
      list: (directories: string[]) => this.call<{ file: string; mtime: number }[]>("amxd_list", [directories]),
      read: async (file: string) => Buffer.from(await this.call<string>("amxd_read", [file]), "base64"),
    };
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.call<string>("ping")) === "pong";
    } catch {
      return false;
    }
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1];
}
