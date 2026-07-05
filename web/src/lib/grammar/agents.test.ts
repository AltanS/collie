import { describe, expect, it } from "vitest";

import { hasBlockGrammar } from "./agents";

// The single source of truth for "which agents get the Claude-tuned block grammars". Both gates
// (buildBlocks and agent-chat's status strip) route through this, so it is worth pinning directly.
describe("hasBlockGrammar", () => {
  it("is true only for Claude Code", () => {
    expect(hasBlockGrammar("claude")).toBe(true);
  });

  it("is false for every non-Claude agent (unverified TUI ⇒ raw mirror)", () => {
    for (const agent of ["codex", "opencode", "pi", "shell", "unknown"]) {
      expect(hasBlockGrammar(agent)).toBe(false);
    }
  });

  it("is false for an absent agent", () => {
    expect(hasBlockGrammar(undefined)).toBe(false);
  });
});
