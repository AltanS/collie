import { describe, expect, it } from "vitest";

import { hasJournalAdapter, reportsSessionNatively, reportsSessionOnFirstPrompt } from "./journal-agents";

describe("Kiro journal support", () => {
  it("offers a journal only for the exact Kiro agent name", () => {
    expect(hasJournalAdapter("kiro")).toBe(true);
    expect(hasJournalAdapter("kiro-cli")).toBe(false);
    expect(hasJournalAdapter("kiro-v3")).toBe(false);
    expect(hasJournalAdapter(undefined)).toBe(false);
  });

  it("diagnoses Kiro as a native reporter rather than a first-prompt hook", () => {
    expect(reportsSessionNatively("kiro")).toBe(true);
    expect(reportsSessionNatively("claude")).toBe(false);
    expect(reportsSessionNatively(undefined)).toBe(false);
    expect(reportsSessionOnFirstPrompt("kiro")).toBe(false);
  });
});
