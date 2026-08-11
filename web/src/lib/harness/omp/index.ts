// The omp adapter (oh-my-pi's `omp` CLI, v17.2.12) — the second registered harness. Its composer
// scanner (chrome.ts) and the lexing primitives under it (markers.ts) live alongside this file; this
// module wires them into the HarnessAdapter surfaces: the block pipeline (ompBuildBlocks) and the
// chrome re-surfacing probes (re-exported from ./chrome).
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
// What ships here is the read-only layer (chrome.ts), and it is not cosmetic: the statusline omp paints
// into its composer's top border, a stranded draft, and — the reason this layer is worth its own PR —
// `composerReady`. Which reply path core takes is decided by whether an adapter EXISTS at all
// (reply-action.ts opens with `if (!adapter) return oneShot(args)`), so before this file omp panes took
// the legacy one-shot send: type AND submit in a single call. A phone reply sent while any modal owned
// the keyboard therefore fired the submit key at that modal, which confirms whatever row it had
// highlighted. Registering ANY adapter swaps that for type-then-verify — the submit key waits until
// `extractInputDraft` can see the text in the box — and supplying `composerReady` adds the pre-flight
// on top, which reads the pane once BEFORE typing and refuses on a definite `false`. This adapter
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
//   - TESTED, for the twenty screens in this corpus: nine composer states, six picker screens
//     (`/model`, `/settings`, `/resume`, each with a moved-selection twin) and five Ask-tool screens.
//     harness/omp.test.ts asserts raw-only over all twenty and `composerReady === false` over the
//     eleven modals, so the declining is a test result rather than an accident. Each is declined
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
// One more limit worth stating where the tier is claimed, because it is the adapter's sharpest edge:
// the whole composer lift hangs off ONE literal, the `╰─ … ─╯` bottom border with its one-space
// gutters. The census behind that is real — once per composer capture, nowhere in the other 49 — but
// it is a measurement of omp 17.2.12's renderer, not a proof about it. omp already draws a two-row
// full-width box at column 0 whose text lives in the TOP border (`╭─── ✘ Error: … ───╮`), so a widget
// that ever labelled its BOTTOM border the way the composer does would be read as a composer. What
// bounds the damage is that it can only mislead while it is the LAST box on screen: with any of omp's
// modals under it the box rule declines the whole shape, which is the case that mattered.

import type { Block, StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import {
  composerPrompt,
  extractInputDraft,
  extractStatusLines,
  hasComposer,
  stripChrome,
} from "./chrome";

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

export { extractStatusLines, extractInputDraft };

export const ompAdapter: HarnessAdapter = {
  agent: "omp",
  buildBlocks: ompBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  // The reply path's pre-flight. omp's composer is exactly what `hasComposer` finds, and its absence
  // is exactly the condition under which typing would land in a modal instead.
  composerReady: hasComposer,
  // …and the region that pre-flight's verdict is bound to on the wire. omp's `╰─ … ─╯` sits at the
  // tail on seven of the nine composer captures and behind at most five palette rows on the other
  // two, so it is well inside the tail window the bridge accepts a binding within.
  composerPrompt,
  // `draftCarriesSend` / `draftIsOpaque` are deliberately ABSENT, which is the documented default:
  // omp echoes typed text back verbatim (see the draft-single / draft-wrapped captures) and has no
  // paste-collapse token of its own, so the reply guard's generic literal-substring match already sees
  // what it needs and there is nothing extra for these hooks to read.
};
