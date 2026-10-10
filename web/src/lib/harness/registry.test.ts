import { describe, expect, it } from "vitest";

import { prepareGrokDisplay } from "./grok/chrome";
import { adapterFor, hasBlockGrammar, registeredAgents } from "./registry";

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
    expect(hasBlockGrammar("codex")).toBe(true);
    expect(hasBlockGrammar("grok")).toBe(true);
    expect(hasBlockGrammar("omp")).toBe(true);
    expect(hasBlockGrammar("agy")).toBe(true);
    expect(hasBlockGrammar("antigravity")).toBe(true);
    expect(hasBlockGrammar("muse")).toBe(true);
    expect(hasBlockGrammar("opencode")).toBe(true);
    expect(hasBlockGrammar("pi")).toBe(true);
  });

  it("is false for every unregistered agent (no adapter ⇒ raw mirror)", () => {
    // Exact strings only: the codex ADAPTER must not leak to variant spellings (#99).
    for (const agent of ["hermes", "shell", "unknown", "Codex", "codex-cli", "OpenCode"]) {
      expect(hasBlockGrammar(agent)).toBe(false);
    }
  });

  // #99: prefix-matching in adapterFor is how Claude's (and later Grok's) live
  // keystroke recipes would attach to a foreign agent string. Catalog folding of `grok-build` is
  // canonicalAgent's job; the harness registry stays exact.
  it("does not prefix-match — grok-build / GROK are not the grok adapter", () => {
    expect(adapterFor("grok-build")).toBeUndefined();
    expect(adapterFor("GROK")).toBeUndefined();
    expect(hasBlockGrammar("grok-build")).toBe(false);
    expect(adapterFor("grok")?.agent).toBe("grok");
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

// The shared terminal mirror tidies a raw block for display through the adapter, never through an
// import of a harness module, so the hook is what the registry hands back.
describe("prepareDisplay", () => {
  it("is Grok's display pass on the grok adapter", () => {
    expect(adapterFor("grok")?.prepareDisplay).toBe(prepareGrokDisplay);
  });

  it("is absent on every other adapter and on an unknown agent", () => {
    for (const agent of registeredAgents().filter((a) => a !== "grok")) {
      expect(adapterFor(agent)?.prepareDisplay).toBeUndefined();
    }
    expect(adapterFor("shell")?.prepareDisplay).toBeUndefined();
    expect(adapterFor(undefined)?.prepareDisplay).toBeUndefined();
  });
});
