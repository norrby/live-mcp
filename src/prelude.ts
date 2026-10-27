// prelude.ts – the Extension Host runs the bundle in a bare vm context: no URL, TextEncoder, crypto, fetch, AbortController.
// A function made by the main context's Function constructor evaluates there, so it can hand us the real globals.
// Only named globals are copied: enumerating the main global touches lazy getters (DOMException) that abort the process
// when called from a vm context. Imported first in extension.ts, so it runs before any dependency touches a global.
import * as fs from "node:fs";

const WANTED = [
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "crypto", "fetch", "Request", "Response", "Headers", "FormData", "Blob", "File",
  "AbortController", "AbortSignal", "EventTarget", "Event", "CustomEvent", "MessageChannel", "MessagePort", "MessageEvent",
  "ReadableStream", "WritableStream", "TransformStream", "ReadableStreamDefaultReader", "CompressionStream", "DecompressionStream",
  "structuredClone", "queueMicrotask", "setImmediate", "clearImmediate", "performance", "atob", "btoa", "WebSocket", "navigator",
  "Buffer", "process", "global",
];

const expr = "return {" + WANTED.map((k) => `${k}: typeof ${k} === "undefined" ? undefined : ${k}`).join(",") + "}";
const mainGlobals = (fs.readFileSync.constructor as (src: string) => () => Record<string, unknown>)(expr)();
export const installedGlobals: string[] = [];
for (const key of WANTED) {
  if (key in globalThis || mainGlobals[key] === undefined) continue;
  try {
    Object.defineProperty(globalThis, key, { value: mainGlobals[key], writable: true, configurable: true, enumerable: false });
    installedGlobals.push(key);
  } catch {
    // read-only on this context; leave it
  }
}
