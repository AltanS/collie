import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetShortcutRegistry, paneKeySink, runShortcutAction, type ShortcutHandler } from "@/lib/shortcuts/registry";

import { registerShortcutHandler } from "@/lib/shortcuts/registry";

import { usePaneKeySink, useShortcutActionAvailable, useShortcutHandler } from "./use-shortcut-handler";

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

function Available({ id }: { id: "find" | "navigate_mode" }) {
  return <p data-testid="available">{String(useShortcutActionAvailable(id))}</p>;
}

describe("useShortcutActionAvailable", () => {
  it("follows a handler as it registers and goes", () => {
    render(<Available id="find" />);
    expect(screen.getByTestId("available")).toHaveTextContent("false");
    let forget: () => void = () => undefined;
    act(() => {
      forget = registerShortcutHandler("find", vi.fn());
    });
    expect(screen.getByTestId("available")).toHaveTextContent("true");
    act(() => forget());
    expect(screen.getByTestId("available")).toHaveTextContent("false");
  });

  it("follows a component that answers the action", () => {
    function Page({ shown }: { shown: boolean }) {
      useShortcutHandler("find", shown ? vi.fn() : undefined);
      return <Available id="find" />;
    }
    const { rerender } = render(<Page shown={false} />);
    expect(screen.getByTestId("available")).toHaveTextContent("false");
    rerender(<Page shown />);
    expect(screen.getByTestId("available")).toHaveTextContent("true");
  });

  it("reads a mode opener through its keys", () => {
    render(<Available id="navigate_mode" />);
    expect(screen.getByTestId("available")).toHaveTextContent("false");
    act(() => {
      registerShortcutHandler("navigate_up", vi.fn());
    });
    expect(screen.getByTestId("available")).toHaveTextContent("true");
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
