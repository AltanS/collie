import { __resetShortcutRegistry, isShortcutActionAvailable, registerShortcutHandler } from "@/lib/shortcuts/registry";
import { ACTIONS } from "@/lib/shortcuts/actions";

import { availableCommands, isDestructive, PALETTE_COMMANDS, SUGGESTED, SUGGESTED_COUNT, suggestedCommands } from "./commands";

// WHERE A COMMAND SHOWS is the registry's answer, never a list of screens (ADR 0165).

afterEach(() => __resetShortcutRegistry());

const available = (id: Parameters<typeof isShortcutActionAvailable>[0]) => isShortcutActionAvailable(id);

describe("palette commands", () => {
  it("lists every command once, each an action of the shortcut table", () => {
    const ids = PALETTE_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    const table = new Set(ACTIONS.map((action) => action.id));
    for (const id of ids) expect(table.has(id)).toBe(true);
    for (const screen of ["pane", "dashboard"] as const) for (const id of SUGGESTED[screen]) expect(ids).toContain(id);
  });

  it("lists only the commands whose handler is registered", () => {
    expect(availableCommands(available)).toEqual([]);
    const off = registerShortcutHandler("copy_output", () => {});
    registerShortcutHandler("settings", () => {});
    expect(availableCommands(available).map((command) => command.id)).toEqual(["copy_output", "settings"]);
    off();
    expect(availableCommands(available).map((command) => command.id)).toEqual(["settings"]);
  });

  it("has no pane or tab command on a screen that registers none", () => {
    for (const id of ["new_agent", "new_space", "new_shell", "settings", "open_dashboard"] as const) registerShortcutHandler(id, () => {});
    const ids = availableCommands(available).map((command) => command.id);
    for (const paneOnly of ["find", "close_pane", "close_tab", "rename_pane", "rename_tab", "pin_pane", "new_tab"] as const) {
      expect(ids).not.toContain(paneOnly);
    }
  });

  it("suggests the brief's four in a pane, and stands in for one that does not answer", () => {
    for (const id of SUGGESTED.pane) registerShortcutHandler(id, () => {});
    expect(suggestedCommands("pane", available).map((command) => command.id)).toEqual(["new_tab", "new_shell", "find", "zen_mode"]);
    __resetShortcutRegistry();
    for (const id of SUGGESTED.pane.filter((other) => other !== "find")) registerShortcutHandler(id, () => {});
    const ids = suggestedCommands("pane", available).map((command) => command.id);
    expect(ids).toHaveLength(SUGGESTED_COUNT);
    expect(ids).not.toContain("find");
  });

  it("suggests New agent, New space, New shell and Settings on the dashboard", () => {
    for (const id of SUGGESTED.dashboard) registerShortcutHandler(id, () => {});
    expect(suggestedCommands("dashboard", available).map((command) => command.id)).toEqual(["new_agent", "new_space", "new_shell", "settings"]);
  });

  it("reads destructive from the table's flag", () => {
    expect(isDestructive("close_pane")).toBe(true);
    expect(isDestructive("close_tab")).toBe(true);
    expect(isDestructive("rename_pane")).toBe(false);
  });
});
