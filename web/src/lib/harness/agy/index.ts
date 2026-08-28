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
};

export const antigravityAdapter: HarnessAdapter = {
  agent: "antigravity",
  buildBlocks: agyBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady: hasInputBox,
};
