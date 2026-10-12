import { trimTrailingBlank, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import { askModalOnScreen, detectAskSelectRegion } from "./ask";
import {
  composerDraft,
  composerPrompt,
  composerStatusLines,
  locateComposer,
} from "./composer";

export function piBuildBlocks(lines: StyledLine[]): Block[] {
  const ask = detectAskSelectRegion(lines);
  if (ask !== null) {
    const before = trimTrailingBlank(lines.slice(0, ask.startLine));
    return [
      ...(before.length > 0 ? [{ kind: "raw" as const, lines: before }] : []),
      {
        kind: "prompt-select",
        prompt: ask.model,
        lines: lines.slice(ask.startLine, ask.endLine),
      },
    ];
  }
  const composer = locateComposer(lines);
  return [{ kind: "raw", lines: composer === null ? lines : trimTrailingBlank(lines.slice(0, composer.top)) }];
}

/** Herdr reports OmO as exactly `pi`; no prefix or executable-name inference. */
export const piAdapter: HarnessAdapter = {
  agent: "pi",
  buildBlocks: piBuildBlocks,
  extractStatusLines: composerStatusLines,
  extractInputDraft: composerDraft,
  // The Ask dialog is drawn between the same rules, so it is excluded by name as well as by shape.
  composerReady: (lines) => locateComposer(lines) !== null && !askModalOnScreen(lines),
  composerPrompt,
  // Captured options print `esc cancel`; the Other editor prints `esc discard`.
  // Escape is offered by name, not promised to cancel every editor (ASK_NOTES.md).
  cancelKey: "Escape",
  modalOnScreen: askModalOnScreen,
};
