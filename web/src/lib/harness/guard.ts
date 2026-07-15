// Model-GENERIC race-guard machinery, factored out of the three harness action files
// (prompt-action, wizard-action, preview-action). Every one of them tapped a menu/wizard/dialog
// button that types into a REAL terminal, and the pane may have moved on between render and tap —
// so before sending they all re-fetch the pane, confirm the revision, and re-derive the model to
// compare against what the user tapped. That skeleton (fresh read → parse → detect → unconditional
// revision check → structural-equality check) is identical across all three; only the model type
// M, its detector, and its equality function differ. Those become the generic parameters here.

import { fetchPane } from "../api";
import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";

/**
 * The canonical result of a guarded action. `sent` = the keystrokes went through; `changed` = the
 * guard rejected the tap (the pane drifted underfoot) and the caller should refresh; `error` = a
 * transport/RPC failure the caller surfaces verbatim.
 */
export type ActionResult =
  | { status: "sent" }
  | { status: "changed" }
  | { status: "error"; error: string };

/** Test seam for the verification polls' pacing. */
export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded verification polling between choreography steps (the TUI re-renders well under a
// second; ~3s total before we give up and refresh).
export const POLL_ATTEMPTS = 8;
export const POLL_DELAY_MS = 350;

/** Derive the on-screen dialog model from a fresh pane's styled lines (null = no dialog there). */
type Detect<M> = (lines: StyledLine[]) => M | null;

/** One fresh read + re-derivation. Returns the model (null = no dialog on screen). */
export async function readModel<M>(
  paneId: string,
  requestedLines: number,
  session: string | undefined,
  detect: Detect<M>,
): Promise<{ revision: number; model: M | null }> {
  const fresh = await fetchPane(paneId, requestedLines, session);
  return { revision: fresh.revision, model: detect(splitLines(parseAnsi(fresh.text))) };
}

/**
 * The shared entry guard: a FRESH pane read, the UNCONDITIONAL revision check, and a full model
 * re-derivation compared (via `equals`) against `tapped` — what the user actually tapped. Returns a
 * terminal `ActionResult` when the guard fails ("changed") or the read errors, or `null` when the
 * guard passes and the caller may proceed to send.
 */
export async function entryGuard<M>(
  args: {
    paneId: string;
    requestedLines: number;
    /** The `revision` the rendered dialog was detected against. */
    detectedRevision: number;
    /** The session the pane lives in (undefined = primary) — scopes the read. */
    session?: string;
  },
  tapped: M,
  detect: Detect<M>,
  equals: (a: M, b: M) => boolean,
): Promise<ActionResult | null> {
  let fresh;
  try {
    fresh = await readModel(args.paneId, args.requestedLines, args.session, detect);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  // Revision check is UNCONDITIONAL: a 304 only means "unchanged since the last poll", and polls
  // keep advancing the ETag cache under a frozen mirror — it does NOT vouch for the snapshot the
  // user actually tapped on. The cached 304 body carries its revision, so this covers both paths.
  if (fresh.revision !== args.detectedRevision) return { status: "changed" };
  // EMPIRICAL (Herdr 0.7.x, live-verified 2026-07-05): pane.read's `revision` is a stub upstream —
  // it is always 0, even for actively-changing panes. The gate above is therefore defense-in-depth
  // for future Herdr versions, NOT load-bearing. So the model re-derivation below runs on EVERY
  // path, including 304: the fresh (= latest cached) text is exactly what a tap on a possibly
  // frozen mirror must be compared against. One parse per tap — taps are rare, correctness isn't.
  if (!fresh.model || !equals(fresh.model, tapped)) return { status: "changed" };
  return null;
}

/**
 * Poll (bounded) until `accept` passes on a fresh re-derivation. THREE-VALUED, because the caller
 * must distinguish "the awaited state never arrived, but this is still our dialog" from "a different
 * dialog is on screen now":
 *   - `"ok"`      — `accept` passed.
 *   - `"drifted"` — the dialog's IDENTITY changed: a fresh model whose `identity` no longer matches
 *                   `tapped` (a same-shaped successor / another dialog entirely), OR the dialog is
 *                   GONE (every read re-derived to null — e.g. the agent is running again). No
 *                   further key may be sent: a blind keystroke would hit whatever replaced it.
 *   - `"timeout"` — our dialog stayed on screen (identity intact) but the awaited state never came
 *                   within the bounded window (e.g. a swallowed keystroke). The dialog is still ours,
 *                   so a bounded RETRY of the same key is safe.
 * A transient null re-derivation MID-poll keeps polling (the TUI redraw can briefly hide the tail);
 * only an all-null poll (the dialog truly vanished) resolves to `"drifted"`.
 */
export async function pollUntil<M>(
  args: {
    paneId: string;
    requestedLines: number;
    /** The session the pane lives in (undefined = primary) — scopes every read. */
    session?: string;
    /** Test seam for the poll pacing. */
    sleep?: Sleep;
  },
  tapped: M,
  detect: Detect<M>,
  accept: (m: M) => boolean,
  identity: (a: M, b: M) => boolean,
): Promise<"ok" | "drifted" | "timeout"> {
  const sleep = args.sleep ?? defaultSleep;
  let sawDialog = false;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_DELAY_MS);
    let fresh;
    try {
      fresh = await readModel(args.paneId, args.requestedLines, args.session, detect);
    } catch {
      continue; // transient read failure — the bounded loop is the timeout
    }
    if (!fresh.model) continue; // transient redraw hid the tail — keep polling
    sawDialog = true;
    if (accept(fresh.model)) return "ok";
    if (!identity(fresh.model, tapped)) return "drifted"; // a different dialog now
  }
  // Exhausted. If we never saw the dialog at all it has vanished (a now-running agent) — treat as
  // drift, NOT a retryable timeout, so no blind key is sent at whatever replaced it.
  return sawDialog ? "timeout" : "drifted";
}

/**
 * Sanitize free text before it is typed into a focused TUI input via the reply path. Collapse
 * whitespace to single spaces FIRST (so \t \n \r become word boundaries, not glue), then strip any
 * remaining C0/C1 control chars. Pasted clipboard text can smuggle in ESC (\x1b — blurs/cancels the
 * dialog), BEL (\x07 — "edit in nano"), ETX (\x03), etc., which the reply path would deliver
 * straight into the focused input BEFORE the readback check — so they must never reach it.
 */
export function sanitizeTypedText(text: string, maxLen: number): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, maxLen);
}
