// The trouble signal (M86 spec 05): when the phone shows one of its two trouble cards, "Cannot read a
// dialog" or "Send not landing", it tells the bridge it talks to, once, and the bridge's next daily
// ping carries the count. The signal holds exactly four names: which card, the agent program, its
// version and the multiplexer. Never a pane id, a host name, a path, a request id, the screen or what
// was typed.
//
// THE NAMES ARE THE REPORT'S OWN. The agent program and its version come from {@link harnessOf}, the
// same rule the report sheet titles its issue with (lib/report/body.ts), over the same two reads the
// sheet makes (the pane's send receipts and `GET /api/report/context`); the multiplexer is that
// context's `mux`. A harness is data here, never a branch.
//
// FIRE AND FORGET. One request per card instance or per streak, and at most one per kind, pane and UTC
// day on this device (once.ts), because a card that re-mounts is the same trouble. Never retried; a
// failed read or a failed send is dropped. With the count off on the bridge, the bridge drops it too.
// This file is pure; the one request is `signalTrouble` in store.ts.

import type { SendReceiptRow } from "../surface/send";
import type { ReportContext } from "./context";

/** Which trouble card showed. */
export type TroubleKind = "dialog" | "send";

/** The body of `POST /api/telemetry/trouble`, exactly. */
export interface TroubleSignal {
  readonly kind: TroubleKind;
  readonly harness: string;
  readonly version: string | null;
  readonly mux: string;
}

const HARNESS_WORD = /^[a-z0-9-]{1,24}$/;
/** The multiplexer is a plain word in the same shape, the bridge's own name for it. No list: the frontend reads capabilities, never a name. */
const MUX_WORD = /^[a-z0-9-]{1,24}$/;
const VERSION_WORD = /^v?\d+(\.\d+){1,3}([-+][0-9A-Za-z.+-]+)?$/;
const VERSION_MAX = 40;

/** The report's words for "no agent" (no pane) and "a plain shell": both count as `other`. */
const NOT_AN_AGENT: ReadonlySet<string> = new Set(["no pane", "shell"]);

/**
 * The signal, cleaned to the shape the bridge accepts. The harness word is lower case, digits and
 * dashes, at most 24 characters, else `other`; the version looks like one and is at most 40
 * characters, else null; the multiplexer word (the bridge's own, passed through) has the same shape, else `other`. Null for a
 * kind that is neither card. Pure.
 */
export function troubleSignal(a: {
  readonly kind: string;
  readonly harness: string | null | undefined;
  readonly version: string | null | undefined;
  readonly mux: string | null | undefined;
}): TroubleSignal | null {
  if (a.kind !== "dialog" && a.kind !== "send") return null;
  const word = a.harness?.trim().toLowerCase() ?? "";
  const harness = NOT_AN_AGENT.has(word) || !HARNESS_WORD.test(word) ? "other" : word;
  const raw = a.version?.trim() ?? "";
  const version = raw.length <= VERSION_MAX && VERSION_WORD.test(raw) ? raw : null;
  const muxWord = a.mux?.trim().toLowerCase() ?? "";
  const mux = MUX_WORD.test(muxWord) ? muxWord : "other";
  return { kind: a.kind, harness, version, mux };
}

// ── The report's own facts ───────────────────────────────────────────────────

/** The report's word for a receipt's or a context's harness: `no pane` with none, `shell` for a plain one. */
export function harnessWord(harness: string | null | undefined): string {
  if (harness === null || harness === undefined) return "no pane";
  return harness === "" ? "shell" : harness;
}

/** Which agent a report is about, and its version. */
export interface HarnessFacts {
  readonly harness: string;
  readonly version: string | null;
}

/** What {@link harnessOf} reads: the sends newest first, the bridge's context, and the dialog card's agent. */
export interface HarnessSources {
  readonly sends: readonly Pick<SendReceiptRow, "harness" | "version">[];
  readonly context: Pick<ReportContext, "harness"> | null;
  readonly dialog?: { readonly agent: string } | undefined;
}

/**
 * The newest receipt names the harness and its version; the context names the pane's agent when none
 * does, and the unread-dialog card's adapter when the context did not answer.
 */
export function harnessOf(input: HarnessSources): HarnessFacts {
  const newest = input.sends[0];
  if (newest !== undefined) return { harness: harnessWord(newest.harness), version: newest.version };
  return { harness: harnessWord(input.context?.harness ?? input.dialog?.agent), version: null };
}

/** The sends a report lists: the streak's own when the card named them and they are still there, else all. */
export function reportedSends(rows: readonly SendReceiptRow[], requestIds: readonly string[] | undefined): SendReceiptRow[] {
  if (requestIds === undefined || requestIds.length === 0) return [...rows];
  const named = rows.filter((row) => requestIds.includes(row.requestId));
  return named.length > 0 ? named : [...rows];
}
