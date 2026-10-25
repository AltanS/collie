// The Clear receipt's wire shape and its closed lists (ADR 0116, the Clear paragraph). `POST
// /api/pane/:id/clear` on a pane with a screen takes `{ requestId }` and empties the harness's input box
// with the profile's clear key (`keys.clear`), the step the Send Protocol already uses to replace a
// draft. A `cleared` receipt carries the text it cleared, so the phone can offer Restore. The bridge runs it (bridge/surface/clear.ts); the phone posts the body and renders the receipt.
// Both read the types from here, so the lists cannot drift apart.
//
// Pure: no DOM, no Bun API, no harness name.

/** What the phone posts: one request id, the same shape as a send's and a Stop's. */
export interface ClearBody {
  readonly requestId: string;
}

/**
 * `cleared`: the clear key went in and a read-back shows the box free (empty, and no dialog). `refused`:
 * the box was not cleared, with one reason. `unknown` is the phone's word, never the bridge's: no
 * receipt came back (a crew member that did not answer the lead in time), so the key may have gone in.
 */
export const CLEAR_OUTCOMES = ["cleared", "refused", "unknown"] as const;
export type ClearOutcome = (typeof CLEAR_OUTCOMES)[number];

/**
 * Why the box was not cleared. `no_profile`: Collie has no reader for this pane, so it does not press
 * blind. `no_draft`: the box already reads empty. `dialog_open`: a dialog is up and a key would reach it.
 * `unreadable`: Collie cannot tell what the box holds. `press_failed`: the multiplexer refused the keys,
 * or the box still holds text after the press; what remains is left alone, never pressed at again blind.
 * `pane_gone`: the multiplexer could not read the pane. `stale_screen`: the box on the screen did not
 * take a probe character and a second read showed the same rows, so it is a stale image; nothing was deleted
 * (2026-10-25). `unsupported_build` is the phone's word, never
 * the bridge's: the machine that owns the pane runs a build with no Clear (its route answered a bare 404,
 * a 400 or a 405 instead of a receipt), so nothing was pressed.
 */
export const CLEAR_REASONS = ["no_profile", "no_draft", "dialog_open", "unreadable", "press_failed", "pane_gone", "stale_screen", "unsupported_build"] as const;
export type ClearReason = (typeof CLEAR_REASONS)[number];

/** The receipt a Clear answers, and the same one again for the same request id. */
export interface ClearReceipt {
  readonly requestId: string;
  readonly outcome: ClearOutcome;
  /** Set on a refusal. */
  readonly reason?: ClearReason;
  /**
   * Set on `cleared` when the box held text: the draft as the read before the press showed it, one line
   * (the box's rows joined with a space), at most {@link CLEAR_DRAFT_MAX_BYTES}. The phone keeps it for a
   * Restore. It is the operator's own text, behind the same write gate as the tap: the bridge never logs
   * it and never puts it on the audit line.
   */
  readonly draft?: string;
}

/** The most UTF-8 bytes a receipt's {@link ClearReceipt.draft} carries. */
export const CLEAR_DRAFT_MAX_BYTES = 8 * 1024;

/** A draft cut to {@link CLEAR_DRAFT_MAX_BYTES} on a character boundary, with no line break or tab: one line, as the box showed it. */
export function boundedDraft(text: string): string {
  const line = text.replace(/[\r\n\t]+/gu, " ");
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= CLEAR_DRAFT_MAX_BYTES) return line;
  let bytes = 0;
  let out = "";
  for (const char of line) {
    bytes += encoder.encode(char).length;
    if (bytes > CLEAR_DRAFT_MAX_BYTES) break;
    out += char;
  }
  return out;
}

/** The request id's grammar is the Send Protocol's: see `REQUEST_ID` in ./send. */
