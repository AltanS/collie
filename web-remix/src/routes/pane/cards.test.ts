/// <reference types="bun" />
// The dialog-to-card mapping over REAL captures (web/src/fixtures/panes), one per harness that has a
// dialog capture. The blocks are built by web's own dispatcher with the agent string the capture was
// taken from; this file only checks what the pane screen draws from them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseAnsi } from "@web/lib/ansi";
import { splitLines, type Block } from "@web/lib/blocks";
import { buildBlocks } from "@web/lib/harness";
import { splitWalk } from "@web/lib/harness/prompt-model";

import { dialogCardOf, dialogOwnsKeyboard, mirrorLines, type DialogCard, type PromptCard } from "./cards";

const FIXTURES = new URL("../../../../web/src/fixtures/panes/", import.meta.url);

function blocksOf(file: string, agent: string): Block[] {
  return buildBlocks(splitLines(parseAnsi(readFileSync(new URL(file, FIXTURES), "utf8"))), { agent });
}

function cardOf(file: string, agent: string): DialogCard | null {
  return dialogCardOf(blocksOf(file, agent));
}

function promptOf(file: string, agent: string): PromptCard {
  const card = cardOf(file, agent);
  if (card?.kind !== "prompt-select") throw new Error(`${file}: expected a prompt card, got ${card?.kind ?? "none"}`);
  return card;
}

const PERMISSION_CASES = [
  { file: "claude--permission-bash.txt", agent: "claude", options: 3, firstKeys: ["1"] },
  { file: "codex--approval-exec.txt", agent: "codex", options: 2, firstKeys: ["1"] },
  { file: "agy--permission-bash.txt", agent: "agy", options: 4 },
  { file: "grok--permission-rm.txt", agent: "grok", options: 2, firstKeys: ["2"] },
  { file: "muse--approval-ls.txt", agent: "muse", options: 3 },
  { file: "oc--permission-bash.txt", agent: "opencode", options: 3, firstKeys: ["Enter"] },
] as const;

describe("permission dialogs, one per harness", () => {
  for (const c of PERMISSION_CASES) {
    test(`${c.agent}: ${c.file}`, () => {
      const card = promptOf(c.file, c.agent);
      expect(card.block.prompt.family).toBe("permission");
      expect(card.options.length).toBe(c.options);
      for (const row of card.options) {
        expect(row.label.length).toBeGreaterThan(0);
        expect(row.badge.length).toBeGreaterThan(0);
        // The card hands back the harness's own option, untouched, for the guarded tap.
        expect(card.block.prompt.options).toContain(row.option);
      }
      if ("firstKeys" in c) expect(card.options[0]!.option.keys).toEqual([...c.firstKeys]);
      expect(card.caption.length).toBeGreaterThan(0);
      // The dialog has the keyboard: a typed reply is refused while it is up.
      expect(dialogOwnsKeyboard([card.block])).toBe(true);
    });
  }

  test("claude: direct digits, no walk", () => {
    const card = promptOf("claude--permission-bash.txt", "claude");
    expect(card.options.map((o) => o.option.keys)).toEqual([["1"], ["2"], ["3"]]);
    for (const o of card.options) expect(splitWalk(o.option.keys)).toBeNull();
  });

  test("grok: the option labels are the screen's", () => {
    const card = promptOf("grok--permission-rm.txt", "grok");
    expect(card.options.map((o) => o.label)).toEqual(["Yes, proceed", "No, reject"]);
  });

  test("opencode: a pointed list walks, then commits (ADR 0080)", () => {
    const card = promptOf("oc--permission-bash.txt", "opencode");
    expect(card.options.map((o) => o.option.keys)).toEqual([["Enter"], ["Right", "Enter"], ["Right", "Right", "Enter"]]);
    expect(splitWalk(card.options[1]!.option.keys)).not.toBeNull();
    // After one step right the pointer sits on "Allow always": its keys are the commit alone.
    const moved = promptOf("oc--permission-bash--moved.txt", "opencode");
    const always = moved.options.find((o) => o.label === card.options[1]!.label);
    expect(always?.option.keys).toEqual(["Enter"]);
  });
});

describe("other card kinds", () => {
  test("a menu carries its footer actions and its advertised arrows", () => {
    const card = cardOf("claude--menu-model-picker.txt", "claude");
    if (card?.kind !== "menu") throw new Error("expected a menu card");
    expect(card.caption).toBe("Select model");
    expect(card.block.menu.nav.upDown).toBe(true);
    expect(card.block.menu.actions.map((a) => a.keys)).toEqual([["Enter"], ["s"], ["Escape"]]);
    expect(card.block.menu.actions.at(-1)?.cancel).toBe(true);
  });

  test("an unread dialog names its one key", () => {
    const card = cardOf("codex--ask-notes-focused.txt", "codex");
    if (card?.kind !== "unread-dialog") throw new Error("expected an unread-dialog card");
    expect(card.block.cancel.key).toBe("Escape");
    expect(card.keyName).toBe("Esc");
  });

  test("wizard, multi-select and preview-select get the keys-only card", () => {
    for (const file of ["claude--select-multi.txt", "claude--select-multiselect-checked.txt", "claude--select-preview.txt"]) {
      const card = cardOf(file, "claude");
      expect(card?.kind).toBe("keys-only");
    }
  });

  test("an agent with no adapter gets the plain mirror and no card", () => {
    const blocks = blocksOf("claude--permission-bash.txt", "some-future-harness");
    expect(dialogCardOf(blocks)).toBeNull();
    expect(mirrorLines(blocks).length).toBe(blocks.flatMap((b) => b.lines).length);
  });

  test("the mirror leaves out the lines the card took", () => {
    const blocks = blocksOf("claude--permission-bash.txt", "claude");
    const card = dialogCardOf(blocks);
    if (card?.kind !== "prompt-select") throw new Error("expected a prompt card");
    const all = blocks.flatMap((b) => b.lines).length;
    expect(mirrorLines(blocks).length).toBe(all - card.block.lines.length);
  });
});
