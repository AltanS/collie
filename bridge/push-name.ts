// What a push, and a cache watch row, calls a pane (notifications.ts, "A push names a pane by its given
// name, never by the terminal title"). Pure and free of file access, so `cache/watch-key.ts` can use it
// as the push path does, and the two surfaces clean a name the same way.

import { givenName, type NameableP } from "./pane-name.ts";

const CONTROL_AND_BIDI_CHARS = /[\p{Cc}\p{Bidi_Control}]+/gu;

/**
 * Strip C0/C1 control characters and Unicode bidirectional overrides/isolates from notification
 * strings so embedded RLO/LRO or control bytes in a label, place or description cannot reorder
 * lock-screen text.
 */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_AND_BIDI_CHARS, "");
}

/**
 * What a push calls a pane: its given name (pane-name.ts `givenName`: Collie's rename, the person's
 * name in the harness, a named one-pane tab, the agent's own session title), cleaned of control and
 * bidi characters; else `shell` or the harness word. Never `terminalTitle`.
 */
export function pushName(pane: NameableP): string {
  const given = givenName(pane);
  const clean = given === null ? "" : stripControlChars(given).trim();
  if (clean) return clean;
  return pane.kind === "shell" ? "shell" : stripControlChars(pane.agent);
}
