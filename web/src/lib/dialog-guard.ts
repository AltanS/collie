// THE race guard for every dialog block — one choreography, no harness in sight.
//
// Tapping any dialog button types into a REAL terminal, and the pane may have moved on between the
// render the user saw and the tap. So before a key goes out, all five action modules do the same
// three things, and they do them HERE:
//
//   1. A FRESH pane read for the same window.
//   2. The fresh read's `revision` must equal the one the block was detected against — checked
//      UNCONDITIONALLY (a 304 only proves "unchanged since the last background poll", and polls keep
//      advancing the ETag cache while a frozen mirror stands still). Herdr 0.7.x's revision is
//      empirically a stub (always 0), so this is defense-in-depth, not the load-bearing check.
//   3. The fresh buffer is re-derived and must still be THE SAME DIALOG. This is the load-bearing
//      check, and it re-derives through `adapterFor(agent).buildBlocks` — the SAME pipeline that
//      produced the block the user tapped — then compares with the kind's contract comparator
//      (harness/dialog-contract.ts).
//
// (3) is why this module exists. Each action file used to import a Claude `detect*` function
// directly, so a non-Claude pane would have been re-verified through Claude's grammar — the guard
// would have been checking a screen against a foreign parser. Going through the adapter means the
// guard verifies exactly what the renderer rendered, and an adapter that emits a block kind gets the
// guard for free: no `detect*` import may appear in lib/ again.
//
// Import direction: lib/dialog-guard → harness/registry (the single "which agent has an adapter"
// decision site) → the adapters. The neutral model modules never import the registry, so nothing
// here can close a cycle.

import { sendKeys } from "./api";
import { type StyledLine } from "./blocks";
import { adapterFor } from "./harness/registry";
import {
  DIALOG_CONTRACT,
  dialogModelOf,
  type DialogKind,
  type DialogModels,
} from "./harness/dialog-contract";
import {
  entryGuard,
  pollUntil,
  readModel,
  type ActionResult,
  type GuardOutcome,
  type Sleep,
} from "./harness/guard";

/** What identifies the dialog a tap is aimed at: where it lives, when it was seen, and what it was. */
export interface DialogTarget<K extends DialogKind> {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered dialog was detected against. */
  detectedRevision: number;
  /** The session the pane lives in (undefined = primary) — scopes every read + keystroke. */
  session?: string;
  /**
   * The pane's Herdr `agent` string — which adapter re-derives the fresh screen. An agent with no
   * adapter re-derives to nothing, so the guard refuses: fail-CLOSED, the only safe default when we
   * can't parse what is on screen.
   */
  agent?: string;
  /** The block kind the tap came from. */
  kind: K;
  /** The model the user actually tapped (from the render). */
  model: DialogModels[K];
}

/**
 * Re-derive `kind`'s model from a pane's styled lines through the AGENT'S adapter — the only
 * re-derivation path in lib/. Returns null when the adapter is unknown, or when the fresh screen no
 * longer carries a block of that kind.
 *
 * The TAIL block of the kind is the one taken: every grammar is tail-anchored (a dialog lifts only
 * while it sits at the buffer tail — pinned by the conformance suite), and an adapter emits at most
 * one, so "the last one" is "the one on screen". Going through buildBlocks rather than a single
 * detector also inherits the adapter's ARBITRATION: if a more specific grammar now claims the screen,
 * this kind is legitimately no longer there, and the guard refuses instead of re-parsing the same
 * rows through the loser's grammar.
 */
export function dialogDetector<K extends DialogKind>(
  kind: K,
  agent: string | undefined,
): (lines: StyledLine[]) => DialogModels[K] | null {
  const adapter = adapterFor(agent);
  if (!adapter) return () => null;
  return (lines) => {
    const blocks = adapter.buildBlocks(lines);
    for (let i = blocks.length - 1; i >= 0; i--) {
      const model = dialogModelOf(blocks[i]!, kind);
      if (model !== null) return model;
    }
    return null;
  };
}

/** Which comparison a step needs: `commits` for a keystroke that acts, `identity` for one whose own
 *  effect is the change it would otherwise be blamed for (an arrow, a pointer walk, a note flow). */
export type Compare = "commits" | "identity";

/**
 * The entry guard: fresh read + revision check + re-derivation through the adapter, compared against
 * `target.model` with the kind's `commits` (default) or `identity` comparator. On success it carries
 * back the region text of the FRESH derivation — what the caller binds its first write to.
 */
export async function guardDialog<K extends DialogKind>(
  target: DialogTarget<K>,
  compare: Compare = "commits",
): Promise<GuardOutcome> {
  const contract = DIALOG_CONTRACT[target.kind];
  return entryGuard(
    target,
    target.model,
    dialogDetector(target.kind, target.agent),
    contract[compare],
    contract.region,
  );
}

/**
 * The whole one-keystroke choreography: guard, then send `keys` bound to the verified region. This is
 * what four of the five action modules are — the fifth (multi-select) and the preview note flow add
 * their own verified mid-flight steps on top of the same guard.
 */
export async function sendGuardedKeys<K extends DialogKind>(
  target: DialogTarget<K>,
  keys: string[],
  compare: Compare = "commits",
): Promise<ActionResult> {
  const guarded = await guardDialog(target, compare);
  if (!guarded.ok) return guarded.result;
  return sendBoundKeys(target, keys, guarded.region);
}

/** Send `keys`, mapping transport + prompt-binding failures onto the ActionResult union. `region`
 *  undefined = an unbound write (a later step of a multi-step choreography, which has deliberately
 *  changed the screen since the guard ran). */
export async function sendBoundKeys(
  target: { paneId: string; session?: string },
  keys: string[],
  region?: string,
): Promise<ActionResult> {
  try {
    const res =
      region === undefined
        ? await sendKeys(target.paneId, keys, target.session)
        : await sendKeys(target.paneId, keys, target.session, region);
    if (!res.ok && res.code === "prompt_changed") return { status: "changed" };
    if (!res.ok) return { status: "error", error: res.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** One fresh read + re-derivation through the adapter (no comparison) — the mid-flight step of the
 *  multi-step choreographies, which re-check identity themselves. */
export async function readDialog<K extends DialogKind>(
  target: DialogTarget<K>,
): Promise<{ revision: number; model: DialogModels[K] | null }> {
  return readModel(
    target.paneId,
    target.requestedLines,
    target.session,
    dialogDetector(target.kind, target.agent),
  );
}

/**
 * Bounded verification polling between choreography steps, through the adapter: wait until `accept`
 * passes on a fresh re-derivation, keyed on the kind's `identity` comparator for drift. Three-valued
 * — see {@link pollUntil} for what "drifted" vs "timeout" oblige the caller to do.
 */
export async function pollDialog<K extends DialogKind>(
  target: DialogTarget<K> & { sleep?: Sleep },
  accept: (m: DialogModels[K]) => boolean,
): Promise<"ok" | "drifted" | "timeout"> {
  return pollUntil(
    target,
    target.model,
    dialogDetector(target.kind, target.agent),
    accept,
    DIALOG_CONTRACT[target.kind].identity,
  );
}
