// errors.ts – errors meant for the model to read: no stack, a sentence that says what to do instead.
export class LiveError extends Error {}

/** Turns anything thrown into a readable message; stale SDK handles become advice to list the set again. */
export function explain(e: unknown): string {
  if (e instanceof LiveError) return e.message;
  const text = e instanceof Error ? e.message : String(e);
  if (/Invalid object reference/.test(text)) return "that object no longer exists in Live (deleted or moved); call get_set for current addresses";
  if (/Object of incorrect type|Unknown object type/.test(text)) return "that handle is not an object this server can use; call get_set for current addresses";
  return `error: ${text}`;
}
