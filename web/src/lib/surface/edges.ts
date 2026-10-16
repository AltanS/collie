// Hook edges: what a harness's own hook says about a turn, as an input to the fold (M56 spec 11; the
// contract is in the M56 README, "Surface", and experiments/reader-stability/ARCHITECTURE.md section 1).
//
// Hooks are edges, not levels. An edge marks the last screen read stale and asks for a fresh read. It
// may say "a turn runs" or "a modal is up". It may close a send receipt as effective. It never makes a
// `free`: only the screen may say `modal: none` and `composer: empty | draft`.
//
// The kinds are neutral words. A profile maps its harness's own hook event names to them
// (`profile.edges.events`), so this module and the fold name no harness.
//
// Pure: no DOM, no Bun API, no harness name.

import { shortHash } from "./surface";

/**
 * What one edge is for the fold.
 *  - `prompt`: a prompt went in, so a turn runs. It opens a running block and may close a receipt.
 *  - `stop`: the turn says it ended. A drift witness and a closing edge: the turn moves to idle only
 *    when the screen agrees.
 *  - `dialog`: the harness asks the person something. It opens a modal block until the screen lifts
 *    the ask, or a block end.
 *  - `start`: a session started in the pane. A closing edge.
 *  - `end`: the session ended, or its hook source is gone. A closing edge.
 *  - `reread`: nothing but "read the screen again".
 *  - `tool`: a tool finished (M56 spec 12). For the fold it is a `reread`; a hook-held permission
 *    reads it as the effect of an answer.
 */
export const EDGE_KINDS = ["prompt", "stop", "dialog", "start", "end", "reread", "tool"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** The delay from an edge to the fresh read it asks for. The screen paints after the hook fires. */
export const REREAD_MS = 700;
/** How long a running edge outvotes a free screen as `contested`. A profile can set its own. */
export const SETTLE_MS = 1500;
/** How many free screen reads end a block that no closing edge ended. */
export const LOST_STOP_READS = 3;
/** The shortest span, first to last, of those reads. */
export const LOST_STOP_SPAN_MS = 10_000;

/** A profile's edge block, as the fold and the runtime read it. */
export interface EdgeProfile {
  /** The ms an edge waits before its fresh read. */
  readonly rereadMs: number;
  /** The ms a running edge stays younger than the settle time. */
  readonly settleMs: number;
  /** Hook event name (or `Event:detail`) to edge kind. */
  readonly events: Readonly<Record<string, EdgeKind>>;
}

/** The timing with no profile: the defaults above, and no event map. */
export const DEFAULT_EDGE_PROFILE: EdgeProfile = { rereadMs: REREAD_MS, settleMs: SETTLE_MS, events: {} };

/**
 * The kind of one hook event under a profile's map. `Event:detail` wins over `Event`. An event the
 * map does not name is a `reread`: it can still ask for a fresh read, and nothing more.
 */
export function edgeKindOf(events: Readonly<Record<string, EdgeKind>>, event: string, detail: string | null): EdgeKind {
  if (detail !== null) {
    const exact = events[`${event}:${detail}`];
    if (exact !== undefined) return exact;
  }
  return events[event] ?? "reread";
}

/**
 * What a lying hook source says instead: each kind turned into its opposite. The CI test runs every
 * trace with edges inverted, and no negative trace may reach `free`.
 */
export function invertEdge(kind: EdgeKind): EdgeKind {
  switch (kind) {
    case "prompt":
      return "stop";
    case "stop":
      return "prompt";
    case "dialog":
      return "end";
    case "end":
      return "dialog";
    case "start":
      return "dialog";
    case "reread":
      return "reread";
    case "tool":
      return "tool";
  }
}

/**
 * A prompt text as both sides hash it: line breaks as `\n`, outer white space cut. The emitter applies
 * its harness's own unwrapping (a collapsed paste) before this; the bridge applies this to the text a
 * send typed. Equal results mean the harness took the text the send typed.
 */
export function normalizePrompt(text: string): string {
  return text.replace(/\r\n?/gu, "\n").trim();
}

/** A receipt a prompt edge may close: the request id, the pane and the hash of its prompt. */
export interface OpenReceipt {
  readonly id: string;
  readonly paneId: string;
  readonly promptHash: string;
  /** When the submit key went out, in ms. */
  readonly at: number;
  /** The send went in during a running turn: the harness takes it when the turn ends. */
  readonly queued?: boolean;
}

/** How long a queued receipt stays open for a prompt edge: the harness takes it after the turn ends. */
export const RECEIPT_EDGE_WINDOW_MS = 10 * 60_000;
/**
 * How long any other receipt stays open. The harness takes a free-box send at once, so a later prompt
 * edge with the same text is more likely a person typing it again at the desk.
 */
export const RECEIPT_EDGE_SHORT_MS = 30_000;

/** The window of one receipt. */
export function receiptWindowMs(receipt: OpenReceipt): number {
  return receipt.queued === true ? RECEIPT_EDGE_WINDOW_MS : RECEIPT_EDGE_SHORT_MS;
}

/**
 * The receipt a prompt edge closes as `effective`, or null. `writtenAt` is when the hook wrote the
 * edge. The newest open receipt on the pane whose prompt hash matches, whose submit key went out no
 * later than the edge, inside its window. One edge closes one receipt at most.
 */
export function closingReceipt(open: readonly OpenReceipt[], paneId: string, promptHash: string, writtenAt: number): OpenReceipt | null {
  let best: OpenReceipt | null = null;
  for (const receipt of open) {
    if (receipt.paneId !== paneId || receipt.promptHash !== promptHash) continue;
    if (writtenAt < receipt.at || writtenAt - receipt.at > receiptWindowMs(receipt)) continue;
    if (best === null || receipt.at > best.at) best = receipt;
  }
  return best;
}

/** The test hash of a prompt: a short unsalted hash, for traces and tests. The bridge salts its own. */
export function tracePromptHash(text: string): string {
  return shortHash(normalizePrompt(text));
}
