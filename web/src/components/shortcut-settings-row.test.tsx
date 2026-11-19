import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetHardwareKeyboard, noteKeyPress } from "@/lib/hardware-keyboard";
import { ACTIONS } from "@/lib/shortcuts/actions";
import { __resetShortcutHelp } from "@/lib/shortcuts/help";
import { buildKeymap } from "@/lib/shortcuts/keymap";
import { __resetShortcutRegistry } from "@/lib/shortcuts/registry";
import { __resetShortcutState, publishShortcutKeymap } from "@/lib/shortcuts/state";

import { ShortcutHelpDoor } from "./shortcut-help-door";
import { ShortcutSettingsRow } from "./shortcut-settings-row";

beforeEach(() => {
  __resetShortcutRegistry();
  __resetShortcutState();
  __resetShortcutHelp();
  __resetHardwareKeyboard();
  publishShortcutKeymap(buildKeymap({ defaults: ACTIONS, mac: false }));
});
afterEach(() => {
  cleanup();
  __resetShortcutHelp();
  __resetHardwareKeyboard();
});

function mount() {
  return render(
    <>
      <ShortcutSettingsRow />
      <ShortcutHelpDoor />
    </>,
  );
}

const HARDWARE = { code: "KeyB", isComposing: false, keyCode: 66 } as const;

describe("ShortcutSettingsRow", () => {
  it("is absent on a device that has not shown a hardware key press", () => {
    mount();
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show keyboard shortcuts" })).toBeNull();
  });

  it("appears at the first hardware key press and opens the shortcut list", async () => {
    mount();
    act(() => noteKeyPress(HARDWARE));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show keyboard shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("stays absent after presses that name no physical key or come from an input method", () => {
    mount();
    act(() => {
      noteKeyPress({ code: "", isComposing: false, keyCode: 0 });
      noteKeyPress({ code: "KeyA", isComposing: true, keyCode: 65 });
      noteKeyPress({ code: "KeyA", isComposing: false, keyCode: 229 });
    });
    expect(screen.queryByRole("button", { name: "Show keyboard shortcuts" })).toBeNull();
  });
});
