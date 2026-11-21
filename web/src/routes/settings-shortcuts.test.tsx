import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShortcutHelpDoor } from "@/components/shortcut-help-door";
import { withHeaderHost } from "@/test/header-host";
import { __reloadHardwareKeyboard, __resetHardwareKeyboard, noteKeyPress } from "@/lib/hardware-keyboard";
import { ACTIONS } from "@/lib/shortcuts/actions";
import { __resetShortcutHelp } from "@/lib/shortcuts/help";
import { buildKeymap } from "@/lib/shortcuts/keymap";
import { __resetShortcutRegistry } from "@/lib/shortcuts/registry";
import { __resetShortcutState, publishShortcutKeymap } from "@/lib/shortcuts/state";

import { SettingsKeysRoute } from "./settings-sections";

// Settings, Keys and touch: the Keyboard shortcuts row (M108), the visible control of the `help` action. It
// opens the same sheet `prefix+?` opens, and it is drawn only on a device that has shown a hardware key
// press, remembered in storage (lib/hardware-keyboard.ts).

const HARDWARE = { code: "KeyB", isComposing: false, keyCode: 66 } as const;

function renderDevice() {
  const router = createMemoryRouter(
    [{ path: "/settings/keys", element: withHeaderHost(<><SettingsKeysRoute /><ShortcutHelpDoor /></>) }],
    { initialEntries: ["/settings/keys"] },
  );
  return render(<RouterProvider router={router} />);
}

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

describe("Settings → Keys and touch → Keyboard shortcuts", () => {
  it("is not on the page before this device has shown a hardware key press", async () => {
    renderDevice();
    await screen.findByRole("heading", { name: "Keys and touch" });
    await screen.findByText("Zen mode");
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show keyboard shortcuts" })).toBeNull();
  });

  it("is a row that opens the shortcut list once a hardware key was pressed", async () => {
    renderDevice();
    await screen.findByRole("heading", { name: "Keys and touch" });
    act(() => noteKeyPress(HARDWARE));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Show keyboard shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Switch pane")).toBeInTheDocument();
  });

  it("is still there after a reload of the page", async () => {
    noteKeyPress(HARDWARE);
    __reloadHardwareKeyboard();
    renderDevice();
    expect(await screen.findByRole("button", { name: "Show keyboard shortcuts" })).toBeInTheDocument();
  });
});
