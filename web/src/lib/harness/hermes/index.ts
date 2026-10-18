// The Hermes Agent adapter, for its classic CLI (`hermes`, prompt_toolkit). Herdr reports the pane as
// `agent: "hermes"` (live-checked 2026-10-16 against Herdr 0.9.1, `herdr agent get`). The Ink TUI
// (`hermes --tui`) is a different screen entirely and is not read here: none of these grammars
// matches it, so it keeps the raw mirror it has today.
//
// Interactive kinds, each with dated captures and a notes file:
//   - clarify, waiting for a choice (`prompt-select`, a digit locks the choice; CLARIFY_NOTES.md),
//   - the dangerous-command approval (`prompt-select`, a digit confirms; APPROVAL_NOTES.md).
// A clarify's typed answer ("Other (type your answer)", or a question with no choices) is not a
// dialog at all: Hermes takes it in its own input row (`✎ ❯`).
//
// A send from the phone is the bridge's Send Protocol, which reads Hermes's box from its profile
// (lib/surface/profiles/hermes.json): the idle `❯` row, the `✎` answer row and the `☤` row of a
// running turn. This adapter lifts the panels into asks, reads the draft for the chat view, and
// names the pickers for the unread-dialog card. `composerPrompt`, `overlayHoldsKeyboard` and
// `submitSettleMs` served the phone's old send guard and are read by nothing since M56 spec 06
// (harness/types.ts); they stay so their tests keep pinning the screens.

import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { detectApprovalRegion } from "./approval";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  pickerOpen,
  stripChrome,
} from "./chrome";
import { detectClarifyRegion } from "./clarify";

export function hermesBuildBlocks(lines: StyledLine[]): Block[] {
  const dialog = detectApprovalRegion(lines) ?? detectClarifyRegion(lines);
  if (dialog !== null) {
    const before = trimTrailingBlank(lines.slice(0, dialog.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "prompt-select", prompt: dialog.model, lines: lines.slice(dialog.startLine) });
    return blocks;
  }
  return [{ kind: "raw", lines: stripChrome(lines) }];
}

/**
 * Positive evidence of a Hermes modal for the unread-dialog card (.adr/0053): a picker holds the
 * keyboard (the model picker, the command palette). Nothing else is claimed, on purpose.
 *
 * The card binds its one key to the screen's last rows (`unreadDialogSignature`). Under a picker
 * those rows hold still: the status bar renders empty. Under a clarify or an approval panel they are
 * the spinner, the countdown and the status bar's clocks, which change every second, so a card there
 * would refuse every tap as "changed" (live, 2026-10-16). A panel no grammar lifts (a multi-select
 * question, a clipped one, a confirm) keeps the raw mirror and the Keys pad instead, which is what it
 * had before this adapter. A shell after Hermes exits has no input frame at all (hermes--exited).
 */
function hermesModalOnScreen(lines: StyledLine[]): boolean {
  return pickerOpen(lines);
}

export const hermesAdapter: HarnessAdapter = {
  agent: "hermes",
  buildBlocks: hermesBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady,
  composerPrompt,
  // The way OUT of a Hermes modal, for the unread-dialog card (.adr/0053), offered on the pickers only
  // (see `hermesModalOnScreen`). Ctrl+C closes the model picker and the command palette and Hermes
  // keeps running (live-probed 2026-10-16, and from a phone tap the same day); it also cancels a
  // clarify and denies an approval (CLARIFY_NOTES.md, APPROVAL_NOTES.md). Hermes binds no Escape on
  // its clarify or approval panels.
  cancelKey: "ctrl+c",
  modalOnScreen: hermesModalOnScreen,
  overlayHoldsKeyboard: (lines) => pickerOpen(lines),
  // An Enter that lands within 50 ms of the input's last change is taken as a pasted newline, not a
  // submit (`_RAPID_INPUT_ENTER_WINDOW_S` in hermes_cli/cli_tui_mixin.py); live, a text and an Enter
  // sent back to back left a newline in the input. Three times that window is the floor.
  submitSettleMs: () => 150,
};
