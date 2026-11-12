import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { claudeBuildBlocks } from "./index";
import { detectPromptSelectRegion } from "./prompt-select";

// Claude Code 2.1.323 with Remote Control on (`claude --remote-control`), against the same screens with it off.
// Lab capture 2026-11-13, tmux at 100 columns, classic renderer, isolated config. Remote Control puts the
// pill `/rc active` under the input box (the Send Protocol side is in bridge/surface/protocol.claude-rc-footer
// .test.ts). The captures show that a dialog draws no footer, so no `/rc` row sits under one and the readers
// have nothing new to skip: the dialog of a session with Remote Control on reads as the dialog of one
// without it. The two bash captures name different files (`demo.txt`, `demo2.txt`) and the two ask captures
// were worded by the model (`Do you want tea or coffee?`, `Which do you prefer, tea or coffee?`).

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const lines = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, `claude--v2323-${name}--w100.txt`), "utf8")));
const text = (row: { segments: { text: string }[] }): string => row.segments.map((s) => s.text).join("");
const regionOf = (name: string) => {
  const region = detectPromptSelectRegion(lines(name));
  expect(region, name).not.toBeNull();
  return region!;
};

describe("Claude 2.1.323 dialogs with Remote Control on read as with it off", () => {
  it("the AskUserQuestion select: same family, options, keys, descriptions' presence and answer row", () => {
    const on = regionOf("rc-on-ask-single").model;
    const off = regionOf("rc-off-ask-single").model;
    expect(on.family).toBe("select");
    expect(on.family).toBe(off.family);
    expect(on.options.map((o) => o.label)).toEqual(["Tea", "Coffee", "Chat about this"]);
    expect(on.options.map((o) => o.label)).toEqual(off.options.map((o) => o.label));
    expect(on.options.map((o) => o.keys)).toEqual([["1", "Enter"], ["2", "Enter"], ["4", "Enter"]]);
    expect(on.options.map((o) => o.keys)).toEqual(off.options.map((o) => o.keys));
    expect(on.options.map((o) => o.description !== undefined)).toEqual(off.options.map((o) => o.description !== undefined));
    expect(on.feedback).toEqual(off.feedback);
    expect(on.question).toBe("Which do you prefer, tea or coffee?");
    expect(off.question).toBe("Do you want tea or coffee?");
  });

  it("the Bash permission: same question, options, keys and subject shape", () => {
    const on = regionOf("rc-on-permission-bash");
    const off = regionOf("rc-off-permission-bash");
    expect(on.model.family).toBe("permission");
    expect(on.model.question).toBe("Do you want to proceed?");
    expect(on.model.question).toBe(off.model.question);
    expect(on.model.options).toEqual(off.model.options);
    expect(on.model.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"], ["4"]]);
    const subject = (r: typeof on) => r.model.subject!.map(text);
    // Header, description and command; the tip row and the dashed frame stay out, as on every Bash dialog.
    expect(subject(on)).toEqual([
      "Bash command",
      "Create a second empty demo file",
      "touch demo2.txt",
    ]);
    expect(subject(off)).toEqual([
      "Bash command",
      "Create empty demo file",
      "touch demo.txt",
    ]);
    expect(on.model.askRegion!.split("\n")[0]).toMatch(/^─+$/);
    expect(off.model.askRegion!.split("\n")[0]).toMatch(/^─+$/);
  });

  it("the block pipeline lifts the same kinds with and without it", () => {
    const kinds = (name: string) => claudeBuildBlocks(lines(name)).map((b) => b.kind);
    expect(kinds("rc-on-ask-single")).toEqual(kinds("rc-off-ask-single"));
    expect(kinds("rc-on-permission-bash")).toEqual(kinds("rc-off-permission-bash"));
    expect(kinds("rc-on-permission-bash")).toContain("prompt-select");
  });

  it("the /rewind list reads as a menu with Continue and Cancel", () => {
    const blocks = claudeBuildBlocks(lines("rc-on-rewind"));
    const menu = blocks.find((b) => b.kind === "menu");
    expect(menu).toBeDefined();
    expect(menu!.kind === "menu" && menu!.menu.title).toBe("Rewind");
    expect(menu!.kind === "menu" && menu!.menu.actions.map((a) => a.label)).toEqual(["Continue", "Cancel"]);
  });

  it("the slash-command list under the box reads as an autocomplete of the commands", () => {
    const blocks = claudeBuildBlocks(lines("rc-on-slash-list"));
    const list = blocks.find((b) => b.kind === "autocomplete");
    expect(list).toBeDefined();
    expect(list!.kind === "autocomplete" && list!.autocomplete.entries.length).toBeGreaterThan(10);
  });
});
