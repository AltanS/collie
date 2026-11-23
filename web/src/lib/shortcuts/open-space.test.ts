import { describe, expect, it } from "vitest";

import { en } from "../i18n/messages/en";
import { ACTIONS, GROUPS, NO_CONTROL_ACTIONS } from "./actions";
import { buildKeymap } from "./keymap";

// `open_space`: from a pane to the overview of the space it is in. Its key must be free in the default set, and a
// person can move or drop it in `shortcuts.toml` like any other action.

describe("the open_space action", () => {
  const action = ACTIONS.find((candidate) => candidate.id === "open_space");

  it("is in the Navigation group with prefix+o and a label in English", () => {
    expect(action?.group).toBe("navigation");
    expect(action?.defaults).toEqual(["prefix+o"]);
    expect(GROUPS.some((group) => group.id === "navigation")).toBe(true);
    expect(en["shortcuts.action.open_space"]).toBe("Open this space");
  });

  it("has a control that wears its key, so it is not in the list of actions with none", () => {
    expect(Object.hasOwn(NO_CONTROL_ACTIONS, "open_space")).toBe(false);
  });

  it("takes a key no other default action takes, with no diagnostic", () => {
    const others = ACTIONS.filter((candidate) => candidate.id !== "open_space").flatMap((candidate) => candidate.defaults.map((text) => text.toLowerCase()));
    expect(others).not.toContain("prefix+o");
    const keymap = buildKeymap({ defaults: ACTIONS });
    expect(keymap.diagnostics).toEqual([]);
    expect(keymap.prefixed.get("o")).toEqual({ action: "open_space" });
  });

  it("reads a key from shortcuts.toml, and drops it when the file says none", () => {
    const moved = buildKeymap({ defaults: ACTIONS, user: { open_space: ["prefix+u"] } });
    expect(moved.diagnostics).toEqual([]);
    expect(moved.prefixed.get("u")).toEqual({ action: "open_space" });
    expect(moved.prefixed.has("o")).toBe(false);
    const dropped = buildKeymap({ defaults: ACTIONS, user: { open_space: [] } });
    expect(dropped.bindings.get("open_space")).toEqual([]);
    expect(dropped.prefixed.has("o")).toBe(false);
  });

  it("gives way to a file that gives prefix+o to another action: the file wins the key", () => {
    const keymap = buildKeymap({ defaults: ACTIONS, user: { settings: ["prefix+o"] } });
    expect(keymap.prefixed.get("o")).toEqual({ action: "settings" });
  });
});
