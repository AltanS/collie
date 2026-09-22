// The Muse harness adapter — Tier 1 chrome + Tier-2 approval / single-select / multi-select /
// trust lifts for Muse Code 1.3.0 (agent string "muse").
//
// The TUI this reads (see DIALOG_NOTES.md beside this file for the full probe log):
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
// Registering this adapter flips Muse panes off one-shot sends onto the guarded reply path:
// type-then-verify against `extractInputDraft`, with the paste-token supplement (paste.ts) for the
// per-line `[Pasted Content N chars]` collapse. Three accepted tradeoffs are stated here because
// they are load-bearing for review:
//
//   1. Signatures run question → dialog end with NO transcript lookback. The transcript rows above
//      carry live spinner timers that would churn a lookback signature every second and 409 every
//      tap. Cost: two consecutive byte-identical dialogs share one signature, so a tap on the first
//      may land on the second — the same command/answer the user consented to. Same bargain on all
//      four dialogs.
//   2. The palette, `/resume` picker, `/tasks` drawer and `/workflows` room are unmeasured (outside
//      the dialog notes' scope): if one leaves a live ❯ below it, the pre-flight types into it and type-then-verify
//      withholds the submit key (a stall, not a misfire — the backstop holds where the pre-flight
//      cannot see). See composerReady.
//   3. An open `Note (optional):` row declines its dialog to raw (it owns the keyboard — probed) and
//      fails the composer gate, so the phone shows the mirror and the keys pad, never buttons.

import { lineText, trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
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
import { askHeaderDirectlyAbove, boxHoldsNoDraft, isVoiceRule, rstrip } from "./markers";
import { museDraftIsOpaque, musePasteCarriesSend } from "./paste";
import { detectQuestionRegion } from "./question";
import { detectTrustRegion } from "./trust";

/**
 * Muse's pane → blocks. The four dialog arms run in the build order of the dialog notes (approval →
 * single → multi → trust); the shapes are disjoint (exact questions, checkbox prefixes, period-less
 * trust options), so order is documentation, not disambiguation. Nothing matches → one raw block
 * with the composer chrome stripped, ready for the native-mirror decoration passes in harness/index.
 *
 * EVERY LIFT KEEPS THE ROWS ABOVE ITS REGION as their own raw block, as Claude and Codex do. The
 * command an approval runs and the folder a trust prompt names sit there, and the prompt panel
 * shows neither itself: without them a button asks consent to something the operator cannot see.
 *
 * QUESTION, CHECKBOX AND REVIEW LIFTS ALSO NEED A LIVE DIALOG, not one quoted in the transcript:
 * an empty box under it ({@link boxHoldsNoDraft}), and on the review screen the live header right
 * above it ({@link askHeaderDirectlyAbove}). A screen that fails stays raw. The send gate agrees:
 * `composerReady` refuses a match only above a strictly bare box (a live dialog owns the keyboard,
 * so its `❯` never holds a draft or a placeholder tip); quoted shapes above a live box stay raw
 * AND sendable (#260). Approval and trust need no such check: an approval replaces the box, and
 * trust's footer must be the pane's last row.
 */
export function museBuildBlocks(lines: StyledLine[]): Block[] {
  const approval = detectApprovalRegion(lines);
  if (approval !== null) {
    return lift(lines, approval.startLine, {
      kind: "prompt-select",
      prompt: approval.model,
      lines: lines.slice(approval.startLine),
    });
  }
  const question = detectQuestionRegion(lines);
  if (question !== null) {
    if (!boxHoldsNoDraft(lines)) return unlifted(lines);
    return lift(lines, question.startLine, {
      kind: "prompt-select",
      prompt: question.model,
      lines: lines.slice(question.startLine),
    });
  }
  const checkbox = detectCheckboxRegion(lines);
  if (checkbox !== null) {
    const texts = lines.map((l) => rstrip(lineText(l)));
    const live =
      boxHoldsNoDraft(lines) &&
      (checkbox.model.phase !== "review" || askHeaderDirectlyAbove(texts, checkbox.startLine));
    if (!live) return unlifted(lines);
    return lift(lines, checkbox.startLine, {
      kind: "multi-select",
      multi: checkbox.model,
      lines: lines.slice(checkbox.startLine),
    });
  }
  const trust = detectTrustRegion(lines);
  if (trust !== null) {
    return lift(lines, trust.startLine, { kind: "prompt-select", prompt: trust.model, lines: lines.slice(trust.startLine) });
  }
  return unlifted(lines);
}

/** No lift: the screen as a raw block, composer chrome stripped. */
function unlifted(lines: StyledLine[]): Block[] {
  return [{ kind: "raw", lines: stripChrome(lines) }];
}

// How far above a region the Voice rule that frames it may sit: an approval draws it over its
// question, `$` subject, stage and argv rows, about seven rows up.
const FRAME_SCAN_ROWS = 12;

/** The rows above `startLine` as a raw block, then the lifted dialog. The Voice rule an approval
 *  draws above its question is the composer's frame, not the dialog's subject, so the last one in
 *  reach is dropped from that block. */
function lift(lines: StyledLine[], startLine: number, dialog: Block): Block[] {
  let before = lines.slice(0, startLine);
  for (let i = before.length - 1; i >= 0 && before.length - 1 - i < FRAME_SCAN_ROWS; i--) {
    if (isVoiceRule(rstrip(lineText(before[i]!)))) {
      before = [...before.slice(0, i), ...before.slice(i + 1)];
      break;
    }
  }
  before = trimTrailingBlank(before);
  return before.length > 0 ? [{ kind: "raw", lines: before }, dialog] : [dialog];
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
  // The way OUT of a Muse modal, for the unread-dialog card (.adr/0053). Read from
  // `muse/DIALOG_NOTES.md`: the ask footers print `Esc to interrupt` (:84, :132) and the REVIEW
  // phase prints `Esc to go back` (:159). NOTE the caveat: on Muse this key STEPS OUT of the screen,
  // it does not always dismiss the request — which is why the card's caption names the key and never
  // promises "cancel".
  cancelKey: "Escape",
  extractInputDraft,
  extractStatusLines,
  composerPrompt,
  draftCarriesSend: musePasteCarriesSend,
  draftIsOpaque: museDraftIsOpaque,
};
