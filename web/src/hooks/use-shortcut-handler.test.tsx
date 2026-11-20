import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetShortcutRegistry, paneKeySink, runShortcutAction, type ShortcutHandler } from "@/lib/shortcuts/registry";

import { usePaneKeySink, useShortcutHandler } from "./use-shortcut-handler";

afterEach(() => __resetShortcutRegistry());

function Answers({ handler }: { handler: ShortcutHandler | undefined }) {
  useShortcutHandler("zen_mode", handler);
  return null;
}

describe("useShortcutHandler", () => {
  it("answers while mounted and stops when the component leaves", () => {
    const handler = vi.fn();
    const { unmount } = render(<Answers handler={handler} />);
    expect(runShortcutAction("zen_mode")).toBe(true);
    unmount();
    expect(runShortcutAction("zen_mode")).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("calls the handler of the latest render, with no new registration", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Answers handler={first} />);
    rerender(<Answers handler={second} />);
    runShortcutAction("zen_mode");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("offers nothing while the handler is undefined", () => {
    const { rerender } = render(<Answers handler={undefined} />);
    expect(runShortcutAction("zen_mode")).toBe(false);
    rerender(<Answers handler={vi.fn()} />);
    expect(runShortcutAction("zen_mode")).toBe(true);
    rerender(<Answers handler={undefined} />);
    expect(runShortcutAction("zen_mode")).toBe(false);
  });
});

function Keyboard({ typing, send }: { typing: boolean; send: (keys: string[]) => Promise<boolean> }) {
  usePaneKeySink({ send, isDirectTyping: () => typing });
  return null;
}

describe("usePaneKeySink", () => {
  it("offers the pane's keyboard while mounted, reading the newest render", () => {
    const send = vi.fn().mockResolvedValue(true);
    const { rerender, unmount } = render(<Keyboard typing={false} send={send} />);
    expect(paneKeySink()?.isDirectTyping()).toBe(false);
    rerender(<Keyboard typing send={send} />);
    expect(paneKeySink()?.isDirectTyping()).toBe(true);
    void paneKeySink()?.send(["ctrl+b"]);
    expect(send).toHaveBeenCalledWith(["ctrl+b"]);
    unmount();
    expect(paneKeySink()).toBeNull();
  });
});
