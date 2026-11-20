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
    expect(screen.getByText("New tab")).toBeInTheDocument();
    expect(screen.getByText("All shortcuts")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("names the Navigate mode and its own keys, and leaves with Esc", () => {
    offer("navigate_down", "navigate_up", "navigate_open", "new_tab");
    show("navigate");
    expect(bar()).toHaveAttribute("data-mode", "navigate");
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("Move:")).toBeInTheDocument();
    expect(screen.getByText("Open:")).toBeInTheDocument();
    expect(screen.getByText("Leave:")).toBeInTheDocument();
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.queryByText("New tab")).toBeNull();
  });

  it("reads Navigate mode as Move: j k ↑ ↓, Open: Enter, Leave: Esc", () => {
    offer("navigate_down", "navigate_up", "navigate_open");
    show("navigate");
    const text = (bar()?.textContent ?? "").replaceAll(/\s+/gu, " ");
    expect(text).toContain("Move:jk↑↓");
    expect(text).toContain("Open:Enter");
    expect(text).toContain("Leave:Esc");
    expect([...(bar()?.querySelectorAll("kbd") ?? [])].map((cap) => cap.textContent)).toEqual(["j", "k", "↑", "↓", "Enter", "Esc"]);
  });

  it("wraps its hints to a second line and never clips them", () => {
    offer("new_tab", "next_tab", "previous_tab", "switch_tab");
    show("prefix");
    const hints = document.querySelector('[data-slot="shortcut-hints"]');
    expect(hints?.className).toContain("flex-wrap");
    expect(hints?.className).not.toContain("overflow-hidden");
    expect(hints?.className).not.toContain("mask-image");
    const band = document.querySelector('[data-slot="mode-band"]');
    expect(band?.querySelector("div")?.className).toContain("h-auto");
    expect(band?.querySelector("div")?.className).not.toMatch(/(?:^| )h-8(?: |$)/u);
  });

  it("names the pairs as one entry each, verb first", () => {
    offer("previous_tab", "next_tab", "switch_tab", "focus_pane_left", "focus_pane_right", "previous_space", "next_space");
    show("prefix");
    for (const label of ["Previous / next tab", "Go to tab", "Focus pane left / right", "Previous / next space"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
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
    const row = screen.getByText("New tab").parentElement;
    expect(row?.textContent).toContain("y");
    expect(row?.textContent).not.toContain("c");
    act(() => publishShortcutKeymap(keymapOf({ new_tab: [""] })));
    expect(screen.queryByText("New tab")).toBeNull();
  });
});
