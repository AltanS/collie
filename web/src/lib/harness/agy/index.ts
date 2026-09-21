import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { detectPromptSelectRegion } from "./prompt-select";
import { extractInputDraft, extractStatusLines, hasInputBox, stripChrome } from "./chrome";

export function agyBuildBlocks(lines: StyledLine[]): Block[] {
  const region = detectPromptSelectRegion(lines);
  if (region) {
    const before = trimTrailingBlank(lines.slice(0, region.startLine));
    const blocks: Block[] = [];
    if (before.length > 0) blocks.push({ kind: "raw", lines: before });
    blocks.push({ kind: "prompt-select", prompt: region.model, lines: lines.slice(region.startLine) });
    return blocks;
  }

  return [{ kind: "raw", lines: stripChrome(lines) }];
}

export { extractStatusLines, extractInputDraft };

export const agyAdapter: HarnessAdapter = {
  agent: "agy",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
  // The way OUT of an AGY modal, for the unread-dialog card (.adr/0053). Its captures print the
  // Claude-style footer: `fixtures/panes/agy--permission-bash.txt`, `agy--permission-edit.txt`,
  // `agy--plan-approval.txt` and `agy--select-menu.txt` all print `esc to cancel`.
  cancelKey: "Escape",
};

export const antigravityAdapter: HarnessAdapter = {
  agent: "antigravity",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
  // Same harness, same registration, same declaration — see `agyAdapter` above.
  cancelKey: "Escape",
};
