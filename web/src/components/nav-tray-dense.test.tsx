import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NavTrayDense } from "./nav-tray-dense";

describe("NavTrayDense", () => {
  // ── Immediate path (nothing armed / empty queue): a key press fires at once ──

  it("sends the bare key for arrows, Space, Enter and Esc", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

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

  it("digits sit on the grid (no 123 tab) and fire as ['1']..['9','0']", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    // No toggle anymore — digits are rows of the same grid.
    expect(screen.queryByRole("button", { name: "123" })).toBeNull();
    for (const d of ["1", "5", "9", "0"]) {
      await user.click(screen.getByRole("button", { name: d }));
    }
    expect(onSend.mock.calls).toEqual([[["1"]], [["5"]], [["9"]], [["0"]]]);
  });

  it("two lanes: terminal left, numpad+F right, F-keys in one lane", () => {
    render(<NavTrayDense onSend={vi.fn()} />);
    const left = document.querySelector('[data-slot="key-lane-left"]');
    const right = document.querySelector('[data-slot="key-lane-right"]');
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();

    // Control lives left, digits and F-keys right — never the reverse.
    expect(within(left as HTMLElement).getByRole("button", { name: "Esc" })).toBeInTheDocument();
    expect(within(right as HTMLElement).queryByRole("button", { name: "Esc" })).toBeNull();
    for (const k of ["F1", "F7", "F12"]) {
      expect(within(right as HTMLElement).getByRole("button", { name: k })).toBeInTheDocument();
      expect(within(left as HTMLElement).queryByRole("button", { name: k })).toBeNull();
    }

    // The numpad reads 7-8-9 on top with 0 above the dot, like hardware.
    const order = ["7", "8", "9", "/", "4", "1", "0", "."].map((n) =>
      within(right as HTMLElement).getByRole("button", { name: n }),
    );
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    }
  });

  it("a quick Ctrl+C button sits by Esc and fires ctrl+c immediately", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    const ctrlC = screen.getByRole("button", { name: "Ctrl+C" });
    // Dense glyph label, same spelling as the Ctrl C preset it duplicates — not tmux's.
    expect(ctrlC).toHaveTextContent("⌃C");

    await user.click(ctrlC);
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+c"]);
  });

  it("does not fire anything when disabled", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} disabled />);

    await user.click(screen.getByRole("button", { name: "Up" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  // ── Compose path: arm a modifier → keys STAGE into a visible queue → explicit Send fires once ──

  it("arm Ctrl, tap Tab: stages ctrl+Tab (nothing sent), Send fires it once", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Tab" }));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove ⌃Tab" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    // Casing mirrors the shift path: base verbatim → "ctrl+Tab" (Herdr keys are case-insensitive).
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+Tab"]);

    // Back to idle: a bare key fires immediately again.
    await user.click(screen.getByRole("button", { name: "Tab" }));
    expect(onSend).toHaveBeenLastCalledWith(["Tab"]);
  });

  it("sticky Shift stages shift+Enter, disarms, and Send fires the same wire string", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    const shiftBtn = screen.getByRole("button", { name: /Shift/ });
    expect(shiftBtn).toHaveAttribute("aria-pressed", "false");

    await user.click(shiftBtn); // once
    expect(shiftBtn).toHaveAttribute("aria-pressed", "true");

    // Pressing a key while armed STAGES it (nothing sent yet) and spends the one-shot Shift.
    await user.click(screen.getByRole("button", { name: /Enter/ }));
    expect(onSend).not.toHaveBeenCalled();
    expect(shiftBtn).toHaveAttribute("aria-pressed", "false");
    // Dense glyphs: shift+Enter reads "⇧⏎".
    expect(screen.getByRole("button", { name: "Remove ⇧⏎" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["shift+Enter"]);
  });

  it("a sticky ⇧ stages a shifted digit tapped on the same grid", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: /Shift/ }));
    await user.click(screen.getByRole("button", { name: "7" }));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove ⇧7" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["shift+7"]);
  });

  it("arm Ctrl, type a char in the key input: stages ctrl+<char>, Send fires it", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    const keyInput = screen.getByRole("textbox", { name: "Type a key to combine" });
    fireEvent.change(keyInput, { target: { value: "g" } });

    expect(screen.getByRole("button", { name: "Remove ⌃G" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+g"]);
  });

  it("builds a multi-key sequence — once composing, taps append (not fire); Send sends all in order", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

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
    render(<NavTrayDense onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Tab" }));
    await user.click(screen.getByRole("button", { name: "Down" }));

    await user.click(screen.getByRole("button", { name: "Remove ⌃Tab" }));
    expect(screen.queryByRole("button", { name: "Remove ⌃Tab" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove Down" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear queued keys" }));
    expect(screen.queryByRole("button", { name: "Remove Down" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull(); // strip gone → not composing
    expect(onSend).not.toHaveBeenCalled();
  });

  it("reports the staged count through onQueueChange, and 0 on unmount", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onQueueChange = vi.fn();
    const { unmount } = render(<NavTrayDense onSend={onSend} onQueueChange={onQueueChange} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Tab" }));
    expect(onQueueChange).toHaveBeenCalledWith(1);

    await user.click(screen.getByRole("button", { name: "Down" }));
    expect(onQueueChange).toHaveBeenCalledWith(2);

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onQueueChange).toHaveBeenLastCalledWith(0);

    onQueueChange.mockClear();
    unmount();
    expect(onQueueChange).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("a chord the multiplexer refuses renders disabled instead of sending", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} unsupportedKeys={["Down"]} />);

    const down = screen.getByRole("button", { name: "Down" });
    expect(down).toBeDisabled();
    await user.click(down);
    expect(onSend).not.toHaveBeenCalled();

    // Everything else still works — the refusal greys one key, not the pad.
    await user.click(screen.getByRole("button", { name: "Up" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["Up"]);
  });

  // ── Combinable + lockable modifiers ──

  it("tapping a modifier cycles off → once → locked → off (aria-pressed + Lock glyph)", async () => {
    const user = userEvent.setup();
    render(<NavTrayDense onSend={vi.fn()} />);

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

  it("modifiers are checkboxes: arming Ctrl then Shift leaves BOTH armed and combines into one chord", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    const shiftBtn = screen.getByRole("button", { name: /Shift/ });
    const ctrlBtn = screen.getByRole("button", { name: "Ctrl" });

    await user.click(ctrlBtn);
    await user.click(shiftBtn);
    // Both stay armed (not radio) — that's the combine.
    expect(ctrlBtn).toHaveAttribute("aria-pressed", "true");
    expect(shiftBtn).toHaveAttribute("aria-pressed", "true");

    // Ghost chip previews the combined chord in canonical order, dense glyphs.
    expect(screen.getByText("⌃⇧ + …")).toBeInTheDocument();

    // Type the base — composes ctrl+shift+p regardless of tap order.
    const keyInput = screen.getByRole("textbox", { name: "Type a key to combine" });
    fireEvent.change(keyInput, { target: { value: "p" } });
    expect(screen.getByRole("button", { name: "Remove ⌃⇧P" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+shift+p"]);
  });

  it("a locked modifier survives Send — the same chord re-stages without re-arming", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

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
    expect(screen.getByRole("button", { name: "Remove ⌃Tab" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenLastCalledWith(["ctrl+Tab"]);
    expect(onSend).toHaveBeenCalledTimes(2); // locked chord sent twice, no re-arm between
  });

  // ── Ctrl presets: immediate two-tap when idle; plain stage when composing ──

  it("sends a non-danger Ctrl preset on a single tap when not composing (after expanding Presets)", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    // Presets are hidden until the section is expanded.
    expect(screen.queryByRole("button", { name: "Ctrl C" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Presets" }));

    await user.click(screen.getByRole("button", { name: "Ctrl C" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+c"]);
  });

  it("preset Ctrl D (not composing) keeps the two-tap confirm and then fires immediately", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

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

  it("while composing, a danger preset tap just stages (no two-tap) and Send still sends", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" })); // arm → composing
    await user.click(screen.getByRole("button", { name: "Presets" }));
    await user.click(screen.getByRole("button", { name: "Ctrl D" }));

    // No two-tap confirm on the queued path — the chord is staged directly.
    expect(screen.queryByRole("button", { name: "Confirm?" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove ⌃D" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+d"]);
  });

  // ── Function keys: on the grid, same fire/stage path as base keys ──

  it("F keys sit on the grid, no disclosure; F7/F12 fire as bare keys", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    // Always visible now — the dense grid has room for all twelve, so the disclosure is gone.
    expect(screen.queryByRole("button", { name: "F keys" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "F7" }));
    await user.click(screen.getByRole("button", { name: "F12" }));
    expect(onSend.mock.calls).toEqual([[["F7"]], [["F12"]]]);
  });

  it("an armed modifier composes with an F key — Ctrl + F7 stages ctrl+F7 for review", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Ctrl" })); // arm → composing
    await user.click(screen.getByRole("button", { name: "F7" }));

    expect(onSend).not.toHaveBeenCalled(); // staged, not fired
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+F7"]);
  });

  // ── Quick combos: the agent-CLI chords on the grid ──

  it("quick combos: safe chords fire on one tap, ^D keeps its danger two-tap", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    render(<NavTrayDense onSend={onSend} />);

    // The agent-CLI combo row: safe chords fire on one tap ...
    await user.click(screen.getByRole("button", { name: "Ctrl+U" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+u"]);

    // ... while ^D keeps its danger two-tap (at an empty prompt it exits the agent).
    await user.click(screen.getByRole("button", { name: "Ctrl+D" }));
    expect(onSend).toHaveBeenCalledTimes(1); // first tap arms the confirm, sends nothing
    await user.click(screen.getByRole("button", { name: "Ctrl+D" }));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]).toEqual([["ctrl+d"]]);
  });

  it("symbols and Backspace sit on the grid and fire through the same path", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn(async () => true);
    render(<NavTrayDense onSend={onSend} />);

    await user.click(screen.getByRole("button", { name: "Backspace" }));
    await user.click(screen.getByRole("button", { name: "|" }));
    expect(onSend.mock.calls).toEqual([[["Backspace"]], [["|"]]]);
  });

  // ── Operator preset rows (`keys.toml`): they REPLACE the shipped presets on a pane they
  // address, and ride the ordinary preset path, so nothing about the two-tap, the staging or the
  // batching is special-cased for them. ──

  it("shows the operator's rows INSTEAD of the shipped presets", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} presets={[{ label: "Interrupt", keys: ["ctrl+c"] }]} />);
    await user.click(screen.getByRole("button", { name: "Presets" }));

    expect(screen.queryByRole("button", { name: "Ctrl U" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+c"]);
  });

  it("a danger operator row needs the same two taps a shipped danger preset does", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <NavTrayDense onSend={onSend} presets={[{ label: "Quit", keys: ["ctrl+d"], danger: true }]} />,
    );
    await user.click(screen.getByRole("button", { name: "Presets" }));

    await user.click(screen.getByRole("button", { name: "Quit" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm?" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["ctrl+d"]);
  });

  it("a multi-chord operator row goes out as ONE ordered batch", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} presets={[{ label: "Yes", keys: ["Down", "Enter"] }]} />);
    await user.click(screen.getByRole("button", { name: "Presets" }));

    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["Down", "Enter"]);
  });

  it("an armed modifier stages an operator row instead of firing it", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<NavTrayDense onSend={onSend} presets={[{ label: "Yes", keys: ["Down", "Enter"] }]} />);
    await user.click(screen.getByRole("button", { name: "Presets" }));

    await user.click(screen.getByRole("button", { name: /Shift/ }));
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(onSend).not.toHaveBeenCalled();
    // Every chord of the row is composed with the armed modifier, in order.
    expect(screen.getByRole("button", { name: "Remove ⇧Down" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove ⇧⏎" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(["shift+Down", "shift+Enter"]);
  });
});

// ── Hold-to-repeat on the arrows: a lost pointerup is a phone holding ↓ inside a real terminal,
//    and two concurrent send_keys calls have UNGUARANTEED ordering, so the pump keeps exactly one
//    in flight and batches the rest. ─────────────────────────────────────────────────────────────

describe("NavTrayDense — hold to repeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const HOLD_DELAY = 350;
  const REPEAT = 90;

  /** Total keys delivered across every call, and the per-call arrays. */
  function delivered(onSend: ReturnType<typeof vi.fn>) {
    const calls = onSend.mock.calls.map((c) => c[0] as string[]);
    return { calls, total: calls.reduce((n, a) => n + a.length, 0) };
  }

  it("a short tap sends exactly one key — the tap path is untouched", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTrayDense onSend={onSend} />);
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
    render(<NavTrayDense onSend={onSend} />);
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

  it("stops on release — no keys keep arriving after the hold ends", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTrayDense onSend={onSend} />);
    const down = screen.getByRole("button", { name: /Down/ });

    fireEvent.pointerDown(down);
    await vi.advanceTimersByTimeAsync(HOLD_DELAY + REPEAT * 3);
    fireEvent.pointerUp(down);
    await vi.advanceTimersByTimeAsync(50);
    const settled = delivered(onSend).total;

    await vi.advanceTimersByTimeAsync(2000); // long past any ticker
    expect(delivered(onSend).total).toBe(settled);
  });

  it("only arrows repeat — Enter, Esc and Space are whitelisted OUT", async () => {
    const onSend = vi.fn(async () => true);
    render(<NavTrayDense onSend={onSend} />);

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
    render(<NavTrayDense onSend={onSend} />);

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
});
