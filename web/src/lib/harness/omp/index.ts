// The omp adapter (oh-my-pi's `omp` CLI, v17.2.12 through v18.4.10), the second registered harness.
// Its boxed-composer scanner (chrome.ts), rule-composer scanner (rule.ts) and shared lexing primitives
// (markers.ts) live alongside this file; this module composes them into the HarnessAdapter block and
// chrome re-surfacing surfaces. The `/resume` picker grammar is resume.ts, and the modal gate that
// lets the unread-dialog card stand over every other omp modal is modal.ts.
//
// This adapter is TIER 1 EVERYWHERE EXCEPT ONE SCREEN. `ompBuildBlocks` lifts the `/resume` session
// picker as a `prompt-select` list (resume.ts, .adr/0076) and returns one `raw` block for every other
// screen. That is a Tier-2 lift for exactly one dialog, and it carries the Tier-2 bar on its own
// (HARNESS_CONTRIBUTING.md): a dated corpus (`omp--menu-resume*.txt`, 2026-08 against v17.2.12, and
// `omp--v18-4-resume*.txt`, 2026-10-02 against v18.4.10), a choreography notes file
// (omp/RESUME_NOTES.md), the conformance run, and the maintainer's live verification against a real
// pane (2026-10-02, omp 18.4.10), which RESUME_NOTES.md and the ADR record.
// Every other screen stays Tier 1: no `wizard`, `preview-select`, `multi-select` or `menu` is ever
// emitted, so no tap on any of them sends a key this adapter derived, and a mis-parse there costs
// cosmetics. The one key they can get is the unread-dialog card's declared Escape (below).
// `/model`, `/settings`, `/tree`, the Ask tool's selects and the tool-approval dialog are the screens
// that stay raw; a later contribution lifts them one at a time, each clearing the bar itself.
//
// Read the Tier-1 claim as one about `buildBlocks` ALONE, not one about the adapter. The chrome
// probes re-exported below sit on the REPLY path, and the paragraph after next spells out why:
// registering any adapter at all switches core off the one-shot send, after which `extractInputDraft`
// is what the submit key waits on and `composerReady` decides whether a byte is typed. Neither
// ORIGINATES a keystroke (nothing here is tappable) but `extractInputDraft` authorises one, so a
// wrong answer there stalls a send rather than costing cosmetics (chrome.ts repeats this at its
// definition). HARNESS_CONTRIBUTING.md's ladder is explicit about why the boundary sits where it does:
// every existing interactive kind already HAS a live keystroke recipe in core, so emitting one goes hot
// the moment detection matches. The tool-approval dialog is a genuine Tier-2 candidate and is
// deliberately NOT lifted here; doing so is a separate, later contribution that must clear that bar on
// its own, live-verification included. It IS in the corpus (`omp--approval-bash`, `omp--approval-write`,
// `omp--approval-write--deny`, captured 2026-09-10 against omp v18.1.17), so the raw-only and
// `composerReady === false` claims below are tested on it rather than argued about.
//
// What ships besides the picker is the read-only chrome layer, and it is not cosmetic: the statusline
// omp paints into or around its composer, a stranded draft, and, the reason this layer is worth its own
// PR, `composerReady`. Which reply path core takes is decided by whether an adapter EXISTS at all
// (reply-action.ts opens with `if (!adapter) return oneShot(args)`), so before this file omp panes took
// the legacy one-shot send: type AND submit in a single call. A phone reply sent while any modal owned
// the keyboard therefore fired the submit key at that modal, which confirms whatever row it had
// highlighted. Registering ANY adapter swaps that for type-then-verify — the submit key waits until
// `extractInputDraft` can see the text in the composer — boxed or rule-shaped — while
// `composerReady` adds the pre-flight on top, reading the pane once BEFORE typing. It definitively
// answers `false` on every capture in this corpus where a modal is up (harness/omp.test.ts), so
// the message never reaches the modal either. Two honest edges: a failed pre-flight read falls through
// rather than blocking a send, and the user's deliberate `force` retry skips the pre-flight — in both
// cases type-then-verify is still what stands between the send and the submit key.
//
// How much of "every other screen stays raw" is TESTED versus STRUCTURAL, because the two are not the
// same guarantee:
//
//   - STRUCTURAL: the only arm in `ompBuildBlocks` that can emit a non-raw block is the `/resume`
//     detector, and it is fail-closed on a whole layout's worth of evidence (resume.ts). There is no
//     other detector to mis-fire, so no other screen, captured or not, can be up-levelled. That
//     covers the tool-approval dialog by construction.
//   - TESTED, for the 42 screens in this corpus: 19 composer states, the `/model` and `/settings`
//     pickers (each in the 17.x/18.1 form with a moved-selection twin, and in the 18.4 form), the
//     `/tree` picker in both versions, the Ask tool's five screens, three tool-approval screens, and
//     the `/resume` picker in both layouts. harness/omp.test.ts asserts that the `/resume` captures
//     with at least one session lift as a `prompt-select` list, that the 18.4 no-match screen and
//     every other capture build only `raw` blocks, and that `composerReady === false` on every modal.
//     Each screen that stays raw is declined because it is out of scope above, or a widget whose
//     `handleInput` we have not read, or one whose options include a free-text row that would strand
//     a phone user — the fail-closed contract says a detector returns null on anything it does not
//     confidently recognise.
//
// THE WAY OUT OF A MODAL WE DID NOT LIFT. omp now declares `cancelKey: "Escape"` and
// `modalOnScreen: ompModalOnScreen` (.adr/0053, .adr/0076), so an omp modal that stays raw gets the
// unread-dialog card with one Escape button, never a card over a live composer: the card needs omp's
// own key-hint footer on screen, naming its way out (modal.ts). `/tree` prints no such footer in
// either capture, so it keeps no card.
//
// The tool-approval dialog used to be the honest gap in the TESTED line: that `hasComposer` would
// answer `false` on one was inferred from the other modals, and the premise it rested on — whether
// omp draws that screen as a box at all — was unmeasured. It is measured now. In omp v18.1.17 the
// dialog is a box spanning the pane, and EVERY row of it opens with a Box Drawing character at
// column 0 (`╭`, `│`, `╰`), which is exactly what `BOX_ROW` matches. `composerReady` is asserted
// `false` on all three captures rather than argued about. Captured for a `bash` approval and a
// `write` approval, the latter in both selection states. Two tools at one width is not every screen
// omp can draw, so the STRUCTURAL guarantee above is still what covers the rest.
//
// Two fixture-derived scanners now carry that chrome claim. The boxed OMP 17/18.1.2 form remains
// anchored on `╰─ … ─╯` (closed or clipped) plus its adjacent top/status row. OMP 18.1.10's `rule`
// form has no bottom border, so rule.ts instead requires its renderer's whole tail choreography:
// a status-bearing top rule directly above `❯` plus bounded continuation rows, then exactly one blank
// gap and one standalone status row at the buffer tail. Neither scanner searches past a completed
// transcript row, and every captured picker and Ask dialog still makes both return null.

import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { locatePiComposer, piDraft } from "./pi-shape";
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
import { decorateOmpDisplay } from "./display";
import { ompModalOnScreen } from "./modal";
import { detectResumePickerRegion } from "./resume";

/**
 * omp's block pipeline: the `/resume` session picker as a `prompt-select` list when it is on screen at
 * the tail (resume.ts, .adr/0076), otherwise one raw block with the composer chrome stripped off the
 * tail. The picker arm is the ONLY dialog arm, and it is fail-closed on a whole layout's worth of
 * evidence, so everything else stays the universal Tier-0 shape plus a strip. The registry only ever
 * hands this function an omp pane, so there is no per-agent gate here.
 *
 * Everything above the picker's title stays raw, so no context is lost. There is no composer to strip
 * while the picker is up: it owns the keyboard, and `composerReady` answers false on it.
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
  const resume = detectResumePickerRegion(lines);
  if (resume !== null) {
    const before = trimTrailingBlank(lines.slice(0, resume.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: decorateOmpDisplay(before) });
    blocks.push({ kind: "prompt-select", prompt: resume.model, lines: lines.slice(resume.startLine) });
    return blocks;
  }
  return [{ kind: "raw", lines: decorateOmpDisplay(stripChrome(lines)) }];
}

export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const pi = locatePiComposer(lines);
  if (pi) return decorateOmpDisplay(lines.slice(pi.bottom + 1, pi.suggestEnd));
  const rule = locateRuleComposer(lines);
  const status = rule === null ? extractBoxStatusLines(lines) : extractRuleStatusLines(lines, rule);
  return decorateOmpDisplay(status);
}

export function extractInputDraft(lines: StyledLine[]): string | null {
  const pi = locatePiComposer(lines);
  if (pi) return piDraft(lines, pi);
  const rule = locateRuleComposer(lines);
  return rule === null ? extractBoxInputDraft(lines) : extractRuleInputDraft(lines, rule);
}

export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const pi = locatePiComposer(lines);
  if (pi) return lines.slice(0, pi.top);
  const rule = locateRuleComposer(lines);
  return rule === null ? stripBoxChrome(lines) : stripRuleChrome(lines, rule);
}

export function hasComposer(lines: StyledLine[]): boolean {
  if (locatePiComposer(lines)) return true;
  return locateRuleComposer(lines) !== null || hasBoxComposer(lines);
}

export function composerPrompt(lines: StyledLine[]): string | null {
  const pi = locatePiComposer(lines);
  if (pi) return lines.slice(pi.top, pi.bottom + 1).map((line) => line.segments.map((s) => s.text).join("").trimEnd()).join("\n");
  const rule = locateRuleComposer(lines);
  return rule === null ? boxComposerPrompt(lines) : ruleComposerPrompt(lines, rule);
}

export const ompAdapter: HarnessAdapter = {
  replyChunks: ompReplyChunks,
  draftIsOpaque: ompOpaqueDraft,
  agent: "omp",
  buildBlocks: ompBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  // The reply path's pre-flight. omp's composer is exactly what `hasComposer` finds, and its absence
  // is exactly the condition under which typing would land in a modal instead.
  composerReady: hasComposer,
  // The way OUT of an omp modal, for the unread-dialog card (.adr/0053, .adr/0076): omp's own footers
  // print it as `⎋ cancel` / `⎋ close` / `⎋ to close` (omp 18.4, `omp--v18-4-menu-model.txt`,
  // `omp--v18-4-menu-settings.txt`, `omp--v18-4-resume.txt`) and as `Esc cancel` / `Esc close` /
  // `Esc to close` before that (`omp--menu-model.txt`, `omp--select-menu.txt`, `omp--menu-resume.txt`),
  // and the approval dialog prints `esc cancel` (`omp--approval-bash.txt`). Escape is the key all of
  // them name.
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
  composerPrompt,
  // Numbered paste chips contain no content evidence. Keep literal verification
  // by sending small, independently checked transport pastes instead.
};
