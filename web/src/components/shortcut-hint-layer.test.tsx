import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIONS, type ActionId } from "@/lib/shortcuts/actions";
import { buildKeymap } from "@/lib/shortcuts/keymap";
import { __resetShortcutRegistry, registerShortcutHandler } from "@/lib/shortcuts/registry";
import { __resetShortcutState, publishShortcutKeymap, publishShortcutMode } from "@/lib/shortcuts/state";
import { shortcutTarget, type ShortcutTarget } from "@/lib/shortcuts/target";
import type { Mode, UserShortcuts } from "@/lib/shortcuts/types";

import { ShortcutHintLayer } from "./shortcut-hint-layer";

// The layer reads the page with `getBoundingClientRect` and `elementFromPoint`, which jsdom does not lay
// out: each test gives its controls a box, and the probe answers with the topmost box that holds the point
// (or the cover a test puts over the page). The frame loop is driven by hand, one `frame()` per paint.

let queued: FrameRequestCallback[] = [];

beforeEach(() => {
  queued = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => queued.push(callback));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    queued = [];
  });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  __resetShortcutState();
  __resetShortcutRegistry();
  vi.restoreAllMocks();
});

function frame() {
  const run = queued;
  queued = [];
  act(() => {
    for (const callback of run) callback(0);
  });
}

function offer(...ids: ActionId[]) {
  for (const id of ids) registerShortcutHandler(id, () => undefined);
}

function keymapOf(user: UserShortcuts = {}) {
  return buildKeymap({ defaults: ACTIONS, user, mac: false });
}

function arm(mode: Mode, user?: UserShortcuts) {
  publishShortcutKeymap(keymapOf(user));
  publishShortcutMode(mode);
  return render(<ShortcutHintLayer />);
}

interface Placed {
  element: HTMLElement;
}

/** A button on the page with a box. `attrs` is what `shortcutTarget` returns; `parent` defaults to the body. */
function control(input: { attrs: ShortcutTarget; box: [number, number, number, number]; parent?: HTMLElement }): Placed {
  const element = document.createElement("button");
  for (const [name, value] of Object.entries(input.attrs)) element.setAttribute(name, String(value));
  const [left, top, right, bottom] = input.box;
  element.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) });
  (input.parent ?? document.body).append(element);
  return { element };
}

let cover: Element | null = null;

beforeEach(() => {
  cover = null;
  document.elementFromPoint = (x, y) => {
    const hits = [...document.querySelectorAll<HTMLElement>("button")].filter((button) => {
      const rect = button.getBoundingClientRect();
      return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
    });
    // A cover (a dialog) answers everywhere, except where one of its own controls stands.
    if (cover !== null) return hits.findLast((button) => cover?.contains(button)) ?? cover;
    return hits.at(-1) ?? document.body;
  };
});

const hints = () => [...document.querySelectorAll<HTMLElement>('[data-slot="shortcut-hint"]')];
const caps = (hint: HTMLElement) => hint.textContent;
/** The first hint on the page, or a failure that says there was none. */
function firstHint(): HTMLElement {
  const [first] = hints();
  if (first === undefined) throw new Error("no hint is drawn");
  return first;
}

const ACTIONS_BUTTON: Parameters<typeof control>[0] = { attrs: shortcutTarget("open_actions"), box: [900, 10, 944, 54] };

describe("ShortcutHintLayer", () => {
  it("draws nothing, and asks for no frame, in the normal mode", () => {
    offer("open_actions");
    control(ACTIONS_BUTTON);
    arm("normal");
    frame();
    expect(hints()).toEqual([]);
    expect(queued).toEqual([]);
    expect(document.querySelector('[data-slot="shortcut-hint-layer"]')).toBeNull();
  });

  it("draws nothing in a sticky mode, and before the keymap is published", () => {
    offer("open_actions");
    control(ACTIONS_BUTTON);
    arm("navigate");
    frame();
    expect(hints()).toEqual([]);
    cleanup();
    __resetShortcutState();
    publishShortcutMode("prefix");
    render(<ShortcutHintLayer />);
    frame();
    expect(hints()).toEqual([]);
  });

  it("appears with the prefix, as a key cap on the control's top right corner, and leaves with it", () => {
    offer("open_actions");
    control(ACTIONS_BUTTON);
    arm("prefix");
    frame();
    expect(hints()).toHaveLength(1);
    const hint = firstHint();
    expect(caps(hint)).toBe("g");
    expect(hint).toHaveAttribute("data-action", "open_actions");
    expect(hint.style.left).toBe("934px");
    expect(hint.style.top).toBe("4px");
    act(() => publishShortcutMode("normal"));
    expect(hints()).toEqual([]);
    expect(queued).toEqual([]);
  });

  it("is not a control: hidden from assistive tech, tap-through, outside the tab order", () => {
    offer("open_actions");
    control(ACTIONS_BUTTON);
    arm("prefix");
    frame();
    const layer = document.querySelector('[data-slot="shortcut-hint-layer"]');
    expect(layer).toHaveAttribute("aria-hidden", "true");
    expect(layer).toHaveClass("pointer-events-none");
    expect(layer?.querySelector("button, a, input, [tabindex]")).toBeNull();
  });

  it("follows a key the person set, a re-bound key and an unbound action", () => {
    offer("open_actions");
    control(ACTIONS_BUTTON);
    arm("prefix", { open_actions: ["prefix+a"] });
    frame();
    expect(hints().map(caps)).toEqual(["a"]);
    act(() => publishShortcutKeymap(keymapOf({ open_actions: ["prefix+e"] })));
    frame();
    expect(hints().map(caps)).toEqual(["e"]);
    act(() => publishShortcutKeymap(keymapOf({ open_actions: [] })));
    frame();
    expect(hints()).toEqual([]);
  });

  it("draws nothing for an action the screen does not answer", () => {
    control(ACTIONS_BUTTON);
    arm("prefix");
    frame();
    expect(hints()).toEqual([]);
    act(() => void offer("open_actions"));
    frame();
    expect(hints().map(caps)).toEqual(["g"]);
  });

  it("numbers the tabs with the keys of switch_tab, and none past the ninth", () => {
    offer("switch_tab");
    control({ attrs: shortcutTarget("switch_tab", { index: 1 }), box: [10, 10, 90, 40] });
    control({ attrs: shortcutTarget("switch_tab", { index: 2 }), box: [100, 10, 180, 40] });
    control({ attrs: shortcutTarget("switch_tab", { index: 10 }), box: [190, 10, 270, 40] });
    arm("prefix");
    frame();
    expect(hints().map(caps)).toEqual(["1", "2"]);
  });

  it("keeps a cap inside the window", () => {
    offer("settings");
    control({ attrs: shortcutTarget("settings"), box: [window.innerWidth - 44, 0, window.innerWidth, 44] });
    arm("prefix");
    frame();
    const hint = firstHint();
    expect(Number.parseFloat(hint.style.left) + 20).toBeLessThanOrEqual(window.innerWidth - 4);
    expect(Number.parseFloat(hint.style.top)).toBeGreaterThanOrEqual(4);
  });

  it("hints only the focused pane's control when several panes of a row share an action", () => {
    offer("remove_from_view");
    const left = document.createElement("section");
    left.dataset.colKey = "a";
    const right = document.createElement("section");
    right.dataset.colKey = "b";
    right.dataset.focused = "";
    document.body.append(left, right);
    control({ attrs: shortcutTarget("remove_from_view"), box: [300, 10, 344, 54], parent: left });
    control({ attrs: shortcutTarget("remove_from_view"), box: [700, 10, 744, 54], parent: right });
    arm("prefix");
    frame();
    expect(hints()).toHaveLength(1);
    expect(firstHint().style.left).toBe("734px");
  });

  it("draws nothing for a control that is not seen: no box, outside the window, scrolled out of its strip", () => {
    offer("new_tab", "settings", "find");
    control({ attrs: shortcutTarget("new_tab"), box: [10, 10, 10, 10] });
    control({ attrs: shortcutTarget("settings"), box: [window.innerWidth + 100, 10, window.innerWidth + 144, 54] });
    const strip = document.createElement("div");
    strip.style.overflowX = "auto";
    strip.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => ({}) });
    document.body.append(strip);
    control({ attrs: shortcutTarget("find"), box: [300, 0, 344, 40], parent: strip });
    arm("prefix");
    frame();
    expect(hints()).toEqual([]);
  });

  it("draws nothing for the controls behind an open dialog, and keeps those inside it", () => {
    offer("open_actions", "find");
    control(ACTIONS_BUTTON);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    control({ attrs: shortcutTarget("find"), box: [100, 100, 400, 144], parent: dialog });
    cover = dialog;
    arm("prefix");
    frame();
    // The dialog answers the probe everywhere but on its own row: the Actions button is covered, the row inside it is not.
    expect(hints().map(caps)).toEqual(["/"]);
  });

  it("follows a scroll or a resize while it is up, one frame at a time", () => {
    offer("settings");
    const { element } = control({ attrs: shortcutTarget("settings"), box: [500, 100, 544, 144] });
    arm("prefix");
    frame();
    expect(firstHint().style.top).toBe("90px");
    element.getBoundingClientRect = () => ({ left: 500, top: 300, right: 544, bottom: 344, width: 44, height: 44, x: 500, y: 300, toJSON: () => ({}) });
    expect(queued).toHaveLength(1);
    frame();
    expect(firstHint().style.top).toBe("290px");
  });
});
