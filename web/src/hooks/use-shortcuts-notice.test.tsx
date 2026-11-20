import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShortcutBarHost } from "@/components/shortcut-bar-host";
import { __resetHardwareKeyboard } from "@/lib/hardware-keyboard";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { __resetShortcutRegistry, registerShortcutHandler } from "@/lib/shortcuts/registry";
import { __resetShortcutState, SHORTCUT_NOTICE_MS } from "@/lib/shortcuts/state";

import { useShortcutKeyboard } from "./use-shortcuts";

// A key that is ours but has no target on this screen: the page gets nothing, and the bar says so for
// two seconds. The keymap's own rules are pinned in lib/shortcuts/; this pins the wiring to the bar.

const CTRL_B = { key: "b", ctrlKey: true } as const;

function Page({ onReplyKey }: { onReplyKey: (key: string) => void }) {
  useShortcutKeyboard("/");
  return (
    <div>
      <textarea aria-label="Reply" onKeyDown={(event) => onReplyKey(event.key)} />
      <ShortcutBarHost />
    </div>
  );
}

const notice = () => screen.queryByText("Not on this screen");

beforeEach(() => {
  __resetShortcutRegistry();
  __resetShortcutState();
  __resetHardwareKeyboard();
});
afterEach(() => {
  vi.useRealTimers();
  __resetOperatorCommands();
  __resetHardwareKeyboard();
});

function mount() {
  const onReplyKey = vi.fn();
  render(<Page onReplyKey={onReplyKey} />);
  return { onReplyKey, reply: screen.getByRole("textbox", { name: "Reply" }) };
}

describe("a key with no target on this screen", () => {
  it("does nothing to the page, and the bar says so, then hides after two seconds", () => {
    const { onReplyKey, reply } = mount();
    reply.focus();
    vi.useFakeTimers();
    fireEvent.keyDown(reply, CTRL_B);
    // The action key is consumed: it does not fall through into the focused text field.
    expect(fireEvent.keyDown(reply, { key: "c" })).toBe(false);
    expect(onReplyKey).not.toHaveBeenCalled();
    expect(notice()).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(SHORTCUT_NOTICE_MS - 1));
    expect(notice()).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(notice()).toBeNull();
    expect(document.querySelector('[data-slot="mode-band"]')).toBeNull();
  });

  it("shows nothing for a key that has a target", () => {
    registerShortcutHandler("new_tab", () => undefined);
    const { reply } = mount();
    fireEvent.keyDown(reply, CTRL_B);
    fireEvent.keyDown(reply, { key: "c" });
    expect(notice()).toBeNull();
  });

  it("is said again, and the two seconds start over, by a second such key", () => {
    const { reply } = mount();
    vi.useFakeTimers();
    fireEvent.keyDown(reply, CTRL_B);
    fireEvent.keyDown(reply, { key: "c" });
    act(() => vi.advanceTimersByTime(SHORTCUT_NOTICE_MS - 500));
    fireEvent.keyDown(reply, CTRL_B);
    fireEvent.keyDown(reply, { key: "c" });
    act(() => vi.advanceTimersByTime(SHORTCUT_NOTICE_MS - 500));
    expect(notice()).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    expect(notice()).toBeNull();
  });

  it("is the answer to a key that opens a mode with no key to run, and no mode starts", () => {
    const { onReplyKey, reply } = mount();
    fireEvent.keyDown(reply, CTRL_B);
    expect(fireEvent.keyDown(reply, { key: "w" })).toBe(false);
    expect(onReplyKey).not.toHaveBeenCalled();
    expect(notice()).toBeInTheDocument();
    // No mode is active, so the band holds the notice alone: no pill.
    expect(document.querySelector('[data-slot="shortcut-mode-bar"]')).toBeNull();
  });

  it("takes the hints' place inside a sticky mode, and the mode stays", () => {
    registerShortcutHandler("navigate_down", () => undefined);
    const { reply } = mount();
    fireEvent.keyDown(reply, CTRL_B);
    fireEvent.keyDown(reply, { key: "w" });
    expect(document.querySelector('[data-slot="shortcut-mode-bar"]')).toHaveAttribute("data-mode", "navigate");
    // `k` moves the ring up, which this screen has no handler for.
    fireEvent.keyDown(reply, { key: "k" });
    expect(notice()).toBeInTheDocument();
    expect(screen.queryByText("Move:")).toBeNull();
    expect(screen.getByText("Leave:")).toBeInTheDocument();
  });
});
