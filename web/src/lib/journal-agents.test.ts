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
  const cases = [
    // agent, hasSession, noPromptYet, answer
    ["codex", false, false, true],
    ["codex", false, true, true],
    ["codex", true, false, false],
    ["codex", true, true, false],
    ["pi", true, false, true],
    ["pi", true, true, true],
    ["pi", false, false, false],
    ["pi", false, true, false],
    ["omp", true, false, true],
    ["omp", true, true, true],
    ["omp", false, false, false],
    ["omp", false, true, false],
    // Claude Code: a session AND the bridge's word that no prompt reached it, and nothing less.
    ["claude", true, true, true],
    ["claude", true, false, false],
    ["claude", false, true, false],
    ["claude", false, false, false],
  ] as const;

  it.each(cases)("%s with session %s and noPromptYet %s answers %s", (agent, hasSession, noPromptYet, answer) => {
    expect(mayBeNewWithNothingToRead(agent, hasSession, noPromptYet)).toBe(answer);
  });

  it("reads an absent noPromptYet as false, the way a bridge with no Collie hooks leaves it", () => {
    expect(mayBeNewWithNothingToRead("claude", true)).toBe(false);
    expect(mayBeNewWithNothingToRead("pi", true)).toBe(true);
    expect(mayBeNewWithNothingToRead("codex", false)).toBe(true);
  });

  it("excuses no other agent, and no pane that names none, whatever the bridge says", () => {
    for (const agent of ["opencode", "grok", "claude-code", "shell", undefined]) {
      for (const hasSession of [true, false]) {
        for (const noPromptYet of [true, false]) expect(mayBeNewWithNothingToRead(agent, hasSession, noPromptYet)).toBe(false);
      }
    }
  });
});
