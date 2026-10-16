import { describe, expect, it } from "vitest";

import { hasDialogCard } from "@/components/card-dock";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { fixtureRows } from "@/test/surface-corpus";

// The composer offers "Answer the dialog" on a refusal only when the dock shows a dialog card (the
// 2026-10-16 field case: an unreadable screen with no card offered a way to nothing).
describe("hasDialogCard", () => {
  const blocks = (name: string) => claudeBuildBlocks(fixtureRows(name));

  it("is true on a screen whose dialog a grammar lifts", () => {
    expect(hasDialogCard(blocks("claude--menu-model-picker.txt"))).toBe(true);
  });

  it("is false on a free box with the agents panel under it, and on a completion popup, which answers nothing", () => {
    expect(hasDialogCard(blocks("claude--v2301-synth-agents-panel-walk-fails.txt"))).toBe(false);
    const popup = blocks("claude--autocomplete-slash-short.txt");
    expect(popup.some((block) => block.kind === "autocomplete")).toBe(true);
    expect(hasDialogCard(popup)).toBe(false);
    expect(hasDialogCard([])).toBe(false);
  });
});
