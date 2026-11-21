import { describe, expect, it } from "vitest";

import { shortcutTarget } from "./target";

describe("shortcutTarget", () => {
  it("names the action in one data attribute", () => {
    expect(shortcutTarget("open_actions")).toEqual({ "data-shortcut-action": "open_actions" });
  });

  it("carries the digit of an indexed action", () => {
    expect(shortcutTarget("switch_tab", { index: 3 })).toEqual({ "data-shortcut-action": "switch_tab", "data-shortcut-index": 3 });
  });

  it("carries a corner other than the default one", () => {
    expect(shortcutTarget("open_dashboard", { corner: "top-left" })).toEqual({ "data-shortcut-action": "open_dashboard", "data-shortcut-corner": "top-left" });
    expect(shortcutTarget("open_dashboard", { corner: "top-right" })).toEqual({ "data-shortcut-action": "open_dashboard" });
  });

  it("can name the icon as the anchor of the cap", () => {
    expect(shortcutTarget("open_dashboard", { icon: true })).toEqual({ "data-shortcut-action": "open_dashboard", "data-shortcut-icon": "true" });
  });

  it("accepts only an id of the action table", () => {
    // @ts-expect-error not an action
    expect(shortcutTarget("make_coffee")["data-shortcut-action"]).toBe("make_coffee");
  });
});
