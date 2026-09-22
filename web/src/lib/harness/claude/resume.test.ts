import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual } from "../prompt-model";
import { claudeBuildBlocks } from "./index";
import { detectResumePicker } from "./resume";

// The `/resume` session picker's own grammar (.adr/0058). Its footer never names Enter or the arrows,
// so the generic menu could only cancel it. These tests pin what the dedicated grammar reads off each
// real capture — the sessions, their meta rows, the pointed row and the walk each tap sends — and
// that it fails closed the moment any piece of its evidence is missing.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const load = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

/** A fixture's screen as plain text rows, for the hand-edited negatives below. */
const textsOf = (name: string): string[] => load(name).map(lineText);
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));

const LAB_SESSIONS = ["Count to three", "Name a colour", "say ok", "Say hi in one word"];

describe("the real captures lift as a list of sessions", () => {
  it("w120-first: the pointer on the first session, each other row walks Down", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w120-first.txt"))!;
    expect(model.family).toBe("select");
    expect(model.question).toBe("Resume session");
    // The card's caption is this dialog's own title, not the generic "select" family caption.
    expect(model.caption).toBe("Resume session");
    expect(model.options.map((o) => o.label)).toEqual([...LAB_SESSIONS, "Cancel"]);
    expect(model.options[0]!.description).toBe("44 seconds ago · master · 177.4KB");
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Enter"],
      ["Escape"],
    ]);
    expect(model.options[0]!.keyLabel).toBe("❯");
  });

  it("w120-third: the pointer on the third session walks Up above it and Down below it", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w120-third.txt"))!;
    expect(model.options.map((o) => o.label)).toEqual([...LAB_SESSIONS, "Cancel"]);
    expect(model.options.map((o) => o.description)).toEqual([
      "1 minute ago · master · 177.4KB",
      "1 minute ago · master · 177.5KB",
      "2 minutes ago · master · 176.8KB",
      "2 minutes ago · master · 177.5KB",
      undefined,
    ]);
    expect(model.options[0]!.keys).toEqual(["Up", "Up", "Enter"]);
    expect(model.options[1]!.keys).toEqual(["Up", "Enter"]);
    expect(model.options[2]!.keys).toEqual(["Enter"]);
    expect(model.options[3]!.keys).toEqual(["Down", "Enter"]);
    // Every non-pointed session row carries the explicit "no badge" marker, never left unset — the
    // block renders it as an empty, same-width slot rather than falling back to the raw key name.
    expect(model.options.map((o) => o.keyLabel)).toEqual(["", "", "❯", "", "Esc"]);
  });

  it("w80-second: the pointer on the second session", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w80-second.txt"))!;
    expect(model.options.map((o) => o.label)).toEqual([...LAB_SESSIONS, "Cancel"]);
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Escape"],
    ]);
  });

  it("w60-first: the footer wrapped onto three rows still reads, and the list is the same", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w60-first.txt"))!;
    expect(model.options.map((o) => o.label)).toEqual([...LAB_SESSIONS, "Cancel"]);
    expect(model.options[0]!.keys).toEqual(["Enter"]);
    expect(model.options[3]!.keys).toEqual(["Down", "Down", "Down", "Enter"]);
    // The whole wrapped footer is inside the signature, down to its last row.
    expect(model.signature.endsWith("· Type to search · Esc to cancel")).toBe(true);
  });

  it("w120-search: one match and no pointer — its tap is Enter, and Esc clears the search", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w120-search.txt"))!;
    expect(model.options).toEqual([
      { label: "Say hi in one word", description: "4 minutes ago · master · 177.5KB", keys: ["Enter"] },
      { label: "Clear", keys: ["Escape"], keyLabel: "Esc" },
    ]);
  });

  it("w120-all-sanitized: the all-projects title, a `now` age, and the `↓` scroll row as a session", () => {
    const model = detectResumePicker(load("claude--menu-resume-picker--w120-all-sanitized.txt"))!;
    expect(model.question).toBe("Resume session (1 of 50)");
    expect(model.caption).toBe("Resume session (1 of 50)");
    expect(model.options).toHaveLength(10);
    expect(model.options[0]!.description).toBe(
      "now · main · 1.1MB · /home/user/projects/example-company-platform",
    );
    expect(model.options[0]!.keyLabel).toBe("❯");
    // The last session carries the `↓` marker in the pointer column: listed, walked to, not pointed.
    expect(model.options[8]!.label).toBe("classifier milestone m09");
    expect(model.options[8]!.keyLabel).toBe("");
    expect(model.options[8]!.keys).toEqual([...Array<string>(8).fill("Down"), "Enter"]);
    expect(model.options[9]!.keys).toEqual(["Escape"]);
  });

  it("the older lab capture at 83 columns lifts the same way", () => {
    const model = detectResumePicker(load("claude-lab--menu-resume-picker--w83.txt"))!;
    expect(model.options.map((o) => [o.label, o.keys])).toEqual([
      ["Read README.md", ["Enter"]],
      ["README review", ["Down", "Enter"]],
      ["Cancel", ["Escape"]],
    ]);
  });

  it("no key anywhere is a digit, and only the Esc row lacks Enter", () => {
    for (const name of RESUME_FIXTURES) {
      for (const option of detectResumePicker(load(name))!.options) {
        expect(option.keys.some((k) => /\d/.test(k)), `${name}: ${option.label}`).toBe(false);
        const last = option.keys.at(-1);
        expect(last === "Enter" || (option.keys.length === 1 && last === "Escape"), name).toBe(true);
      }
    }
  });

  it("the pipeline emits it as a prompt-select block, not the generic menu", () => {
    for (const name of RESUME_FIXTURES) {
      const blocks = claudeBuildBlocks(load(name));
      expect(blocks.at(-1)!.kind, name).toBe("prompt-select");
      expect(blocks.filter((b) => b.kind !== "raw"), name).toHaveLength(1);
    }
  });
});

const RESUME_FIXTURES = [
  "claude--menu-resume-picker--w120-first.txt",
  "claude--menu-resume-picker--w120-third.txt",
  "claude--menu-resume-picker--w120-search.txt",
  "claude--menu-resume-picker--w60-first.txt",
  "claude--menu-resume-picker--w80-second.txt",
  "claude--menu-resume-picker--w120-all-sanitized.txt",
  "claude-lab--menu-resume-picker--w83.txt",
];

describe("the race guard sees the pointer", () => {
  it("a pointer moved between render and tap is not the same prompt", () => {
    const first = detectResumePicker(load("claude--menu-resume-picker--w120-first.txt"))!;
    const texts = textsOf("claude--menu-resume-picker--w120-first.txt");
    const pointedAt = texts.findIndex((t) => t.startsWith("   ❯ Count to three"));
    const nextAt = texts.findIndex((t) => t.startsWith("     Name a colour"));
    const moved = [...texts];
    moved[pointedAt] = texts[pointedAt]!.replace("❯", " ");
    moved[nextAt] = texts[nextAt]!.replace("     Name", "   ❯ Name");
    const after = detectResumePicker(fromTexts(moved))!;
    expect(after.options[1]!.keys).toEqual(["Enter"]);
    expect(after.signature).not.toBe(first.signature);
    expect(promptsEqual(first, after)).toBe(false);
    // And a re-derivation of the unchanged screen is equal, so the guard is not simply always shut.
    expect(promptsEqual(first, detectResumePicker(fromTexts(texts))!)).toBe(true);
  });
});

describe("fails closed", () => {
  const base = textsOf("claude--menu-resume-picker--w120-third.txt");

  it("without the search box", () => {
    const at = base.findIndex((t) => t.includes("⌕"));
    const texts = base.filter((_, i) => i < at - 1 || i > at + 1);
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("without the `Resume session` title", () => {
    const texts = base.map((t) => (t.trim() === "Resume session" ? "   Pick a session" : t));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("with several sessions and no pointer", () => {
    const texts = base.map((t) => t.replace("❯", " "));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("with two pointers", () => {
    const texts = base.map((t) => (t.startsWith("     Count to three") ? t.replace("     Count", "   ❯ Count") : t));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("without `Esc to cancel` in the footer", () => {
    const texts = base.map((t) => t.replace("Esc to cancel", "Esc to go back"));
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("on a numbered list below a `Resume session` line of prose", () => {
    const texts = [
      "",
      "   Resume session",
      "",
      "   ❯ 1. Count to three",
      "     2. Name a colour",
      "",
      "   Enter to select · Esc to cancel",
    ];
    expect(detectResumePicker(fromTexts(texts))).toBeNull();
  });

  it("never turns the project heading into an option", () => {
    const model = detectResumePicker(fromTexts(base))!;
    expect(model.options.map((o) => o.label)).not.toContain("resume-lab");
    // Even with the blank row under the heading removed, the heading has no meta row of its own.
    const at = base.findIndex((t) => t.trim() === "resume-lab");
    const tight = base.filter((_, i) => i !== at + 1);
    expect(detectResumePicker(fromTexts(tight))!.options.map((o) => o.label)).toEqual([
      ...LAB_SESSIONS,
      "Cancel",
    ]);
  });

  it("claims no other Claude capture in the corpus", () => {
    const others = readdirSync(PANES_DIR).filter(
      (f) => /^claude(-lab)?--/.test(f) && f.endsWith(".txt") && !f.includes("resume-picker"),
    );
    expect(others.length).toBeGreaterThan(100);
    for (const name of others) {
      expect(detectResumePicker(load(name)), name).toBeNull();
    }
  });
});
