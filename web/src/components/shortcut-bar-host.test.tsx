import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ACTIONS, type ActionId } from "@/lib/shortcuts/actions";
import { buildKeymap } from "@/lib/shortcuts/keymap";
import { __resetShortcutRegistry, registerShortcutHandler } from "@/lib/shortcuts/registry";
import { __resetShortcutState, publishShortcutKeymap, publishShortcutMode } from "@/lib/shortcuts/state";
import type { Mode, UserShortcuts } from "@/lib/shortcuts/types";

import { ShortcutBarHost } from "./shortcut-bar-host";

afterEach(() => {
  cleanup();
  __resetShortcutState();
  __resetShortcutRegistry();
});

/** A screen that answers these actions, as the pane view answers its tab and pane keys. */
function offer(...ids: ActionId[]) {
  for (const id of ids) registerShortcutHandler(id, () => undefined);
}

function keymapOf(user: UserShortcuts = {}) {
  return buildKeymap({ defaults: ACTIONS, user, mac: false });
}

function show(mode: Mode, user?: UserShortcuts) {
  publishShortcutKeymap(keymapOf(user));
  publishShortcutMode(mode);
  return render(<ShortcutBarHost />);
}

const bar = () => document.querySelector('[data-slot="shortcut-mode-bar"]');

describe("ShortcutBarHost", () => {
  it("draws nothing in the normal mode", () => {
    show("normal");
    expect(bar()).toBeNull();
    expect(document.querySelector('[data-slot="mode-band"]')).toBeNull();
  });

  it("draws nothing before the keymap is published", () => {
    publishShortcutMode("prefix");
    render(<ShortcutBarHost />);
    expect(bar()).toBeNull();
  });

  it("names the prefix, its keys and the way out while the prefix waits", () => {
    offer("new_tab");
    show("prefix");
    expect(bar()).toHaveAttribute("data-mode", "prefix");
    expect(screen.getByText("Prefix")).toBeInTheDocument();
    expect(screen.getByText("new tab")).toBeInTheDocument();
    expect(screen.getByText("all shortcuts")).toBeInTheDocument();
    expect(screen.getByText("cancel")).toBeInTheDocument();
  });

  it("names the Navigate mode and its own keys, and leaves with Enter or Esc", () => {
    offer("focus_pane_left", "focus_pane_right", "new_tab");
    show("navigate");
    expect(bar()).toHaveAttribute("data-mode", "navigate");
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("panes")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText("leave")).toBeInTheDocument();
    expect(screen.queryByText("new tab")).toBeNull();
  });

  it("sits in the info tone, out of the flow, along the foot of the window", () => {
    show("prefix");
    const band = document.querySelector('[data-slot="mode-band"]');
    expect(band?.className).toContain("fixed");
    expect(band?.className).toContain("bottom-0");
    expect(band?.querySelector("div")?.className).toContain("status-info");
  });

  it("follows the mode as it changes, and goes away with it", () => {
    show("prefix");
    act(() => publishShortcutMode("resize"));
    expect(bar()).toHaveAttribute("data-mode", "resize");
    act(() => publishShortcutMode("normal"));
    expect(bar()).toBeNull();
  });

  it("shows the keys of the live keymap, so a change in shortcuts.toml shows", () => {
    offer("new_tab");
    show("prefix", { new_tab: ["prefix+y"] });
    const row = screen.getByText("new tab").parentElement;
    expect(row?.textContent).toContain("y");
    expect(row?.textContent).not.toContain("c");
    act(() => publishShortcutKeymap(keymapOf({ new_tab: [""] })));
    expect(screen.queryByText("new tab")).toBeNull();
  });
});
