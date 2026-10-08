import { describe, expect, test } from "vitest";

import { modelLabel } from "./model-label";

describe("modelLabel", () => {
  test.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5-5-20260101", "Sonnet 5.5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-opus-5", "Opus 5"],
    ["claude-opus-5-5[1m]", "Opus 5.5"],
    // A Claude `/model` choice arrives in Claude Code's own display words.
    ["Fable 5.1", "Fable 5.1"],
    ["Opus 5 (1M context)", "Opus 5"],
    // opencode and pi send `provider:model`; a gateway adds a vendor path.
    ["anthropic:claude-opus-5-5", "Opus 5.5"],
    ["openrouter:openai/gpt-5.6-sol", "gpt-5.6-sol"],
    ["openrouter:anthropic/claude-opus-4", "Opus 4"],
    // Every other name is printed as the harness wrote it.
    ["gpt-5.6-codex", "gpt-5.6-codex"],
  ])("%s reads as %s", (raw, label) => {
    expect(modelLabel(raw)).toBe(label);
  });

  test("nothing to show is null, never a placeholder", () => {
    expect(modelLabel(undefined)).toBeNull();
    expect(modelLabel("")).toBeNull();
    expect(modelLabel("   ")).toBeNull();
    expect(modelLabel("anthropic:")).toBeNull();
    expect(modelLabel("<synthetic>")).toBeNull();
  });

  test("control characters are removed and a long name is capped", () => {
    expect(modelLabel("gpt\u001b[31m-5")).toBe("gpt-5");
    const long = modelLabel("x".repeat(200));
    expect(long).toHaveLength(32);
    expect(long?.endsWith("…")).toBe(true);
  });
});
