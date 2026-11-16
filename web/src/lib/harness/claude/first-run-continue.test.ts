import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../../blocks";
import { withUnreadDialog } from "../index";
import { detectFirstRunContinueRegion } from "./first-run-continue";
import { claudeAdapter, claudeBuildBlocks } from "./index";

// The first run's two "Press Enter to continue…" steps after a sign-in (first-run-continue.ts), from the
// live run of 2026-11-16 (Claude Code 2.1.325, 219 columns, masked): the sign-in step, then the
// security notes. The step after them is the folder trust dialog, read by the prompt grammar.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const load = (name: string): StyledLine[] => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));
const pipeline = (lines: StyledLine[]): Block[] => withUnreadDialog(claudeAdapter, lines, claudeBuildBlocks(lines));

const LOGIN_OK = "claude--v2325-first-run-login-ok--w219.txt";
const NOTES = "claude--v2325-first-run-security-notes--w219.txt";
const TRUST = "claude--v2325-first-run-trust--w219.txt";

describe("first run: the Press Enter to continue steps are one-key cards", () => {
  it.each([
    [LOGIN_OK, "Login successful."],
    [NOTES, "Security notes"],
  ])("first run: %s lifts as a menu with one action, Enter, labelled Continue", (name, title) => {
    const blocks = pipeline(load(name));
    const menu = blocks.find((b) => b.kind === "menu");
    expect(menu?.kind).toBe("menu");
    if (menu?.kind !== "menu") return;
    expect(menu.menu.title).toBe(title);
    expect(menu.menu.actions).toEqual([{ label: "Continue", keys: ["Enter"] }]);
    expect(menu.menu.nav).toEqual({ upDown: false });
    expect(blocks.some((b) => b.kind === "unread-dialog")).toBe(false);
  });

  it("first run: the sign-in step's card holds the account row and the prompt", () => {
    const region = detectFirstRunContinueRegion(load(LOGIN_OK))!;
    const texts = load(LOGIN_OK).map(lineText);
    expect(texts[region.startLine]!.trim()).toMatch(/^Logged in as /u);
  });

  it("first run: the notes step's card starts at its title and never offers a digit", () => {
    const region = detectFirstRunContinueRegion(load(NOTES))!;
    expect(load(NOTES).map(lineText)[region.startLine]!.trim()).toBe("Security notes:");
    expect(region.model.actions.flatMap((a) => a.keys).some((k) => /^\d$/u.test(k))).toBe(false);
  });

  it("first run: a moved screen has another signature", () => {
    const a = detectFirstRunContinueRegion(load(LOGIN_OK))!;
    const b = detectFirstRunContinueRegion(load(NOTES))!;
    expect(a.model.signature).not.toBe(b.model.signature);
  });

  it("first run: the composer stays blocked under both steps (a dialog holds the keys)", () => {
    for (const name of [LOGIN_OK, NOTES]) {
      const lines = load(name);
      expect(claudeAdapter.composerReady?.(lines)).toBe(false);
      expect(claudeAdapter.modalOnScreen?.(lines)).toBe(true);
    }
  });

  it("first run: the folder trust dialog after them is not claimed here, and the prompt grammar reads it", () => {
    expect(detectFirstRunContinueRegion(load(TRUST))).toBeNull();
    const card = pipeline(load(TRUST)).find((b) => b.kind === "prompt-select");
    expect(card?.kind).toBe("prompt-select");
    if (card?.kind !== "prompt-select") return;
    // The pointer stands on the default, No; Yes is one Down away. No digit: the rows have none.
    expect(card.prompt.options.map((o) => [o.label, o.keys])).toEqual([
      ["No, exit", ["Enter"]],
      ["Yes, I trust this folder", ["Down", "Enter"]],
    ]);
  });

  it("first run: no screen after a sign-in ends in a blocked box with no card", () => {
    for (const name of [LOGIN_OK, NOTES, TRUST]) {
      const blocks = pipeline(load(name));
      expect(blocks.some((b) => b.kind === "menu" || b.kind === "prompt-select")).toBe(true);
    }
  });

  it("first run: strict match, near misses stay null", () => {
    const texts = load(NOTES).map(lineText);
    // No welcome row: a chat line that quotes the prompt is not the step.
    expect(detectFirstRunContinueRegion(fromTexts(texts.filter((t) => !t.startsWith("Welcome to Claude Code"))))).toBeNull();
    // Another key named: not the one-key prompt.
    expect(detectFirstRunContinueRegion(fromTexts([...texts.slice(0, -1), " Press Esc to continue…"]))).toBeNull();
    // A bare prompt with no notes title above it.
    expect(detectFirstRunContinueRegion(fromTexts(texts.map((t) => (t.trim() === "Security notes:" ? " Something else:" : t))))).toBeNull();
    // Text under the prompt: it is no longer the last row.
    expect(detectFirstRunContinueRegion(fromTexts([...texts, " more"]))).toBeNull();
  });
});
