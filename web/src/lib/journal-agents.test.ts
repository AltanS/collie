import { describe, expect, it } from "vitest";

import { hasJournalAdapter } from "./journal-agents";

describe("Kiro journal support", () => {
  it("offers a journal only for the exact Kiro agent name", () => {
    expect(hasJournalAdapter("kiro")).toBe(true);
    expect(hasJournalAdapter("kiro-cli")).toBe(false);
    expect(hasJournalAdapter("kiro-v3")).toBe(false);
    expect(hasJournalAdapter(undefined)).toBe(false);
  });
});
