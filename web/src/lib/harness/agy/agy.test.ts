import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { agyAdapter, antigravityAdapter } from "./index";
import { detectPromptSelect } from "./prompt-select";

describe("agyAdapter", () => {
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

  it("detects an AskUserQuestion prompt where options are at the tail without explicit footer", () => {
    const raw = [
      "Which theme or primary color accent would you prefer for the Collie AGY experience?",
      "  1. Google Blue (#1A73E8) - Classic Antigravity styling",
      "  2. Dark Indigo (#4F46E5) - Modern terminal contrast",
      "  3. Emerald (#10B981) - Clean status accent",
      "  4. Keep default theme without custom accent",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).not.toBeNull();
    expect(model!.question).toBe(
      "Which theme or primary color accent would you prefer for the Collie AGY experience?",
    );
    expect(model!.family).toBe("select");
    expect(model!.options).toHaveLength(4);
    expect(model!.options[0]!.label).toBe("Google Blue (#1A73E8) - Classic Antigravity styling");
    expect(model!.options[0]!.keys).toEqual(["1", "Enter"]);
    expect(model!.options[3]!.label).toBe("Keep default theme without custom accent");
    expect(model!.options[3]!.keys).toEqual(["4", "Enter"]);

    const blocks = agyAdapter.buildBlocks(lines);
    expect(blocks.some((b) => b.kind === "prompt-select")).toBe(true);
  });

  it("detects radio/checkbox and bracketed option styles", () => {
    const raw = [
      "Select a build target:",
      "  ( ) 1. Development build",
      "  (*) 2. Production build",
      "  ( ) 3. Staging build",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));

    const model = detectPromptSelect(lines);
    expect(model).not.toBeNull();
    expect(model!.options).toHaveLength(3);
    expect(model!.options[0]!.label).toBe("Development build");
    expect(model!.options[1]!.label).toBe("Production build");
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
});
