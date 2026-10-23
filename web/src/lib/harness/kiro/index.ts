// The Kiro CLI V3 adapter. Tool approvals (2.32.0) and startup workspace trust (2.33.0) use
// the shared guarded pointer walk; their evidence is in APPROVAL_NOTES.md and WORKSPACE_TRUST_NOTES.md.
// Other captured panels stay terminal-only, with Escape on the unread-dialog card.

import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { detectApprovalRegion } from "./approval";
import { composerReady, extractInputDraft, extractStatusLines, stripChrome } from "./chrome";
import { modalOnScreen } from "./markers";
import { detectWorkspaceTrust } from "./workspace-trust";

/** Captured startup trust and tool approvals, or the transcript with composer chrome removed. */
function kiroBuildBlocks(lines: StyledLine[]): Block[] {
  const dialog = detectWorkspaceTrust(lines) ?? detectApprovalRegion(lines);
  if (dialog === null) return [{ kind: "raw", lines: stripChrome(lines) }];
  const before = trimTrailingBlank(lines.slice(0, dialog.startLine));
  const blocks: Block[] = [];
  if (before.length > 0) blocks.push({ kind: "raw", lines: before });
  blocks.push({
    kind: "prompt-select",
    prompt: dialog.model,
    lines: lines.slice(dialog.startLine),
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
