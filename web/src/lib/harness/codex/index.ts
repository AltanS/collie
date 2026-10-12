// The Codex adapter. Chrome/status/draft are Tier 1: the boxless `› ` composer plus its
// dot-separated status row are stripped from the mirror and re-surfaced natively. Interactive
// kinds with dated captures and notes (all under this directory): the folder-trust prompt
// (`prompt-select`, family trust), exec approvals (`prompt-select`, family permission —
// classified by row: the one-shot Yes and the reject become buttons, persistent rows never do),
// and `request_user_input` question cards (`prompt-select`, family select — a digit answers the
// current question and submits on the last). Digits confirm directly on all three (probed;
// notes files). The notes flow of a question card stays in the terminal: the focused-notes
// state refuses to raw, because a digit would type into the box.
//
// The review bar is #99 (agy): exact agent string only, and every emitted keystroke probed on
// the captured screen. Registered as `agent: "codex"`; variant folding belongs in
// `canonicalAgent`, never here. The 0.156.1 screens (captured 2026-09-26) follow the same bar: the
// patch approval sends the shortcuts it prints (`y`, Escape), the rewritten trust prompt sends a
// pointer walk and the Enter its footer names, and each of those was pressed live the same day
// (APPROVAL_NOTES.md, TRUST_NOTES.md). The update prompt and the `/model` and `/permissions`
// pickers are deliberately left to the unread-dialog card.

import { lineText, trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  stripChrome,
} from "./chrome";
import { detectApprovalRegion } from "./approval";
import { detectAskRegion } from "./ask";
import { detectTrustRegion } from "./trust";
import { decorateCodexDisplay } from "./display";
import { codexDraftCarriesSend } from "./paste";

function raw(lines: StyledLine[]): Block {
  return { kind: "raw", lines: decorateCodexDisplay(lines) };
}

export function codexBuildBlocks(lines: StyledLine[]): Block[] {
  const trust = detectTrustRegion(lines);
  if (trust) {
    const before = trimTrailingBlank(lines.slice(0, trust.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push(raw(before));
    blocks.push({ kind: "prompt-select", prompt: trust.model, lines: lines.slice(trust.startLine) });
    return blocks;
  }

  const approval = detectApprovalRegion(lines);
  if (approval) {
    const before = trimTrailingBlank(lines.slice(0, approval.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push(raw(before));
    blocks.push({
      kind: "prompt-select",
      prompt: approval.model,
      lines: lines.slice(approval.startLine),
    });
    return blocks;
  }

  const ask = detectAskRegion(lines);
  if (ask) {
    const before = trimTrailingBlank(lines.slice(0, ask.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push(raw(before));
    blocks.push({ kind: "prompt-select", prompt: ask.model, lines: lines.slice(ask.startLine) });
    return blocks;
  }

  return [raw(stripChrome(lines))];
}

export { extractStatusLines, extractInputDraft };

// How many of the screen's last non-blank rows may carry a dialog's footer: the same window Claude's
// `modalOnScreen` reads (claude/index.ts MODAL_HINT_ROWS).
const MODAL_HINT_ROWS = 6;
const NAMES_ESC = /\besc(?:ape)?\b/i;

/**
 * Positive evidence of a Codex dialog for the unread-dialog card (.adr/0053, addendum 2026-09-26):
 * one of the last rows names Escape, as every Codex dialog footer does (`enter continue · esc quit`,
 * `enter select · esc back`, `Press enter to confirm or esc to cancel`, codex/markers.ts; the notes
 * card's `tab or esc to clear notes`). The shell after `/quit` (`codex resume <id>`) and the first
 * frames before the status row paints (`? for shortcuts` alone) name no key, and the card no longer
 * flashes over them (harness canary 2026-10-12, Codex 0.159.3; the known gap of 1.13.2).
 */
function codexModalOnScreen(lines: StyledLine[]): boolean {
  const rows: string[] = [];
  for (let i = lines.length - 1; i >= 0 && rows.length < MODAL_HINT_ROWS; i--) {
    const text = lineText(lines[i]!);
    if (text.trim() !== "") rows.push(text);
  }
  return rows.some((text) => NAMES_ESC.test(text));
}

export const codexAdapter: HarnessAdapter = {
  agent: "codex",
  buildBlocks: codexBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady,
  // The way OUT of a Codex modal, for the unread-dialog card (.adr/0053). Read from
  // `codex/APPROVAL_NOTES.md`: `3. No, and tell Codex what to do differently (esc)` and
  // `Press enter to confirm or esc to cancel`.
  cancelKey: "Escape",
  modalOnScreen: codexModalOnScreen,
  composerPrompt,
  draftCarriesSend: codexDraftCarriesSend,
};
