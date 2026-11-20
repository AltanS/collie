import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetHardwareKeyboard, noteKeyPress } from "@/lib/hardware-keyboard";
import { ACTIONS, type ActionId } from "@/lib/shortcuts/actions";
import { __resetShortcutHelp, openShortcutHelp } from "@/lib/shortcuts/help";
import { buildKeymap } from "@/lib/shortcuts/keymap";
import { __resetShortcutRegistry, registerShortcutHandler, runShortcutAction } from "@/lib/shortcuts/registry";
import { __resetShortcutState, publishShortcutKeymap, publishShortcutMode } from "@/lib/shortcuts/state";

import { ShortcutBarHost } from "./shortcut-bar-host";
import { ShortcutHelpDoor } from "./shortcut-help-door";
import { ShortcutSettingsRow } from "./shortcut-settings-row";

// THE BAR AND THE LIST FOLLOW THE SCREEN (M108). A screen is the set of handlers its components
// registered: the dashboard answers Settings and New but has no tab and no pane to move.

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
  __resetShortcutRegistry();
  __resetHardwareKeyboard();
});

const DASHBOARD: readonly ActionId[] = ["settings", "new_space"];
const PANE_VIEW: readonly ActionId[] = ["settings", "open_dashboard", "new_tab", "next_tab", "previous_tab", "switch_tab", "focus_pane_left", "focus_pane_right", "zen_mode"];

function offer(ids: readonly ActionId[]): () => void {
  const undo = ids.map((id) => registerShortcutHandler(id, () => undefined));
  return () => {
    for (const release of undo) release();
  };
}

/** The element, or a failure that says what was missing, so no test casts a maybe-null. */
function found(element: Element | null, what: string): HTMLElement {
  if (!(element instanceof HTMLElement)) throw new Error(`No ${what}`);
  return element;
}

const sheet = () => found(screen.queryByRole("dialog", { name: "Keyboard shortcuts" }), "sheet");
const notHere = () => document.querySelector('[data-slot="shortcut-list-not-here"]');
/** The cell that holds a row's words: the second span of the row. */
const labelOf = (row: HTMLElement) => found(row.children[1] ?? null, "label cell");
/** The action's own key cap; the cap before it is the prefix chord, always muted. */
const lastKey = (row: HTMLElement) => found([...row.querySelectorAll("kbd")].at(-1) ?? null, "key cap");
const rowOf = (label: string) => found(screen.getByText(label).closest("li"), `row ${label}`);

describe("the mode bar on the screen", () => {
  function showBar(mode: "prefix" | "navigate" | "resize") {
    publishShortcutMode(mode);
    return render(<ShortcutBarHost />);
  }

  it("on a dashboard-like screen names no tab and no pane key", () => {
    offer(DASHBOARD);
    showBar("prefix");
    for (const word of ["New tab", "Previous / next tab", "Go to tab", "Focus pane left / right", "Switch pane", "Move in the sidebar", "Resize panes"]) {
      expect(screen.queryByText(word)).toBeNull();
    }
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("keeps the ways out and the way to the list on every screen", () => {
    showBar("prefix");
    expect(screen.getByText("All shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("keeps Enter and Esc in Resize mode", () => {
    offer(["resize_wider"]);
    showBar("resize");
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Leave")).toBeInTheDocument();
  });

  it("names the tab and pane keys on a wide pane view", () => {
    offer(PANE_VIEW);
    showBar("prefix");
    for (const word of ["New tab", "Previous / next tab", "Go to tab", "Focus pane left / right", "Settings", "Dashboard", "Zen mode"]) {
      expect(screen.getByText(word)).toBeInTheDocument();
    }
    expect(screen.queryByText("Show or hide the sidebar")).toBeNull();
  });

  it("follows the screen as handlers mount and unmount", () => {
    showBar("prefix");
    expect(screen.queryByText("New tab")).toBeNull();
    let release = () => {};
    act(() => {
      release = offer(["new_tab"]);
    });
    expect(screen.getByText("New tab")).toBeInTheDocument();
    act(() => release());
    expect(screen.queryByText("New tab")).toBeNull();
  });
});

describe("the shortcut list in the screen context", () => {
  function openOnScreen(ids: readonly ActionId[]) {
    offer(ids);
    render(<ShortcutHelpDoor />);
    act(() => {
      expect(runShortcutAction("help")).toBe(true);
    });
  }

  it("leads with the groups that work here, and leaves out a group with nothing", () => {
    openOnScreen(DASHBOARD);
    const dialog = sheet();
    expect(within(dialog).getByRole("region", { name: "General" })).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Navigation" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "Tabs" })).toBeNull();
    expect(within(dialog).queryByRole("region", { name: "Panes" })).toBeNull();
    expect(within(dialog).queryByRole("region", { name: "View" })).toBeNull();
  });

  it("ends with one section of every action that does nothing here, dimmed, with its keys", () => {
    openOnScreen(DASHBOARD);
    const section = found(notHere(), "Not on this screen section");
    expect(within(section).getByText("Not on this screen")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="shortcut-list-not-here"]')).toHaveLength(1);
    // The help door answers `help` and the Actions palette's `open_shortcuts` on every screen (ADR 0165).
    const available = DASHBOARD.length + 2;
    expect(section.querySelectorAll("li")).toHaveLength(ACTIONS.length - available);
    const row = within(section).getByText("Next tab").closest("li");
    expect(found(row, "row").querySelector("kbd")).not.toBeNull();
    expect(labelOf(found(row, "row")).className).toContain("text-muted-foreground");
    expect(lastKey(found(row, "row")).className).toContain("text-muted-foreground");
    // A row that works here is plain, and stands outside the section.
    expect(labelOf(rowOf("Settings")).className).not.toContain("text-muted-foreground");
    expect(section.contains(rowOf("Settings"))).toBe(false);
  });

  it("finds an action that does nothing here with the filter", async () => {
    openOnScreen(DASHBOARD);
    await userEvent.type(screen.getByRole("textbox", { name: "Filter shortcuts" }), "sidebar");
    const section = found(notHere(), "Not on this screen section");
    expect(section.textContent).toContain("Show or hide the sidebar");
    expect(document.querySelectorAll('[data-slot="shortcut-list"] section')).toHaveLength(1);
  });

  it("finds an action that works here in the groups, and the section goes when nothing is left over", async () => {
    openOnScreen(DASHBOARD);
    // "shortcut" names only rows the help door answers here ("settings" also names the pane's settings
    // since ADR 0165, which does nothing on the dashboard).
    await userEvent.type(screen.getByRole("textbox", { name: "Filter shortcuts" }), "shortcut");
    expect(notHere()).toBeNull();
    expect(within(sheet()).getByRole("region", { name: "General" })).toBeInTheDocument();
  });

  it("moves a row between the parts as the screen changes under it", () => {
    openOnScreen(DASHBOARD);
    expect(found(notHere(), "section").textContent).toContain("Next tab");
    act(() => {
      offer(["next_tab"]);
    });
    expect(found(notHere(), "section").textContent).not.toContain("Next tab");
    expect(within(sheet()).getByRole("region", { name: "Tabs" })).toBeInTheDocument();
  });
});

describe("the shortcut list opened from Settings", () => {
  function openFromSettings() {
    offer(DASHBOARD);
    render(
      <>
        <ShortcutSettingsRow />
        <ShortcutHelpDoor />
      </>,
    );
    act(() => noteKeyPress({ code: "KeyB", isComposing: false, keyCode: 66 }));
  }

  it("is complete and plain, in its groups, with no section for the screen", async () => {
    openFromSettings();
    await userEvent.click(screen.getByRole("button", { name: "Show keyboard shortcuts" }));
    const dialog = sheet();
    expect(notHere()).toBeNull();
    for (const name of ["General", "Navigation", "Tabs", "Panes", "View"]) {
      expect(within(dialog).getByRole("region", { name })).toBeInTheDocument();
    }
    expect(dialog.querySelectorAll("li")).toHaveLength(ACTIONS.length);
    expect(labelOf(rowOf("Next tab")).className).not.toContain("text-muted-foreground");
    expect(lastKey(rowOf("Next tab")).className).not.toContain("text-muted-foreground");
  });

  it("is the screen's list again when the key opens it next", () => {
    offer(DASHBOARD);
    render(<ShortcutHelpDoor />);
    act(() => openShortcutHelp("all"));
    expect(notHere()).toBeNull();
    act(() => {
      runShortcutAction("help");
    });
    expect(notHere()).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
  });
});
