import { describe, expect, it } from "vitest";

import { ACTIONS } from "./actions";
import { HERDR_NAMES, herdrNameMessage } from "./herdr-names";
import { buildKeymap } from "./keymap";
import type { UserShortcuts } from "./types";

function build(user: UserShortcuts) {
  return buildKeymap({ defaults: ACTIONS, user });
}

describe("the Herdr names table", () => {
  const ids = new Set<string>(ACTIONS.map((action) => action.id));

  it("never lists a name that is an action of Collie: a shared id is a normal action", () => {
    for (const name of HERDR_NAMES.keys()) expect(ids.has(name), name).toBe(false);
  });

  it("points only at ids that exist in the action table", () => {
    for (const [name, collie] of HERDR_NAMES) {
      if (collie === null) continue;
      expect(ids.has(collie), `${name} -> ${collie}`).toBe(true);
    }
  });

  it("names the four renames of the milestone", () => {
    expect(HERDR_NAMES.get("new_workspace")).toBe("new_space");
    expect(HERDR_NAMES.get("zoom")).toBe("zen_mode");
    expect(HERDR_NAMES.get("workspace_picker")).toBe("navigate_mode");
    expect(HERDR_NAMES.get("goto")).toBe("switch_pane");
  });

  it("says Collie has no equal where the meaning differs", () => {
    for (const name of ["focus_pane_up", "focus_pane_down", "close_pane", "detach"]) {
      expect(HERDR_NAMES.has(name), name).toBe(true);
      expect(HERDR_NAMES.get(name), name).toBeNull();
    }
  });
});

describe("a Herdr name in shortcuts.toml", () => {
  it("is dropped, with the Collie id to write", () => {
    const keymap = build({ new_workspace: ["prefix+m"] });
    expect(keymap.diagnostics).toEqual([
      { action: "new_workspace", binding: "prefix+m", code: "herdr-name", message: "`new_workspace` is Herdr's name; write `new_space`" },
    ]);
    expect(keymap.prefixed.has("m")).toBe(false);
  });

  it("says Collie has no such action when the name has no equal", () => {
    const keymap = build({ close_pane: ["prefix+m"], detach: ["ctrl+q"] });
    expect(keymap.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "`close_pane` is Herdr's name; Collie has no such action",
      "`detach` is Herdr's name; Collie has no such action",
    ]);
    expect(keymap.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["herdr-name", "herdr-name"]);
  });

  it("leaves the shipped keys of the renamed action as they are", () => {
    const keymap = build({ zoom: ["prefix+m"] });
    expect(keymap.prefixed.get("z")).toEqual({ action: "zen_mode" });
    expect(keymap.prefixed.has("m")).toBe(false);
  });

  it("does not stop the rest of the block from loading", () => {
    const keymap = build({ goto: ["prefix+m"], find: ["prefix+m"] });
    expect(keymap.diagnostics.map((diagnostic) => diagnostic.action)).toEqual(["goto"]);
    expect(keymap.prefixed.get("m")).toEqual({ action: "find" });
  });

  it("still calls a name that neither program has an unknown action", () => {
    const keymap = build({ make_coffee: ["prefix+m"] });
    expect(keymap.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["unknown-action"]);
  });

  it("does not read a name that looks like an object method as a Herdr name", () => {
    const user: UserShortcuts = JSON.parse('{"constructor":["prefix+m"],"toString":["prefix+n"]}');
    expect(build(user).diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["unknown-action", "unknown-action"]);
  });

  it("writes the message in one place", () => {
    expect(herdrNameMessage({ name: "zoom", collie: "zen_mode" })).toBe("`zoom` is Herdr's name; write `zen_mode`");
  });
});
