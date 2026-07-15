import { describe, expect, it } from "vitest";

import { adapterFor, hasBlockGrammar } from "./registry";

// The single source of truth for "which agents get the block grammars". Both gates (the render
// pipeline's buildBlocks and agent-chat's status strip) route through the registry, so it is worth
// pinning directly — this re-homes the old grammar/agents predicate test onto the registry, which
// now derives the predicate from adapterFor().
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

  // Inherited Object.prototype keys must not resolve to a truthy non-adapter (which would crash the
  // render path calling `.buildBlocks` on `Object.prototype.toString`). `Object.hasOwn` gates the lookup.
  it("is false for inherited Object.prototype keys (no prototype-chain lookup)", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(adapterFor(key)).toBeUndefined();
      expect(hasBlockGrammar(key)).toBe(false);
    }
  });
});
