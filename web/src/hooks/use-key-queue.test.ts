import { renderHook, act } from "@testing-library/react";

import { useKeyQueue } from "./use-key-queue";

describe("useKeyQueue", () => {
  it("fires immediately when nothing is armed and the queue is empty", () => {
    const { result } = renderHook(() => useKeyQueue());

    let r: ReturnType<typeof result.current.press> | undefined;
    act(() => {
      r = result.current.press(["Down"]);
    });
    expect(r).toEqual({ mode: "fire", keys: ["Down"] });
    expect(result.current.queue).toEqual([]);
    expect(result.current.composing).toBe(false);
  });

  it("arm() cycles a single modifier off → once → locked → off", () => {
    const { result } = renderHook(() => useKeyQueue());

    expect(result.current.mods.ctrl).toBe("off");

    act(() => result.current.arm("ctrl"));
    expect(result.current.mods.ctrl).toBe("once");
    expect(result.current.composing).toBe(true);

    act(() => result.current.arm("ctrl"));
    expect(result.current.mods.ctrl).toBe("locked");

    act(() => result.current.arm("ctrl"));
    expect(result.current.mods.ctrl).toBe("off");
    expect(result.current.composing).toBe(false);
  });

  it("modifiers are checkboxes: arming several combines them into activeMods (canonical order)", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("shift")); // once
    act(() => result.current.arm("ctrl")); // once — shift stays armed (not radio)
    expect(result.current.mods.shift).toBe("once");
    expect(result.current.mods.ctrl).toBe("once");
    // MODIFIER_ORDER is ctrl, alt, shift regardless of the shift→ctrl tap order.
    expect(result.current.activeMods).toEqual(["ctrl", "shift"]);
  });

  it("stages a combined chord and spends the one-shot modifiers after the press", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("ctrl"));
    act(() => result.current.arm("shift"));

    let r: ReturnType<typeof result.current.press> | undefined;
    act(() => {
      r = result.current.press(["x"]);
    });
    expect(r).toEqual({ mode: "queued" });
    expect(result.current.queue).toEqual(["ctrl+shift+x"]);
    // once mods spent → back to off.
    expect(result.current.mods.ctrl).toBe("off");
    expect(result.current.mods.shift).toBe("off");
    expect(result.current.activeMods).toEqual([]);
  });

  it("a locked modifier survives a press: the same chord re-stages without re-arming", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("ctrl")); // once
    act(() => result.current.arm("ctrl")); // locked
    expect(result.current.mods.ctrl).toBe("locked");

    act(() => result.current.press(["p"]));
    expect(result.current.queue).toEqual(["ctrl+p"]);
    expect(result.current.mods.ctrl).toBe("locked"); // still armed

    act(() => result.current.press(["p"])); // no re-arm needed
    expect(result.current.queue).toEqual(["ctrl+p", "ctrl+p"]);
    expect(result.current.mods.ctrl).toBe("locked");
  });

  it("a locked modifier survives take() (Send), so you can stage the same chord again", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("ctrl")); // once
    act(() => result.current.arm("ctrl")); // locked
    act(() => result.current.press(["p"]));

    let taken: string[] = [];
    act(() => {
      taken = result.current.take();
    });
    expect(taken).toEqual(["ctrl+p"]);
    expect(result.current.queue).toEqual([]);
    expect(result.current.mods.ctrl).toBe("locked"); // lock survives Send
    expect(result.current.composing).toBe(true); // still composing — mod armed

    act(() => result.current.press(["p"]));
    expect(result.current.queue).toEqual(["ctrl+p"]);
  });

  it("take() spends a once modifier but keeps a locked one", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("ctrl")); // once
    act(() => result.current.arm("shift")); // once
    act(() => result.current.arm("shift")); // locked
    act(() => result.current.press(["x"])); // ctrl spent, shift stays locked
    expect(result.current.queue).toEqual(["ctrl+shift+x"]);
    expect(result.current.mods.ctrl).toBe("off");
    expect(result.current.mods.shift).toBe("locked");
  });

  it("clear() releases everything including locked modifiers", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("ctrl")); // once
    act(() => result.current.arm("ctrl")); // locked
    act(() => result.current.press(["p"]));
    expect(result.current.mods.ctrl).toBe("locked");

    act(() => result.current.clear());
    expect(result.current.queue).toEqual([]);
    expect(result.current.mods.ctrl).toBe("off");
    expect(result.current.composing).toBe(false);
  });

  it("stages (does not fire) while composing; a bare key after a chord still appends", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("ctrl"));
    let r: ReturnType<typeof result.current.press> | undefined;
    act(() => {
      r = result.current.press(["Tab"]);
    });
    expect(r).toEqual({ mode: "queued" });
    expect(result.current.queue).toEqual(["ctrl+Tab"]);
    expect(result.current.mods.ctrl).toBe("off"); // one-shot consumed

    // Queue is non-empty, so a subsequent bare key appends (still composing) rather than firing.
    act(() => {
      r = result.current.press(["Down"]);
    });
    expect(r).toEqual({ mode: "queued" });
    expect(result.current.queue).toEqual(["ctrl+Tab", "Down"]);
  });

  it("pushBase composes the armed mods with a normalised char and settles", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("ctrl"));
    act(() => result.current.pushBase("G"));
    expect(result.current.queue).toEqual(["ctrl+g"]);
    expect(result.current.mods.ctrl).toBe("off");

    // Non-printable input is ignored — nothing pushed, the mod stays armed.
    act(() => result.current.arm("ctrl"));
    act(() => result.current.pushBase(" "));
    expect(result.current.queue).toEqual(["ctrl+g"]);
    expect(result.current.mods.ctrl).toBe("once");
  });

  it("removeAt / clear edit the queue", () => {
    const { result } = renderHook(() => useKeyQueue());
    act(() => result.current.arm("ctrl"));
    act(() => result.current.press(["Tab"]));
    act(() => result.current.press(["Down"]));
    expect(result.current.queue).toEqual(["ctrl+Tab", "Down"]);

    act(() => result.current.removeAt(0));
    expect(result.current.queue).toEqual(["Down"]);

    act(() => result.current.clear());
    expect(result.current.queue).toEqual([]);
    expect(result.current.composing).toBe(false);
  });

  it("composing is true when any modifier is armed OR the queue is non-empty", () => {
    const { result } = renderHook(() => useKeyQueue());
    expect(result.current.composing).toBe(false);

    act(() => result.current.arm("alt")); // armed, empty queue
    expect(result.current.composing).toBe(true);

    act(() => result.current.press(["Up"])); // stages alt+Up, alt spent → queue keeps composing on
    expect(result.current.activeMods).toEqual([]);
    expect(result.current.composing).toBe(true); // queue non-empty

    act(() => result.current.take());
    expect(result.current.composing).toBe(false);
  });
});
