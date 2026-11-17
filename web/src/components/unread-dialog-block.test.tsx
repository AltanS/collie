import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { buildBlocks } from "@/lib/harness";
import { ARM_DWELL_MS, ARM_MS } from "@/lib/arm";
import { __resetReport, openReport, unreadDialogReport, useReportTarget } from "@/lib/report/store";
import type { ComponentProps } from "react";
import { DEFAULT_BOARD, setCell } from "@/lib/key-board";
import { resetKeyBoard, setKeyBoard } from "@/lib/key-board-store";
import { CardDock } from "./card-dock";
import { UnreadDialogBlock } from "./unread-dialog-block";

// The unread-dialog card (.adr/0053). Driven off a real capture through the real pipeline, so what
// it renders is exactly what the post-pass produces.

const SCREEN = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "panes", "claude-lab--menu-status-screen--w82.txt"),
  "utf8",
);

function cardBlock() {
  const block = buildBlocks(splitLines(parseAnsi(SCREEN)), { agent: "claude" }).find(
    (b) => b.kind === "unread-dialog",
  );
  if (!block || block.kind !== "unread-dialog") throw new Error("the fixture produced no card");
  return block;
}

function renderCard(onAction = vi.fn(), disabled = false) {
  const block = cardBlock();
  const { container } = render(
    <UnreadDialogBlock
      cancel={block.cancel}
      lines={block.lines}
      onAction={onAction}
      disabled={disabled}
    />,
  );
  return { onAction, container, block };
}

describe("UnreadDialogBlock", () => {
  it("renders the caption and exactly two controls: the declared key and Put away", () => {
    renderCard();
    expect(screen.getByText("Collie cannot read this screen. You can.")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    // The key, named the way the Keys keypad names it — and NEVER a verb: on Muse this key steps
    // back rather than dismisses, so a label promising "cancel" would be a lie on a real harness.
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    // ADR 0056, counsel fix: this card shows its mirror by default, so the control's job is
    // putting the key control away, never a claimed swap — "Put away" / its aria-label.
    expect(
      screen.getByRole("button", { name: "Hide this card's buttons, keep the terminal" }),
    ).toBeInTheDocument();
  });

  it("mirrors the whole screen under the control by default, so nothing is hidden", () => {
    const { container, block } = renderCard();
    const pre = container.querySelector("pre")!;
    for (const line of block.lines.slice(0, 5)) {
      const text = line.segments.map((s) => s.text).join("").trim();
      if (text !== "") expect(pre.textContent).toContain(text);
    }
  });

  // ADR 0056, counsel fix: the control puts the key control away for a decluttered, mirror-only
  // view, and "Show the buttons" restores it. The rows themselves stay on screen throughout (same
  // `lines`, same RawMirror) — this card never claims a swap.
  it("declutters to the mirror alone when Put away is tapped, and restores on Show the buttons", async () => {
    const user = userEvent.setup();
    const { container, block } = renderCard();

    await user.click(
      screen.getByRole("button", { name: "Hide this card's buttons, keep the terminal" }),
    );

    expect(screen.queryByRole("button", { name: "Esc" })).toBeNull();
    const pre = container.querySelector("pre")!;
    for (const line of block.lines.slice(0, 5)) {
      const text = line.segments.map((s) => s.text).join("").trim();
      if (text !== "") expect(pre.textContent).toContain(text);
    }
    expect(screen.getByRole("button", { name: "Show the buttons" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show the buttons" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
  });

  // #372: the pane was drawn at the desk's width, so the device's Wrap lines decides whether the
  // card's mirror wraps or pans, in both views, as it does for the pane mirror.
  it("wraps or pans its mirror by the device's Wrap lines, before and after Put away", async () => {
    const user = userEvent.setup();
    const block = cardBlock();
    const props = { cancel: block.cancel, lines: block.lines, onAction: vi.fn() };
    const { container, rerender } = render(<UnreadDialogBlock {...props} wrap />);
    expect(container.querySelector("pre")!.className).toContain("whitespace-pre-wrap");

    await user.click(
      screen.getByRole("button", { name: "Hide this card's buttons, keep the terminal" }),
    );
    expect(container.querySelector("pre")!.className).toContain("whitespace-pre-wrap");

    rerender(<UnreadDialogBlock {...props} wrap={false} />);
    expect(container.querySelector("pre")!.className).toContain("overflow-x-auto");
    expect(container.querySelector("pre")!.className).not.toContain("whitespace-pre-wrap");
  });

  // #667: the dialog is the LAST rows of the pane, so the mirror opens at its bottom, not at the old
  // tool output on top. jsdom has no layout, so the two properties are stubbed on the prototype.
  it("scrolls its mirror to the bottom on mount and when the rows change", () => {
    const sets: number[] = [];
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1234);
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (v: number) => void sets.push(v),
    });
    try {
      const block = cardBlock();
      const props = { cancel: block.cancel, onAction: vi.fn() };
      const { container, rerender } = render(<UnreadDialogBlock {...props} lines={block.lines} />);
      expect(container.querySelector("pre")!.className).toContain("overflow-y-auto");
      expect(sets).toEqual([1234]);
      // Equal rows in a new array do not yank the person who scrolled up to read.
      rerender(<UnreadDialogBlock {...props} lines={[...block.lines]} />);
      expect(sets).toEqual([1234]);
      rerender(<UnreadDialogBlock {...props} lines={block.lines.slice(1)} />);
      expect(sets).toEqual([1234, 1234]);
    } finally {
      vi.restoreAllMocks();
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
    }
  });

  // #339: the first tap arms, the second sends. An Escape over a screen nobody read can end a
  // question turn, so one stray tap must never do it.
  it("arms on the first tap and sends nothing", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard();
    await user.click(screen.getByRole("button", { name: "Esc" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tap again to send Esc" })).toBeInTheDocument();
  });

  it("sends the declared key on the second tap, once", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard();
    await user.click(screen.getByRole("button", { name: "Esc" }));
    await user.click(screen.getByRole("button", { name: "Tap again to send Esc" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("Escape");
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
  });

  it("disarms after the timeout, so the next tap arms again", () => {
    vi.useFakeTimers();
    try {
      const { onAction } = renderCard();
      fireEvent.click(screen.getByRole("button", { name: "Esc" }));
      expect(screen.getByRole("button", { name: "Tap again to send Esc" })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(ARM_MS + 1);
      });
      expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Esc" }));
      expect(onAction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarms when the card is disabled", () => {
    const block = cardBlock();
    const props = { cancel: block.cancel, lines: block.lines, onAction: vi.fn() };
    const { rerender } = render(<UnreadDialogBlock {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    rerender(<UnreadDialogBlock {...props} disabled />);
    rerender(<UnreadDialogBlock {...props} />);
    expect(screen.getByRole("button", { name: "Esc" })).toBeInTheDocument();
  });

  it("says Dismiss on a screen whose footer prints `esc dismiss` (opencode question)", async () => {
    const user = userEvent.setup();
    const text = readFileSync(
      join(import.meta.dirname, "..", "fixtures", "panes", "oc--question--tall14.txt"),
      "utf8",
    );
    const block = buildBlocks(splitLines(parseAnsi(text)), { agent: "opencode" }).find(
      (b) => b.kind === "unread-dialog",
    );
    if (!block || block.kind !== "unread-dialog") throw new Error("no card");
    const onAction = vi.fn();
    render(<UnreadDialogBlock cancel={block.cancel} lines={block.lines} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: "Esc" }));
    expect(onAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Tap again to dismiss" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("Escape");
  });

  it("keeps the arm while the rows change, because the arm belongs to the pane and the key, not the rows (the M102 review 2)", () => {
    const block = cardBlock();
    const onAction = vi.fn();
    const props = { cancel: block.cancel, onAction, paneId: "w1:p1" };
    const { rerender } = render(<UnreadDialogBlock {...props} lines={block.lines} />);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    rerender(<UnreadDialogBlock {...props} lines={block.lines.slice(1)} />);
    fireEvent.click(screen.getByRole("button", { name: "Tap again to send Esc" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("Escape");
  });

  it("resets the arm when the pane changes, so a tap on the other pane's card only arms", () => {
    const block = cardBlock();
    const onAction = vi.fn();
    const props = { cancel: block.cancel, onAction, lines: block.lines };
    const { rerender } = render(<UnreadDialogBlock {...props} paneId="w1:p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    rerender(<UnreadDialogBlock {...props} paneId="w1:p2" />);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tap again to send Esc" })).toBeInTheDocument();
  });

  it("resets the arm when the declared key changes", () => {
    const block = cardBlock();
    const onAction = vi.fn();
    const { rerender } = render(
      <UnreadDialogBlock cancel={block.cancel} lines={block.lines} onAction={onAction} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    rerender(
      <UnreadDialogBlock
        cancel={{ ...block.cancel, key: "Enter" }}
        lines={block.lines}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0]!);
    expect(screen.getAllByRole("button")[0]).not.toHaveTextContent("Tap again");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keeps the arm when a refresh brings the same rows", () => {
    const block = cardBlock();
    const onAction = vi.fn();
    const { rerender } = render(
      <UnreadDialogBlock cancel={block.cancel} lines={block.lines} onAction={onAction} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    rerender(
      <UnreadDialogBlock cancel={{ ...block.cancel }} lines={[...block.lines]} onAction={onAction} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Tap again to send Esc" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("Escape");
  });

  it("uses the key wording, not Dismiss, when no row prints `esc dismiss`", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(screen.getByRole("button", { name: "Tap again to send Esc" })).toBeInTheDocument();
    expect(screen.queryByText("Tap again to dismiss")).toBeNull();
  });

  it("announces the armed wording in a status region", () => {
    renderCard();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(screen.getByRole("status")).toHaveTextContent("Tap again to send Esc");
  });

  it("presses nothing while disabled", async () => {
    const user = userEvent.setup();
    const { onAction } = renderCard(vi.fn(), true);
    await user.click(screen.getByRole("button", { name: "Esc" }));
    await user.click(screen.getByRole("button", { name: "Esc" }));
    expect(onAction).not.toHaveBeenCalled();
  });

  // DESIGN.md §2: a state may repaint, it may not re-lay-out. The in-flight state recolours the
  // button and nothing else — same text, same children, same reserved border — so the card the
  // operator is reading does not shift under the tap.
  it("does not move content when the tap goes in flight", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => (release = resolve));
    const { container } = renderCard(vi.fn().mockReturnValue(pending));
    const button = screen.getByRole("button", { name: "Esc" });

    const before = {
      text: container.textContent,
      children: button.childNodes.length,
      classes: button.className.split(" ").filter((c) => c.startsWith("min-h") || c === "border")
        .length,
    };

    await user.click(button);
    await user.click(screen.getByRole("button", { name: "Tap again to send Esc" }));
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(container.textContent).toBe(before.text);
    expect(button.childNodes.length).toBe(before.children);
    // The tap floor and the reserved edge survive the state (DESIGN.md §6 and §2).
    expect(
      button.className.split(" ").filter((c) => c.startsWith("min-h") || c === "border").length,
    ).toBe(before.classes);

    release();
  });
});

describe("Report a problem on the card (ADR 0123, amendment 2026-10-28)", () => {
  afterEach(() => act(() => __resetReport()));

  /** What the one report sheet would open on, as the store holds it. */
  function TargetProbe() {
    const target = useReportTarget();
    return <output data-testid="target">{target === null ? "closed" : JSON.stringify(target)}</output>;
  }

  it("opens the report sheet with kind unread-dialog and the card's verdicts, and presses no key", async () => {
    const user = userEvent.setup();
    const blocks = buildBlocks(splitLines(parseAnsi(SCREEN)), { agent: "claude" });
    const onAction = vi.fn();
    render(
      <>
        <CardDock
          blocks={blocks}
          onUnreadDialogAction={onAction}
          onUnreadDialogReport={(cancel) => openReport(unreadDialogReport("w1:p7", undefined, cancel))}
        />
        <TargetProbe />
      </>,
    );
    expect(screen.getByTestId("target")).toHaveTextContent("closed");
    await user.click(screen.getByRole("button", { name: "Report a problem" }));
    const target = JSON.parse(screen.getByTestId("target").textContent ?? "{}");
    expect(target).toMatchObject({ paneId: "w1:p7", kind: "unread-dialog", dialog: { agent: "claude", key: "Escape" } });
    expect(target.dialog.verdicts.length).toBeGreaterThan(0);
    expect(target.dialog.verdicts[0]).toEqual({ name: "preview-select", result: "null" });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keeps the report row on a read-only card, and draws none when no handler is given", () => {
    const block = cardBlock();
    const onReport = vi.fn();
    const { rerender } = render(<UnreadDialogBlock cancel={block.cancel} lines={block.lines} onAction={vi.fn()} disabled onReport={onReport} />);
    const report = screen.getByRole("button", { name: "Report a problem" });
    expect(report).toBeEnabled();
    fireEvent.click(report);
    expect(onReport).toHaveBeenCalledTimes(1);
    rerender(<UnreadDialogBlock cancel={block.cancel} lines={block.lines} onAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
  });
});

// M102 spec 03, the picked option "Your Keys pad": the person's own pad is the key row. The card draws a
// cap only for a core key that board lacks, with the pad's face; never a digit, a letter or an answer word.
describe("unread card: your Keys pad (M102 spec 03)", () => {
  afterEach(() => resetKeyBoard());

  function mount(over: Partial<ComponentProps<typeof UnreadDialogBlock>> = {}) {
    const block = cardBlock();
    const onPadKeys = vi.fn(() => Promise.resolve(true));
    const onTypeAnyway = vi.fn();
    render(<UnreadDialogBlock cancel={block.cancel} lines={block.lines} onAction={vi.fn()} onPadKeys={onPadKeys} onTypeAnyway={onTypeAnyway} {...over} />);
    return { onPadKeys, onTypeAnyway, block };
  }
  const caps = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="unread-dialog-cap"]'));

  it("unread card: no cap while the person's board holds every core key", () => {
    mount();
    expect(caps()).toHaveLength(0);
  });

  it("unread card: a board without Esc gets one Esc cap, through the Keys pad's road, and nothing else", async () => {
    setKeyBoard(setCell(DEFAULT_BOARD, 0, null));
    const { onPadKeys } = mount();
    expect(caps().map((b) => b.getAttribute("aria-label"))).toEqual(["Esc"]);
    await userEvent.setup().click(caps()[0]!);
    expect(onPadKeys).toHaveBeenCalledWith(["Escape"]);
  });

  it("unread card: a cap is never a digit, a letter or a word that guesses what the key means", () => {
    let board = DEFAULT_BOARD;
    for (let cell = 0; cell < board.cells.length; cell++) board = setCell(board, cell, null);
    setKeyBoard(board);
    mount();
    const labels = caps().map((b) => b.getAttribute("aria-label") ?? "");
    expect(labels.toSorted()).toEqual(["Down", "Enter", "Esc", "Left", "Right", "Up"]);
    for (const label of labels) {
      expect(label).not.toMatch(/^[0-9a-z]$/iu);
      expect(label).not.toMatch(/^(Continue|Yes|No|OK)$/iu);
    }
  });

  /** A second tap counts only ARM_DWELL_MS after the arm (lib/arm.ts): wait it out, as a thumb does. */
  const pastTheDwell = () => new Promise<void>((resolve) => setTimeout(resolve, ARM_DWELL_MS));

  /** A spinner row whose timer and token count tick: the same row, a second later. */
  const spinnerRow = (seconds: number) => splitLines(parseAnsi(`\u2733 Wibbling\u2026 (${seconds}s \u00b7 \u2193 ${seconds * 10} tokens) lab clock 12:15:0${seconds}`))[0]!;

  it("unread card: a timer that ticks between the two taps keeps the Enter cap armed, so the second tap sends (the M102 review, J)", async () => {
    let board = DEFAULT_BOARD;
    for (let cell = 0; cell < board.cells.length; cell++) board = setCell(board, cell, null);
    setKeyBoard(board);
    const block = cardBlock();
    const onPadKeys = vi.fn(() => Promise.resolve(true));
    const props = { cancel: block.cancel, onAction: vi.fn(), onPadKeys, onTypeAnyway: vi.fn() };
    const { rerender } = render(<UnreadDialogBlock {...props} lines={[...block.lines, spinnerRow(4)]} />);
    const user = userEvent.setup();
    await user.click(caps().find((b) => b.getAttribute("aria-label") === "Enter")!);
    rerender(<UnreadDialogBlock {...props} lines={[...block.lines, spinnerRow(5)]} />);
    await pastTheDwell();
    await user.click(screen.getByRole("button", { name: /^Tap again to send / }));
    expect(onPadKeys).toHaveBeenCalledExactlyOnceWith(["Enter"]);
  });

  /** Rows that change every tick in ways that are not digits: a progress bar, a dot cycle, streaming text. */
  const movingRows = (tick: number) =>
    splitLines(parseAnsi([`[${"#".repeat(tick)}${" ".repeat(6 - tick)}]`, `Working${".".repeat((tick % 3) + 1)}`, "The agent writes: " + "lorem ipsum dolor sit amet".slice(0, tick * 4)].join("\n")));

  function mountMoving(paneId = "w1:p1") {
    let board = DEFAULT_BOARD;
    for (let cell = 0; cell < board.cells.length; cell++) board = setCell(board, cell, null);
    setKeyBoard(board);
    const block = cardBlock();
    const onPadKeys = vi.fn(() => Promise.resolve(true));
    const props = { cancel: block.cancel, onAction: vi.fn(), onPadKeys, onTypeAnyway: vi.fn(), paneId };
    const view = render(<UnreadDialogBlock {...props} lines={[...block.lines, ...movingRows(1)]} />);
    const tick = (n: number) => view.rerender(<UnreadDialogBlock {...props} lines={[...block.lines, ...movingRows(n)]} />);
    const enterCap = () => caps().find((b) => b.getAttribute("aria-label") === "Enter")!;
    return { onPadKeys, tick, enterCap, view, props, block };
  }

  it("unread card: rows that change every tick (a progress bar, a dot cycle, streaming text) keep the Enter cap armed for five seconds (the M102 review 2, J)", () => {
    vi.useFakeTimers();
    try {
      const { onPadKeys, tick, enterCap } = mountMoving();
      fireEvent.click(enterCap());
      expect(onPadKeys).not.toHaveBeenCalled();
      for (let n = 2; n <= 5; n++) {
        act(() => vi.advanceTimersByTime(1000));
        tick(n);
      }
      // 4 s after the first tap, with every row moved: the second tap presses Enter.
      fireEvent.click(screen.getByRole("button", { name: /^Tap again to send / }));
      expect(onPadKeys).toHaveBeenCalledExactlyOnceWith(["Enter"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unread card: after five seconds the Enter cap's arm has lapsed, and the next tap only arms again", () => {
    vi.useFakeTimers();
    try {
      const { onPadKeys, tick, enterCap } = mountMoving();
      fireEvent.click(enterCap());
      act(() => vi.advanceTimersByTime(4999));
      tick(2);
      expect(screen.getByRole("button", { name: /^Tap again to send / })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2));
      fireEvent.click(enterCap());
      expect(onPadKeys).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /^Tap again to send / })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unread card: a second tap on the Enter cap 100 ms after the first sends nothing and keeps the arm; one after 450 ms sends Enter once (the M102 review 3)", () => {
    vi.useFakeTimers();
    try {
      const { onPadKeys, enterCap } = mountMoving();
      fireEvent.click(enterCap());
      act(() => vi.advanceTimersByTime(100));
      fireEvent.click(screen.getByRole("button", { name: /^Tap again to send / }));
      expect(onPadKeys).not.toHaveBeenCalled();
      // The armed look stays: the tap inside the dwell is the same touch landing twice.
      expect(screen.getByRole("button", { name: /^Tap again to send / })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(350));
      fireEvent.click(screen.getByRole("button", { name: /^Tap again to send / }));
      expect(onPadKeys).toHaveBeenCalledExactlyOnceWith(["Enter"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unread card: a held hardware Enter key on the Enter cap repeats nothing; its first press still counts (the M102 review 3)", () => {
    const { enterCap } = mountMoving();
    expect(fireEvent.keyDown(enterCap(), { key: "Enter", repeat: true })).toBe(false);
    expect(fireEvent.keyDown(enterCap(), { key: "Enter", repeat: false })).toBe(true);
  });

  it("unread card: the Enter cap's arm belongs to its pane, so a card on another pane only arms", () => {
    const { onPadKeys, enterCap, view, props, block } = mountMoving("w1:p1");
    fireEvent.click(enterCap());
    view.rerender(<UnreadDialogBlock {...props} paneId="w1:p2" lines={[...block.lines, ...movingRows(1)]} />);
    fireEvent.click(enterCap());
    expect(onPadKeys).not.toHaveBeenCalled();
  });

  it("unread card: an Enter cap asks a second tap, as the declared key does, and the arrows do not", async () => {
    let board = DEFAULT_BOARD;
    for (let cell = 0; cell < board.cells.length; cell++) board = setCell(board, cell, null);
    setKeyBoard(board);
    const { onPadKeys } = mount();
    const user = userEvent.setup();
    await user.click(caps().find((b) => b.getAttribute("aria-label") === "Enter")!);
    expect(onPadKeys).not.toHaveBeenCalled();
    await pastTheDwell();
    await user.click(screen.getByRole("button", { name: /^Tap again to send / }));
    expect(onPadKeys).toHaveBeenCalledExactlyOnceWith(["Enter"]);
    await user.click(caps().find((b) => b.getAttribute("aria-label") === "Down")!);
    expect(onPadKeys).toHaveBeenLastCalledWith(["Down"]);
  });

  it("unread card: Send past this screen opens the composer's one send; the declared key keeps its second tap", async () => {
    const { onTypeAnyway } = mount();
    await userEvent.setup().click(screen.getByRole("button", { name: "Send anyway" }));
    expect(onTypeAnyway).toHaveBeenCalledTimes(1);
  });

  it("unread card: a screen that asks for a secret has no Send past this screen, and points at Type mode", () => {
    mount({ secret: true });
    expect(screen.queryByRole("button", { name: "Send anyway" })).toBeNull();
    expect(screen.getByText(/asks for a secret\. Use Type/u)).toBeInTheDocument();
  });

  it("unread card: opened by a refusal, with no declared key, it still has the screen and Send past this screen", () => {
    const block = cardBlock();
    render(<UnreadDialogBlock cancel={null} lines={block.lines} onAction={vi.fn()} onTypeAnyway={vi.fn()} />);
    expect(screen.getByText("Collie cannot read this screen. You can.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send anyway" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Esc" })).toBeNull();
  });
});
