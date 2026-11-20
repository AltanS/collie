import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTIONS } from "@/lib/shortcuts/actions";
import { __resetShortcutHelp, openShortcutHelp } from "@/lib/shortcuts/help";
import { buildKeymap } from "@/lib/shortcuts/keymap";
import { __resetShortcutRegistry, runShortcutAction } from "@/lib/shortcuts/registry";
import { __resetShortcutState, publishShortcutKeymap } from "@/lib/shortcuts/state";
import type { UserShortcuts } from "@/lib/shortcuts/types";

import { ShortcutHelpDoor } from "./shortcut-help-door";

beforeEach(() => {
  __resetShortcutRegistry();
  __resetShortcutState();
  __resetShortcutHelp();
});
afterEach(() => {
  cleanup();
  __resetShortcutHelp();
});

function mountWith(user: UserShortcuts = {}) {
  publishShortcutKeymap(buildKeymap({ defaults: ACTIONS, user, mac: false }));
  return render(<ShortcutHelpDoor />);
}

const rowTexts = () => [...document.querySelectorAll('[data-slot="shortcut-list"] li')].map((row) => row.textContent ?? "");
/** The element, or a failure that says what was missing, so no test casts a maybe-null. */
function found(element: Element | null, what: string): HTMLElement {
  if (!(element instanceof HTMLElement)) throw new Error(`No ${what}`);
  return element;
}
const sheet = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });

describe("ShortcutHelpDoor", () => {
  it("stays closed until something opens it", () => {
    mountWith();
    expect(sheet()).toBeNull();
  });

  it("opens when the help action runs", () => {
    mountWith();
    act(() => {
      expect(runShortcutAction("help")).toBe(true);
    });
    expect(sheet()).toBeInTheDocument();
  });

  it("opens from the store the Settings row uses, and closes on Escape", () => {
    mountWith();
    act(() => openShortcutHelp("all"));
    expect(sheet()).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sheet()).toBeNull();
  });

  it("draws nothing and answers nothing's wrong when the keymap is not published yet", () => {
    render(<ShortcutHelpDoor />);
    act(() => {
      runShortcutAction("help");
    });
    expect(sheet()).toBeNull();
  });

  it("lists the actions of the table in groups, with the nine tab keys as one row", () => {
    mountWith();
    act(() => openShortcutHelp("all"));
    const dialog = found(sheet(), "sheet");
    expect(within(dialog).getByRole("region", { name: "Tabs" })).toBeInTheDocument();
    expect(within(dialog).getAllByText("Go to tab")).toHaveLength(1);
    expect(within(dialog).getAllByText("1–9")).toHaveLength(1);
  });

  it("narrows the rows as the filter is typed", async () => {
    mountWith();
    act(() => openShortcutHelp("all"));
    expect(screen.getByText("Zen mode on or off")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Filter shortcuts" }), "sidebar");
    // The matched word is drawn as a mark, so the row's text is read as a whole.
    expect(rowTexts()).toEqual([expect.stringContaining("Move in the sidebar"), expect.stringContaining("Show or hide the sidebar")]);
    await userEvent.clear(screen.getByRole("textbox", { name: "Filter shortcuts" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Filter shortcuts" }), "nothing like this");
    expect(screen.getByText(/No shortcut matches/)).toBeInTheDocument();
  });

  it("moves the cursor to the filter on /", () => {
    mountWith();
    act(() => openShortcutHelp("all"));
    const field = screen.getByRole("textbox", { name: "Filter shortcuts" });
    expect(field).not.toHaveFocus();
    expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(false);
    expect(field).toHaveFocus();
  });

  it("reads unset for an action the file unbound", () => {
    mountWith({ zen_mode: [""] });
    act(() => openShortcutHelp("all"));
    const row = found(screen.getByText("Zen mode on or off").closest("li"), "zen_mode row");
    expect(within(row).getByText("unset")).toBeInTheDocument();
  });

  it("shows what the file got wrong in the foot, with the reason", () => {
    mountWith({ zen_mode: ["ctrl+w"], find: ["no+such+key"] });
    act(() => openShortcutHelp("all"));
    const foot = found(document.querySelector('[data-slot="shortcut-list-foot"]'), "foot");
    expect(within(foot).getByText("Dropped from shortcuts.toml (2)")).toBeInTheDocument();
    expect(foot.textContent).toContain("zen_mode = ctrl+w");
    expect(foot.textContent).toContain("find = no+such+key");
  });

  it("shows no note when the file loaded clean", () => {
    mountWith();
    act(() => openShortcutHelp("all"));
    expect(screen.queryByText(/Dropped from shortcuts.toml/)).toBeNull();
  });

  it("follows a change of the keymap while it is open", () => {
    mountWith();
    act(() => openShortcutHelp("all"));
    act(() => publishShortcutKeymap(buildKeymap({ defaults: ACTIONS, user: { zen_mode: [""] }, mac: false })));
    const row = found(screen.getByText("Zen mode on or off").closest("li"), "zen_mode row");
    expect(within(row).getByText("unset")).toBeInTheDocument();
  });
});
