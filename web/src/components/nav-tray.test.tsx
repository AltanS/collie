import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NavTray } from "./nav-tray";
import { addRow, boardOf, chordKey, DEFAULT_BOARD, setCell } from "@/lib/key-board";

describe("NavTray", () => {
  // ── Immediate path (nothing armed / empty queue): unchanged from before the key-queue refactor ──

  it("sends the bare key for arrows, Space and Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Up" }));
    await user.click(screen.getByRole("button", { name: "Left" }));
    await user.click(screen.getByRole("button", { name: "Space" }));
    await user.click(screen.getByRole("button", { name: "Enter" }));
    await user.click(screen.getByRole("button", { name: "Esc" }));

    expect(onSend.mock.calls).toEqual([
      [["Up"]],
      [["Left"]],
      [["Space"]],
      [["Enter"]],
      [["Escape"]],
    ]);
  });

  it("digits live behind the 123 chip (closed by default) and fire as ['1']..['9']", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    // Closed by default — the digit panel isn't mounted yet.
    expect(screen.queryByRole("button", { name: "1" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "123" }));

    for (const d of ["1", "5", "9"]) {
      await user.click(screen.getByRole("button", { name: d }));
    }
    expect(onSend.mock.calls).toEqual([[["1"]], [["5"]], [["9"]]]);
  });

  it("the Default board is today's pad: Esc/Tab/modifiers/Up/^C over Space/Enter/arrows, Enter away from the arrows", () => {
    render(<NavTray onSend={vi.fn()} />);

    const esc = screen.getByRole("button", { name: "Esc" });
    const tab = screen.getByRole("button", { name: "Tab" });
    const shift = screen.getByRole("button", { name: "Shift" });
    const ctrl = screen.getByRole("button", { name: "Ctrl" });
    const alt = screen.getByRole("button", { name: "Alt" });
    const up = screen.getByRole("button", { name: "Up" });
    const ctrlC = screen.getByRole("button", { name: "Ctrl+C" });
    const space = screen.getByRole("button", { name: "Space" });
    const left = screen.getByRole("button", { name: "Left" });
    const down = screen.getByRole("button", { name: "Down" });
    const right = screen.getByRole("button", { name: "Right" });
    const enter = screen.getByRole("button", { name: "Enter" });

    // a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING !== 0 means a comes before b.
    const isBefore = (a: HTMLElement, b: HTMLElement) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    // Row 1, in order: Esc, Tab, Shift, Ctrl, Alt, Up, the quick Ctrl+C.
    expect(isBefore(esc, tab)).toBe(true);
    expect(isBefore(tab, shift)).toBe(true);
    expect(isBefore(shift, ctrl)).toBe(true);
    expect(isBefore(ctrl, alt)).toBe(true);
    expect(isBefore(alt, up)).toBe(true);
    expect(isBefore(up, ctrlC)).toBe(true);

    // Row 2: Enter, a Space three cells wide, then the inverted-T's Left, Down, Right.
    expect(isBefore(ctrlC, enter)).toBe(true);
    expect(isBefore(enter, space)).toBe(true);
    expect(isBefore(space, left)).toBe(true);
    expect(isBefore(left, down)).toBe(true);
    expect(isBefore(down, right)).toBe(true);

    // Every key is placed on a 7-column grid by CSS: its corner, and how far it spans. Enter stays
    // away from the arrows (issue #263): the wide Space stands between it and Left.
    const grid = esc.parentElement!;
    expect(grid).toHaveClass("grid-cols-7");
    const place = (el: HTMLElement) => [el.style.gridColumn, el.style.gridRow];
    expect(place(esc)).toEqual(["1 / span 1", "1 / span 1"]);
    expect(place(ctrlC)).toEqual(["7 / span 1", "1 / span 1"]);
    expect(place(enter)).toEqual(["1 / span 1", "2 / span 1"]);
    expect(place(space)).toEqual(["2 / span 3", "2 / span 1"]);
    expect(place(left)).toEqual(["5 / span 1", "2 / span 1"]);
    expect(place(down)[0]).toBe(place(up)[0]);
    // Nothing else is in the grid: no spacer cells to shift anything.
    expect(grid.children).toHaveLength(12);

    // Enter carries a low-opacity tint of the primary colour at rest — the commit-key read.
    expect(enter).toHaveClass("bg-primary/15");
    expect(enter).toHaveClass("border-primary/40");
  });

  // jsdom lays out nothing, so the row heights can only be pinned by the style that produces them.
  it("the grid pins explicit 36px rows, one per used row, and hides trailing empty rows", () => {
    const { rerender } = render(<NavTray onSend={vi.fn()} />);
    const grid = () => screen.getByRole("button", { name: "Esc" }).parentElement!;
    expect(grid().style.gridTemplateRows).toBe("repeat(2, 36px)");

    // A third row that holds nothing is not drawn.
    const spare = addRow(DEFAULT_BOARD);
    rerender(<NavTray onSend={vi.fn()} board={spare} />);
    expect(grid().style.gridTemplateRows).toBe("repeat(2, 36px)");
    expect(grid().children).toHaveLength(12);
  });

  it("a key two rows tall stretches over both, and a key it covers draws nothing", () => {
    const tallEnter = boardOf(2, [
      [0, { kind: "chord", steps: ["Escape"] }],
      [1, { kind: "chord", steps: ["Enter"], h: 2 }],
      [2, { kind: "mod", mod: "ctrl", w: 2 }],
    ]);
    render(<NavTray onSend={vi.fn()} board={tallEnter} />);
    const enter = screen.getByRole("button", { name: "Enter" });
    expect(enter.style.gridRow).toBe("1 / span 2");
    expect(enter).toHaveClass("h-auto", "self-stretch");
    expect(enter.parentElement).toHaveClass("grid-cols-7");
    const ctrl = screen.getByRole("button", { name: "Ctrl" });
    expect(ctrl.style.gridColumn).toBe("3 / span 2");
    expect(screen.getByRole("button", { name: "Esc" })).not.toHaveClass("self-stretch");
  });

  it("the quick Ctrl+C key shows ^C (fits its 1/7 column) but keeps its chord and accessible name", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    const ctrlC = screen.getByRole("button", { name: "Ctrl+C" }); // aria-label unchanged
    expect(ctrlC).toHaveTextContent("^C");
    expect(ctrlC).toHaveAttribute("aria-label", "Ctrl+C");

    await user.click(ctrlC);
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+c"]);
  });

  it("no pad key can overflow its column — every key gets min-w-0 and overflow-hidden", () => {
    render(<NavTray onSend={vi.fn()} />);
    for (const name of ["Esc", "Tab", "Up", "Ctrl+C", "Space", "Left", "Down", "Right", "Enter"]) {
      const btn = screen.getByRole("button", { name });
      expect(btn).toHaveClass("min-w-0");
      expect(btn).toHaveClass("overflow-hidden");
    }
  });

  it("every icon key (Space, Shift, Tab, Enter, and the arrows) keeps its aria-label", () => {
    render(<NavTray onSend={vi.fn()} />);

    for (const name of ["Space", "Shift", "Tab", "Enter", "Up", "Down", "Left", "Right"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-label", name);
    }
  });

  it("a quick Ctrl+C closes row 1 and fires ctrl+c immediately", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    const ctrlC = screen.getByRole("button", { name: "Ctrl+C" });
    // The visible label is "^C" — "Ctrl C" is wider than a 1/7 column on a 390px phone — but the
    // chord it sends and its accessible name ("Ctrl+C", asserted via `getByRole` above) don't move.
    expect(ctrlC).toHaveTextContent("^C");
    expect(ctrlC).not.toHaveTextContent("Ctrl C");

    await user.click(ctrlC);
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+c"]);
  });

  it("the accordion row shows exactly the 123 / Presets / F keys chips, one panel open at a time", async () => {
    const user = userEvent.setup();
    render(<NavTray onSend={vi.fn()} />);

    const digits123 = screen.getByRole("button", { name: "123" });
    const presetsChip = screen.getByRole("button", { name: "Presets" });
    const fkeysChip = screen.getByRole("button", { name: "F keys" });
    expect(digits123).toHaveAttribute("aria-pressed", "false");
    expect(presetsChip).toHaveAttribute("aria-pressed", "false");
    expect(fkeysChip).toHaveAttribute("aria-pressed", "false");

    await user.click(digits123);
    expect(digits123).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument();

    // Opening Presets closes 123 — only one panel open at a time.
    await user.click(presetsChip);
    expect(digits123).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "1" })).toBeNull();
    expect(presetsChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Ctrl C" })).toBeInTheDocument();

    // Switching straight to F keys closes Presets in the same tap.
    await user.click(fkeysChip);
    expect(presetsChip).toHaveAttribute("aria-pressed", "false");
    expect(fkeysChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "F1" })).toBeInTheDocument();

    // Tapping the open chip again closes it (the accordion's own collapse).
    await user.click(fkeysChip);
    expect(fkeysChip).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "F1" })).toBeNull();
  });

  it("does not fire anything when disabled", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} disabled />);

    await user.click(screen.getByRole("button", { name: "Up" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  // ── Compose path: arm a modifier → keys STAGE into a visible queue → explicit Send fires once ──

  it("sticky Shift stages the next key as shift+<key>, disarms, and Send fires the same wire string", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    const shiftBtn = screen.getByRole("button", { name: /Shift/ });
    expect(shiftBtn).toHaveAttribute("aria-pressed", "false");

    await user.click(shiftBtn); // once
    expect(shiftBtn).toHaveAttribute("aria-pressed", "true");

    // Pressing a key while armed STAGES it (nothing sent yet) and spends the one-shot Shift.
    await user.click(screen.getByRole("button", { name: /Enter/ }));
    expect(onSend).not.toHaveBeenCalled();
    expect(shiftBtn).toHaveAttribute("aria-pressed", "false");
    // keyLabel renders Enter as "⏎", so the shift+Enter chip reads "⇧ ⏎".
    expect(screen.getByRole("button", { name: "Remove ⇧ ⏎" })).toBeInTheDocument();

    // Send fires the exact same string as before the refactor — only the WHEN changed.
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["shift+Enter"]);

    // Back to idle: a bare key fires immediately again.
    await user.click(screen.getByRole("button", { name: /Enter/ }));
    expect(onSend).toHaveBeenLastCalledWith(["Enter"]);
  });

  it("a sticky ⇧ armed on the main pad stages a shifted digit tapped on the 123 panel (queue survives opening it)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: /Shift/ }));
    await user.click(screen.getByRole("button", { name: "123" }));
    await user.click(screen.getByRole("button", { name: "7" }));

    expect(onSend).not.toHaveBeenCalled();
    // The strip lives above the accordion, so the staged chip is visible with the digit panel open.
    expect(screen.getByRole("button", { name: "Remove ⇧ 7" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["shift+7"]);
  });

  it("arm Ctrl, tap Tab: stages ctrl+Tab (nothing sent), Send fires it once", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Tab" }));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove Ctrl Tab" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    // Casing mirrors the shift path: base verbatim → "ctrl+Tab" (Herdr keys are case-insensitive).
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+Tab"]);
  });

  it("arm Ctrl, type a char in the key input: stages ctrl+<char>, Send fires it", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    const keyInput = screen.getByRole("textbox", { name: "Type a key to combine" });
    fireEvent.change(keyInput, { target: { value: "g" } });

    expect(screen.getByRole("button", { name: "Remove Ctrl G" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+g"]);
  });

  it("builds a multi-key sequence — once composing, taps append (not fire); Send sends all in order", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Down" })); // ctrl+Down (disarms)
    await user.click(screen.getByRole("button", { name: "Down" })); // queue non-empty → bare Down
    await user.click(screen.getByRole("button", { name: /Enter/ })); // bare Enter

    expect(onSend).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+Down", "Down", "Enter"]);
  });

  it("tapping a chip removes it; Clear empties the queue and exits compose mode", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Tab" }));
    await user.click(screen.getByRole("button", { name: "Down" }));

    await user.click(screen.getByRole("button", { name: "Remove Ctrl Tab" }));
    expect(screen.queryByRole("button", { name: "Remove Ctrl Tab" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove Down" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear queued keys" }));
    expect(screen.queryByRole("button", { name: "Remove Down" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull(); // strip gone → not composing
    expect(onSend).not.toHaveBeenCalled();
  });

  // ── Combinable + lockable modifiers (#19 / #20) ──

  it("the Alt modifier renders alongside Shift and Ctrl", () => {
    render(<NavTray onSend={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Shift" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ctrl" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alt" })).toBeInTheDocument();
  });

  it("tapping a modifier cycles off → once → locked → off (aria-pressed + Lock glyph)", async () => {
    const user = userEvent.setup();
    render(<NavTray onSend={vi.fn()} />);

    const alt = () => screen.getByRole("button", { name: "Alt" });
    const isLocked = () => alt().querySelector(".lucide-lock") !== null;

    // off
    expect(alt()).toHaveAttribute("aria-pressed", "false");
    expect(isLocked()).toBe(false);

    // once — armed, no lock glyph yet
    await user.click(alt());
    expect(alt()).toHaveAttribute("aria-pressed", "true");
    expect(isLocked()).toBe(false);

    // locked — armed, lock glyph shows
    await user.click(alt());
    expect(alt()).toHaveAttribute("aria-pressed", "true");
    expect(isLocked()).toBe(true);

    // off again
    await user.click(alt());
    expect(alt()).toHaveAttribute("aria-pressed", "false");
    expect(isLocked()).toBe(false);
  });

  it("modifiers are checkboxes: arming Shift then Ctrl leaves BOTH armed and combines into one chord", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    const shiftBtn = screen.getByRole("button", { name: /Shift/ });
    const ctrlBtn = screen.getByRole("button", { name: "Ctrl" });

    await user.click(ctrlBtn);
    await user.click(shiftBtn);
    // Both stay armed (not radio) — that's the combine.
    expect(ctrlBtn).toHaveAttribute("aria-pressed", "true");
    expect(shiftBtn).toHaveAttribute("aria-pressed", "true");

    // Ghost chip previews the combined chord in canonical order.
    expect(screen.getByText("Ctrl ⇧ + …")).toBeInTheDocument();

    // Type the base — composes ctrl+shift+p regardless of the shift-then… tap order.
    const keyInput = screen.getByRole("textbox", { name: "Type a key to combine" });
    fireEvent.change(keyInput, { target: { value: "p" } });
    expect(screen.getByRole("button", { name: "Remove Ctrl ⇧ P" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+shift+p"]);
  });

  it("a locked modifier survives Send — the same chord re-stages without re-arming", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    const ctrlBtn = () => screen.getByRole("button", { name: "Ctrl" });
    await user.click(ctrlBtn()); // once
    await user.click(ctrlBtn()); // locked
    expect(ctrlBtn().querySelector(".lucide-lock")).not.toBeNull();

    // Stage ctrl+Tab and send.
    await user.click(screen.getByRole("button", { name: "Tab" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenLastCalledWith(["ctrl+Tab"]);

    // Ctrl is still locked, so tapping Tab again re-stages ctrl+Tab with no re-arm.
    expect(ctrlBtn()).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Tab" }));
    expect(screen.getByRole("button", { name: "Remove Ctrl Tab" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenLastCalledWith(["ctrl+Tab"]);
    expect(onSend).toHaveBeenCalledTimes(2); // locked chord sent twice, no re-arm between
  });

  it("Clear releases a locked modifier (the one explicit escape hatch)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    const ctrlBtn = () => screen.getByRole("button", { name: "Ctrl" });
    await user.click(ctrlBtn()); // once
    await user.click(ctrlBtn()); // locked
    await user.click(screen.getByRole("button", { name: "Tab" })); // stage ctrl+Tab

    await user.click(screen.getByRole("button", { name: "Clear queued keys" }));
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull(); // not composing
    expect(ctrlBtn()).toHaveAttribute("aria-pressed", "false"); // lock released
    expect(ctrlBtn().querySelector(".lucide-lock")).toBeNull();
  });

  // ── Ctrl presets: immediate two-tap when idle; plain stage when composing ──

  it("sends a non-danger Ctrl preset on a single tap when not composing (after expanding Presets)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    // Presets are hidden until the section is expanded.
    expect(screen.queryByRole("button", { name: "Ctrl C" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Presets" }));

    await user.click(screen.getByRole("button", { name: "Ctrl C" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+c"]);
  });

  it("preset Ctrl D (not composing) keeps the two-tap confirm and then fires immediately", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Presets" }));

    // First tap arms the confirm — nothing is sent, and no queue/strip appears.
    await user.click(screen.getByRole("button", { name: "Ctrl D" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    // Second tap fires immediately.
    await user.click(screen.getByRole("button", { name: "Confirm?" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+d"]);
  });

  it("while composing, a danger preset tap just stages (no two-tap) and Send is styled destructive but still sends", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" })); // arm → composing
    await user.click(screen.getByRole("button", { name: "Presets" }));
    await user.click(screen.getByRole("button", { name: "Ctrl D" }));

    // No two-tap confirm on the queued path — the chord is staged directly.
    expect(screen.queryByRole("button", { name: "Confirm?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove Ctrl D" })).toBeInTheDocument();

    // A queued danger chord (ctrl+d) styles Send destructive — but it still sends.
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toHaveClass("bg-destructive");
    await user.click(send);
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+d"]);
  });

  // ── Function keys (#119): F1–F12 behind their own disclosure, same fire/stage path as base keys ──

  it("F keys stay behind their disclosure; expanded, F7/F12 fire as bare keys", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    // Collapsed by default — the tray's height is unchanged until you ask for F keys.
    expect(screen.queryByRole("button", { name: "F7" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "F keys" }));

    await user.click(screen.getByRole("button", { name: "F7" }));
    await user.click(screen.getByRole("button", { name: "F12" }));
    expect(onSend.mock.calls).toEqual([[["F7"]], [["F12"]]]);
  });

  it("an armed modifier composes with an F key — Ctrl + F7 stages ctrl+F7 for review", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" })); // arm → composing
    await user.click(screen.getByRole("button", { name: "F keys" }));
    await user.click(screen.getByRole("button", { name: "F7" }));

    expect(onSend).not.toHaveBeenCalled(); // staged, not fired
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+F7"]);
  });

  // ── Press echo: the tray used to be silent on success, and the mirror it deferred to can be ~2s
  //    behind, so a key press looked like it went nowhere. ────────────────────────────────────────

  it("an immediate press echoes on its own button until the send resolves", async () => {
    const user = userEvent.setup();
    let release = () => {};
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    render(<NavTray onSend={onSend} />);

    const enter = screen.getByRole("button", { name: /Enter/ });
    expect(enter).toHaveClass("border"); // outline variant at rest
    await user.click(enter);

    // Filled the instant it's tapped — synchronous, no network wait. That IS the fix.
    expect(screen.getByRole("button", { name: /Enter/ })).toHaveClass("bg-primary");

    release();
    // Settles back to the resting outline once the ✓ window elapses.
    await vi.waitFor(
      () => expect(screen.getByRole("button", { name: /Enter/ })).not.toHaveClass("bg-primary"),
      { timeout: 3000 },
    );
  });

  it("a REFUSED send leaves no ✓ — the button drops straight back to rest", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => false);
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Esc" }));

    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Esc" })).not.toHaveClass("bg-primary"),
    );
  });

  it("a STAGED press does not echo — the queue chip is already the receipt", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" })); // arm → compose mode
    await user.click(screen.getByRole("button", { name: "Tab" }));

    expect(onSend).not.toHaveBeenCalled();
    // Tab stays at rest (outline); the chip in the strip carries the feedback instead.
    expect(screen.getByRole("button", { name: "Tab" })).not.toHaveClass("bg-primary");
    expect(screen.getByRole("button", { name: /Remove Ctrl/ })).toBeInTheDocument();
  });
});

// ── Hold-to-repeat. Highest-risk feature in the tray: a lost pointerup is a phone holding ↓ inside
//    a real terminal, and two concurrent send_keys calls have UNGUARANTEED ordering (one-shot RPC),
//    so the pump must keep exactly one in flight and batch the rest. ───────────────────────────────

describe("NavTray — hold to repeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const HOLD_DELAY = 350;
  const REPEAT = 90;

  /** Total keys delivered across every call, and the per-call arrays. */
  function delivered(onSend: ReturnType<typeof vi.fn>) {
    // SAFETY: `onSend` is the tray's `(keys: string[]) => Promise<boolean>` prop, so argument 0 of
    // every recorded call is that array. Vitest types a mock's recorded arguments loosely.
    const calls = onSend.mock.calls.map((c) => c[0] as string[]);
    return { calls, total: calls.reduce((n, a) => n + a.length, 0) };
  }

  it("a short tap sends exactly one key — the tap path is untouched", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTray onSend={onSend} />);
    const down = screen.getByRole("button", { name: "Down" });

    fireEvent.pointerDown(down);
    await vi.advanceTimersByTimeAsync(HOLD_DELAY - 100); // released before repeat engages
    fireEvent.pointerUp(down);
    fireEvent.click(down);
    await vi.advanceTimersByTimeAsync(0);

    expect(delivered(onSend).total).toBe(1);
    expect(onSend).toHaveBeenCalledWith(["Down"]);
  });

  it("a hold repeats, and the release's synthesized click does NOT add an extra key", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTray onSend={onSend} />);
    const down = screen.getByRole("button", { name: /Down/ });

    fireEvent.pointerDown(down);
    await vi.advanceTimersByTimeAsync(HOLD_DELAY + REPEAT * 4);
    const held = delivered(onSend).total;
    expect(held).toBeGreaterThan(1);

    fireEvent.pointerUp(down);
    fireEvent.click(down); // the click that always follows a release
    await vi.advanceTimersByTimeAsync(50);

    // The pump may flush a trailing batch, but the click itself must contribute nothing.
    const after = delivered(onSend);
    expect(after.calls.every((a) => a.every((k) => k === "Down"))).toBe(true);
    expect(after.total).toBeGreaterThanOrEqual(held);
  });

  it("keeps ONE send in flight and batches the rest — ordering depends on it", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const onSend = vi.fn(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 300)); // a slow tailnet
      inFlight--;
      return true;
    });
    render(<NavTray onSend={onSend} />);
    const down = screen.getByRole("button", { name: /Down/ });

    fireEvent.pointerDown(down);
    await vi.advanceTimersByTimeAsync(HOLD_DELAY + REPEAT * 10);
    fireEvent.pointerUp(down);
    await vi.advanceTimersByTimeAsync(1000);

    expect(maxConcurrent).toBe(1);
    // A slow link produces BIGGER batches, not more calls — that's what the array API is for.
    expect(delivered(onSend).calls.some((a) => a.length > 1)).toBe(true);
  });

  it("stops on release — no keys keep arriving after the hold ends", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTray onSend={onSend} />);
    const down = screen.getByRole("button", { name: /Down/ });

    fireEvent.pointerDown(down);
    await vi.advanceTimersByTimeAsync(HOLD_DELAY + REPEAT * 3);
    fireEvent.pointerUp(down);
    await vi.advanceTimersByTimeAsync(50);
    const settled = delivered(onSend).total;

    await vi.advanceTimersByTimeAsync(2000); // long past any ticker
    expect(delivered(onSend).total).toBe(settled);
  });

  it("a LOST pointerup can't run away — the dead-man ceiling releases the hold", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTray onSend={onSend} />);
    const down = screen.getByRole("button", { name: /Down/ });

    fireEvent.pointerDown(down); // ...and no pointerup ever arrives
    await vi.advanceTimersByTimeAsync(10_000);
    const settled = delivered(onSend).total;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivered(onSend).total).toBe(settled); // capped, not still hammering
  });

  it("pointercancel releases the hold (thumb dragged off / gesture stolen)", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTray onSend={onSend} />);
    const down = screen.getByRole("button", { name: /Down/ });

    fireEvent.pointerDown(down);
    await vi.advanceTimersByTimeAsync(HOLD_DELAY + REPEAT * 2);
    fireEvent.pointerCancel(down);
    await vi.advanceTimersByTimeAsync(50);
    const settled = delivered(onSend).total;

    await vi.advanceTimersByTimeAsync(2000);
    expect(delivered(onSend).total).toBe(settled);
  });

  it("only arrows repeat — Enter, Esc and Space are whitelisted OUT", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTray onSend={onSend} />);

    const names: (string | RegExp)[] = [/Enter/, "Esc", "Space"];
    for (const name of names) {
      const btn = screen.getByRole("button", { name });
      fireEvent.pointerDown(btn);
      await vi.advanceTimersByTimeAsync(HOLD_DELAY + REPEAT * 5);
      fireEvent.pointerUp(btn);
      await vi.advanceTimersByTimeAsync(50);
    }
    // No pointer binding at all on these — nothing was sent without a click.
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a hold while COMPOSING stages one chip, not fifteen", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTray onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "Ctrl" })); // arm → compose mode
    const down = screen.getByRole("button", { name: /Down/ });
    fireEvent.pointerDown(down);
    await vi.advanceTimersByTimeAsync(HOLD_DELAY + REPEAT * 8);
    fireEvent.pointerUp(down);
    fireEvent.click(down);
    await vi.advanceTimersByTimeAsync(50);

    expect(onSend).not.toHaveBeenCalled(); // staged, not fired
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(1);
  });

  it("a refused key stops the hold instead of hammering the pane", async () => {
    const onSend = vi.fn(async () => false); // bridge says no
    render(<NavTray onSend={onSend} />);
    const down = screen.getByRole("button", { name: /Down/ });

    fireEvent.pointerDown(down);
    await vi.advanceTimersByTimeAsync(HOLD_DELAY + REPEAT * 20);
    const settled = onSend.mock.calls.length;

    await vi.advanceTimersByTimeAsync(2000);
    expect(onSend.mock.calls.length).toBe(settled);
    expect(settled).toBeLessThan(5); // stopped early, nowhere near 20 ticks
  });
});

// ── Operator presets (`keys.toml`, ADR 0018): the rows REPLACE the shipped six on a pane they
// address, and ride the ordinary preset path, so nothing about the two-tap, the staging or the
// batching is special-cased for them. ──

describe("NavTray — operator preset rows", () => {
  const openPresets = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Presets" }));
  };

  it("shows the operator's rows INSTEAD of the shipped presets", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <NavTray onSend={onSend} presets={[{ label: "Interrupt", keys: ["ctrl+c"] }]} />,
    );
    await openPresets(user);

    expect(screen.queryByRole("button", { name: "Ctrl U" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+c"]);
  });

  it("a danger row needs the same two taps a shipped danger preset does", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} presets={[{ label: "Quit", keys: ["ctrl+d"], danger: true }]} />);
    await openPresets(user);

    await user.click(screen.getByRole("button", { name: "Quit" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm?" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+d"]);
  });

  it("a multi-chord row goes out as ONE ordered batch", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} presets={[{ label: "Yes", keys: ["Down", "Enter"] }]} />);
    await openPresets(user);

    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["Down", "Enter"]);
  });

  it("an armed modifier stages the row instead of firing it", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} presets={[{ label: "Yes", keys: ["Down", "Enter"] }]} />);
    await openPresets(user);

    await user.click(screen.getByRole("button", { name: /Shift/ }));
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(onSend).not.toHaveBeenCalled();
    // Every chord of the row is composed with the armed modifier, in order.
    expect(screen.getByRole("button", { name: "Remove ⇧ Down" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove ⇧ ⏎" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["shift+Down", "shift+Enter"]);
  });

  it("a danger row while composing just stages — the Send review IS the confirm", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} presets={[{ label: "Quit", keys: ["ctrl+d"], danger: true }]} />);
    await openPresets(user);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Quit" }));
    expect(screen.queryByRole("button", { name: "Confirm?" })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });
  // ── A custom board (M48 spec 03): the same send path, whatever the cells hold ──

  const key = (...steps: string[]) => {
    const made = chordKey(steps);
    if (made === null) throw new Error(`not a key: ${steps.join(" ")}`);
    return made;
  };
  const custom = boardOf(1, [
    [0, key("ctrl+alt+shift+t")],
    [1, key("ctrl+b", "c")],
    [2, key("ctrl+d")],
    [3, key("Home")],
    [4, { kind: "mod", mod: "shift" }],
    [5, key("ctrl+c", "Enter")],
  ]);

  it("a chord key sends its whole chord through onSend, and a sequence sends its steps in order in one call", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} board={custom} />);

    await user.click(screen.getByRole("button", { name: "Ctrl+Alt+Shift+T" }));
    expect(onSend).toHaveBeenLastCalledWith(["ctrl+alt+shift+t"]);

    await user.click(screen.getByRole("button", { name: "Ctrl+B, then C" }));
    expect(onSend).toHaveBeenLastCalledWith(["ctrl+b", "c"]);
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("a key with a danger step asks a second tap, and only the second tap sends", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} board={custom} />);

    await user.click(screen.getByRole("button", { name: "Ctrl+D" }));
    expect(onSend).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: "Ctrl+D, tap again to send" });
    expect(armed).toHaveTextContent("Sure?");
    await user.click(armed);
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+d"]);

    // A sequence that holds ctrl+c is not the stock ^C: it asks too.
    onSend.mockClear();
    await user.click(screen.getByRole("button", { name: "Ctrl+C, then Enter" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  describe("a modifier key made in the editor", () => {
    // What the builder saves: a plain `{kind:"mod"}`, here two cells wide in a free spot of row 2.
    const withMod = boardOf(2, [
      [0, { kind: "mod", mod: "shift", w: 2 }],
      [2, { kind: "chord", steps: ["x"] }],
      [7, { kind: "mod", mod: "alt" }],
    ]);

    it("cycles off, once, locked like the stock ones, and opens the queue strip", async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(<NavTray onSend={onSend} board={withMod} />);
      const alt = screen.getByRole("button", { name: "Alt" });
      expect(alt).toHaveAttribute("aria-pressed", "false");
      await user.click(alt);
      expect(alt).toHaveAttribute("aria-pressed", "true");
      expect(alt.querySelector("svg")).toBeNull(); // once: no lock glyph
      await user.click(alt);
      expect(alt.querySelector("svg")).not.toBeNull(); // locked
      await user.click(alt);
      expect(alt).toHaveAttribute("aria-pressed", "false");
      expect(onSend).not.toHaveBeenCalled();
    });

    it("arms the next key: it is staged as a chord and goes out only on Send", async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      render(<NavTray onSend={onSend} board={withMod} />);
      await user.click(screen.getByRole("button", { name: "Shift" }));
      await user.click(screen.getByRole("button", { name: "Alt" }));
      await user.click(screen.getByRole("button", { name: "X" }));
      expect(onSend).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: /^Send/ }));
      expect(onSend).toHaveBeenCalledExactlyOnceWith(["alt+shift+x"]);
    });

    it("is spent after one key when set once, and kept when locked", async () => {
      const user = userEvent.setup();
      render(<NavTray onSend={vi.fn()} board={withMod} />);
      const shift = screen.getByRole("button", { name: "Shift" });
      await user.click(shift);
      await user.click(screen.getByRole("button", { name: "X" }));
      expect(shift).toHaveAttribute("aria-pressed", "false");
      await user.click(shift);
      await user.click(shift);
      await user.click(screen.getByRole("button", { name: "X" }));
      expect(shift).toHaveAttribute("aria-pressed", "true");
    });

    it("lets go of an armed modifier when its key leaves the board", async () => {
      const user = userEvent.setup();
      const onSend = vi.fn();
      const { rerender } = render(<NavTray onSend={onSend} board={withMod} />);
      await user.click(screen.getByRole("button", { name: "Alt" }));
      expect(screen.getByRole("button", { name: "Alt" })).toHaveAttribute("aria-pressed", "true");
      // Alt is removed in the editor: the armed state goes with it, so the next press fires plain.
      rerender(<NavTray onSend={onSend} board={setCell(withMod, 7, null)} />);
      expect(screen.queryByRole("button", { name: "Alt" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "X" }));
      expect(onSend).toHaveBeenCalledExactlyOnceWith(["x"]);
    });
  });

  it("the stock ^C keeps its single tap", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);
    await user.click(screen.getByRole("button", { name: "Ctrl+C" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+c"]);
  });

  it("a key the multiplexer refuses is disabled, as on the fixed pad", () => {
    render(<NavTray onSend={vi.fn()} board={custom} unsupportedKeys={["Home"]} />);
    expect(screen.getByRole("button", { name: "Home" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ctrl+B, then C" })).toBeEnabled();
  });

  it("a refused key anywhere in a sequence greys the whole key", () => {
    render(<NavTray onSend={vi.fn()} board={boardOf(1, [[0, key("ctrl+b", "End")]])} unsupportedKeys={["End"]} />);
    expect(screen.getByRole("button", { name: "Ctrl+B, then End" })).toBeDisabled();
  });

  it("a sticky modifier key still composes onto the next chord key and stages it", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} board={boardOf(1, [[0, { kind: "mod", mod: "ctrl" }], [1, key("x")]])} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "X" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove Ctrl X" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+x"]);
  });

  it("a renamed key shows its name and says what it sends", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const renamed = chordKey(["ctrl+b", "c"], "Window");
    if (renamed === null) throw new Error("bad key");
    render(<NavTray onSend={onSend} board={setCell(boardOf(1, []), 0, renamed)} />);
    const btn = screen.getByRole("button", { name: "Window, sends Ctrl+B, then C" });
    expect(btn).toHaveTextContent("Window");
    await user.click(btn);
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+b", "c"]);
  });
});
