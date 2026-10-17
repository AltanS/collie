import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { detectApprovalRegion } from "./approval";
import {
  composerPrompt,
  composerReady,
  extractInputDraft,
  extractStatusLines,
  stripChrome,
} from "./chrome";
import { modalOnScreen } from "./frame";

/** Kiro V3's captured shell/filesystem approvals, or its transcript with composer chrome removed. */
export function kiroBuildBlocks(lines: StyledLine[]): Block[] {
  const approval = detectApprovalRegion(lines);
  if (approval === null) return [{ kind: "raw", lines: stripChrome(lines) }];
  const before = trimTrailingBlank(lines.slice(0, approval.startLine));
  const blocks: Block[] = [];
  if (before.length > 0) blocks.push({ kind: "raw", lines: before });
  blocks.push({
    kind: "prompt-select",
    prompt: approval.model,
    lines: lines.slice(approval.startLine),
  });
  return blocks;
}

/** Exact `kiro` registration. V2 approvals, lite mode, MCP and uncaptured option sets stay terminal-only. */
export const kiroAdapter: HarnessAdapter = {
  agent: "kiro",
  buildBlocks: kiroBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady,
  composerPrompt,
  // The panels print `esc to close`. Escape both closes a panel and leaves its Modify request
  // editor; both were pressed in kiro-cli 2.32.0 (APPROVAL_NOTES.md, 2026-10-17).
  cancelKey: "Escape",
  modalOnScreen,
  // Enter on a typed draft submits it; multiline paste and its chip are not handled here.
  // Refuse raw multiline sends until their separate choreography has live coverage.
  newlineSubmits: () => true,
};
