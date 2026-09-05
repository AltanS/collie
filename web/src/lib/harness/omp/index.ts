// The omp adapter (oh-my-pi's `omp` CLI, v17.2.12 through v18.1.10) — the second registered harness.
// Its boxed-composer scanner (chrome.ts), rule-composer scanner (rule.ts) and shared lexing primitives
// (markers.ts) live alongside this file; this module composes them into the HarnessAdapter block and
// chrome re-surfacing surfaces.
//
// This adapter is TIER 1 ONLY, BY CHOICE, and the choice is what makes it mergeable from fixtures
// alone. It emits NO interactive block kind — not `prompt-select`, `wizard`, `preview-select`,
// `multi-select` or `menu` — so no tap anywhere in the app can turn one of its derivations into a
// keystroke, and a mis-parse in `ompBuildBlocks` costs cosmetics rather than a key typed into a live
// terminal.
//
// Read that as a claim about `buildBlocks` ALONE — it is not one about the adapter. The chrome probes
// re-exported below sit on the REPLY path, and the paragraph after next spells out why: registering
// any adapter at all switches core off the one-shot send, after which `extractInputDraft` is what the
// submit key waits on and `composerReady` decides whether a byte is typed. Neither ORIGINATES a
// keystroke — nothing here is tappable — but `extractInputDraft` authorises one, so a wrong answer
// there stalls a send rather than costing cosmetics (chrome.ts repeats this at its definition).
// HARNESS_CONTRIBUTING.md's ladder is explicit about why that boundary is where it is: every existing
// interactive kind already HAS a live keystroke recipe in core, so emitting one goes hot the moment
// detection matches, which is Tier 2 and needs the full bar — a dated corpus, a choreography notes
// file, a green conformance run, and maintainer live-verification against a real pane. omp's
// tool-approval dialog is a genuine Tier-2 candidate and is deliberately NOT in this contribution; it
// is a separate, later one that must clear that bar on its own, live-verification included. It is
// also NOT IN THE CORPUS — no capture of it exists here, which is why nothing below claims it as
// tested.
//
// What ships here is the read-only chrome layer, and it is not cosmetic: the statusline omp paints
// into or around its composer, a stranded draft, and — the reason this layer is worth its own PR —
// `composerReady`. Which reply path core takes is decided by whether an adapter EXISTS at all
// (reply-action.ts opens with `if (!adapter) return oneShot(args)`), so before this file omp panes took
// the legacy one-shot send: type AND submit in a single call. A phone reply sent while any modal owned
// the keyboard therefore fired the submit key at that modal, which confirms whatever row it had
// highlighted. Registering ANY adapter swaps that for type-then-verify — the submit key waits until
// `extractInputDraft` can see the text in the composer — boxed or rule-shaped — while
// `composerReady` adds the pre-flight on top, reading the pane once BEFORE typing. It definitively
// answers `false` on all eleven captures in this corpus where a modal is up (harness/omp.test.ts), so
// the message never reaches the modal either. Two honest edges: a failed pre-flight read falls through
// rather than blocking a send, and the user's deliberate `force` retry skips the pre-flight — in both
// cases type-then-verify is still what stands between the send and the submit key.
//
// Every omp screen therefore stays RAW, and it is worth being exact about how much of that is TESTED
// versus STRUCTURAL, because the two are not the same guarantee:
//
//   - STRUCTURAL, for every screen omp can draw: `ompBuildBlocks` returns one `raw` block
//     unconditionally. There is no detector to mis-fire, so no screen — captured or not — can be
//     up-levelled. That covers the tool-approval dialog by construction.
//   - TESTED, for the 25 screens in this corpus: 14 composer states, six picker screens
//     (`/model`, `/settings`, `/resume`, each with a moved-selection twin) and five Ask-tool screens.
//     harness/omp.test.ts asserts raw-only over all 25 and `composerReady === false` over the eleven
//     modals, so the declining is a test result rather than an accident. Each is declined
//     because it is out of scope above, or a widget whose `handleInput` we have not read, or one
//     whose options include a free-text row that would strand a phone user — the fail-closed
//     contract says a detector returns null on anything it does not confidently recognise.
//   - NEITHER, and the honest gap: omp's TOOL-APPROVAL dialog is not in the corpus. That `hasComposer`
//     would answer `false` on one is INFERRED from the eleven modals that are captured, and nothing
//     here measures it. The inference is at least about a rule the scanner really has: all eleven are
//     BOXES drawn at column 0, and `locateComposer` declines any composer with a box under it, so an
//     approval dialog drawn the way all eleven are is refused by that rule rather than by luck. What
//     is unmeasured is the premise — whether omp draws that screen as a box at all. It is the screen
//     where a wrong `true` would be worst, so capturing it is the first thing the Tier-2 contribution
//     owes, ahead of any grammar.
//
// Two fixture-derived scanners now carry that chrome claim. The boxed OMP 17/18.1.2 form remains
// anchored on `╰─ … ─╯` (closed or clipped) plus its adjacent top/status row. OMP 18.1.10's `rule`
// form has no bottom border, so rule.ts instead requires its renderer's whole tail choreography:
// a status-bearing top rule directly above `❯` plus bounded continuation rows, then exactly one blank
// gap and one standalone status row at the buffer tail. Neither scanner searches past a completed
// transcript row, and every captured picker and Ask dialog still makes both return null.

import type { Block, StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
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

/**
 * omp's block pipeline: one raw block with the composer chrome stripped off the tail. There is no
 * dialog arm at all — see the module header for why the interactive layer is a separate contribution
 * — so this is the universal Tier-0 shape plus a strip, and the registry only ever hands this function
 * an omp pane, so there is no per-agent gate here.
 *
 * No generic `menu` arm either, for a reason that is now pinned by a test rather than asserted in
 * prose (harness/omp.test.ts): `parseKeyHintFooter` (the shared, pinned key-hint grammar) returns `[]`
 * for six of omp's seven modal footers, and for `/settings` it returns only `{Jump sections, [Tab]}` +
 * `{Close, [Escape]}` because `menuKeyFor` rejects the compound tokens (`Enter/Space`, `←/→`, `Type`)
 * that screen's real actions are named with. Shipping a modal whose only button is "Jump sections" is
 * worse than the raw mirror, and widening the shared grammar to fit omp would change a contract
 * Claude's `/model` picker is pinned against. `composerReady` already delivers the safety half.
 */
export function ompBuildBlocks(lines: StyledLine[]): Block[] {
  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const rule = locateRuleComposer(lines);
  return rule === null ? extractBoxStatusLines(lines) : extractRuleStatusLines(lines, rule);
}

export function extractInputDraft(lines: StyledLine[]): string | null {
  const rule = locateRuleComposer(lines);
  return rule === null ? extractBoxInputDraft(lines) : extractRuleInputDraft(lines, rule);
}

function stripChrome(lines: StyledLine[]): StyledLine[] {
  const rule = locateRuleComposer(lines);
  return rule === null ? stripBoxChrome(lines) : stripRuleChrome(lines, rule);
}

function hasComposer(lines: StyledLine[]): boolean {
  return locateRuleComposer(lines) !== null || hasBoxComposer(lines);
}

function composerPrompt(lines: StyledLine[]): string | null {
  const rule = locateRuleComposer(lines);
  return rule === null ? boxComposerPrompt(lines) : ruleComposerPrompt(lines, rule);
}

export const ompAdapter: HarnessAdapter = {
  agent: "omp",
  buildBlocks: ompBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  // The reply path's pre-flight. omp's composer is exactly what `hasComposer` finds, and its absence
  // is exactly the condition under which typing would land in a modal instead.
  composerReady: hasComposer,
  // …and the exact on-screen draft region the destructive pre-clear is bound to on the wire: the
  // box's bottom prompt row or all of the rule composer's prompt rows. The box scanner declines when
  // a long palette pushes that row out of range; the rule region ends one status row from the tail.
  composerPrompt,
  // `draftCarriesSend` / `draftIsOpaque` are deliberately ABSENT, which is the documented default:
  // omp echoes typed text back verbatim (see the draft-single / draft-wrapped captures) and has no
  // paste-collapse token of its own, so the reply guard's generic literal-substring match already sees
  // what it needs and there is nothing extra for these hooks to read.
};
