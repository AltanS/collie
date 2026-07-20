import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NavTray } from "./nav-tray";

describe("NavTray", () => {
  // ── Immediate path (nothing armed / empty queue): unchanged from before the key-queue refactor ──

  it("sends the bare key for arrows, Space and Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Up" }));
    await user.click(screen.getByRole("button", { name: "Left" }));
    await user.click(screen.getByRole("button", { name: "Space" }));
    await user.click(screen.getByRole("button", { name: /Enter/ }));
    await user.click(screen.getByRole("button", { name: "Esc" }));

    expect(onSend.mock.calls).toEqual([
      [["Up"]],
      [["Left"]],
      [["Space"]],
      [["Enter"]],
      [["Escape"]],
    ]);
  });

  it("digits live on the 123 tab (hidden on Keys) and fire as ['1']..['9']", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    // Default tab is "Keys" — the digit pad isn't mounted yet.
    expect(screen.queryByRole("button", { name: "1" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "123" }));

    for (const d of ["1", "5", "9"]) {
      await user.click(screen.getByRole("button", { name: d }));
    }
    expect(onSend.mock.calls).toEqual([[["1"]], [["5"]], [["9"]]]);
  });

  it("keys tab: Esc leads row 1, Tab leads row 2 (physical-keyboard geometry)", () => {
    render(<NavTray onSend={vi.fn()} />);

    const esc = screen.getByRole("button", { name: "Esc" });
    const up = screen.getByRole("button", { name: "Up" });
    const enter = screen.getByRole("button", { name: /Enter/ });
    const tab = screen.getByRole("button", { name: "Tab" });
    const left = screen.getByRole("button", { name: "Left" });
    const down = screen.getByRole("button", { name: "Down" });
    const right = screen.getByRole("button", { name: "Right" });
    const space = screen.getByRole("button", { name: "Space" });

    // a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING !== 0 means a comes before b.
    const isBefore = (a: HTMLElement, b: HTMLElement) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    // Esc is the very first key button — top-left of row 1, before ↑ and ⏎ (row 1) and Tab (row 2).
    expect(isBefore(esc, up)).toBe(true);
    expect(isBefore(esc, enter)).toBe(true);
    expect(isBefore(esc, tab)).toBe(true);

    // Tab begins row 2 — after all of row 1, before ← ↓ → which follow it in the same row.
    expect(isBefore(enter, tab)).toBe(true);
    expect(isBefore(tab, left)).toBe(true);
    expect(isBefore(tab, down)).toBe(true);
    expect(isBefore(tab, right)).toBe(true);

    // Space sits below the two rows, on its own full-width row.
    expect(isBefore(right, space)).toBe(true);
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

  it("a sticky ⇧ armed on the Keys tab stages a shifted digit tapped on the 123 tab (queue survives the switch)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: /Shift/ }));
    await user.click(screen.getByRole("button", { name: "123" }));
    await user.click(screen.getByRole("button", { name: "7" }));

    expect(onSend).not.toHaveBeenCalled();
    // The strip lives above both tabs, so the staged chip is visible on the digit pad.
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
    expect(screen.getByRole("button", { name: "⇧ Shift" })).toBeInTheDocument();
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
});
