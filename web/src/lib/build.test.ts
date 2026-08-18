import { describe, expect, it } from "vitest";

import { buildLabel, isStaleBuild, prereleaseLabel } from "./build";

describe("isStaleBuild", () => {
  it("is not stale when the ids match", () => {
    expect(isStaleBuild("0.3.0+abc.1", "0.3.0+abc.1")).toBe(false);
  });
  it("is not stale when the server build is unknown", () => {
    expect(isStaleBuild("0.3.0+abc.1", "unknown")).toBe(false);
  });
  it("is not stale when the server build is missing", () => {
    expect(isStaleBuild("0.3.0+abc.1", undefined)).toBe(false);
  });
  it("is stale when the ids differ", () => {
    expect(isStaleBuild("0.3.0+abc.1", "0.3.0+abc.2")).toBe(true);
  });
});

describe("prereleaseLabel — what the alpha bar keys off", () => {
  it("names the prerelease train from the tag's first identifier", () => {
    expect(prereleaseLabel("1.0.0-alpha.3")).toBe("ALPHA");
    expect(prereleaseLabel("1.0.0-beta.1")).toBe("BETA");
    expect(prereleaseLabel("2.0.0-rc.2")).toBe("RC");
    expect(prereleaseLabel("v1.0.0-alpha.3")).toBe("ALPHA"); // leading v tolerated
    expect(prereleaseLabel("1.0.0-alpha.3+abc123")).toBe("ALPHA"); // build metadata ignored
  });

  it("says nothing for a stable release", () => {
    expect(prereleaseLabel("0.25.0")).toBeUndefined();
    expect(prereleaseLabel("1.0.0")).toBeUndefined();
    expect(prereleaseLabel("1.0.0+abc123")).toBeUndefined();
  });

  it("does not mistake the build-time -dev marker for a prerelease", () => {
    // vite.config.ts appends -dev whenever HEAD isn't the release tag. Stable stays silent…
    expect(prereleaseLabel("0.25.0-dev")).toBeUndefined();
    // …and a real prerelease built off-tag still announces itself.
    expect(prereleaseLabel("1.0.0-alpha.3-dev")).toBe("ALPHA");
  });

  it("falls back to a generic label for a numeric-only tag", () => {
    expect(prereleaseLabel("1.0.0-1")).toBe("PRERELEASE");
  });

  it("fails toward hidden on garbage or absent input", () => {
    expect(prereleaseLabel("")).toBeUndefined();
    expect(prereleaseLabel("banana")).toBeUndefined();
    expect(prereleaseLabel("1.0-alpha")).toBeUndefined(); // not a three-number core
    expect(prereleaseLabel("not a version - really")).toBeUndefined();
    expect(prereleaseLabel(undefined)).toBeUndefined();
    expect(prereleaseLabel(null)).toBeUndefined();
    expect(prereleaseLabel(42)).toBeUndefined(); // a number really can arrive off parsed JSON
  });
});

describe("buildLabel", () => {
  it("formats version, sha and minute-resolution time", () => {
    expect(buildLabel({ version: "0.3.0", sha: "c9167c3", time: "2026-06-30T00:12:34.000Z" })).toBe(
      "v0.3.0 · c9167c3 · 2026-06-30 00:12 UTC",
    );
  });
});
