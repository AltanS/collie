import { beforeEach, describe, expect, it } from "vitest";

import {
  __clearMirrorOverrides,
  paneMirrorOverride,
  setPaneMirrorOverride,
} from "@/lib/mirror-invert";
import type { Scope } from "@/lib/scope";

// Scope is `{ host?, session? }`, so a plain literal IS one: no assertion needed.
const A: Scope = { host: "alpha" };
const B: Scope = { host: "beta" };

beforeEach(() => {
  __clearMirrorOverrides();
});

describe("paneMirrorOverride", () => {
  it("is undefined until the operator decides, which is not the same as false", () => {
    // The tri-state is the point: absent must mean "let the agent bit decide", so that a Muse pane
    // with no override still renders natively.
    expect(paneMirrorOverride(A, "w1:p1")).toBeUndefined();
    setPaneMirrorOverride(A, "w1:p1", false);
    expect(paneMirrorOverride(A, "w1:p1")).toBe(false);
  });

  it("round-trips both directions", () => {
    setPaneMirrorOverride(A, "w1:p1", true);
    expect(paneMirrorOverride(A, "w1:p1")).toBe(true);
    setPaneMirrorOverride(A, "w1:p1", false);
    expect(paneMirrorOverride(A, "w1:p1")).toBe(false);
  });

  it("clears back to undefined rather than storing a third value", () => {
    setPaneMirrorOverride(A, "w1:p1", true);
    setPaneMirrorOverride(A, "w1:p1", undefined);
    expect(paneMirrorOverride(A, "w1:p1")).toBeUndefined();
  });

  it("does not bleed across hosts: two machines can both have a w1:p1", () => {
    setPaneMirrorOverride(A, "w1:p1", true);
    expect(paneMirrorOverride(B, "w1:p1")).toBeUndefined();
  });

  it("has no opinion about a pane it was never given", () => {
    expect(paneMirrorOverride(A, undefined)).toBeUndefined();
  });

  it("evicts oldest-first past the bound, keeping the pane just chosen", () => {
    // 33 decisions against a bound of 32: the first must go, the last must stay.
    for (let i = 0; i < 33; i++) setPaneMirrorOverride(A, `w1:p${i}`, true, 1000 + i);
    expect(paneMirrorOverride(A, "w1:p0")).toBeUndefined();
    expect(paneMirrorOverride(A, "w1:p32")).toBe(true);
  });

  it("reads a corrupt entry as no override, leaving the shipped inversion in place", () => {
    setPaneMirrorOverride(A, "w1:p1", true);
    const key = Object.keys(localStorage).find((k) => k.startsWith("collie:mirror-native:"));
    expect(key).toBeDefined();
    localStorage.setItem(key!, "{not json");
    expect(paneMirrorOverride(A, "w1:p1")).toBeUndefined();
  });

  it("clears an entry it cannot decode, which the decodable-only sweep left behind", () => {
    // Regression: __clearMirrorOverrides used to go through the DECODABLE set, so a corrupt entry
    // survived the clear and leaked into the next test.
    setPaneMirrorOverride(A, "w1:p1", true);
    const key = Object.keys(localStorage).find((k) => k.startsWith("collie:mirror-native:"));
    expect(key).toBeDefined();
    localStorage.setItem(key!, "{not json");

    __clearMirrorOverrides();
    expect(localStorage.getItem(key!)).toBeNull();
  });

  it("drops an undecodable entry on the next write instead of letting it live forever", () => {
    // Skipping junk in the prune looks harmless (it already reads as no override) but makes it
    // immortal: it never decodes, so it never sorts into the prune, so it never leaves.
    setPaneMirrorOverride(A, "w1:p1", true);
    const key = Object.keys(localStorage).find((k) => k.startsWith("collie:mirror-native:"));
    localStorage.setItem(key!, "{not json");

    setPaneMirrorOverride(A, "w9:p9", true);
    expect(localStorage.getItem(key!)).toBeNull();
  });

  it("ignores an entry whose shape it cannot trust", () => {
    // The key is DERIVED, not guessed: a hardcoded one would let this pass even if the shape
    // validation did nothing, because a key that does not match reads undefined anyway.
    setPaneMirrorOverride(A, "w1:p1", true);
    const key = Object.keys(localStorage).find((k) => k.startsWith("collie:mirror-native:"));
    expect(key).toBeDefined();
    expect(paneMirrorOverride(A, "w1:p1")).toBe(true);

    localStorage.setItem(key!, JSON.stringify({ at: "soon", native: true }));
    expect(paneMirrorOverride(A, "w1:p1")).toBeUndefined();
  });
});
