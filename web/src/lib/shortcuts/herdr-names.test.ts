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
    expect(HERDR_NAMES.get("goto")).toBe("open_actions");
  });

  it("says Collie has no equal where the meaning differs", () => {
    for (const name of ["focus_pane_up", "focus_pane_down", "close_workspace", "detach"]) {
      expect(HERDR_NAMES.has(name), name).toBe(true);
      expect(HERDR_NAMES.get(name), name).toBeNull();
    }
  });
});

describe("a Herdr name in shortcuts.toml", () => {
  it("is dropped, with the Collie id to write", () => {
    const keymap = build({ new_workspace: ["prefix+y"] });
    expect(keymap.diagnostics).toEqual([
      { action: "new_workspace", binding: "prefix+y", code: "herdr-name", message: "`new_workspace` is Herdr's name; write `new_space`" },
    ]);
    expect(keymap.prefixed.has("y")).toBe(false);
  });

  it("says Collie has no such action when the name has no equal", () => {
    const keymap = build({ close_workspace: ["prefix+y"], detach: ["ctrl+q"] });
    expect(keymap.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "`close_workspace` is Herdr's name; Collie has no such action",
      "`detach` is Herdr's name; Collie has no such action",
    ]);
    expect(keymap.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["herdr-name", "herdr-name"]);
  });

  it("leaves the shipped keys of the renamed action as they are", () => {
    const keymap = build({ zoom: ["prefix+y"] });
    expect(keymap.prefixed.get("z")).toEqual({ action: "zen_mode" });
    expect(keymap.prefixed.has("y")).toBe(false);
  });

  it("maps Herdr's goto to the Actions palette, and its rename_workspace to rename_space", () => {
    expect(build({ goto: ["prefix+y"] }).diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["`goto` is Herdr's name; write `open_actions`"]);
    expect(HERDR_NAMES.get("rename_workspace")).toBe("rename_space");
  });

  it("takes the names both programs now share as Collie actions", () => {
    const keymap = build({ close_pane: ["prefix+y"], rename_tab: ["prefix+e"] });
    expect(keymap.diagnostics).toEqual([]);
    expect(keymap.prefixed.get("y")).toEqual({ action: "close_pane" });
    expect(keymap.prefixed.get("e")).toEqual({ action: "rename_tab" });
  });

  it("does not stop the rest of the block from loading", () => {
    const keymap = build({ goto: ["prefix+y"], find: ["prefix+y"] });
    expect(keymap.diagnostics.map((diagnostic) => diagnostic.action)).toEqual(["goto"]);
    expect(keymap.prefixed.get("y")).toEqual({ action: "find" });
  });

  it("still calls a name that neither program has an unknown action", () => {
    const keymap = build({ make_coffee: ["prefix+y"] });
    expect(keymap.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["unknown-action"]);
  });

  it("does not read a name that looks like an object method as a Herdr name", () => {
    const user: UserShortcuts = JSON.parse('{"constructor":["prefix+y"],"toString":["prefix+n"]}');
    expect(build(user).diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["unknown-action", "unknown-action"]);
  });

  it("writes the message in one place", () => {
    expect(herdrNameMessage({ name: "zoom", collie: "zen_mode" })).toBe("`zoom` is Herdr's name; write `zen_mode`");
  });
});
