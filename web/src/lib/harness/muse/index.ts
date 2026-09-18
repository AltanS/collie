// The Muse harness adapter — Tier 1 chrome + Tier-2 approval / single-select / multi-select /
// trust lifts for Muse Code 1.3.0 (agent string "muse").
//
// The TUI this reads (see grammar/MUSE_DIALOG_NOTES.md for the full probe log):
//
//     <transcript: ❯ echoes, ◆/◇/◈ status rows with live (Ns) timers>
//     <dialog — one of the four below, or nothing>
//     ── Voice input … ──              (titled rule above the composer)
//     ❯ <draft…>                       (bare while a dialog owns the keyboard)
//       <continuations…>
//     ─────────────────                 (full-width bottom rule)
//       muse-spark-1.3 · …              (opaque statusline)
//
//   - Approval REPLACES the box (no ❯ row): `Would you like to run the following command?` + `$` /
//     `Stage N/M` / `Current argv:` subject + `› N.` options. Digit alone (family `permission`).
//   - Questions LEAVE the bare ❯ under them: `Request user input` header (live timer — anchors
//     detection, never enters a signature) + question + `› N.` options + footer. Digits MOVE the
//     pointer; Enter selects (family `select`, keys [digit, Enter]).
//   - Checkbox adds `[ ]`/`[x]` prefixes + a numbered `Submit answer (N checked)` row and a review
//     phase (`Review answers before submit` + `> Submit answers` / `Interrupt turn`). Pointer-mode
//     choreography throughout (`toggle`/`submit: "pointer"`): digit-jump + verified Enter to toggle,
//     a verified pointer walk + freshly-bound Enter to submit — review swallows digits entirely.
//   - Trust is pre-session (no chrome at all): `Do you trust this workspace?` + period-less `N  Label`
//     options. Digit alone (family `trust`).
//
// Registering this adapter flips Muse panes off one-shot sends onto the guarded reply path (D3):
// type-then-verify against `extractInputDraft`, with the paste-token supplement (paste.ts) for the
// per-line `[Pasted Content N chars]` collapse. Three accepted tradeoffs are stated here because
// they are load-bearing for review:
//
//   1. Signatures run question → dialog end with NO transcript lookback. The transcript rows above
//      carry live spinner timers that would churn a lookback signature every second and 409 every
//      tap. Cost: two consecutive byte-identical dialogs share one signature, so a tap on the first
//      may land on the second — the same command/answer the user consented to. Same bargain on all
//      four dialogs.
//   2. The palette, `/resume` picker, `/tasks` drawer and `/workflows` room are unmeasured (D5
//      scope): if one leaves a live ❯ below it, the pre-flight types into it and type-then-verify
//      withholds the submit key (a stall, not a misfire — the backstop holds where the pre-flight
//      cannot see). See composerReady.
//   3. An open `Note (optional):` row declines its dialog to raw (it owns the keyboard — probed) and
//      fails the composer gate, so the phone shows the mirror and the keys pad, never buttons.

import type { Block, StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { detectApprovalRegion } from "./approval";
import { detectCheckboxRegion } from "./checkbox";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  stripChrome,
} from "./chrome";
import { museDraftIsOpaque, musePasteCarriesSend } from "./paste";
import { detectQuestionRegion } from "./question";
import { detectTrustRegion } from "./trust";

/**
 * Muse's pane → blocks. The four dialog arms run in D5 build order (approval → single → multi →
 * trust); the shapes are disjoint (exact questions, checkbox prefixes, period-less trust options),
 * so order is documentation, not disambiguation. Nothing matches → one raw block with the composer
 * chrome stripped, ready for the native-mirror decoration passes in harness/index.
 */
export function museBuildBlocks(lines: StyledLine[]): Block[] {
  const approval = detectApprovalRegion(lines);
  if (approval !== null) {
    return [
      { kind: "prompt-select", prompt: approval.model, lines: lines.slice(approval.startLine) },
    ];
  }
  const question = detectQuestionRegion(lines);
  if (question !== null) {
    return [
      { kind: "prompt-select", prompt: question.model, lines: lines.slice(question.startLine) },
    ];
  }
  const checkbox = detectCheckboxRegion(lines);
  if (checkbox !== null) {
    return [{ kind: "multi-select", multi: checkbox.model, lines: lines.slice(checkbox.startLine) }];
  }
  const trust = detectTrustRegion(lines);
  if (trust !== null) {
    return [{ kind: "prompt-select", prompt: trust.model, lines: lines.slice(trust.startLine) }];
  }
  return [{ kind: "raw", lines: stripChrome(lines) }];
}

/**
 * The Muse adapter: Tier-1 composer/status/draft/chrome probes plus the four Tier-2 dialog lifts.
 * Registers under the EXACT Herdr agent string "muse" (registry.ts) — prefix-matching is banned
 * (AltanS/collie#99). The paste supplement + opacity predicate are what keep long sends verifying
 * once this registration flips the reply path off one-shot.
 */
export const museAdapter: HarnessAdapter = {
  agent: "muse",
  buildBlocks: museBuildBlocks,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  composerPrompt,
  draftCarriesSend: musePasteCarriesSend,
  draftIsOpaque: museDraftIsOpaque,
};
