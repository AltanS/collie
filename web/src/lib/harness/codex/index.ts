// The Codex adapter. Chrome/status/draft are Tier 1: the boxless `› ` composer remains visible in
// the mirror for diagnosis, while its trailing status/footer row is stripped and re-surfaced
// natively. Interactive
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
// `canonicalAgent`, never here.

import type { Block, StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import {
  composerPrompt as chromeComposerPrompt,
  composerReady as chromeComposerReady,
  extractInputDraft as extractChromeInputDraft,
  extractStatusLines,
  presentChrome,
} from "./chrome";
import { detectApprovalRegion } from "./approval";
import { detectAskRegion } from "./ask";
import { detectTrustRegion } from "./trust";
import { codexDraftCarriesSend } from "./paste";
import { slashComposerReady, slashInputDraft, slashPromptRegion } from "./slash";

export function extractInputDraft(lines: StyledLine[]): string | null {
  return extractChromeInputDraft(lines) ?? slashInputDraft(lines);
}

function composerReady(lines: StyledLine[]): boolean {
  return chromeComposerReady(lines) || slashComposerReady(lines);
}

function composerPrompt(lines: StyledLine[]): string | null {
  return chromeComposerPrompt(lines) ?? slashPromptRegion(lines);
}

export function codexBuildBlocks(lines: StyledLine[]): Block[] {
  const trust = detectTrustRegion(lines);
  if (trust) {
    return [
      { kind: "raw", lines },
      { kind: "prompt-select", prompt: trust.model, lines: lines.slice(trust.startLine) },
    ];
  }

  const approval = detectApprovalRegion(lines);
  if (approval) {
    return [
      { kind: "raw", lines },
      {
        kind: "prompt-select",
        prompt: approval.model,
        lines: lines.slice(approval.startLine),
      },
    ];
  }

  const ask = detectAskRegion(lines);
  if (ask) {
    return [
      { kind: "raw", lines },
      { kind: "prompt-select", prompt: ask.model, lines: lines.slice(ask.startLine) },
    ];
  }

  return [{ kind: "raw", lines: presentChrome(lines) }];
}

export { extractStatusLines };

export const codexAdapter: HarnessAdapter = {
  agent: "codex",
  buildBlocks: codexBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady,
  composerPrompt,
  draftCarriesSend: codexDraftCarriesSend,
};
