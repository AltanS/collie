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
//   2. a dated reason in {@link WALK_GAPS}: no such pair exists in the corpus yet. Gaps only shrink:
//      the set of keys is pinned in `conformance.test.ts`, so a new gap is a reviewed decision.
//
// A new fixture whose grammar is in neither fails the suite. The fix is a second capture of the same
// dialog with the pointer on another row, added to {@link WALK_PAIRS}. A pair that fails identity is a
// defect in the grammar's `coreSignature` (blank what follows the pointer), never in the table.
//
// A pair whose two `signature` strings are EQUAL is a pointer drawn only as a style. The suite then also
// requires `styledSignature` on both models, different between the two, and checks it against the raw
// captures with the bridge's own verifier (ADR 0080 point 7).
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
  ["grok", "grok--model-picker.txt", "grok--model-picker-moved.txt"],
  ["grok", "grok--model-window.txt", "grok--model-window-moved.txt"],
  ["grok", "grok--model-effort.txt", "grok--model-effort-moved.txt"],
  // omp tool approval, `unicode` preset (18.4.10) and `nerd` preset (18.1.17): Approve and Deny.
  ["omp", "omp--v18-4-approval-bash.txt", "omp--v18-4-approval-bash-moved.txt"],
  ["omp", "omp--v18-4-approval-write.txt", "omp--v18-4-approval-write-moved.txt"],
  ["omp", "omp--approval-write.txt", "omp--approval-write--deny.txt"],
  // omp Ask single-select, both keycap dialects, and the 18.8 dialog with option descriptions (#372).
  ["omp", "omp--select-menu.txt", "omp--select-menu-moved.txt"],
  ["omp", "omp--v18-4-ask-single.txt", "omp--v18-4-ask-single-moved.txt"],
  ["omp", "omp--v18-8-ask-single-described.txt", "omp--v18-8-ask-single-described-moved.txt"],
  ["omp", "omp--v18-10-ask-batch.txt", "omp--v18-10-ask-batch-moved.txt"],
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
  // Claude Code 2.1.303 on a long list: the title counts the pointer, `(1 of 50)` against `(2 of 50)`,
  // which `coreSignature` blanks and the card's title drops (2026-10-19). Two widths.
  ["claude", "claude--v2303-menu-resume-picker--w119-first.txt", "claude--v2303-menu-resume-picker--w119-second.txt"],
  ["claude", "claude--v2303-menu-resume-picker--w160-first.txt", "claude--v2303-menu-resume-picker--w160-second.txt"],
  // Claude "Switch model?" confirmation (2.1.289), two widths: the pointer on `Yes` against on `No`.
  // The 50-column pair also prints the edge row both ways (labelled, then bare), which
  // `coreSignature` leaves out of the identity.
  ["claude", "claude--v2289-switch-model-yes.txt", "claude--v2289-switch-model-no.txt"],
  ["claude", "claude--v2289-switch-model-yes--w50.txt", "claude--v2289-switch-model-no--w50.txt"],
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
  // pi's stock `question` example, pi 0.87.1 and 1.1.0, full width and 50 columns, with and without
  // option descriptions: the `>` pointer moved one row down.
  ["pi", "pi--v0871-question-single.txt", "pi--v0871-question-single-moved.txt"],
  ["pi", "pi--v110-question-single.txt", "pi--v110-question-single-moved.txt"],
  ["pi", "pi--v0871-question-narrow.txt", "pi--v0871-question-narrow-moved.txt"],
  ["pi", "pi--v110-question-narrow.txt", "pi--v110-question-narrow-moved.txt"],
  ["pi", "pi--v0871-question-plain.txt", "pi--v0871-question-plain-moved.txt"],
  ["pi", "pi--v110-question-plain.txt", "pi--v110-question-plain-moved.txt"],
  // pi's stock `questionnaire` example: one question, then both pages of a tabbed one.
  ["pi", "pi--v0871-questionnaire-single.txt", "pi--v0871-questionnaire-single-moved.txt"],
  ["pi", "pi--v110-questionnaire-single.txt", "pi--v110-questionnaire-single-moved.txt"],
  ["pi", "pi--v0871-questionnaire-tabs.txt", "pi--v0871-questionnaire-tabs-moved.txt"],
  ["pi", "pi--v110-questionnaire-tabs.txt", "pi--v110-questionnaire-tabs-moved.txt"],
  ["pi", "pi--v0871-questionnaire-tabs-second.txt", "pi--v0871-questionnaire-tabs-second-moved.txt"],
  ["pi", "pi--v110-questionnaire-tabs-second.txt", "pi--v110-questionnaire-tabs-second-moved.txt"],
  // The PR 397 question extension (pi 1.1.0): its one captured pair.
  ["pi", "pi--v110-single-desc.txt", "pi--v110-single-moved.txt"],
  // pi 1.2.0's folder trust prompt (pi/trust.ts), before and after one Down.
  ["pi", "pi--trust-prompt.txt", "pi--trust-prompt-moved.txt"],
  // gentle-pi 4.2.0's ask_user_choice (pi 1.3.0): unnumbered rows, the second capture after a real Down.
  ["pi", "pi--v130-gentle-choice.txt", "pi--v130-gentle-choice-moved.txt"],
  // pi's example permission-gate (pi 0.87.1), pi's own selector: Down at 120 columns, Up at 80.
  ["pi", "pi--v0871-permission-gate.txt", "pi--v0871-permission-gate-moved.txt"],
  ["pi", "pi--v0871-permission-gate-narrow.txt", "pi--v0871-permission-gate-narrow-moved.txt"],
  // gentle-pi 4.2.0's review-consent screen (pi 1.3.0): no rule frame, footer last; the Effect paragraph follows the pointer.
  ["pi", "pi--v130-gentle-review-consent.txt", "pi--v130-gentle-review-consent-moved.txt"],
  // Kiro V3 2.33.0: the startup workspace trust dialog, before and after one Down at each width.
  ["kiro", "kiro--v3-workspace-trust-continue-w120.txt", "kiro--v3-workspace-trust-exit-w120.txt"],
  ["kiro", "kiro--v3-workspace-trust-continue-w60.txt", "kiro--v3-workspace-trust-exit-w60.txt"],
  ["kiro", "kiro--v3-workspace-trust-continue-w40.txt", "kiro--v3-workspace-trust-exit-w40.txt"],
  // Kiro V3 2.32.0: the same shell request with Allow, Always allow and Deny pointed.
  ["kiro", "kiro--v3-approval-allow-w120.txt", "kiro--v3-approval-deny-w120.txt"],
  ["kiro", "kiro--v3-approval-always-w120.txt", "kiro--v3-approval-deny-w120.txt"],
  ["kiro", "kiro--v3-approval-allow-w60.txt", "kiro--v3-approval-deny-w60.txt"],
  ["kiro", "kiro--v3-approval-denied-request-allow-w120.txt", "kiro--v3-approval-denied-request-deny-w120.txt"],
  ["kiro", "kiro--v3-shell-args-allow-w120.txt", "kiro--v3-shell-args-deny-w120.txt"],
  ["kiro", "kiro--v3-shell-args-allow-w60.txt", "kiro--v3-shell-args-deny-w60.txt"],
  ["kiro", "kiro--v3-shell-bare-allow-w120.txt", "kiro--v3-shell-bare-deny-w120.txt"],
  ["kiro", "kiro--v3-shell-wrapped-allow-w120.txt", "kiro--v3-shell-wrapped-deny-w120.txt"],
  ["kiro", "kiro--v3-shell-wrapped-allow-w60.txt", "kiro--v3-shell-wrapped-deny-w60.txt"],
  // Installed V3 file tools: Allow and Deny with the complete read/diff preview unchanged.
  ["kiro", "kiro--v3-read-allow-w120.txt", "kiro--v3-read-deny-w120.txt"],
  ["kiro", "kiro--v3-read-allow-w60.txt", "kiro--v3-read-deny-w60.txt"],
  ["kiro", "kiro--v3-read-denied-request-allow-w120.txt", "kiro--v3-read-denied-request-deny-w120.txt"],
  ["kiro", "kiro--v3-write-allow-w120.txt", "kiro--v3-write-deny-w120.txt"],
  ["kiro", "kiro--v3-write-allow-w60.txt", "kiro--v3-write-deny-w60.txt"],
  ["kiro", "kiro--v3-write-lines-allow-w120.txt", "kiro--v3-write-lines-deny-w120.txt"],
  ["kiro", "kiro--v3-write-denied-request-allow-w120.txt", "kiro--v3-write-denied-request-deny-w120.txt"],
  ["kiro", "kiro--v3-replace-allow-w120.txt", "kiro--v3-replace-deny-w120.txt"],
  ["kiro", "kiro--v3-replace-allow-w60.txt", "kiro--v3-replace-deny-w60.txt"],
  ["kiro", "kiro--v3-replace-denied-request-allow-w120.txt", "kiro--v3-replace-denied-request-deny-w120.txt"],
  ["kiro", "kiro--v3-read-wrapped-allow-w120.txt", "kiro--v3-read-wrapped-deny-w120.txt"],
  ["kiro", "kiro--v3-read-wrapped-allow-w60.txt", "kiro--v3-read-wrapped-deny-w60.txt"],
  // Kiro V3 2.32.0 with tools trusted: write and replace panels also offer Always allow.
  ["kiro", "kiro--v3-write-trusted-allow-w120.txt", "kiro--v3-write-trusted-deny-w120.txt"],
  ["kiro", "kiro--v3-write-trusted-always-w120.txt", "kiro--v3-write-trusted-deny-w120.txt"],
  ["kiro", "kiro--v3-replace-trusted-allow-w120.txt", "kiro--v3-replace-trusted-deny-w120.txt"],
];

/**
 * Grammar groups with no pair in the corpus yet, keyed as {@link walkGroupKey}, one line of reason
 * each, dated. The ratchet fails when a listed group gains a pair (remove the entry) or has no walked
 * fixture left (stale). Gaps only shrink: the set of keys is pinned by a literal list in
 * `conformance.test.ts`, so a new gap needs a second capture first, and adding one is a reviewed
 * decision. An entry is a debt, not a fix: it says "nothing proves this grammar blanks what follows
 * its pointer".
 */
export interface WalkGap {
  /** The date the gap was listed (ISO), so its age is visible in review. */
  since: string;
  /** One line: why no pair exists yet. */
  reason: string;
}

export const WALK_GAPS = {
  "claude | trust | Quick safety check": {
    since: "2026-10-03",
    reason: "no second capture yet: the two captures differ in width and both have the pointer on the first row",
  },
  "codex | trust | Trust this folder?": {
    since: "2026-10-03",
    reason: "no second capture yet: one capture, pointer on the first row",
  },
  "opencode | permission | % WebFetch https": {
    since: "2026-10-03",
    reason:
      "no second capture yet: one capture, pointer on the first chip (the same grammar as the bash dialog, " +
      "which has pairs, but the body differs)",
  },
  "opencode | permission | $ echo narrow-width-probe": {
    since: "2026-10-03",
    reason:
      "no second capture yet: the 50-column layout puts the chips on a row of their own, and only the pointer " +
      "on the first chip is captured",
  },
  "opencode | permission | This will allow edit until OpenCode is restarted.": {
    since: "2026-10-03",
    reason: "no second capture yet: one capture of the edit's `Always allow` step, pointer on Confirm",
  },
  "pi | select | Which package manager do you want to use?": {
    since: "2026-10-12",
    reason:
      "the PR 397 extension is unpublished, so no second capture can be made; its paired `Which database " +
      "provider` dialog proves the same grammar",
  },
  "pi | select | Auth": {
    since: "2026-10-12",
    reason:
      "the PR 397 extension is unpublished, so no second capture can be made; both Auth captures have the " +
      "pointer on the first row, and stock questionnaire tab pages have pairs",
  },
  "pi | select | 1": {
    since: "2026-10-12",
    reason: "the PR 397 extension is unpublished, so no second capture can be made of its compact tab strip",
  },
  "omp | select | Pick a colour": {
    since: "2026-10-03",
    reason: "no pointer-only pair: the two captures differ by a `✎ note` mark, which is note state, not the pointer",
  },
} satisfies Record<string, WalkGap>;
