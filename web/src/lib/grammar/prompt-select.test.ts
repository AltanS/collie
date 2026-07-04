import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";
import { detectPromptSelect, detectPromptSelectRegion } from "./prompt-select";
import { lineText } from "./markers";

// Anchored on this file's own directory (NOT `new URL(..., import.meta.url)`, which Vite statically
// rewrites into a root-relative asset path) so the fixtures resolve regardless of the run cwd.
const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

// The detector is developed and gated entirely against the byte-faithful pane captures in
// web/src/fixtures/panes/*.txt (real ESC bytes; see that README). Each fixture is run through the
// real parseAnsi → splitLines pipeline exactly as the renderer does, so these tests exercise the
// same code path production uses. Hard gates (from the spec): all five blocked-state fixtures detect
// with the correct question / labels / family / keystroke plan; working / fresh-idle / done produce
// ZERO detections; a menu that isn't at the tail must not match.

function fixtureText(name: string): string {
  return readFileSync(join(PANES_DIR, name), "utf8");
}

function fixtureLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(fixtureText(name)));
}

describe("detectPromptSelect — the five blocked-state fixtures", () => {
  it("folder-trust prompt → trust family, digit-alone keys", () => {
    const model = detectPromptSelect(fixtureLines("claude--trust-prompt.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("trust");
    expect(model!.question).toContain("Is this a project you created or one you trust?");
    expect(model!.options.map((o) => o.label)).toEqual(["Yes, I trust this folder", "No, exit"]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"]]);
  });

  it("AskUserQuestion select → select family, digit-THEN-Enter keys, free-text row dropped", () => {
    const model = detectPromptSelect(fixtureLines("claude--select-menu.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("select");
    expect(model!.question).toBe("Which color theme should the dashboard use?");
    // "4. Type something." is a free-text escape row → not up-levelled into a button.
    expect(model!.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", "Chat about this"]);
    expect(model!.options.map((o) => o.keys)).toEqual([
      ["1", "Enter"],
      ["2", "Enter"],
      ["3", "Enter"],
      ["5", "Enter"], // "Chat about this" keeps its original number (5), not its render position
    ]);
    // Description sub-lines are captured as secondary text.
    expect(model!.options[0]!.description).toContain("warm");
    expect(model!.options[3]!.description).toBeUndefined(); // "Chat about this" has none
  });

  it("edit-permission dialog → permission family, digit-alone keys", () => {
    const model = detectPromptSelect(fixtureLines("claude--permission-edit.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("permission");
    expect(model!.question).toBe("Do you want to create hello.txt?");
    expect(model!.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, allow all edits during this session (shift+tab)",
      "No",
    ]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
  });

  it("bash-permission dialog → permission family, digit-alone keys", () => {
    const model = detectPromptSelect(fixtureLines("claude--permission-bash.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("permission");
    expect(model!.question).toBe("Do you want to proceed?");
    expect(model!.options).toHaveLength(3);
    expect(model!.options[0]!.label).toBe("Yes");
    expect(model!.options[1]!.label).toContain("ask again");
    expect(model!.options[1]!.label).toContain("mkfifo fixture-fifo");
    expect(model!.options[2]!.label).toBe("No");
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
  });

  it("plan-approval dialog → plan family, digit-alone keys, free-text row dropped", () => {
    const model = detectPromptSelect(fixtureLines("claude--plan-approval.txt"));
    expect(model).not.toBeNull();
    expect(model!.family).toBe("plan");
    expect(model!.question).toContain("Would you like to proceed?");
    // "4. Tell Claude what to change" is a free-text escape row → dropped, leaving three buttons.
    expect(model!.options.map((o) => o.label)).toEqual([
      "Yes, and use auto mode",
      "Yes, manually approve edits",
      "No, refine with Ultraplan on Claude Code on the web",
    ]);
    expect(model!.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
  });
});

describe("detectPromptSelect — false-positive gate (no menu at the tail)", () => {
  for (const name of ["claude--working.txt", "claude--fresh-idle.txt", "claude--done.txt"]) {
    it(`${name} produces zero detections`, () => {
      expect(detectPromptSelect(fixtureLines(name))).toBeNull();
    });
  }

  it("a menu-shaped block that is NOT at the tail does not match", () => {
    // Take the real select-menu buffer and append ordinary output after it: the footer is no longer
    // the last non-blank line, so the tail anchor fails.
    const withTail = fixtureText("claude--select-menu.txt") + "\n● Wrote the file\n  ⎿  done\n";
    expect(detectPromptSelect(splitLines(parseAnsi(withTail)))).toBeNull();
  });

  it("empty and whitespace-only buffers do not match", () => {
    expect(detectPromptSelect(splitLines(parseAnsi("")))).toBeNull();
    expect(detectPromptSelect(splitLines(parseAnsi("\n\n   \n")))).toBeNull();
  });
});

describe("detectPromptSelectRegion — render boundary", () => {
  it("starts the menu region at the first option row (question + preamble stay above it)", () => {
    const lines = fixtureLines("claude--select-menu.txt");
    const region = detectPromptSelectRegion(lines);
    expect(region).not.toBeNull();
    // The region's first line is the first option; the question sits on the line just above it.
    expect(lineText(lines[region!.startLine]!).trim()).toMatch(/^❯?\s*1\.\s+Red$/);
    expect(lineText(lines[region!.startLine - 1]!).trim()).toBe("");
    expect(region!.model).toEqual(detectPromptSelect(lines));
  });
});
