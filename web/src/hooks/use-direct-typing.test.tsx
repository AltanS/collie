import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearStatus } from "@/lib/status";
import { useDirectTyping } from "./use-direct-typing";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface HarnessProps {
  sendKeys: (keys: string[]) => Promise<boolean>;
  suspended?: boolean;
  agentKey?: string;
  paneKey?: string;
}

function Harness({ sendKeys, suspended = false, agentKey = "claude", paneKey = "pane-1" }: HarnessProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const direct = useDirectTyping({
    paneKey,
    inputRef,
    replyDraft: () => "",
    canActivate: () => !suspended,
    suspended,
    sendKeys,
    onActivate: () => {},
    focusInput: () => inputRef.current?.focus(),
    agentKey,
  });
  return (
    <>
      <button type="button" onClick={direct.activate}>Start typing</button>
      <button type="button" onClick={direct.deactivate}>Stop typing</button>
      <output aria-label="Typing mode">{direct.active ? "active" : "inactive"}</output>
      <textarea
        aria-label="Terminal input"
        ref={inputRef}
        value={direct.value}
        onChange={direct.onChange}
        onCompositionStart={direct.onCompositionStart}
        onCompositionEnd={direct.onCompositionEnd}
        onKeyDown={direct.onKeyDown}
      />
    </>
  );
}

const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
afterEach(() => {
  clearStatus();
  vi.useRealTimers();
  if (visibility !== undefined) Object.defineProperty(document, "visibilityState", visibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

function startTyping() {
  fireEvent.click(screen.getByRole("button", { name: "Start typing" }));
  return screen.getByRole("textbox", { name: "Terminal input" });
}

describe("useDirectTyping: disarming drops unsent keys", () => {
  it.each(["stop", "hidden", "suspended", "agent", "timeout", "pane", "unmount"] as const)(
    "%s never drains keys queued behind an in-flight batch",
    async (reason) => {
      vi.useFakeTimers();
      const first = deferred<boolean>();
      const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(true);
      const view = render(<Harness sendKeys={sendKeys} />);
      const box = startTyping();
      fireEvent.change(box, { target: { value: "a" } });
      fireEvent.change(box, { target: { value: "b" } });
      fireEvent.keyDown(box, { key: "Enter" });
      expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["a"]);

      if (reason === "stop") fireEvent.click(screen.getByRole("button", { name: "Stop typing" }));
      if (reason === "hidden") {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        fireEvent(document, new Event("visibilitychange"));
      }
      if (reason === "suspended") view.rerender(<Harness sendKeys={sendKeys} suspended />);
      if (reason === "agent") view.rerender(<Harness sendKeys={sendKeys} agentKey="shell" />);
      if (reason === "timeout") act(() => vi.advanceTimersByTime(60_000));
      if (reason === "pane") view.rerender(<Harness sendKeys={sendKeys} paneKey="pane-2" />);
      if (reason === "unmount") view.unmount();

      if (reason !== "unmount") expect(screen.getByLabelText("Typing mode")).toHaveTextContent("inactive");
      await act(async () => first.resolve(true));
      expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["a"]);
    },
  );

  it("an old failed batch cannot disarm or discard a newly armed session", async () => {
    const first = deferred<boolean>();
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.change(box, { target: { value: "old" } });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Stop typing" }));
    startTyping();
    fireEvent.change(box, { target: { value: "new" } });

    await act(async () => first.resolve(false));
    expect(sendKeys.mock.calls).toEqual([[["o", "l", "d"]], [["n", "e", "w"]]]);
    expect(screen.getByLabelText("Typing mode")).toHaveTextContent(/^active$/);
  });

  it("ignores late keyboard and composition events after disarming", () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.compositionStart(box);
    fireEvent.input(box, { target: { value: "한" }, inputType: "insertCompositionText", isComposing: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop typing" }));
    fireEvent.compositionEnd(box, { data: "한" });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.change(box, { target: { value: "late" } });
    expect(sendKeys).not.toHaveBeenCalled();
  });
});

describe("useDirectTyping: physical IME keys belong to the candidate", () => {
  it.each(["Enter", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Tab"])(
    "does not intercept %s during Korean composition",
    async (key) => {
      const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
      render(<Harness sendKeys={sendKeys} />);
      const box = startTyping();
      fireEvent.compositionStart(box);
      fireEvent.input(box, { target: { value: "한" }, inputType: "insertCompositionText", isComposing: true });
      expect(fireEvent.keyDown(box, { key, isComposing: true })).toBe(true);
      expect(sendKeys).not.toHaveBeenCalled();
      fireEvent.compositionEnd(box, { data: "한" });
      await act(async () => {});
      expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["한"]);
    },
  );

  it("also protects composition when keydown omits isComposing", () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.compositionStart(box);
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(true);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("keeps native Backspace in the candidate even when beforeinput omits isComposing", () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.compositionStart(box);
    expect(fireEvent(box, new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }))).toBe(true);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("does not send Safari's IME-confirming Enter after compositionend", async () => {
    const sendKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    render(<Harness sendKeys={sendKeys} />);
    const box = startTyping();
    fireEvent.compositionStart(box);
    fireEvent.compositionEnd(box, { data: "한" });
    expect(fireEvent.keyDown(box, { key: "Enter", keyCode: 229 })).toBe(true);
    await act(async () => {});
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith(["한"]);

    fireEvent.keyDown(box, { key: "Enter" });
    await act(async () => {});
    expect(sendKeys.mock.calls).toEqual([[["한"]], [["Enter"]]]);
  });
});
