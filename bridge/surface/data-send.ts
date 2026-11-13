// The data road of one phone send (M99 spec 03): hand the text to the pane's part over the inside
// wire, under the phone's own request id, and read the part's word as the evidence (decision 6). The
// Send Protocol calls it under the pane lock and settles the receipt, the held card and the counters
// exactly as for the screen road (`bridge/surface/protocol.ts`, `runData`).
//
// One request id, one road, never twice (decision 5, WIRE.md "One id, one path, never twice"):
//  - queued, and no part took it within TAKE_MS: withdrawn, and the screen road runs it, once;
//  - taken: from then on only the part's word counts. `sent` is sent. With `failed` or no word within
//    WORD_MS the receipt says it may have arrived, and nothing sends it again.
//  - one exception, for a WalkyTalky `mail` only: `failed` with the reason `draft` is the part's word
//    that it found a draft in the box and submitted nothing (M99 spec 05, decision of 2026-11-13). The
//    caller holds the message again; a later try goes under a new command id.

import type { CommandState, PaneAddress } from "../inside/queue.ts";
import type { EnqueueOutcome } from "../inside/hub.ts";
import type { Capability } from "../inside/wire.ts";

/** How long a queued send waits for the part's poll to take it. An open poll takes it in milliseconds. */
export const TAKE_MS = 2000;
/** How long a taken send waits for the part's word. A Claude mod's submit resolves at turn start. */
export const WORD_MS = 15_000;

/** The reason a part gives with `failed` for a `mail` it did not submit because the box held a draft. */
export const DRAFT_REFUSAL = "draft";

/** The part side the data road needs: the inside hub, or a test's stand-in. */
export interface DataDoor {
  partOf(address: PaneAddress): { readonly capabilities: ReadonlySet<Capability> } | null;
  /**
   * The turn as the part last said it; null when it is not known, an old `running` included (M100 spec 05).
   * `anyAge` reads an old `running` as running, for a caller that never sends on it.
   */
  turnOf(address: PaneAddress, options?: { readonly anyAge?: boolean }): "running" | "idle" | null;
  /** Whether the box holds a draft, as the part last said; null when it is not known, an old "present" included. */
  draftOf(address: PaneAddress): boolean | null;
  /** The reason of a command's `failed`, or null. */
  failReasonOf(id: string): string | null;
  /** Whether the part holds a question open: a dialog stands. */
  askOpen(address: PaneAddress): boolean;
  enqueue(address: PaneAddress, command: DataCommand): EnqueueOutcome;
  withdraw(id: string): boolean;
  waitFor(id: string, states: readonly CommandState[], ms: number): Promise<CommandState | null>;
}

/**
 * What the data road hands a part. `overDraft` only on a `mail` the person chose to deliver over their own
 * draft (Deliver now, spec 05): the part submits it without reading the box.
 */
export type DataCommand =
  | { readonly id: string; readonly kind: "prompt"; readonly text: string }
  | { readonly id: string; readonly kind: "mail"; readonly text: string; readonly overDraft?: true };

/** How a data send ended. `screen`: nothing reached the part, and the screen road may run it once. */
export type DataResult =
  | { readonly kind: "sent" }
  /** A `mail` the part refused before any submit, because the box held a draft: hold it again. */
  | { readonly kind: "draft" }
  | { readonly kind: "screen"; readonly why: "refused" | "not-taken" }
  | { readonly kind: "unconfirmed"; readonly why: "failed" | "no-word" };

export interface DataLimits {
  readonly takeMs: number;
  readonly wordMs: number;
}

/** Send one text by data, as a `prompt` or as a WalkyTalky `mail` (spec 05). Never throws. */
export async function sendByData(
  door: DataDoor,
  address: PaneAddress,
  send: DataCommand,
  limits: DataLimits = { takeMs: TAKE_MS, wordMs: WORD_MS },
): Promise<DataResult> {
  const { id } = send;
  const queued = door.enqueue(address, send);
  if (!queued.ok) return { kind: "screen", why: "refused" };
  const took = await door.waitFor(id, ["taken", "sent", "failed", "withdrawn"], limits.takeMs);
  // Not taken in time: withdraw it. A withdraw that fails means the part took it in between, and the
  // part's word decides as for any taken send.
  if (took === "queued" && door.withdraw(id)) return { kind: "screen", why: "not-taken" };
  if (took === "withdrawn") return { kind: "screen", why: "not-taken" };
  const word = await door.waitFor(id, ["sent", "failed"], limits.wordMs);
  if (word === "sent") return { kind: "sent" };
  if (word === "failed" && send.kind === "mail" && door.failReasonOf(id) === DRAFT_REFUSAL) return { kind: "draft" };
  return { kind: "unconfirmed", why: word === "failed" ? "failed" : "no-word" };
}
