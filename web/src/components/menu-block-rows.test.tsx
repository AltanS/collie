import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { claudeBuildBlocks } from "@/lib/harness/claude";
import { MenuBlock, type MenuBlockAction } from "./menu-block";

// One button per option on a generic menu's card. A tap only moves the highlight, in arrow presses;
// the commit stays on Confirm. The owner's report: a dialog showed Confirm alone, with no way to
// choose. Driven off real captures through the real pipeline.

const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
const capture = (name: string) => readFileSync(join(PANES, name), "utf8");
const exitCapture = (n: 1 | 2 | 3) => capture(`claude--background-work-exit-${n}.txt`);

const EXIT = "Exit and stop tasks";
const BACKGROUND = "Move to background and exit";
const STAY = "Stay";

function menuBlock(text: string) {
  const block = claudeBuildBlocks(splitLines(parseAnsi(text))).find((b) => b.kind === "menu");
  if (block?.kind !== "menu") throw new Error("the capture lifted no menu block");
  return block;
}

function renderCard(text: string, disabled = false) {
  const onAction = vi.fn<(a: MenuBlockAction) => void>();
  const block = menuBlock(text);
  const view = render(<MenuBlock menu={block.menu} lines={block.lines} onAction={onAction} disabled={disabled} />);
  return { onAction, ...view };
}

/** A card whose send stays in flight until `release` is called. */
function renderInFlight(text: string) {
  const flight = { release: () => {} };
  const onAction = vi.fn(() => new Promise<void>((resolve) => (flight.release = resolve)));
  const block = menuBlock(text);
  render(<MenuBlock menu={block.menu} lines={block.lines} onAction={onAction} />);
  return { onAction, flight };
}

const button = (name: string) => screen.getByRole("button", { name });
const noButton = (name: string) => screen.queryByRole("button", { name });
const isMarkedCurrent = (el: HTMLElement) => {
  const value = el.getAttribute("aria-current");
  return value !== null && value !== "false";
};

/** A synthetic dialog in the exit dialog's layout, with `body` between its title and its footer. */
const dialog = (...body: string[]) =>
  ["─".repeat(60), "  Some title", "", ...body, "", "  Enter to confirm · Esc to cancel"].join("\n");

describe("MenuBlock option rows", () => {
  it.each([
    [1, EXIT],
    [2, BACKGROUND],
    [3, STAY],
  ] as const)("@req:MENU-2 @oracle:requirement file %i: a button per row, %s current and disabled", (n, current) => {
    renderCard(exitCapture(n));
    for (const label of [EXIT, BACKGROUND, STAY]) {
      const row = button(label);
      expect(isMarkedCurrent(row)).toBe(label === current);
      if (label === current) expect(row).toBeDisabled();
      else expect(row).toBeEnabled();
    }
  });

  it("@req:MENU-2 @oracle:requirement Confirm, Cancel and the arrows are still there", () => {
    renderCard(exitCapture(1));
    expect(button(EXIT)).toBeInTheDocument();
    expect(button("Confirm")).toBeInTheDocument();
    expect(button("Cancel")).toBeInTheDocument();
    expect(button("Move up")).toBeInTheDocument();
    expect(button("Move down")).toBeInTheDocument();
  });

  it("@req:MENU-2 @oracle:requirement the rows sit under the mirror and above Confirm", () => {
    const { container } = renderCard(exitCapture(1));
    const mirror = container.querySelector("pre");
    if (mirror === null) throw new Error("the mirror is gone");
    expect(within(mirror).getByText(/Exit and stop tasks/)).toBeInTheDocument();
    const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(mirror, button(EXIT))).toBe(true);
    expect(follows(button(EXIT), button(BACKGROUND))).toBe(true);
    expect(follows(button(BACKGROUND), button(STAY))).toBe(true);
    expect(follows(button(STAY), button("Confirm"))).toBe(true);
  });

  it.each([
    [1, BACKGROUND, ["Down"]],
    [1, STAY, ["Down", "Down"]],
    [2, EXIT, ["Up"]],
    [2, STAY, ["Down"]],
    [3, EXIT, ["Up", "Up"]],
    [3, BACKGROUND, ["Up"]],
  ] as const)("@req:MENU-3 @oracle:requirement from file %i a tap on %s walks %j as nav", async (n, label, keys) => {
    const user = userEvent.setup();
    const { onAction } = renderCard(exitCapture(n));
    await user.click(button(label));
    expect(onAction.mock.calls).toEqual([[{ keys: [...keys], nav: true }]]);
  });

  it("@req:MENU-3 @oracle:requirement the distance is counted from the live marker, across a long list", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard(
      dialog("    1. Alpha", "    2. Beta", "    3. Gamma", "    4. Delta", "  ❯ 5. Epsilon"),
    );
    await user.click(button("Alpha"));
    expect(onAction.mock.calls).toEqual([[{ keys: ["Up", "Up", "Up", "Up"], nav: true }]]);
  });

  it("@req:MENU-3 @oracle:requirement a scrolled block walks by distance, its printed numbers play no part", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard(dialog("    2. Alpha", "  ❯ 3. Beta", "    4. Gamma", "    5. Delta"));
    await user.click(button("Delta"));
    expect(onAction.mock.calls).toEqual([[{ keys: ["Down", "Down"], nav: true }]]);
  });

  it("@req:MENU-3 @oracle:requirement after the marker moved a tap walks from where it is now", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn<(a: MenuBlockAction) => void>();
    const first = menuBlock(exitCapture(1));
    const { rerender } = render(<MenuBlock menu={first.menu} lines={first.lines} onAction={onAction} />);
    const moved = menuBlock(exitCapture(2));
    rerender(<MenuBlock menu={moved.menu} lines={moved.lines} onAction={onAction} />);
    expect(isMarkedCurrent(button(BACKGROUND))).toBe(true);
    expect(isMarkedCurrent(button(EXIT))).toBe(false);
    await user.click(button(STAY));
    expect(onAction.mock.calls).toEqual([[{ keys: ["Down"], nav: true }]]);
  });

  it.each([1, 2, 3] as const)("@req:MENU-3 @oracle:requirement file %i: no row ever sends Enter or a digit", async (n) => {
    const user = userEvent.setup();
    const { onAction } = renderCard(exitCapture(n));
    for (const label of [EXIT, BACKGROUND, STAY]) {
      const row = button(label);
      if (!isMarkedCurrent(row)) await user.click(row);
    }
    expect(onAction).toHaveBeenCalledTimes(2);
    for (const [action] of onAction.mock.calls) {
      expect(action.nav).toBe(true);
      expect(action.keys.length).toBeGreaterThan(0);
      for (const key of action.keys) expect(["Up", "Down"]).toContain(key);
    }
  });

  it("@req:MENU-4 @oracle:requirement Confirm sends Enter, Cancel sends Escape, neither as nav", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard(exitCapture(2));
    expect(button(STAY)).toBeInTheDocument();
    await user.click(button("Confirm"));
    await user.click(button("Cancel"));
    expect(onAction.mock.calls).toEqual([
      [{ keys: ["Enter"], nav: false }],
      [{ keys: ["Escape"], nav: false }],
    ]);
  });

  it("@req:MENU-4 @oracle:requirement a row tap never fires the Confirm action", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard(exitCapture(1));
    await user.click(button(STAY));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalledWith({ keys: ["Enter"], nav: false });
    expect(onAction.mock.calls.flatMap(([a]) => a.keys)).not.toContain("Enter");
  });

  it("@req:MENU-5 @oracle:requirement `disabled` makes the rows not pressable", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard(exitCapture(1), true);
    for (const label of [EXIT, BACKGROUND, STAY]) {
      expect(button(label)).toBeDisabled();
      await user.click(button(label));
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it("@req:MENU-5 @oracle:requirement a row tap in flight locks every control, then lets go", async () => {
    const user = userEvent.setup();
    const { onAction, flight } = renderInFlight(exitCapture(1));
    const [stay, background, confirm, cancel, up, down] = [
      button(STAY),
      button(BACKGROUND),
      button("Confirm"),
      button("Cancel"),
      button("Move up"),
      button("Move down"),
    ];

    await user.click(stay);
    for (const control of [stay, background, confirm, cancel, up, down]) expect(control).toBeDisabled();
    await user.click(background);
    expect(onAction).toHaveBeenCalledTimes(1);

    await act(async () => flight.release());
    expect(button(STAY)).toBeEnabled();
    expect(button(BACKGROUND)).toBeEnabled();
    expect(button("Confirm")).toBeEnabled();
  });

  it("@req:MENU-5 @oracle:requirement a Confirm in flight locks the rows", async () => {
    const user = userEvent.setup();
    const { onAction, flight } = renderInFlight(exitCapture(1));
    const confirm = button("Confirm");
    await user.click(confirm);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(button(STAY)).toBeDisabled();
    expect(button(BACKGROUND)).toBeDisabled();
    await act(async () => flight.release());
    expect(button(STAY)).toBeEnabled();
  });

  it.each<[string, string[], string[]]>([
    ["marker on an unnumbered row", ["    Alpha", "  ❯ Beta", "    Gamma"], ["Alpha", "Beta", "Gamma"]],
    ["two markers", ["  ❯ 1. Alpha", "  ❯ 2. Beta", "    3. Gamma"], ["Alpha", "Beta", "Gamma"]],
    ["a gap in the numbering", ["  ❯ 1. Alpha", "    2. Beta", "    4. Gamma"], ["Alpha", "Beta", "Gamma"]],
    ["one row", ["  ❯ 1. Alpha"], ["Alpha"]],
  ])("@req:MENU-6 @oracle:requirement %s: no row buttons, the arrows stay", (_name, body, labels) => {
    renderCard(dialog(...body));
    for (const label of labels) expect(noButton(label)).toBeNull();
    expect(button("Move up")).toBeInTheDocument();
    expect(button("Move down")).toBeInTheDocument();
    expect(button("Confirm")).toBeInTheDocument();
  });

  // No marker means the screen advertised no highlight, so today's card has no arrows either: the
  // arrows exist only where a `❯` row advertises them. What counts here is that no row is guessed.
  it("@req:MENU-6 @oracle:requirement no marker: no row buttons", () => {
    renderCard(dialog("    1. Alpha", "    2. Beta"));
    expect(noButton("Alpha")).toBeNull();
    expect(noButton("Beta")).toBeNull();
    expect(button("Confirm")).toBeInTheDocument();
  });

  it("@req:MENU-7 @oracle:requirement numbered body text gets no button, the marker's block does", () => {
    renderCard(dialog("  1. foo", "  2. bar", "", "  ❯ 1. Alpha", "       what alpha does", "    2. Beta"));
    expect(noButton("foo")).toBeNull();
    expect(noButton("bar")).toBeNull();
    expect(noButton("what alpha does")).toBeNull();
    expect(button("Alpha")).toBeInTheDocument();
    expect(button("Beta")).toBeInTheDocument();
  });

  it.each([
    "claude--menu-model-picker.txt",
    "claude--menu-model-picker-moved.txt",
    "claude-lab--menu-model-picker-v2301--w119.txt",
    "claude--v21314-core-menu-model--w120.txt",
  ])("@req:MENU-9 @oracle:requirement %s: every row walks arrows only, never a digit", async (name) => {
    const user = userEvent.setup();
    const { onAction } = renderCard(capture(name));
    const footer = ["Set as default", "Use this session only", "Cancel"];
    for (const control of screen.getAllByRole("button")) {
      if (/^\d+$/.test(control.textContent ?? "")) throw new Error(`a digit button: ${control.textContent}`);
    }
    const rows = menuBlock(capture(name)).menu.rows;
    if (rows === undefined) throw new Error("the picker read no rows");
    const expected: MenuBlockAction[] = [];
    for (const [i, label] of rows.labels.entries()) {
      // An accessible name collapses runs of spaces; the picker's rows have them between their columns.
      const row = button(label.replace(/\s+/g, " ").trim());
      expect(isMarkedCurrent(row)).toBe(i === rows.current);
      if (i === rows.current) continue;
      await user.click(row);
      expected.push({
        keys: Array.from({ length: Math.abs(i - rows.current) }, () => (i > rows.current ? "Down" : "Up")),
        nav: true,
      });
    }
    for (const label of footer) await user.click(button(label));
    const calls = onAction.mock.calls.map(([action]) => action);
    expect(calls.slice(-3)).toEqual([
      { keys: ["Enter"], nav: false },
      { keys: ["s"], nav: false },
      { keys: ["Escape"], nav: false },
    ]);
    expect(calls.slice(0, -3)).toEqual(expected);
  });

  it("@req:MENU-10 @oracle:requirement the /effort slider keeps its chips and draws no rows", async () => {
    const user = userEvent.setup();
    const { onAction, container } = renderCard(capture("claude--menu-effort-slider--w132.txt"));
    const chips = screen.getAllByRole("button").filter((b) => /^(low|medium|high|xhigh|max|ultracode)$/.test(b.textContent ?? ""));
    expect(chips.map((b) => b.textContent)).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"]);
    // The card reads the body, so the mirror stays off, and with it any option row.
    expect(container.querySelector("pre")).toBeNull();
    const current = chips.findIndex(isMarkedCurrent);
    expect(current).toBeGreaterThanOrEqual(0);
    const target = current === 0 ? 1 : 0;
    await user.click(chips[target]!);
    const key = target > current ? "Right" : "Left";
    expect(onAction.mock.calls).toEqual([
      [{ keys: Array.from({ length: Math.abs(target - current) }, () => key), nav: true }],
    ]);
  });
});
