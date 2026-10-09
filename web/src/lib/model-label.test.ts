import { describe, expect, test } from "vitest";

import { modelLabel, rowsNameModel } from "./model-label";

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

// DOES THE SCREEN ALREADY NAME THE MODEL? The rows are the ones each harness paints near the bottom
// (the lifted statusline strip, or the raw footer), copied from the fixture corpus where there is one.
describe("rowsNameModel", () => {
  const label = (raw: string) => modelLabel(raw);

  test.each([
    // Claude Code: the configured statusline, claude--done.txt and claude--working.txt.
    ["claude", "claude-opus-4-8", ["  [Opus 4.8] ctx:3% ~/playground/collie 32.7k tokens", "  ← for agents"]],
    ["claude, a /model display name", "Fable 5", ["  [Fable 5] ctx:15% ~/playground/collie on main* 151.5k tokens"]],
    ["claude, a 1M-context statusline", "claude-opus-5-5", ["  Opus 5.5 (1M context) · ctx:3%"]],
    // Codex: the footer row, codex--v0157-idle.txt and codex--v0150-custom-status.txt.
    ["codex", "gpt-6-luna", ["  GPT-6-Luna low · /tmp/collie-canary-project"]],
    ["codex, a lower-case id", "gpt-5.6-sol", ["  gpt-5.6-sol default · /tmp/collie-codex-sandbox · main"]],
    // omp (pi's cousin) paints the model in its statusline, omp--v18-pi-effort-hint.txt.
    ["omp", "anthropic:claude-opus-5-5", ["  Opus 5.5 ·  1.4%/1M"]],
    // pi: the raw footer's last row, hand-typed from pi's footer shape (no fixture names a model).
    ["pi", "anthropic:claude-sonnet-4-5", ["~/webapp (main)", "↑1.2k ↓300 $0.012 4.5%/200k (auto)  (anthropic) claude-sonnet-4-5 • medium"]],
    ["a gateway path", "openrouter:openai/gpt-5.6-sol", ["  openrouter/openai/gpt-5.6-sol · high"]],
  ])("%s: a row that names the model says true", (_name, model, rows) => {
    expect(rowsNameModel(rows, label(model))).toBe(true);
  });

  test.each([
    // opencode's strip carries cwd, tokens and key hints, never the model (oc--done--tool-run.txt).
    ["opencode", "openrouter:openai/gpt-5.6-sol", ["   /tmp/pr255cap/proj      26.9K (3%) · $0.38  ctrl+p commands  "]],
    // A statusline configured without a model.
    ["claude, no model in the statusline", "claude-opus-4-8", ["  ctx:3% ~/playground/collie 32.7k tokens", "  ← for agents"]],
    // A footer that is behind a /model: it names the OLD model, so the new one is still news.
    ["claude, behind a /model", "Fable 5.1", ["  [Opus 4.8] ctx:3% ~/playground/collie"]],
    // A shorter name is not the same model: "Opus 5" is not inside "Opus 5.5", nor "Sonnet" "Sonnet 4.6".
    ["claude, a version prefix", "claude-opus-5", ["  [Opus 5.5] ctx:3%"]],
    ["claude, family only", "claude-sonnet-4-6", ["  [Sonnet·xhigh] /tmp/fable-capture-claude"]],
  ])("%s: rows that do not name it say false", (_name, model, rows) => {
    expect(rowsNameModel(rows, label(model))).toBe(false);
  });

  test("no rows or no label is nothing to judge, null", () => {
    expect(rowsNameModel([], "Opus 4.8")).toBeNull();
    expect(rowsNameModel(["[Opus 4.8]"], null)).toBeNull();
  });
});
