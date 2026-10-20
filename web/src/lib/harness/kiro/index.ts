// The Kiro CLI V3 adapter (`kiro-cli chat --v3`, 2.32.0). Chrome, status bar and draft are read from
// the normal composer; the shell, read, write and replace approval panels are Tier 2 `prompt-select`
// lifts whose Allow and Deny walk the panel's pointer and confirm with Enter (probed, APPROVAL_NOTES.md).
// Every other panel is positive modal evidence for the unread-dialog card and its Escape.

import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { detectApprovalRegion } from "./approval";
import { composerReady, extractInputDraft, extractStatusLines, stripChrome } from "./chrome";
import { modalOnScreen } from "./markers";

/** Kiro V3's captured shell/filesystem approvals, or its transcript with composer chrome removed. */
function kiroBuildBlocks(lines: StyledLine[]): Block[] {
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
  // The panels print `esc to close`. Escape both closes a panel and leaves its Modify request
  // editor; both were pressed in kiro-cli 2.32.0 (APPROVAL_NOTES.md, 2026-10-17).
  cancelKey: "Escape",
  modalOnScreen,
};
