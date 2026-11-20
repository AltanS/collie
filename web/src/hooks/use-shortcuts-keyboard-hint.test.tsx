import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetHardwareKeyboard } from "@/lib/hardware-keyboard";
import { __resetKeyboardHint, isKeyboardHintDone } from "@/lib/keyboard-hint";
import { __resetShortcutRegistry } from "@/lib/shortcuts/registry";
import { __resetShortcutState } from "@/lib/shortcuts/state";

import { useShortcutKeyboard } from "./use-shortcuts";

// The first press of the prefix ends the one-time keyboard hint (components/keyboard-hint-card.tsx);
// any other key does not.

function Page() {
  useShortcutKeyboard("/");
  return null;
}

beforeEach(() => {
  __resetShortcutRegistry();
  __resetShortcutState();
  __resetHardwareKeyboard();
  __resetKeyboardHint();
});
afterEach(() => {
  __resetHardwareKeyboard();
  __resetKeyboardHint();
});

describe("the keyboard hint and the root listener", () => {
  it("is not done by a key that is not the prefix", () => {
    render(<Page />);
    fireEvent.keyDown(document.body, { key: "x", code: "KeyX" });
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: false });
    expect(isKeyboardHintDone()).toBe(false);
  });

  it("is done by the first press of the prefix", () => {
    render(<Page />);
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    expect(isKeyboardHintDone()).toBe(true);
    expect(localStorage.getItem("collie:keyboard-hint-done:v1")).toBe("1");
  });
});
