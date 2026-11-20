import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BottomSheet } from "@/components/ui/sheet";
import { __reloadHardwareKeyboard, __resetHardwareKeyboard, noteKeyPress } from "@/lib/hardware-keyboard";
import { resetIdleLock, setLocked } from "@/lib/idle";
import { __reloadKeyboardHint, __resetKeyboardHint, isKeyboardHintDone } from "@/lib/keyboard-hint";
import { ACTIONS } from "@/lib/shortcuts/actions";
import { __resetShortcutHelp } from "@/lib/shortcuts/help";
import { buildKeymap } from "@/lib/shortcuts/keymap";
import { __resetShortcutRegistry } from "@/lib/shortcuts/registry";
import { __resetShortcutState, publishShortcutKeymap, publishShortcutMode } from "@/lib/shortcuts/state";
import type { UserShortcuts } from "@/lib/shortcuts/types";

import { KeyboardHintCard } from "./keyboard-hint-card";
import { ShortcutHelpDoor } from "./shortcut-help-door";

const KEY = "collie:keyboard-hint-done:v1";
const HARDWARE = { code: "KeyB", isComposing: false, keyCode: 66 } as const;

function publish(user: UserShortcuts = {}): void {
  publishShortcutKeymap(buildKeymap({ defaults: ACTIONS, user, mac: false }));
}

beforeEach(() => {
  __resetShortcutRegistry();
  __resetShortcutState();
  __resetShortcutHelp();
  __resetHardwareKeyboard();
  __resetKeyboardHint();
  publish();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  resetIdleLock();
  __resetShortcutHelp();
  __resetHardwareKeyboard();
  __resetKeyboardHint();
});

function mount() {
  return render(
    <>
      <KeyboardHintCard />
      <ShortcutHelpDoor />
    </>,
  );
}

const card = () => document.querySelector('[data-slot="keyboard-hint"]');
const caps = () => [...(card()?.querySelectorAll("kbd") ?? [])].map((cap) => cap.textContent);
const seeKeyboard = () => act(() => noteKeyPress(HARDWARE));

describe("KeyboardHintCard", () => {
  it("is hidden on a device that has shown no hardware key press", () => {
    mount();
    expect(card()).toBeNull();
  });

  it("shows after a hardware key press, with the prefix as key caps and the words around it", () => {
    mount();
    seeKeyboard();
    expect(card()).not.toBeNull();
    expect(screen.getByText("You have a keyboard")).toBeInTheDocument();
    expect(card()?.textContent).toContain("Collie takes Herdr's keys. Press");
    expect(card()?.textContent).toContain("then ? to see them all.");
    expect(caps()).toEqual(["Ctrl", "B", "?"]);
  });

  it("draws the help key as key caps, the first binding of help", () => {
    publish({ help: ["prefix+shift+k", "prefix+f1"] });
    mount();
    seeKeyboard();
    expect(caps()).toEqual(["Ctrl", "B", "Shift", "K"]);
  });

  it("names a direct help key without the prefix", () => {
    publish({ help: ["ctrl+alt+h"] });
    mount();
    seeKeyboard();
    expect(card()?.textContent).toContain("Press");
    expect(card()?.textContent).not.toContain("then");
    expect(caps()).toEqual(["Ctrl", "Alt", "H"]);
  });

  it("leaves the sentence that names help out when help is unbound", () => {
    publish({ help: [] });
    mount();
    seeKeyboard();
    expect(card()?.textContent).toContain("Collie takes Herdr's keys.");
    expect(card()?.textContent).not.toContain("to see them all");
    expect(caps()).toEqual([]);
  });

  it("closes, and stays closed after a reload", async () => {
    mount();
    seeKeyboard();
    await userEvent.click(screen.getByRole("button", { name: "Close the keyboard hint" }));
    expect(card()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe("1");

    __reloadHardwareKeyboard();
    __reloadKeyboardHint();
    expect(isKeyboardHintDone()).toBe(true);
    expect(card()).toBeNull();
  });

  it("opens the shortcut list from Show shortcuts and is done", async () => {
    mount();
    seeKeyboard();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(isKeyboardHintDone()).toBe(true);
    expect(card()).toBeNull();
  });

  it("draws the prefix a user set in shortcuts.toml", () => {
    publish({ prefix: ["ctrl+a"] });
    mount();
    seeKeyboard();
    expect(caps()).toEqual(["Ctrl", "A", "?"]);
  });

  it("follows a prefix that changes while it shows", () => {
    mount();
    seeKeyboard();
    act(() => publish({ prefix: ["alt+x"] }));
    expect(caps()).toEqual(["Alt", "X", "?"]);
  });

  it("waits while the mode bar is up and comes back after it", () => {
    mount();
    seeKeyboard();
    act(() => publishShortcutMode("prefix"));
    expect(card()).toBeNull();
    act(() => publishShortcutMode("normal"));
    expect(card()).not.toBeNull();
  });

  it("waits under the idle lock", () => {
    mount();
    seeKeyboard();
    act(() => setLocked(true));
    expect(card()).toBeNull();
    act(() => setLocked(false));
    expect(card()).not.toBeNull();
  });

  it("waits while a sheet is open", () => {
    render(
      <>
        <KeyboardHintCard />
        <BottomSheet open onClose={() => undefined} title="A sheet">
          <p>Body</p>
        </BottomSheet>
      </>,
    );
    seeKeyboard();
    expect(card()).toBeNull();
  });

  it("sits 8px below the header's bottom edge, wherever the header ends", () => {
    render(
      <>
        <header data-slot="app-header" />
        <KeyboardHintCard />
      </>,
    );
    const header = document.querySelector('[data-slot="app-header"]');
    expect(header).not.toBeNull();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 800, this === header ? 109 : 0);
    });
    act(() => window.dispatchEvent(new Event("resize")));
    seeKeyboard();
    expect(card()).toHaveStyle({ top: "117px" });
  });

  it("draws nothing before the keymap is published", () => {
    __resetShortcutState();
    mount();
    seeKeyboard();
    expect(card()).toBeNull();
  });
});
