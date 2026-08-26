import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { agyAdapter, antigravityAdapter } from "./index";
import { detectPromptSelect } from "./prompt-select";
import { describeAdapterConformance } from "../conformance";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const allFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.endsWith(".txt"))
  .sort();

const allAgyFixtures = allFixtures.filter((f) => f.startsWith("agy--"));

const NEUTRAL = ["agy--fresh-idle.txt", "agy--working.txt", "agy--done.txt"];

const ownFixtures = allAgyFixtures.filter((f) => !NEUTRAL.includes(f));
const neutralFixtures = allAgyFixtures.filter((f) => NEUTRAL.includes(f));
const foreignFixtures = allFixtures.filter((f) => !f.startsWith("agy--"));

describeAdapterConformance(agyAdapter, {
  ownFixtures,
  foreignFixtures,
  neutralFixtures,
});

describeAdapterConformance(antigravityAdapter, {
  ownFixtures,
  foreignFixtures,
  neutralFixtures,
});

describe("agyAdapter unit & footer safety", () => {
  it("claims agent 'agy' and 'antigravity'", () => {
    expect(agyAdapter.agent).toBe("agy");
    expect(antigravityAdapter.agent).toBe("antigravity");
  });

  it("detects an AskUserQuestion prompt with a footer and lifts it into interactive prompt-select options", () => {
    const raw = [
      "Which action would you like to take?",
      "❯ 1. Run build directly",
      "  2. Inspect directory first",
      "  3. Skip step",
      "Enter to select · ↑/↓ to navigate",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).not.toBeNull();
    expect(model!.question).toBe("Which action would you like to take?");
    expect(model!.family).toBe("select");
    expect(model!.options).toHaveLength(3);
    expect(model!.options[0]!.label).toBe("Run build directly");
    expect(model!.options[0]!.keys).toEqual(["1", "Enter"]);
    expect(model!.options[1]!.label).toBe("Inspect directory first");
    expect(model!.options[1]!.keys).toEqual(["2", "Enter"]);

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.some((b) => b.kind === "prompt-select")).toBe(true);
  });

  it("declines a numbered list without a dialog footer (ADR 0009 safety)", () => {
    const raw = [
      "Available skills:",
      "  1. agy-customizations - Guide and reference",
      "  2. graphify - Knowledge graph analysis",
      "  3. antigravity-guide - Overview and quick reference",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).toBeNull();

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.every((b) => b.kind === "raw")).toBe(true);
  });

  it("detects tool permission prompt and extracts digit key alone", () => {
    const raw = [
      "Allow bash command: `npm test`?",
      "  1. Yes",
      "  2. No",
      "  3. Always allow",
      "Tab to amend · Esc to cancel",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).not.toBeNull();
    expect(model!.family).toBe("permission");
    expect(model!.options[0]!.label).toBe("Yes");
    expect(model!.options[0]!.keys).toEqual(["1"]);
    expect(model!.options[1]!.label).toBe("No");
    expect(model!.options[1]!.keys).toEqual(["2"]);
  });

  it("answers composerReady false when a prompt dialog is on screen", () => {
    const raw = [
      "Which model should be used?",
      "  1. Gemini 3.7 Pro",
      "  2. Gemini 3.7 Flash",
      "Enter to select",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(false);
  });

  it("answers composerReady true when at an idle prompt line", () => {
    const raw = ["Ready for instructions.", "❯ "].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(agyAdapter.composerReady!(lines)).toBe(true);
  });

  it("correctly locates the input box and extracts statusline on agy--fresh-idle.txt", () => {
    const raw = readFileSync(join(PANES_DIR, "agy--fresh-idle.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    expect(agyAdapter.composerReady!(lines)).toBe(true);

    const status = agyAdapter.extractStatusLines!(lines);
    expect(status.length).toBeGreaterThan(0);
    const statusText = status.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(statusText).toContain("? for shortcuts");
    expect(statusText).toContain("Gemini 3.7 Flash");

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.kind).toBe("raw");
    const mirrorText = blocks[0]!.lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
    expect(mirrorText).not.toContain("? for shortcuts");
    expect(mirrorText).not.toContain("──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n>");
  });

  it("extracts no spurious draft and extracts statusline on agy--done.txt", () => {
    const raw = readFileSync(join(PANES_DIR, "agy--done.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    expect(agyAdapter.composerReady!(lines)).toBe(true);

    const status = agyAdapter.extractStatusLines!(lines);
    expect(status.length).toBeGreaterThan(0);
    const statusText = status.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(statusText).toContain("? for shortcuts");
  });

  it("extracts working statusline on agy--working.txt", () => {
    const raw = readFileSync(join(PANES_DIR, "agy--working.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBeNull();
    const status = agyAdapter.extractStatusLines!(lines);
    expect(status.length).toBeGreaterThan(0);
    const statusText = status.map((l) => l.segments.map((s) => s.text).join("")).join(" ");
    expect(statusText).toContain("Gemini 3.7 Flash");
  });

  it("extracts typed user draft inside an input box", () => {
    const raw = [
      "────────────────────────────────────────────────────────────",
      "> write a python fibonacci function",
      "────────────────────────────────────────────────────────────",
      "? for shortcuts                                 Gemini 3.7",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    expect(agyAdapter.extractInputDraft!(lines)).toBe("write a python fibonacci function");
  });
});

