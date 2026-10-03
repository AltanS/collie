// THE WALK PAIRS: the corpus proof that a grammar's pointed list survives its own walk (ADR 0080
// point 5, enforced by `describeAdapterConformance` in conformance.ts).
//
// WHY THIS TABLE EXISTS. A tap on a pointed-list row is walked, verified, then committed
// (lib/prompt-action.ts `walkVerifyCommit`): the arrows go out, and Enter goes out only after a fresh
// read is the SAME dialog (`promptsSameIdentity`) with the tapped row now carrying the plan
// ["Enter"]. That is only true if the grammar's `coreSignature` blanks EVERYTHING the pointer's own
// move changes: the `❯` glyph and any text that follows the pointer (a detail pane under the list, a
// description of the highlighted row, a "(n/m)" position counter). One that keeps such text makes
// every walked tap answer `changed` and never commit. The omp `/switch` picker shipped exactly that:
// its two detail rows describe the pointed model. Synthetic perturbations never show it. Only two
// REAL captures of one dialog, the pointer on different rows, do.
//
// HOW IT WORKS. Every fixture an adapter lifts into a `prompt-select` model with at least one walked
// plan (`splitWalk` non-null with arrows) belongs to a GRAMMAR GROUP, keyed `agent | family | title`
// (`walkGroupKey`). The suite then demands, for every such group, one of:
//
//   1. a declared PAIR in {@link WALK_PAIRS}: two captures of the same dialog with the pointer on a
//      different row. The suite asserts `promptsSameIdentity` both ways, not `promptsEqual`, and that
//      the row carrying the plan ["Enter"] (the pointed offered row) differs between the two, so a
//      pair can never be two captures of one pointer position;
//   2. a reason in {@link WALK_GAPS}: no such pair exists in the corpus yet.
//
// A new fixture whose grammar is in neither fails the suite. The fix is a second capture of the same
// dialog with the pointer on another row, added to {@link WALK_PAIRS}. A pair that fails identity is a
// defect in the grammar's `coreSignature` (blank what follows the pointer), never in the table.
//
// The group key is the agent, the family and the dialog's own title (the caption, else the first
// question line, cut at the first `:` or ` (`). It needs no per-fixture bookkeeping, it is stable
// across widths and presets of one grammar, and a new grammar lands in a new group by itself.

import type { PromptModel } from "./prompt-model";

/** `[agent, fixtureA, fixtureB]`: two captures of one dialog, the pointer on a different row. */
export type WalkPair = readonly [agent: string, a: string, b: string];

/** The grammar group of a walked `prompt-select` model: `agent | family | title`. */
export function walkGroupKey(agent: string, model: PromptModel): string {
  const raw = (model.caption ?? "").trim() || (model.question.split("\n")[0] ?? "").trim();
  const title = raw.split(/:| \(/)[0]!.trim();
  return `${agent} | ${model.family} | ${title}`;
}

export const WALK_PAIRS: readonly WalkPair[] = [
  // omp tool approval, `unicode` preset (18.4.10) and `nerd` preset (18.1.17): Approve and Deny.
  ["omp", "omp--v18-4-approval-bash.txt", "omp--v18-4-approval-bash-moved.txt"],
  ["omp", "omp--v18-4-approval-write.txt", "omp--v18-4-approval-write-moved.txt"],
  ["omp", "omp--approval-write.txt", "omp--approval-write--deny.txt"],
  // omp Ask single-select, both keycap dialects.
  ["omp", "omp--select-menu.txt", "omp--select-menu-moved.txt"],
  ["omp", "omp--v18-4-ask-single.txt", "omp--v18-4-ask-single-moved.txt"],
  // omp `/resume` picker. The unboxed pair differs in the ages too (`1 minute ago` against
  // `2 minutes ago`); `coreSignature` blanks them, so the pair holds.
  ["omp", "omp--v18-4-resume.txt", "omp--v18-4-resume-moved.txt"],
  ["omp", "omp--menu-resume.txt", "omp--menu-resume-moved.txt"],
  // Claude `/resume` picker, one width. Four of the ages differ between the two (`44 seconds ago`
  // against `1 minute ago`): clock drift, which `coreSignature` blanks.
  [
    "claude",
    "claude--menu-resume-picker--w120-first.txt",
    "claude--menu-resume-picker--w120-third.txt",
  ],
  // omp `/switch` picker. The four ptr captures move the pointer over one list, the first of them on
  // the hidden CURRENT row; the detail rows under the list change with every move (the 2026-10-03
  // defect). The rest are older pairs of the same picker in other layouts.
  ["omp", "omp--v18-4-switch-ptr-opus-current.txt", "omp--v18-4-switch-ptr-haiku.txt"],
  ["omp", "omp--v18-4-switch-ptr-haiku.txt", "omp--v18-4-switch-ptr-fable.txt"],
  ["omp", "omp--v18-4-switch-ptr-fable.txt", "omp--v18-4-switch-ptr-sonnet.txt"],
  ["omp", "omp--v18-4-switch-ptr-sonnet.txt", "omp--v18-4-switch-ptr-opus-current.txt"],
  ["omp", "omp--v18-4-switch.txt", "omp--v18-4-switch-moved.txt"],
  ["omp", "omp--v18-4-switch-moved.txt", "omp--v18-4-switch-moved-up.txt"],
  ["omp", "omp--v18-4-switch-top.txt", "omp--v18-4-switch-moved.txt"],
  ["omp", "omp--v18-4-switch-narrow.txt", "omp--v18-4-switch-narrow-moved.txt"],
  ["omp", "omp--v18-4-switch-overcontext.txt", "omp--v18-4-switch-overcontext-moved.txt"],
  ["omp", "omp--v18-4-switch-search-short.txt", "omp--v18-4-switch-search-short-moved.txt"],
  ["omp", "omp--v18-4-switch-top-edge.txt", "omp--v18-4-switch-wrapped.txt"],
  // opencode permission dialog: horizontal chips, the pointer is a background colour and not a glyph,
  // so the TEXT of each pair is identical and only the option plans differ (Right × d, then Enter).
  // `promptsEqual` still tells them apart because it compares the exact plans (prompt-model.ts).
  ["opencode", "oc--permission-bash.txt", "oc--permission-bash--moved.txt"],
  ["opencode", "oc--permission-bash--moved.txt", "oc--permission-bash--reject.txt"],
  ["opencode", "oc--permission-bash--reject.txt", "oc--permission-bash--wrap.txt"],
  ["opencode", "oc--permission-edit.txt", "oc--permission-edit--moved.txt"],
  // The second step, `Always allow`, two chips: Confirm and Cancel.
  ["opencode", "oc--permission-always-bash.txt", "oc--permission-always-bash--cancel.txt"],
];

/**
 * Grammar groups with no pair in the corpus yet, keyed as {@link walkGroupKey}, one line of reason
 * each. The ratchet fails when a listed group gains a pair (remove the line) or has no walked fixture
 * left (stale). Adding a line here is a debt, not a fix: it says "nothing proves this grammar blanks
 * what follows its pointer".
 */
export const WALK_GAPS = {
  "claude | trust | Quick safety check":
    "no second capture yet: the two captures differ in width and both have the pointer on the first row",
  "codex | trust | Trust this folder?": "no second capture yet: one capture, pointer on the first row",
  "opencode | permission | % WebFetch https":
    "no second capture yet: one capture, pointer on the first chip (the same grammar as the bash dialog, " +
    "which has pairs, but the body differs)",
  "opencode | permission | $ echo narrow-width-probe":
    "no second capture yet: the 50-column layout puts the chips on a row of their own, and only the pointer " +
    "on the first chip is captured",
  "opencode | permission | This will allow edit until OpenCode is restarted.":
    "no second capture yet: one capture of the edit's `Always allow` step, pointer on Confirm",
  "omp | select | Pick a colour":
    "no pointer-only pair: the two captures differ by a `✎ note` mark, which is note state, not the pointer",
} satisfies Record<string, string>;
