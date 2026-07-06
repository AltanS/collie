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

  it("stages (does not fire) while composing and disarms the one-shot modifier", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("ctrl"));
    expect(result.current.mod).toBe("ctrl");
    expect(result.current.composing).toBe(true);

    let r: ReturnType<typeof result.current.press> | undefined;
    act(() => {
      r = result.current.press(["Tab"]);
    });
    expect(r).toEqual({ mode: "queued" });
    expect(result.current.queue).toEqual(["ctrl+Tab"]);
    expect(result.current.mod).toBeNull(); // one-shot consumed

    // Queue is non-empty, so a subsequent bare key appends (still composing) rather than firing.
    act(() => {
      r = result.current.press(["Down"]);
    });
    expect(r).toEqual({ mode: "queued" });
    expect(result.current.queue).toEqual(["ctrl+Tab", "Down"]);
  });

  it("arm() is radio + toggle across the two modifiers", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("shift"));
    expect(result.current.mod).toBe("shift");

    act(() => result.current.arm("ctrl")); // switches
    expect(result.current.mod).toBe("ctrl");

    act(() => result.current.arm("ctrl")); // toggles off
    expect(result.current.mod).toBeNull();
  });

  it("pushBase composes the armed mod with a normalised char and disarms", () => {
    const { result } = renderHook(() => useKeyQueue());

    act(() => result.current.arm("ctrl"));
    act(() => result.current.pushBase("G"));
    expect(result.current.queue).toEqual(["ctrl+g"]);
    expect(result.current.mod).toBeNull();

    // Non-printable input is ignored.
    act(() => result.current.arm("ctrl"));
    act(() => result.current.pushBase(" "));
    expect(result.current.queue).toEqual(["ctrl+g"]);
    expect(result.current.mod).toBe("ctrl"); // still armed — nothing was pushed
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

  it("take() returns the queue and clears composition state", () => {
    const { result } = renderHook(() => useKeyQueue());
    act(() => result.current.arm("ctrl"));
    act(() => result.current.press(["Tab"]));

    let taken: string[] = [];
    act(() => {
      taken = result.current.take();
    });
    expect(taken).toEqual(["ctrl+Tab"]);
    expect(result.current.queue).toEqual([]);
    expect(result.current.mod).toBeNull();
    expect(result.current.composing).toBe(false);
  });
});
