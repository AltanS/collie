import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  textBeforeLastSend: vi.fn(),
}));

import { fetchPane, sendKeys } from "../../api";
import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { menusEqual, menusSameIdentity, submitMenuKeys } from "../../menu-action";
import type { MenuModel } from "../menu-model";
import { claudeBuildBlocks } from "./index";
import { detectMenu } from "./menu";

// Reading a menu's numbered rows into `rows`, so the card can draw one button per option. The
// rows are read only when the screen leaves no doubt: every case in MENU-6 and MENU-7 is a screen
// where a guess would put a wrong button in front of the operator.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const raw = (name: string): string => readFileSync(join(PANES_DIR, name), "utf8");
const load = (name: string): StyledLine[] => splitLines(parseAnsi(raw(name)));

const EXIT_LABELS = ["Exit and stop tasks", "Move to background and exit", "Stay"];
const exitFile = (n: 1 | 2 | 3): string => `claude--background-work-exit-${n}.txt`;
const exitMenu = (n: 1 | 2 | 3): MenuModel => {
  const menu = detectMenu(load(exitFile(n)));
  if (menu === null) throw new Error(`${exitFile(n)} lifted no menu`);
  return menu;
};

/** The menu of the card the whole pipeline lifts: the /effort slider has its own grammar, ahead of this one. */
function cardMenu(name: string): MenuModel {
  const block = claudeBuildBlocks(load(name)).find((b) => b.kind === "menu");
  if (block?.kind !== "menu") throw new Error(`${name} lifted no menu block`);
  return block.menu;
}

/** A dialog in the exit dialog's layout, with `body` between its title and its footer. */
function dialog(...body: string[]): MenuModel {
  const text = ["─".repeat(60), "  Some title", "", ...body, "", "  Enter to confirm · Esc to cancel"].join("\n");
  const menu = detectMenu(splitLines(parseAnsi(text)));
  if (menu === null) throw new Error("the synthetic dialog lifted no menu");
  return menu;
}

describe("rows on the real exit dialog", () => {
  it("@req:MENU-1 @oracle:requirement the rows sit on the menu, and `nav` stays as it was", () => {
    expect(exitMenu(1).nav).toEqual({ upDown: true });
  });

  it.each([
    [1, 0],
    [2, 1],
    [3, 2],
  ] as const)("@req:MENU-1 @oracle:requirement file %i reads the three options, current %i", (n, current) => {
    expect(exitMenu(n).rows).toEqual({ labels: EXIT_LABELS, current });
  });

  it("@req:MENU-1 @oracle:requirement the rows reach the menu block the card draws", () => {
    const block = claudeBuildBlocks(load(exitFile(2))).find((b) => b.kind === "menu");
    if (block?.kind !== "menu") throw new Error("no menu block");
    expect(block.menu.title).toBe("Background work is running");
    expect(block.menu.rows).toEqual({ labels: EXIT_LABELS, current: 1 });
  });

  it("@req:MENU-1 @oracle:requirement the `❯` prompts of the transcript above the dialog do not count", () => {
    // The capture holds two more `❯` rows above the rule: the prompts `❯ /exit` and `❯ Use the Bash…`.
    expect(raw(exitFile(1)).split("❯").length - 1).toBe(3);
    expect(exitMenu(1).rows?.labels).toHaveLength(3);
  });
});

describe("rows are read only when they can be read honestly", () => {
  // The positive control: the same frame the refusals below use does read rows, so each refusal is a
  // refusal of its own screen and not of the frame.
  it("@req:MENU-6 @oracle:requirement the frame reads honest rows", () => {
    expect(dialog("  ❯ 1. Alpha", "    2. Beta", "    3. Gamma").rows).toEqual({
      labels: ["Alpha", "Beta", "Gamma"],
      current: 0,
    });
    expect(dialog("    1. Alpha", "    2. Beta", "  ❯ 3. Gamma").rows).toEqual({
      labels: ["Alpha", "Beta", "Gamma"],
      current: 2,
    });
  });

  // A scrolled list: the numbering runs on from a row above the fold. `current` counts within the
  // block, because a tap walks the distance between rows, never to a number.
  it("@req:MENU-6 @oracle:requirement a scrolled block, consecutive from any start, is honest", () => {
    expect(dialog("    2. Alpha", "  ❯ 3. Beta", "    4. Gamma").rows).toEqual({
      labels: ["Alpha", "Beta", "Gamma"],
      current: 1,
    });
  });

  it("@req:MENU-6 @oracle:requirement no marker: no rows", () => {
    const menu = dialog("    1. Alpha", "    2. Beta", "    3. Gamma");
    expect(menu.rows).toBeUndefined();
    expect(menu.nav.upDown).toBe(false);
  });

  it.each<[string, string[]]>([
    ["marker on an unnumbered row, none numbered", ["    Alpha", "  ❯ Beta", "    Gamma"]],
    ["marker on an unnumbered row among numbered ones", ["    1. Alpha", "  ❯ Beta", "    2. Gamma"]],
    ["two markers", ["  ❯ 1. Alpha", "  ❯ 2. Beta", "    3. Gamma"]],
    ["two markers, one block apart", ["  ❯ 1. Alpha", "    2. Beta", "", "  ❯ 1. Gamma", "    2. Delta"]],
    ["a gap in the numbering", ["  ❯ 1. Alpha", "    2. Beta", "    4. Gamma"]],
    ["a gap after the first row", ["    1. Alpha", "  ❯ 3. Beta", "    4. Gamma"]],
    ["a repeated number", ["  ❯ 1. Alpha", "    1. Beta", "    2. Gamma"]],
    ["descending numbers", ["  ❯ 3. Alpha", "    2. Beta", "    1. Gamma"]],
    ["one row", ["  ❯ 1. Alpha"]],
    ["a blank line leaves the marker alone in its block", ["  ❯ 1. Alpha", "", "    2. Beta"]],
    ["the glyph inside a label, on no row's gutter", ["    1. Go ❯ back", "    2. Stay"]],
  ])("@req:MENU-6 @oracle:requirement %s: no rows, the arrows stay", (_name, body) => {
    const menu = dialog(...body);
    expect(menu.rows).toBeUndefined();
    expect(menu.nav.upDown).toBe(true);
  });
});

describe("only the marker's contiguous block holds the options", () => {
  it("@req:MENU-7 @oracle:requirement numbered body lines above a blank line are not options", () => {
    expect(dialog("  1. foo", "  2. bar", "", "  ❯ 1. Alpha", "    2. Beta").rows).toEqual({
      labels: ["Alpha", "Beta"],
      current: 0,
    });
  });

  it("@req:MENU-7 @oracle:requirement numbered lines below a blank line are not options", () => {
    expect(dialog("    1. Alpha", "  ❯ 2. Beta", "", "  3. note").rows).toEqual({
      labels: ["Alpha", "Beta"],
      current: 1,
    });
  });

  it("@req:MENU-7 @oracle:requirement a description line inside the block neither breaks it nor becomes a label", () => {
    expect(
      dialog("  ❯ 1. Alpha", "       what alpha does", "    2. Beta", "       what beta does", "    3. Gamma").rows,
    ).toEqual({ labels: ["Alpha", "Beta", "Gamma"], current: 0 });
  });

  it("@req:MENU-7 @oracle:requirement a wrapped continuation counts the rows right under the marker", () => {
    expect(dialog("    1. Alpha", "       wrapped tail", "  ❯ 2. Beta", "    3. Gamma").rows).toEqual({
      labels: ["Alpha", "Beta", "Gamma"],
      current: 1,
    });
  });
});

describe("the guard's comparators with rows on the model", () => {
  const mockFetchPane = vi.mocked(fetchPane);
  const mockSendKeys = vi.mocked(sendKeys);
  const base = { paneId: "w1:p1", requestedLines: 200, detectedRevision: 0, agent: "claude" };
  const pane = (text: string) =>
    mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text, truncated: false, revision: 0 });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendKeys.mockResolvedValue({ ok: true });
  });

  it("@req:MENU-8 @oracle:requirement files 1 and 2 are the same screen with a moved highlight", () => {
    const [a, b] = [exitMenu(1), exitMenu(2)];
    expect(a.rows?.current).toBe(0);
    expect(b.rows?.current).toBe(1);
    expect(menusSameIdentity(a, b)).toBe(true);
    expect(menusEqual(a, b)).toBe(false);
  });

  it("@req:MENU-8 @oracle:requirement rows do not enter the identity", () => {
    const a = exitMenu(1);
    const b: MenuModel = { ...a, rows: { labels: ["Other", "Rows"], current: 1 } };
    const none: MenuModel = { title: a.title, actions: a.actions, nav: a.nav, signature: a.signature };
    expect(menusSameIdentity(a, b)).toBe(true);
    expect(menusSameIdentity(a, none)).toBe(true);
  });

  it("@req:MENU-8 @oracle:requirement a walk of several arrows passes the guard after the highlight moved", async () => {
    pane(raw(exitFile(2)));
    const res = await submitMenuKeys({ ...base, menu: exitMenu(1), keys: ["Down", "Down"], nav: true });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["Down", "Down"], undefined, expect.any(String));
  });

  it("@req:MENU-8 @oracle:requirement a stale Confirm is refused and sends nothing", async () => {
    pane(raw(exitFile(2)));
    const res = await submitMenuKeys({ ...base, menu: exitMenu(1), keys: ["Enter"] });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

describe("a scrolled picker's edge rows", () => {
  it("@req:MENU-11 @oracle:requirement the `↓ 10.` row of the 2.1.291 picker is the tenth option, and the marker row stays current", () => {
    const rows = detectMenu(load("claude-lab--menu-model-picker-v2291--w82.txt"))?.rows;
    expect(rows?.labels).toHaveLength(10);
    expect(rows?.labels[9]).toBe("Opus 4.7");
    expect(rows?.labels[3]).toBe("Sonnet 5.5 ✔");
    expect(rows?.current).toBe(3);
  });

  it("@req:MENU-11 @oracle:requirement the 2.1.301 picker at 119 columns ends on `↓ 10. Opus 4.8`", () => {
    const rows = detectMenu(load("claude-lab--menu-model-picker-v2301--w119.txt"))?.rows;
    expect(rows?.labels).toHaveLength(10);
    expect(rows?.labels[9]).toBe("Opus 4.8");
    expect(rows?.current).toBe(0);
  });

  it("@req:MENU-11 @oracle:requirement a `↑` row at the top of the window is the first option, no marker and no label text", () => {
    const rows = dialog("↑ 1. Default", "  2. Opus", "❯ 3. Sonnet", "  4. Haiku", "↓ 5. Fable").rows;
    expect(rows).toEqual({ labels: ["Default", "Opus", "Sonnet", "Haiku", "Fable"], current: 2 });
  });

  it("@req:MENU-11 @oracle:requirement an arrow row does not count as the marker: with none on a numbered row, no rows", () => {
    expect(dialog("↑ 1. Default", "  2. Opus", "  3. Sonnet").rows).toBeUndefined();
  });
});

describe("the cards this change must leave alone", () => {
  it.each([
    ["claude--menu-model-picker.txt", 5, 0],
    ["claude--menu-model-picker-moved.txt", 5, 2],
    ["claude-lab--menu-model-picker-v2301--w119.txt", 10, 0],
    ["claude--v21314-core-menu-model--w120.txt", 5, 4],
  ] as const)("@req:MENU-9 @oracle:requirement %s: reads %i rows, current %i", (name, count, current) => {
    const rows = detectMenu(load(name))?.rows;
    expect(rows?.labels).toHaveLength(count);
    expect(rows?.current).toBe(current);
    // A row also prints a description column; a label may or may not carry it. Its name comes first.
    expect(rows?.labels[0]?.startsWith("Default (recommended)")).toBe(true);
  });

  it.each([
    "claude--menu-model-picker.txt",
    "claude--menu-model-picker-moved.txt",
    "claude-lab--menu-model-picker-v2301--w119.txt",
    "claude--v21314-core-menu-model--w120.txt",
  ])("@req:MENU-9 @oracle:requirement %s: a card, no digit key anywhere, its keys as the footer named them", (name) => {
    const menu = detectMenu(load(name));
    if (menu === null) throw new Error(`${name} lifted no menu`);
    expect(menu.title).toBe("Select model");
    expect(menu.actions.flatMap((a) => a.keys)).toEqual(["Enter", "s", "Escape"]);
    expect(menu.nav.upDown).toBe(true);
    expect(menu.nav.leftRight?.verb).toBe("adjust");
  });

  it.each([
    "claude--menu-effort-slider.txt",
    "claude--menu-effort-slider--w132.txt",
    "claude--menu-effort-slider--w120.txt",
    "claude--menu-effort-slider--w80.txt",
    "claude--menu-effort-slider--w60.txt",
    "claude--menu-effort-slider--w40.txt",
  ])("@req:MENU-10 @oracle:requirement %s: the slider reads no rows", (name) => {
    expect(cardMenu(name).rows).toBeUndefined();
  });

  it("@req:MENU-10 @oracle:requirement the printed scale itself is unchanged", () => {
    expect(cardMenu("claude--menu-effort-slider--w132.txt").nav.leftRight?.values).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
  });
});
