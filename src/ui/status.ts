// status.ts – the "Live MCP status…" dialog: what is running, whether the bridge answers, how to connect a client,
// and the one setting a user may want to change from inside Live: whether clients need a token.
// The page is built as a string and shown with ui.showModalDialog; it answers with close_and_send (see the SDK docs).

export interface StatusState {
  version: string;
  url: string;
  /** "" means no token */
  token: string;
  readOnly: boolean;
  bridge: "reachable" | "not reachable";
  maxForLive: { known: number; via: "files" | "bridge"; errors: string[] };
  lastRequest?: { secondsAgo: number; what: string };
  requests: number;
  connect: { claudeCode: string; vsCode: string };
  /** a message from the last action, shown at the top */
  notice?: string;
}

/** What the dialog answers with; anything else (or nothing) means "close". */
export type StatusAction = { action: "token_on" | "token_off" | "read_only_on" | "read_only_off" } | { action: "close" };
const ACTIONS = ["token_on", "token_off", "read_only_on", "read_only_off"] as const;

export function parseStatusAction(result: string | undefined): StatusAction {
  try {
    const parsed = JSON.parse(result ?? "") as { action?: unknown };
    const action = ACTIONS.find((a) => a === parsed.action);
    if (action) return { action };
  } catch {
    // closed with the window button, or nothing sent
  }
  return { action: "close" };
}

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function ago(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

export function statusHtml(s: StatusState): string {
  const row = (label: string, value: string, ok?: boolean) =>
    `<tr><th>${esc(label)}</th><td${ok === undefined ? "" : ` class="${ok ? "ok" : "warn"}"`}>${value}</td></tr>`;
  const client = s.lastRequest
    ? `${esc(ago(s.lastRequest.secondsAgo))}: ${esc(s.lastRequest.what)} (${s.requests} requests since Live started)`
    : "no assistant has connected yet";
  const bridge =
    s.bridge === "reachable"
      ? "reachable: playback, routing, browser, undo and automation work"
      : "not reachable: unzip LiveRemote into the User Library's Remote Scripts folder and pick it as a Control Surface in Settings, Link, Tempo &amp; MIDI";
  const m4l = `${s.maxForLive.known} devices known${s.maxForLive.via === "bridge" ? ", read through the bridge" : ""}${s.maxForLive.errors.length ? ` (${esc(s.maxForLive.errors[0])})` : ""}`;
  const token = s.token
    ? `on: clients must send it (it is in the lines below). <button onclick="send('token_off')">Stop requiring a token</button>`
    : `off: programs on this computer can connect, web pages cannot. <button onclick="send('token_on')">Require a token</button>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Live MCP</title>
<script>
function post(message) {
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) window.webkit.messageHandlers.live.postMessage(message);
  else if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(message);
}
function send(action) { post({ method: "close_and_send", params: [JSON.stringify({ action: action })] }); }
function pick(el) { el.focus(); el.select(); }
</script>
<style>
:root { --bg: #383838; --panel: #4e4e4e; --text: #f0f0f0; --dim: #b8b8b8; --accent: #ffa500; --ok: #9ad08a; --warn: #f0b060; --field: #2c2c2c; }
body { background: var(--panel); color: var(--text); font: 13px -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 16px 18px; }
h1 { font-size: 15px; margin: 0 0 10px; }
.notice { background: var(--bg); border-left: 3px solid var(--accent); padding: 6px 10px; margin-bottom: 10px; }
table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
th { text-align: left; color: var(--dim); font-weight: normal; padding: 4px 10px 4px 0; vertical-align: top; white-space: nowrap; }
td { padding: 4px 0; }
td.ok { color: var(--ok); } td.warn { color: var(--warn); }
h2 { font-size: 13px; margin: 12px 0 4px; color: var(--dim); font-weight: normal; }
textarea { width: 100%; box-sizing: border-box; background: var(--field); color: var(--text); border: 1px solid #2a2a2a; font: 12px ui-monospace, Menlo, Consolas, monospace; padding: 6px; resize: none; }
button { background: var(--accent); color: #000; border: none; padding: 4px 10px; margin-left: 6px; cursor: pointer; }
.close { float: right; margin-top: 10px; }
</style></head><body>
<h1>Live MCP ${esc(s.version)}</h1>
${s.notice ? `<div class="notice">${esc(s.notice)}</div>` : ""}
<table>
${row("Server", `listening on ${esc(s.url)}`, true)}
${row("Assistant", client, Boolean(s.lastRequest))}
${row("LiveRemote bridge", bridge, s.bridge === "reachable")}
${row("Max for Live", m4l)}
${row("Changes", s.readOnly
    ? `read-only: assistants can look but not change anything. <button onclick="send('read_only_off')">Allow changes</button>`
    : `allowed. <button onclick="send('read_only_on')">Make read-only</button>`, !s.readOnly)}
${row("Token", token)}
</table>
<h2>Connect Claude Code (run in a terminal; click the text, then copy)</h2>
<textarea rows="2" readonly onclick="pick(this)">${esc(s.connect.claudeCode)}</textarea>
<h2>Connect VS Code with GitHub Copilot</h2>
<textarea rows="2" readonly onclick="pick(this)">${esc(s.connect.vsCode)}</textarea>
<button class="close" onclick="send('close')">Close</button>
</body></html>`;
}

export const statusDialogUrl = (html: string) => `data:text/html,${encodeURIComponent(html)}`;
