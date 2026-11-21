import { describe, expect, it } from "vitest";

import { en } from "../i18n/messages/en";
import { ACTIONS, GROUPS, MODES } from "./actions";
import { buildKeymap } from "./keymap";

describe("the action table", () => {
  it("has one row per id", () => {
    const ids = ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a help label in the English dictionary for every row, group and mode", () => {
    const keys = [...ACTIONS.map((action) => action.labelKey), ...GROUPS.map((group) => group.labelKey), ...MODES.map((mode) => mode.labelKey)];
    for (const key of keys) expect(en, key).toHaveProperty([key]);
  });

  it("puts every row in a group the help list draws", () => {
    const groups = new Set<string>(GROUPS.map((group) => group.id));
    for (const action of ACTIONS) expect(groups.has(action.group), action.id).toBe(true);
  });

  it("binds every action by default but the Actions palette's own commands, which a person may bind", () => {
    const unbound = ACTIONS.filter((action) => action.defaults.length === 0).map((action) => action.id);
    expect(unbound.toSorted()).toEqual(
      [
        "close_pane",
        "close_tab",
        "conversation_history",
        "copy_output",
        "new_agent",
        "new_shell",
        "open_crew",
        "open_files",
        "open_shortcuts",
        "pane_settings",
        "pin_pane",
        "rename_pane",
        "rename_space",
        "rename_tab",
        "switch_pane",
        "walky_messages",
      ].toSorted(),
    );
    for (const action of ACTIONS) {
      if (action.defaults.length > 0) continue;
      expect("scope" in action || "opensMode" in action || "indexed" in action, action.id).toBe(false);
    }
  });

  it("opens Actions with prefix+g, the key Switch pane had", () => {
    const keymap = buildKeymap({ defaults: ACTIONS });
    expect(keymap.prefixed.get("g")).toEqual({ action: "open_actions" });
    expect(keymap.bindings.get("switch_pane")).toEqual([]);
  });

  it("marks only the two closes as destructive", () => {
    const destructive = ACTIONS.filter((action) => "destructive" in action && action.destructive === true).map((action) => action.id);
    expect(destructive.toSorted()).toEqual(["close_pane", "close_tab"]);
  });

  it("loads its own defaults with no diagnostic, on every platform", () => {
    for (const mac of [false, true]) {
      const keymap = buildKeymap({ defaults: ACTIONS, mac });
      expect(keymap.diagnostics, `mac ${mac}`).toEqual([]);
      for (const action of ACTIONS) {
        const bound = keymap.bindings.get(action.id)?.length ?? 0;
        if (action.defaults.length === 0) expect(bound, action.id).toBe(0);
        else expect(bound, action.id).toBeGreaterThan(0);
      }
    }
  });

  it("binds each default key once", () => {
    const keymap = buildKeymap({ defaults: ACTIONS });
    const placed = ACTIONS.flatMap((action) => keymap.bindings.get(action.id) ?? []);
    const hits = keymap.direct.size + keymap.prefixed.size + [...keymap.modes.values()].reduce((sum, mode) => sum + mode.keys.size, 0);
    expect(hits).toBe(placed.length);
  });

  it("gives every sticky mode one opener, and keys of its own", () => {
    for (const mode of MODES) {
      const openers = ACTIONS.filter((action) => "opensMode" in action && action.opensMode === mode.id);
      expect(openers, mode.id).toHaveLength(1);
      expect(ACTIONS.some((action) => "scope" in action && action.scope === mode.id), mode.id).toBe(true);
    }
  });

  it("keeps a mode's keys out of the normal mode and out of the prefix", () => {
    for (const action of ACTIONS) {
      if (!("scope" in action)) continue;
      for (const text of action.defaults) expect(text.toLowerCase().startsWith("prefix"), action.id).toBe(false);
    }
  });

  it("takes a number only where the binding is a range", () => {
    for (const action of ACTIONS) {
      if (!("indexed" in action)) continue;
      expect(action.defaults.some((text) => text.endsWith("1..9")), action.id).toBe(true);
    }
  });
});
