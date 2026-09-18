// The multi-select action recipes — the generic race guard (lib/dialog-guard.ts) plus the extra
// verified steps this dialog needs, because its Submit is a CLOSED-LOOP choreography (never a blind
// Enter). The model carries the choreography (`toggle` / `submit`: "digit" | "pointer" —
// harness/multi-select-model.ts) and every intent below branches on it, so this file stays
// harness-neutral while the keystrokes stay right per harness:
//
//   - DIGIT mode (Claude): a digit TOGGLES its option on/off (pointer-independent, deterministic).
//     "Chat about this" aborts the tool. The review screen's 1/2 submit/cancel. Each of these is one
//     guarded keystroke.
//   - POINTER mode (Muse): a digit merely MOVES the pointer (verified target row first) and review
//     swallows digits entirely, so toggle is digit-jump + verified Enter and review submit/cancel is
//     a verified pointer walk + a freshly-bound Enter (the irreversible keystroke carries a fresh
//     region, prompt-feedback style, so a pointer move in the final gap 409s instead of misfiring).
//   - Submit (checkbox → review) is the hard case in BOTH modes: Enter activates the POINTED row, NOT
//     a global submit, and Down CLAMPS at the bottom ("Chat about this") with "Submit" exactly one row
//     above it. So the deterministic macro is: clamp Down to the bottom → Up once → VERIFY the pointer
//     sits on "Submit" → only then Enter. The pointer is re-derived from a fresh read at every step, so
//     a checkbox flip / dialog change mid-macro aborts BEFORE any Enter.
//
// Every flow starts with the same entry guard as the sibling actions (lib/dialog-guard.ts): a FRESH
// pane read, the unconditional revision check, and a re-derivation THROUGH THE PANE'S ADAPTER compared
// against what the user tapped (Herdr 0.7.x's revision is a stub — the re-derivation is the
// load-bearing check). The mid-flight reads re-derive the same way, keyed on the
// pointer-independent-but-not-checkbox-independent `multiSelectIdentity` so the macro's own Down/Up
// moves don't read as drift while a box flipped by another device does. Both comparators are the
// neutral contract in harness/multi-select-model.ts, wired to this kind by harness/dialog-contract.ts.

import { type MultiSelectModel } from "./blocks";
import {
  guardDialog,
  readDialog,
  sendBoundKeys,
  type DialogTarget,
} from "./dialog-guard";
import { multiSelectIdentity } from "./harness/multi-select-model";
import { defaultSleep, type ActionResult, type Sleep } from "./harness/guard";
import { paneScopeKey, type Scope } from "./scope";

/** One tap's intent, resolved to keystrokes by {@link submitMultiSelectIntent}. Shared with the
 *  MultiSelectBlock renderer (its `onAction` emits exactly these). */
export type MultiSelectIntent =
  | { kind: "toggle"; n: number } // checkbox: toggle option n on/off (digit, or digit-jump + Enter)
  | { kind: "escape" } //            checkbox: "Chat about this" — aborts the tool
  | { kind: "advance" } //           checkbox: the closed-loop Down→Up→verify→Enter macro onto the
  //                                 advance row ("Submit" on the last question, "Next" before it)
  | { kind: "nav"; keys: string[] } // checkbox step of a wizard: Left/Right to another question
  | { kind: "confirm" } //           review: submit the answers (digit 1, or pointer walk + Enter)
  | { kind: "cancel" }; //           review: back out (digit 2, or pointer walk + Enter)

/** The multi-select identity comparators, part of the neutral contract
 *  (harness/multi-select-model.ts). Re-exported under their original names so existing call sites and
 *  tests keep one import site. */
export { multiSelectEquals, multiSelectIdentity } from "./harness/multi-select-model";

interface GuardArgs {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered dialog was detected against. */
  detectedRevision: number;
  multi: MultiSelectModel;
  /** Which machine + which named session the pane lives in — scopes every read + keystroke below. */
  scope?: Scope;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
  /** Test seam for the verification polls' pacing. */
  sleep?: Sleep;
}

/** This module's slice of the generic guard: the multi-select dialog the tap is aimed at. */
function target(args: GuardArgs): DialogTarget<"multi-select"> {
  return { ...args, kind: "multi-select", model: args.multi };
}

// Per-pane serialization of multi-select actions WITHIN this browser context. The Submit macro is a
// multi-step, ~1-2s choreography (walk the pointer, re-reading each step); the single-keystroke
// intents are quick but still a read + a send. Without a mutex, two overlapping calls on the SAME
// pane can interleave dangerously — the acute case: two Submit macros both reaching "pointer on
// Submit" and both sending Enter, where the FIRST lands on the review screen (its pointer already on
// "1. Submit answers") and the SECOND Enter activates it, submitting WITHOUT the user seeing review.
// Two ways in: two devices on one herd, or one device where a mid-redraw briefly unmounts+remounts
// the block and clears its local `sending` lock, inviting a re-tap. A module-scoped in-flight set
// closes the single-device path outright and shrinks the multi-device path to the irreducible
// read→send window (fully closing it would need server-side coordination — out of scope). An overlap
// is rejected as "changed" so the caller simply revalidates onto the fresh state.
const inFlight = new Set<string>();
const paneKey = (paneId: string, scope: Scope | undefined) => paneScopeKey(scope, paneId);

/**
 * Dispatch a multi-select intent through the race guard, serialized per pane. Toggle/escape/confirm/
 * cancel are one guarded keystroke each; submit is the closed-loop macro. Pure of any UI — the caller
 * maps the result to a status message + a revalidation. A second call on a pane already mid-action (in
 * this browser context) is rejected as "changed" without touching the terminal.
 */
export async function submitMultiSelectIntent(
  args: GuardArgs & { intent: MultiSelectIntent },
): Promise<ActionResult> {
  const key = paneKey(args.paneId, args.scope);
  if (inFlight.has(key)) return { status: "changed" }; // a sibling action holds this pane
  inFlight.add(key);
  try {
    return await dispatchIntent(args);
  } finally {
    inFlight.delete(key);
  }
}

/** Resolve one intent to its guarded keystroke(s). Runs with the per-pane lock held. */
async function dispatchIntent(
  args: GuardArgs & { intent: MultiSelectIntent },
): Promise<ActionResult> {
  const { intent } = args;
  if (intent.kind === "advance") return runAdvanceMacro(args);
  if (intent.kind === "toggle") {
    // Validate the tapped digit against the CURRENT model BEFORE the guard reads: a renderer that
    // emits an out-of-range / non-option `n` must never inject a stray digit into the live terminal.
    // (The entry guard then confirms that model is still on screen, so the digit maps to a real,
    // present option.)
    if (args.multi.phase !== "checkbox" || !args.multi.options.some((o) => o.n === intent.n)) {
      return { status: "changed" };
    }
    if (args.multi.toggle === "pointer") return runToggleMacro(args, intent.n);
    return guardedKey(args, [String(intent.n)]);
  }
  if (intent.kind === "nav") {
    // Only a wizard STEP has anywhere to navigate to; a standalone multiSelect has no siblings.
    if (args.multi.phase !== "checkbox" || !args.multi.steps) return { status: "changed" };
    return guardedKey(args, intent.keys);
  }
  if (intent.kind === "escape") {
    if (args.multi.phase !== "checkbox" || !args.multi.escape) return { status: "changed" };
    return guardedKey(args, [String(args.multi.escape.n)]);
  }
  if (intent.kind === "confirm") {
    if (args.multi.phase !== "review") return { status: "changed" };
    if (args.multi.submit === "pointer") return runReviewMacro(args, "submit");
    return guardedKey(args, ["1"]);
  }
  // cancel
  if (args.multi.phase !== "review") return { status: "changed" };
  if (args.multi.submit === "pointer") return runReviewMacro(args, "cancel");
  return guardedKey(args, ["2"]);
}

/** Entry guard, then send exactly `keys` (one keystroke against the dialog). */
async function guardedKey(args: GuardArgs, keys: string[]): Promise<ActionResult> {
  const guarded = await guardDialog(target(args));
  if (!guarded.ok) return guarded.result;
  return sendBoundKeys(args, keys, guarded.region);
}

// The pointer settles fast after a nav key — a pointer move is a cheap redraw, unlike the note-focus
// race the 350ms POLL_DELAY guards — so the Submit walk re-reads on this short cadence and advances
// one row per read. (The old macro polled for "reached the bottom" AFTER every Down, so each
// intermediate step burned the full ~2.8s poll timeout before giving up and stepping again — a
// ~5-row walk stalled ~15s. Re-reading the actual pointer resolves each step in one settle.)
const NAV_SETTLE_MS = 250;

/**
 * A macro's keystroke sender: binds only the FIRST write to the entry region. A macro intentionally
 * changes the dialog step by step, so reusing the original region would reject every valid later
 * step; later writes ride on the identity check that runs before each one instead. Shared by the
 * advance, toggle and review macros. Returns null on `sent`, the failing result otherwise.
 */
function bindFirstWriter(
  args: GuardArgs,
  region: string | undefined,
): (keys: string[]) => Promise<ActionResult | null> {
  let expectedPrompt: string | undefined = region;
  return async (keys: string[]) => {
    const expected = expectedPrompt;
    expectedPrompt = undefined;
    const res = await sendBoundKeys(args, keys, expected);
    return res.status === "sent" ? null : res;
  };
}

/**
 * One mid-macro re-read: the fresh model, or null when the read failed or the tail hid mid-redraw
 * (already slept — the caller just retries within its bound). Shared by the advance, toggle and
 * review macros; the identity comparison stays in each loop (every macro checks against its own
 * tap, and the check differs by phase).
 */
async function readMacroDialog(
  args: GuardArgs,
  sleep: Sleep,
): Promise<MultiSelectModel | null> {
  try {
    const fresh = await readDialog(target(args));
    // TUI mid-redraw hid the tail — retry without sending a key.
    if (!fresh.model) await sleep(NAV_SETTLE_MS);
    return fresh.model;
  } catch {
    // Transient read failure — retry within the bounded walk.
    await sleep(NAV_SETTLE_MS);
    return null;
  }
}

/**
 * The Submit macro (checkbox → review): entry guard → walk the pointer DOWN onto "Submit" → Enter.
 * Each step re-reads the ACTUAL pointer and stops the INSTANT it lands on "Submit" — which sits just
 * above the bottom "Chat about this" row, so a downward walk reaches it first (no overshoot, no
 * back-up). Enter is NEVER sent without a fresh read confirming the pointer is on "Submit", and every
 * read re-checks the dialog IDENTITY, so a drift / a checkbox screen that already advanced / a
 * vanished dialog aborts BEFORE any key. Reaching the review screen re-renders on the next poll, where
 * the user confirms (we do NOT auto-send "1").
 */
async function runAdvanceMacro(args: GuardArgs): Promise<ActionResult> {
  if (args.multi.phase !== "checkbox") return { status: "changed" };
  const guarded = await guardDialog(target(args));
  if (!guarded.ok) return guarded.result;

  const sleep = args.sleep ?? defaultSleep;
  // Bound the walk: enough nudges to cross every navigable row (options + free-text + Submit + Chat)
  // with slack for a couple of swallowed keys, so a wedged pane can't loop forever.
  const maxSteps = args.multi.options.length + 6;
  // Enter stays protected by the identity check that runs before every macro write.
  const sendMacroStep = bindFirstWriter(args, guarded.region);

  for (let step = 0; step < maxSteps; step++) {
    const m = await readMacroDialog(args, sleep);
    if (!m) continue;
    // Drift guard: a successor dialog, or the checkbox screen already gone — abort before any key.
    if (!multiSelectIdentity(m, args.multi) || m.phase !== "checkbox") return { status: "changed" };
    if (m.pointer === "advance") {
      // Verified on the advance row: activate it. What appears next — the following question of a
      // wizard, or the review screen — is re-detected by whichever grammar owns it on the next poll.
      // This macro deliberately does not predict another screen's shape.
      return (await sendMacroStep(["Enter"])) ?? { status: "sent" };
    }
    // Nudge toward the advance row: Down for every row above it (options / free-text / none), and Up
    // on the off chance the pointer starts on the bottom "Chat about this" row (advance is above it).
    const sent = await sendMacroStep([m.pointer === "chat" ? "Up" : "Down"]);
    if (sent) return sent;
    await sleep(NAV_SETTLE_MS);
  }
  // Never landed on the advance row within the bounded walk — refresh rather than blind-send.
  return { status: "changed" };
}

// The pointer-mode toggle needs no walk (the digit jumps straight there), only retries for a
// redraw that swallows the jump — a small fixed bound, not the advance macro's row-counted one.
const TOGGLE_MACRO_MAX_STEPS = 6;

// Two action rows: any walk longer than this is a wedged pane, not a slow redraw.
const REVIEW_MACRO_MAX_STEPS = 8;

/**
 * The pointer-mode toggle (checkbox): entry guard → digit-jump the pointer onto row `n` → VERIFY
 * the pointer row → Enter. Enter is NEVER sent without a fresh read confirming the pointer sits on
 * row `n`, and every read re-checks the dialog IDENTITY, so drift (a flip by another device, a
 * successor dialog, a vanished dialog) aborts BEFORE any Enter. The flip itself is reversible and
 * re-renders on the next poll, so the Enter rides the macro's first-write binding like the advance
 * macro's (unlike the review macro's irreversible submit, which re-binds fresh below).
 */
async function runToggleMacro(args: GuardArgs, n: number): Promise<ActionResult> {
  if (args.multi.phase !== "checkbox") return { status: "changed" };
  const guarded = await guardDialog(target(args));
  if (!guarded.ok) return guarded.result;

  const sleep = args.sleep ?? defaultSleep;
  const sendMacroStep = bindFirstWriter(args, guarded.region);

  for (let step = 0; step < TOGGLE_MACRO_MAX_STEPS; step++) {
    const m = await readMacroDialog(args, sleep);
    if (!m) continue;
    // Drift guard: identity (mode included) + still the checkbox phase — abort before any key.
    if (!multiSelectIdentity(m, args.multi) || m.phase !== "checkbox") return { status: "changed" };
    if (m.pointerRow === n) {
      // Verified on the tapped row: toggle it. A digit already sitting on its row no-ops above,
      // so reaching here on the first iteration just means no jump was needed.
      return (await sendMacroStep(["Enter"])) ?? { status: "sent" };
    }
    // Jump the pointer onto row n (a no-op when already there — verified, never assumed).
    const sent = await sendMacroStep([String(n)]);
    if (sent) return sent;
    await sleep(NAV_SETTLE_MS);
  }
  // Never observed the pointer on row n within the bounded macro — refresh, don't blind-send.
  return { status: "changed" };
}

/**
 * The pointer-mode review submit/cancel: entry guard → walk the pointer onto the target action row
 * → VERIFY → Enter carrying a FRESH region binding. Every step re-reads and re-checks the dialog
 * IDENTITY, so drift aborts BEFORE any key — and because submitting answers is IRREVERSIBLE (unlike
 * a toggle), the final Enter is bound to the just-read region prompt-feedback-style, so a pointer
 * move in the final gap 409s instead of submitting the wrong row. No checked-set comparison rides
 * along: the review screen offers no toggle affordance, so the set cannot change while it is up —
 * the pointer + identity verify is complete.
 */
async function runReviewMacro(args: GuardArgs, targetRow: "submit" | "cancel"): Promise<ActionResult> {
  if (args.multi.phase !== "review") return { status: "changed" };
  const guarded = await guardDialog(target(args));
  if (!guarded.ok) return guarded.result;

  const sleep = args.sleep ?? defaultSleep;
  const sendMacroStep = bindFirstWriter(args, guarded.region);

  for (let step = 0; step < REVIEW_MACRO_MAX_STEPS; step++) {
    const m = await readMacroDialog(args, sleep);
    if (!m) continue;
    // Drift guard: identity (mode included) + still the review phase — abort before any key.
    if (!multiSelectIdentity(m, args.multi) || m.phase !== "review") return { status: "changed" };
    if (m.pointer === targetRow) {
      // Verified on the target row: submit it with the FRESH region this read just derived, so a
      // terminal pointer move between the verify and the send 409s rather than misfiring.
      return sendBoundKeys(args, ["Enter"], m.regionSignature);
    }
    // Nudge toward the target: the action rows read submit-above-cancel, so Down heads for cancel
    // from anywhere unknown-or-above, and Up heads for submit from cancel.
    const key = m.pointer === "cancel" && targetRow === "submit" ? "Up" : "Down";
    const sent = await sendMacroStep([key]);
    if (sent) return sent;
    await sleep(NAV_SETTLE_MS);
  }
  // Never observed the pointer on the target row within the bounded walk — refresh, don't send.
  return { status: "changed" };
}
