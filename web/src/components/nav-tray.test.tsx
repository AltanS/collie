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

    await user.click(shiftBtn);
    expect(shiftBtn).toHaveAttribute("aria-pressed", "true");

    // Pressing a key while armed STAGES it (nothing sent yet) and disarms Shift.
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

  it("arming Shift then Ctrl leaves only Ctrl armed (radio modifiers)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTray onSend={onSend} />);

    const shiftBtn = screen.getByRole("button", { name: /Shift/ });
    const ctrlBtn = screen.getByRole("button", { name: "Ctrl" });

    await user.click(shiftBtn);
    expect(shiftBtn).toHaveAttribute("aria-pressed", "true");

    await user.click(ctrlBtn);
    expect(ctrlBtn).toHaveAttribute("aria-pressed", "true");
    expect(shiftBtn).toHaveAttribute("aria-pressed", "false");
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
