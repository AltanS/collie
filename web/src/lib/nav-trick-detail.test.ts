import { describe, expect, it } from "vitest";

import { ancestorsOf, isAncestor, readTrickDetailKey, trickDetailKey, trickDetailPath } from "./nav";

// A trick's details page address (2026-11-21): `/settings/tricks/<key>`, a child of the list and of the trick's
// own page.

describe("the details page address", () => {
  it("writes a trick's key as host:id, encoded, and reads it back", () => {
    expect(trickDetailPath(trickDetailKey("lodge", "legs"))).toBe("/settings/tricks/lodge%3Alegs");
    expect(readTrickDetailKey("lodge:legs")).toEqual({ kind: "trick", host: "lodge", id: "legs" });
  });

  it("reads a bare id as an official entry, and no other shape", () => {
    expect(trickDetailPath("morph")).toBe("/settings/tricks/morph");
    expect(readTrickDetailKey("morph")).toEqual({ kind: "official", id: "morph" });
    expect(readTrickDetailKey("")).toBeUndefined();
    expect(readTrickDetailKey(":legs")).toBeUndefined();
    expect(readTrickDetailKey("lodge:")).toBeUndefined();
    expect(readTrickDetailKey("a:b:c")).toBeUndefined();
  });

  it("sits below the list and below a trick's own page", () => {
    const here = "/settings/tricks/lodge%3Alegs";
    expect(ancestorsOf(here)[0]).toBe("/settings/tricks");
    expect(isAncestor("/settings/tricks", here)).toBe(true);
    expect(isAncestor("/trick/trick%3Alodge%3Alegs%3Alegs", here)).toBe(true);
    expect(isAncestor("/settings", here)).toBe(true);
  });
});
