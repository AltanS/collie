import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { buildBlocks } from "../index";
import { adapterFor } from "../registry";
import { dropClosingRule, isClosingRule } from "./closing-rule";
import { claudeBuildBlocks } from "./index";

// Claude Code 2.1.296 draws a closing rule with the session name set into it under some dialogs when
// the session was renamed (`/rename`, `--name`). See closing-rule.ts for the whole story. The
// captures are in fixtures/panes as `claude-lab--*-named-v2296--w*.txt`, each beside the unnamed
// twin taken from an unnamed session on the same build.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const text = (name: string): string => readFileSync(join(PANES_DIR, name), "utf8");
const fixtureLines = (name: string): StyledLine[] => splitLines(parseAnsi(text(name)));
const fromText = (raw: string): StyledLine[] => splitLines(parseAnsi(raw));
const kindsOf = (lines: StyledLine[]): string[] => claudeBuildBlocks(lines).map((b) => b.kind);
/** The same bytes without the final row: the screen an unnamed session shows. */
const withoutLastRow = (raw: string): string => raw.slice(0, raw.lastIndexOf("\n"));

const RULE = "──────────────────────────────────────────────────────────────────── capture lab ─";
const FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

/** [named fixture, its unnamed twin or null, the kind both must lift]. */
const PAIRS: [string, string | null, string][] = [
  ["claude-lab--ask-single-named-v2296--w82.txt", "claude-lab--ask-single-v2296--w82.txt", "prompt-select"],
  ["claude-lab--ask-multi-named-v2296--w82.txt", "claude-lab--ask-multi-v2296--w82.txt", "multi-select"],
  ["claude-lab--ask-wizard-named-v2296--w82.txt", "claude-lab--ask-wizard-v2296--w82.txt", "wizard"],
  ["claude-lab--ask-single-named-v2296--w40.txt", "claude-lab--ask-single-v2296--w40.txt", "prompt-select"],
  ["claude-lab--ask-multi-named-v2296--w40.txt", "claude-lab--ask-multi-v2296--w40.txt", "multi-select"],
  ["claude-lab--ask-wizard-named-v2296--w40.txt", "claude-lab--ask-wizard-v2296--w40.txt", "wizard"],
  ["claude-lab--ask-wizard-review-named-v2296--w82.txt", "claude-lab--ask-wizard-review-v2296--w82.txt", "wizard"],
  ["claude-lab--ask-wizard-review-named-v2296--w40.txt", "claude-lab--ask-wizard-review-v2296--w40.txt", "wizard"],
  ["claude-lab--menu-config-panel-named-v2296--w82.txt", "claude-lab--menu-config-panel-v2296--w82.txt", "menu"],
  ["claude-lab--menu-config-panel-named-v2296--w40.txt", "claude-lab--menu-config-panel-v2296--w40.txt", "menu"],
  ["claude-lab--menu-resume-picker-named-v2296--w82.txt", "claude-lab--menu-resume-picker-v2296--w82.txt", "prompt-select"],
  ["claude-lab--menu-resume-picker-named-v2296--w40.txt", null, "prompt-select"],
];

describe("a named session's dialog reads as its unnamed twin does", () => {
  it.each(PAIRS)("%s", (named, unnamed, kind) => {
    const lines = fixtureLines(named);
    // The captured screen really does end in the rule: this test would pass vacuously otherwise.
    const last = lines.map(lineText).findLast((t) => t.trim() !== "")!;
    expect(isClosingRule(last), `${named} ends in a closing rule`).toBe(true);

    expect(kindsOf(lines).at(-1)).toBe(kind);
    if (unnamed !== null) expect(kindsOf(lines)).toEqual(kindsOf(fixtureLines(unnamed)));
  });

  it.each(PAIRS)("%s is not the unread-dialog card, and the composer is not offered", (named) => {
    const lines = fixtureLines(named);
    const blocks = buildBlocks(lines, { agent: "claude" });
    expect(blocks.map((b) => b.kind)).not.toContain("unread-dialog");
    expect(adapterFor("claude")!.composerReady!(lines)).toBe(false);
  });

  it.each(PAIRS)("%s lifts the block it lifts without the rule, byte for byte", (named) => {
    const raw = text(named);
    const withRule = claudeBuildBlocks(fromText(raw)).filter((b) => b.kind !== "raw");
    const without = claudeBuildBlocks(fromText(withoutLastRow(raw))).filter((b) => b.kind !== "raw");
    expect(withRule).toEqual(without);
  });
});

describe("the rule is dropped once, in one place", () => {
  it("drops exactly the last row of a named dialog and nothing else", () => {
    const lines = fixtureLines("claude-lab--ask-single-named-v2296--w82.txt");
    const dropped = dropClosingRule(lines);
    expect(dropped.length).toBe(lines.length - 1);
    expect(dropped).toEqual(lines.slice(0, -1));
  });

  it("leaves startLine in the same index space: every row of the dialog keeps its index", () => {
    const lines = fixtureLines("claude-lab--ask-wizard-named-v2296--w82.txt");
    const blocks = claudeBuildBlocks(lines);
    const wizard = blocks.find((b) => b.kind === "wizard")!;
    const before = blocks.find((b) => b.kind === "raw")!;
    // The raw block above plus the dialog's rows are the screen up to the dropped rule.
    expect(before.lines.length + wizard.lines.length).toBeLessThanOrEqual(lines.length - 1);
    expect(wizard.lines.map(lineText).some((t) => t.includes("capture lab"))).toBe(false);
  });

  it("sees through blank rows between the footer and the rule, and after the rule", () => {
    const raw = `${withoutLastRow(text("claude-lab--ask-single-named-v2296--w82.txt"))}\n\n${RULE}\n\n`;
    expect(kindsOf(fromText(raw)).at(-1)).toBe("prompt-select");
  });

  it("takes a plain rule with no label too, and a label of any script", () => {
    expect(isClosingRule("────────────────────────────────")).toBe(true);
    expect(isClosingRule("──────────────────────── 会話の名前 ─")).toBe(true);
    expect(isClosingRule("──────────────────────── a ─")).toBe(true);
  });

  it("does not take things that only look like a rule", () => {
    expect(isClosingRule("── x ─")).toBe(false);
    expect(isClosingRule("──")).toBe(false);
    expect(isClosingRule("--------------------------------")).toBe(false);
    expect(isClosingRule("──────────── name")).toBe(false);
    expect(isClosingRule("──────────── two ─ rules ─")).toBe(false);
    expect(isClosingRule("──────────── name ─ trailing")).toBe(false);
    expect(isClosingRule("╭────────────────╮")).toBe(false);
    expect(isClosingRule("")).toBe(false);
  });
});

describe("it fails closed", () => {
  const dialog = withoutLastRow(text("claude-lab--ask-single-named-v2296--w82.txt"));

  it("keeps a rule that sits under a row that is not a footer", () => {
    const lines = fromText(`Some transcript output\nA sentence that ends here.\n${RULE}`);
    expect(dropClosingRule(lines)).toBe(lines);
  });

  it("keeps a rule under an option row that is not the review step's Cancel row", () => {
    const lines = fromText(`${dialog.split("\n").slice(0, 8).join("\n")}\n  2. Blue\n${RULE}`);
    expect(dropClosingRule(lines)).toBe(lines);
  });

  it("does not drop two rules: only one row goes, and only when a footer is right above it", () => {
    const lines = fromText(`${dialog}\n${RULE}\n${RULE}`);
    // The second rule's neighbour is a rule, not a footer: nothing is dropped, nothing is lifted.
    expect(dropClosingRule(lines)).toBe(lines);
    expect(kindsOf(lines)).not.toContain("prompt-select");
  });

  it("does not drop a footer-shaped last row, or a rule above the footer", () => {
    const lines = fromText(`${RULE}\n${FOOTER}`);
    expect(dropClosingRule(lines)).toBe(lines);
  });

  it("leaves a body rule inside the transcript untouched", () => {
    const body = `Report\n${RULE}\nResults follow\n`;
    const lines = fromText(`${body}${dialog}\n${RULE}`);
    const dropped = dropClosingRule(lines);
    expect(dropped.length).toBe(lines.length - 1);
    expect(dropped.map(lineText).filter((t) => isClosingRule(t))).toHaveLength(
      lines.map(lineText).filter((t) => isClosingRule(t)).length - 1,
    );
    // Only the rule the dialog's footer sits on goes. A rule in the transcript, or one with a footer
    // above it that is not the last row, stays.
    const mid = fromText(`${dialog}\n${RULE}\nand then more output\n`);
    expect(dropClosingRule(mid)).toBe(mid);
  });

  it("keeps the idle input box, whose borders may be labelled with the session name", () => {
    for (const name of readdirSync(PANES_DIR).filter((f) => f.startsWith("claude-lab--idle-") && f.endsWith(".txt"))) {
      const lines = fixtureLines(name);
      expect(dropClosingRule(lines), name).toBe(lines);
    }
  });

  it("hands back the very same array when there is nothing to drop", () => {
    const lines = fixtureLines("claude-lab--ask-single-v2296--w82.txt");
    expect(dropClosingRule(lines)).toBe(lines);
    expect(dropClosingRule([])).toEqual([]);
  });

  it("no capture in the corpus changes unless it is one of the named twins", () => {
    const changed = readdirSync(PANES_DIR)
      .filter((f) => f.endsWith(".txt"))
      .filter((f) => {
        const lines = fixtureLines(f);
        return dropClosingRule(lines) !== lines;
      })
      .toSorted();
    expect(changed).toEqual(PAIRS.map(([named]) => named).toSorted());
  });
});
