import { describe, expect, it } from "vitest";

import { buildLabel, isStaleBuild } from "./build";

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

describe("buildLabel", () => {
  it("formats version, sha and minute-resolution time", () => {
    expect(buildLabel({ version: "0.3.0", sha: "c9167c3", time: "2026-06-30T00:12:34.000Z" })).toBe(
      "v0.3.0 · c9167c3 · 2026-06-30 00:12 UTC",
    );
  });
});
