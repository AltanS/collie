// The omp adapter (oh-my-pi's `omp` CLI, v17.2.12 through v18.4.10), the second registered harness.
// Its boxed-composer scanner (chrome.ts), rule-composer scanner (rule.ts) and shared lexing primitives
// (markers.ts) live alongside this file; this module composes them into the HarnessAdapter block and
// chrome re-surfacing surfaces. The `/resume` picker grammar is resume.ts, the `ask` tool's
// single-select grammar is ask.ts, the tool-approval grammar is approval.ts, the compact model picker
// grammar is switch.ts, and the modal gate that lets the unread-dialog card stand over every other omp
// modal is modal.ts.
//
// This adapter is TIER 1 EVERYWHERE EXCEPT FOUR SCREENS. `ompBuildBlocks` lifts the `/resume` session
// picker (resume.ts, .adr/0076), the `ask` tool's one-question single-select dialog (ask.ts,
// .adr/0077), the `bash` and `write` tool-approval dialog (approval.ts, .adr/0078) and the compact
// session-only model picker that `/switch` and Alt+P open (switch.ts, .adr/0079) as `prompt-select`
// lists, and returns one `raw` block for every other screen. Each lift carries the Tier-2 bar on its
// own (HARNESS_CONTRIBUTING.md): a dated corpus (`omp--menu-resume*.txt` and `omp--select-menu*.txt`,
// 2026-08 against v17.2.12; `omp--approval-*.txt`, 2026-09-10 against v18.1.17;
// `omp--select-menu-{noted,other}.txt`, 2026-10-01 against v18.4.4; `omp--v18-4-resume*.txt`,
// `omp--v18-4-ask-*.txt`, `omp--v18-4-approval-*.txt` and `omp--v18-4-switch*.txt`, 2026-10-02 against
// v18.4.10), a choreography notes file (omp/RESUME_NOTES.md, omp/ASK_NOTES.md, omp/APPROVAL_NOTES.md,
// omp/SWITCH_NOTES.md), the conformance run, and the maintainer's live verification against a real
// pane. `/resume`, the Ask dialog and the approval dialog were verified live on 2026-10-02 (omp
// 18.4.10), which RESUME_NOTES.md, ASK_NOTES.md, APPROVAL_NOTES.md and ADRs 0076 to 0078 record. The
// model picker's walks were checked against a sandbox pane without Enter, with the one-batch plan; its
// live tap verification is still the maintainer's (SWITCH_NOTES.md).
// Every pointed list here (resume, Ask, approval, model picker) builds its plans with `pointerWalk`
// and carries the pointer verbatim in `signature`, blank in `coreSignature`. A tap is walked, verified
// and then confirmed, never sent as one batch (.adr/0080): the arrows go first, bound to the tapped
// screen, and `Enter` goes only bound to a fresh read that shows the pointer on the tapped row. No
// grammar bends a plan to survive a race.
// Every other screen stays Tier 1: no `wizard`, `preview-select`, `multi-select` or `menu` is ever
// emitted, so no tap on any of them sends a key this adapter derived, and a mis-parse there costs
// cosmetics. The one key they can get is the unread-dialog card's declared Escape (below).
// `/model`, `/settings`, `/tree`, the Ask tool's multi-select and multi-question dialogs, every
// approval the grammar declines (another tool, a third option row, a countdown, an uncaptured preset),
// and the model picker's `@` quick-roles and task-model states are the screens that stay raw; a later contribution lifts them one at a time, each clearing the bar
// itself.
//
// Read the Tier-1 claim as one about `buildBlocks` ALONE, not one about the adapter. The chrome
// probes re-exported below sit on the REPLY path, and the paragraph after next spells out why:
// registering any adapter at all switches core off the one-shot send, after which `extractInputDraft`
// is what the submit key waits on and `composerReady` decides whether a byte is typed. Neither
// ORIGINATES a keystroke (nothing here is tappable) but `extractInputDraft` authorises one, so a
// wrong answer there stalls a send rather than costing cosmetics (chrome.ts repeats this at its
// definition). HARNESS_CONTRIBUTING.md's ladder is explicit about why the boundary sits where it does:
// every existing interactive kind already HAS a live keystroke recipe in core, so emitting one goes hot
// the moment detection matches. That is why the tool-approval lift (approval.ts) is the most
// conservative of the four: Approve runs a command or writes a file, so the grammar declines every
// shape it was not built against, its Deny button cannot land on Approve, and the card carries the
// command or the path it approves.
//
// What ships besides the picker is the read-only chrome layer, and it is not cosmetic: the statusline
// omp paints into or around its composer, a stranded draft, and, the reason this layer is worth its own
// PR, `composerReady`. Which reply path core takes is decided by whether an adapter EXISTS at all
// (reply-action.ts opens with `if (!adapter) return oneShot(args)`), so before this file omp panes took
// the legacy one-shot send: type AND submit in a single call. A phone reply sent while any modal owned
// the keyboard therefore fired the submit key at that modal, which confirms whatever row it had
// highlighted. Registering ANY adapter swaps that for type-then-verify — the submit key waits until
// `extractInputDraft` can see the text in the input — the composer, boxed or rule-shaped, or the
// `ask` tool's answer editor — while `composerReady` adds the pre-flight on top, reading the pane
// once BEFORE typing. It definitively answers `false` on every capture in this corpus where a modal
// is up (harness/omp.test.ts), so the message never reaches the modal either. Two honest edges: a
// failed pre-flight read falls through rather than blocking a send, and the user's deliberate `force`
// retry skips the pre-flight — in both cases type-then-verify is still what stands between the send
// and the submit key.
//
// How much of "every other screen stays raw" is TESTED versus STRUCTURAL, because the two are not the
// same guarantee:
//
//   - STRUCTURAL: the only arms in `ompBuildBlocks` that can emit a non-raw block are the `/resume`,
//     Ask single-select, tool-approval and model-picker detectors, and each is fail-closed on a whole
//     layout's worth of evidence (resume.ts, ask.ts, approval.ts, switch.ts). There is no other
//     detector to mis-fire, so no other screen, captured or not, can be up-levelled.
//   - TESTED, for the 85 screens in this corpus: 21 composer states, six answer-editor states, the
//     `/model` and `/settings` pickers (each in the 17.x/18.1 form with a moved-selection twin, and in
//     the 18.4 form), the `/tree` picker in both versions, the Ask tool's eleven screens, eight
//     tool-approval screens, the `/resume` picker in both layouts, and the compact model picker in 23
//     states. harness/omp.test.ts asserts that the `/resume` captures with at least one session, the
//     six one-question single-select Ask captures, the eight approval captures and the eighteen model
//     picker captures of its session state lift as a `prompt-select` list, that every other capture
//     builds only `raw` blocks, and that `composerReady === false` on every modal that is not the
//     answer editor (which is an input, so it answers `true`). Each screen that stays raw is
//     declined because it is out of scope above, or because its keys are a recipe no shared model
//     carries (the Ask multi-select toggles with Space after an arrow walk, .adr/0077). The
//     fail-closed contract says a detector returns null on anything it does not confidently recognise.
//
// THE WAY OUT OF A MODAL WE DID NOT LIFT. omp now declares `cancelKey: "Escape"` and
// `modalOnScreen: ompModalOnScreen` (.adr/0053, .adr/0076), so an omp modal that stays raw gets the
// unread-dialog card with one Escape button, never a card over a live composer: the card needs omp's
// own key-hint footer on screen, naming its way out (modal.ts). `/tree` prints no such footer in
// either capture, so it keeps no card.
//
// The tool-approval dialog used to be the honest gap in the TESTED line: that `hasComposer` would
// answer `false` on one was inferred from the other modals, and the premise it rested on, whether
// omp draws that screen as a box at all, was unmeasured. It is measured now, in omp v18.1.17 and
// v18.4.10. The dialog is a box spanning the pane, and EVERY row of it opens with a Box Drawing
// character at column 0 (`╭`, `│`, `╰`), which is exactly what `BOX_ROW` matches. `composerReady` is
// asserted `false` on all eight captures rather than argued about.
//
// Two fixture-derived scanners now carry that chrome claim. The boxed OMP 17/18.1.2 form remains
// anchored on `╰─ … ─╯` (closed or clipped) plus its adjacent top/status row. OMP 18.1.10's `rule`
// form has no bottom border, so rule.ts instead requires its renderer's whole tail choreography:
// a status-bearing top rule directly above `❯` plus bounded continuation rows, then exactly one blank
// gap and one standalone status row at the buffer tail. Neither scanner searches past a completed
// transcript row, and every captured picker and Ask dialog still makes both return null.
//
// OMP 18.4's `claude` and `borderless` composer shapes (issue #343) carry a third scanner, glyph-prompt.ts.
// `claude` is a rule pair around the `❯` rows with the status row directly under the bottom rule;
// `borderless` has no rule, so it takes only the `❯` rows directly above a styled status row that is the
// last non-blank row. Each declines on any modal and on every other shape's tail.

import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { locatePiComposer, piComposerPrompt, piDraft } from "./pi-shape";
import {
  extractGlyphInputDraft,
  extractGlyphStatusLines,
  glyphComposerPrompt,
  locateGlyphComposer,
  stripGlyphChrome,
} from "./glyph-prompt";
import { ompOpaqueDraft, ompReplyChunks } from "./reply-chunks";
import {
  composerPrompt as boxComposerPrompt,
  extractInputDraft as extractBoxInputDraft,
  extractStatusLines as extractBoxStatusLines,
  hasComposer as hasBoxComposer,
  stripChrome as stripBoxChrome,
} from "./chrome";
import {
  extractRuleInputDraft,
  extractRuleStatusLines,
  locateRuleComposer,
  ruleComposerPrompt,
  stripRuleChrome,
} from "./rule";
import { answerEditorDraft, answerEditorPrompt, locateAnswerEditor } from "./answer-editor";
import { decorateOmpDisplay } from "./display";
import { ompModalOnScreen } from "./modal";
import { detectApprovalRegion } from "./approval";
import { detectAskSelectRegion } from "./ask";
import { detectResumePickerRegion } from "./resume";
import { detectSwitchPickerRegion } from "./switch";

/**
 * omp's block pipeline: the `/resume` session picker (resume.ts, .adr/0076), the `ask` tool's
 * one-question single-select dialog (ask.ts, .adr/0077), the tool-approval dialog (approval.ts,
 * .adr/0078) or the compact model picker (switch.ts, .adr/0079) as a `prompt-select` list when one is
 * on screen at the tail, otherwise one raw block with the composer chrome stripped off the tail. Those
 * four arms are the ONLY dialog arms, and each is fail-closed on a whole layout's worth of evidence, so
 * everything else stays the universal Tier-0 shape plus a strip. The registry only ever hands this
 * function an omp pane, so there is no per-agent gate here.
 *
 * Everything above the dialog's title stays raw, so no context is lost; the approval card starts at
 * its title row, which holds the body it approves, and the model picker's card
 * starts at its list, so its title, status sentence and typed search stay raw above it. There is no composer to strip
 * while a dialog is up: it owns the keyboard, and `composerReady` answers false on it.
 *
 * No generic `menu` arm, for a reason that is pinned by a test rather than asserted in prose
 * (harness/omp.test.ts): `parseKeyHintFooter` (the shared, pinned key-hint grammar) returns `[]` for
 * six of omp's seven 17.x/18.1 modal footers, and for `/settings` it returns only `{Jump sections,
 * [Tab]}` + `{Close, [Escape]}` because `menuKeyFor` rejects the compound tokens (`Enter/Space`,
 * `←/→`, `Type`) that screen's real actions are named with. Shipping a modal whose only button is
 * "Jump sections" is worse than the raw mirror, and widening the shared grammar to fit omp would change
 * a contract Claude's `/model` picker is pinned against. The unread-dialog card (`cancelKey` below)
 * delivers the way out, and `composerReady` already delivers the safety half.
 */
export function ompBuildBlocks(lines: StyledLine[]): Block[] {
  // The four lifted screens never share a tail: each is anchored on its own bottom border and footer.
  const lifted =
    detectResumePickerRegion(lines) ??
    detectAskSelectRegion(lines) ??
    detectApprovalRegion(lines) ??
    detectSwitchPickerRegion(lines);
  if (lifted !== null) {
    const before = trimTrailingBlank(lines.slice(0, lifted.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: decorateOmpDisplay(before) });
    blocks.push({ kind: "prompt-select", prompt: lifted.model, lines: lines.slice(lifted.startLine) });
    return blocks;
  }
  return [{ kind: "raw", lines: decorateOmpDisplay(stripChrome(lines)) }];
}

export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const pi = locatePiComposer(lines);
  // The slash palette stands in the status row's place while it is up (pi-shape.ts), so there is no
  // statusline to lift off the mirror: the run below the composer is the palette's, and the phone
  // draws its own command list rather than echoing omp's here.
  if (pi) return pi.palette ? [] : decorateOmpDisplay(lines.slice(pi.bottom + 1, pi.suggestEnd));
  const rule = locateRuleComposer(lines);
  if (rule !== null) return decorateOmpDisplay(extractRuleStatusLines(lines, rule));
  const glyph = locateGlyphComposer(lines);
  if (glyph !== null) return decorateOmpDisplay(extractGlyphStatusLines(lines, glyph));
  return decorateOmpDisplay(extractBoxStatusLines(lines));
}

export function extractInputDraft(lines: StyledLine[]): string | null {
  const pi = locatePiComposer(lines);
  if (pi) return piDraft(lines, pi);
  const rule = locateRuleComposer(lines);
  if (rule !== null) return extractRuleInputDraft(lines, rule);
  const glyph = locateGlyphComposer(lines);
  return glyph === null ? extractBoxInputDraft(lines) : extractGlyphInputDraft(lines, glyph);
}

export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const pi = locatePiComposer(lines);
  if (pi) return lines.slice(0, pi.top);
  const rule = locateRuleComposer(lines);
  if (rule !== null) return stripRuleChrome(lines, rule);
  const glyph = locateGlyphComposer(lines);
  return glyph === null ? stripBoxChrome(lines) : stripGlyphChrome(lines, glyph);
}

export function hasComposer(lines: StyledLine[]): boolean {
  if (locatePiComposer(lines)) return true;
  if (locateRuleComposer(lines) !== null) return true;
  return locateGlyphComposer(lines) !== null || hasBoxComposer(lines);
}

export function composerPrompt(lines: StyledLine[]): string | null {
  const pi = locatePiComposer(lines);
  if (pi) return piComposerPrompt(lines, pi);
  const rule = locateRuleComposer(lines);
  if (rule !== null) return ruleComposerPrompt(lines, rule);
  const glyph = locateGlyphComposer(lines);
  return glyph === null ? boxComposerPrompt(lines) : glyphComposerPrompt(lines, glyph);
}

// Two inputs a phone reply can land in: the composer (boxed, rule or pi-shaped), and the `ask` tool's
// answer editor (the box `Other (type your own)` and `n note` open, omp/answer-editor.ts). They never
// share a screen: omp swaps its composer out for the editor while the editor is open. So each reply
// probe asks the composer first and the editor second. The editor is not a modal and not a lift:
// `buildBlocks` still leaves it raw, and nothing here originates a keystroke.
export const ompAdapter: HarnessAdapter = {
  replyChunks: ompReplyChunks,
  draftIsOpaque: ompOpaqueDraft,
  agent: "omp",
  buildBlocks: ompBuildBlocks,
  extractStatusLines,
  extractInputDraft: (lines) => (hasComposer(lines) ? extractInputDraft(lines) : answerEditorDraft(lines)),
  // The reply path's pre-flight. Either input is a place typing belongs; their absence is exactly the
  // condition under which typing would land in a modal instead. The `ask` answer editor is an input,
  // so it answers `true` here and never draws the unread-dialog card below.
  composerReady: (lines) => hasComposer(lines) || locateAnswerEditor(lines) !== null,
  // The way OUT of an omp modal, for the unread-dialog card (.adr/0053, .adr/0076): omp's own footers
  // print it as `⎋ cancel` / `⎋ close` / `⎋ to close` (omp 18.4, `omp--v18-4-menu-model.txt`,
  // `omp--v18-4-menu-settings.txt`, `omp--v18-4-resume.txt`) and as `Esc cancel` / `Esc close` /
  // `Esc to close` before that (`omp--menu-model.txt`, `omp--select-menu.txt`, `omp--menu-resume.txt`),
  // and the approval dialog prints `esc cancel` in 18.1 (`omp--approval-bash.txt`) and `⎋ cancel` in
  // 18.4 (`omp--v18-4-approval-bash.txt`). Escape is the key all of them name. An approval the grammar
  // declines keeps this card, and Escape there is a denial (approval.ts).
  //
  // This was declined in ADR 0053 for one reason, and it is answered by the next line rather than
  // ignored. `composerReady` has a total, permanent false-negative mode (`omp/chrome.ts`: one ZWJ emoji
  // in a statusline template and `locateComposer` returns null on EVERY frame), so a card gated on it
  // alone would paint itself over a live composer for good. The card also needs `modalOnScreen`, and
  // omp's answer is positive evidence: its own key-hint footer, naming its way out, at the buffer tail
  // (modal.ts). A composer never has that, so the ZWJ pane shows no card.
  cancelKey: "Escape",
  modalOnScreen: ompModalOnScreen,
  // …and the exact on-screen draft region the destructive pre-clear is bound to on the wire: the
  // box's bottom prompt row or all of the rule composer's prompt rows. The box scanner declines when
  // a long palette pushes that row out of range; the rule region ends one status row from the tail.
  // The answer editor's region is its last answer row, four rows above the tail.
  composerPrompt: (lines) => (hasComposer(lines) ? composerPrompt(lines) : answerEditorPrompt(lines)),
  // The composer inserts a raw newline; the answer editor SUBMITS on one (answer-editor.ts).
  newlineSubmits: (lines) => !hasComposer(lines) && locateAnswerEditor(lines) !== null,
  // Numbered paste chips contain no content evidence. Keep literal verification
  // by sending small, independently checked transport pastes instead.
};
