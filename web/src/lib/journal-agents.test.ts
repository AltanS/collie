import { describe, expect, it } from "vitest";

import { hasJournalAdapter, mayBeNewWithNothingToRead } from "./journal-agents";

describe("Kiro journal support", () => {
  it("offers a journal only for the exact Kiro agent name", () => {
    expect(hasJournalAdapter("kiro")).toBe(true);
    expect(hasJournalAdapter("kiro-cli")).toBe(false);
    expect(hasJournalAdapter("kiro-v3")).toBe(false);
    expect(hasJournalAdapter(undefined)).toBe(false);
  });
});

// Which agents may be new when an idle pane has nothing to read: each set is a fact about when the
// agent names its session and writes its log, and the answer depends on the session being there.
describe("mayBeNewWithNothingToRead", () => {
  it("excuses an agent that reports its session on the first prompt only while it has no session", () => {
    expect(mayBeNewWithNothingToRead("codex", false)).toBe(true);
    expect(mayBeNewWithNothingToRead("codex", true)).toBe(false);
  });

  it("excuses an agent that writes its log after the first reply only once it has a session", () => {
    for (const agent of ["pi", "omp"]) {
      expect(mayBeNewWithNothingToRead(agent, true)).toBe(true);
      expect(mayBeNewWithNothingToRead(agent, false)).toBe(false);
    }
  });

  it("excuses an agent that writes its log at the first prompt only once it has a session", () => {
    expect(mayBeNewWithNothingToRead("claude", true)).toBe(true);
    expect(mayBeNewWithNothingToRead("claude", false)).toBe(false);
  });

  it("excuses no other agent, and no pane that names none", () => {
    for (const agent of ["opencode", "grok", "claude-code", "shell", undefined]) {
      expect(mayBeNewWithNothingToRead(agent, true)).toBe(false);
      expect(mayBeNewWithNothingToRead(agent, false)).toBe(false);
    }
  });
});
