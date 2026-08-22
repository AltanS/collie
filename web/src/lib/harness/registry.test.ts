import { describe, expect, it } from "vitest";

import { adapterFor, hasBlockGrammar } from "./registry";

// The single source of truth for "which agents get the block grammars". Both gates (the render
// pipeline's buildBlocks and agent-chat's status strip) route through the registry, so it is worth
// pinning directly — this re-homes the old grammar/agents predicate test onto the registry, which
// now derives the predicate from adapterFor().
describe("hasBlockGrammar", () => {
  // "Registered", not "verified": in HARNESS_CONTRIBUTING.md "verified" is a term of art meaning
  // live-verified against a real pane, which is the Tier-2 bar. Claude has cleared it; omp has not
  // and does not claim to. What this predicate actually answers is "does an adapter exist".
  it("is true for every registered adapter", () => {
    expect(hasBlockGrammar("claude")).toBe(true);
    expect(hasBlockGrammar("omp")).toBe(true);
    expect(hasBlockGrammar("agy")).toBe(true);
    expect(hasBlockGrammar("antigravity")).toBe(true);
  });

  it("is false for every unregistered agent (no adapter ⇒ raw mirror)", () => {
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
