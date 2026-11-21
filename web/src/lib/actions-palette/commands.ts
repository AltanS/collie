// THE COMMANDS OF THE ACTIONS PALETTE (ADR 0165), as data. Every command is an action of the shortcut
// table (lib/shortcuts/actions.ts), so a person can also bind it, and running one runs that action's
// handler: the same function its menu row calls. WHERE a command appears is never decided here. The
// palette asks the registry (`isShortcutActionAvailable`) and lists only what answers on this screen,
// so a command a screen does not draw is not listed there.
//
// What this file holds is only what a list needs beyond the table: the word the palette shows (the
// menu row's own word where one exists, so the two read the same), the glyph, and the order of a list
// with nothing typed. A destructive command is the table's `destructive` flag, read through
// {@link isDestructive}.

import type { IconKey } from "@/components/icons/keys";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { ACTIONS, type ActionId } from "@/lib/shortcuts/actions";

export interface PaletteCommand {
  readonly id: ActionId;
  readonly labelKey: MessageKey;
  readonly icon: IconKey;
}

/** In the order a ranked list keeps for equal matches: the pane's own acts, the tab, the space, creates, places. */
export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: "find", labelKey: "chat.find.label", icon: "find-in-pane" },
  { id: "copy_output", labelKey: "chat.copyOutput.label", icon: "copy" },
  { id: "toggle_chat_terminal", labelKey: "actions.command.chatTerminal", icon: "show-terminal-view" },
  { id: "zen_mode", labelKey: "chat.zen.label", icon: "zen-enter" },
  { id: "conversation_history", labelKey: "chat.history.label", icon: "history-screen" },
  { id: "walky_messages", labelKey: "actions.command.walky", icon: "messages" },
  { id: "pin_pane", labelKey: "actions.command.pin", icon: "pin" },
  { id: "rename_pane", labelKey: "actions.command.renamePane", icon: "edit" },
  { id: "pane_menu", labelKey: "paneActions.menu.label", icon: "pane-menu" },
  { id: "pane_settings", labelKey: "paneActions.settings.label", icon: "pane-settings" },
  { id: "open_files", labelKey: "chat.changes.label", icon: "files" },
  { id: "close_pane", labelKey: "paneActions.close.label", icon: "close-pane" },
  { id: "rename_tab", labelKey: "actions.command.renameTab", icon: "edit" },
  { id: "close_tab", labelKey: "space.tab.close", icon: "close-pane" },
  { id: "rename_space", labelKey: "actions.command.renameSpace", icon: "edit" },
  { id: "new_tab", labelKey: "actions.command.newTab", icon: "add" },
  { id: "new_shell", labelKey: "actions.command.newShell", icon: "new-shell" },
  { id: "new_agent", labelKey: "actions.command.newAgent", icon: "new-agent" },
  { id: "new_space", labelKey: "wide.newSpace", icon: "new-space" },
  { id: "switch_pane", labelKey: "chat.switcher.title", icon: "pane-switcher" },
  { id: "open_dashboard", labelKey: "actions.command.dashboard", icon: "tab-dashboard" },
  { id: "open_crew", labelKey: "actions.command.crew", icon: "crew" },
  { id: "settings", labelKey: "settings.title", icon: "settings" },
  { id: "open_shortcuts", labelKey: "shortcuts.list.title", icon: "keys-drawer" },
];

/**
 * The four commands "Suggested" offers before anything is typed, in order, then the ones that stand in
 * when one of them does not work on this screen (find is not offered in Chat, New tab not in a folded
 * strip), so the list keeps four rows where four commands answer.
 */
export const SUGGESTED = {
  pane: ["new_tab", "new_shell", "find", "zen_mode", "toggle_chat_terminal", "conversation_history", "copy_output", "pane_settings"],
  dashboard: ["new_agent", "new_space", "new_shell", "settings", "open_crew", "open_shortcuts"],
} as const satisfies Record<"pane" | "dashboard", readonly ActionId[]>;

export const SUGGESTED_COUNT = 4;

const DESTRUCTIVE: ReadonlySet<ActionId> = new Set(
  ACTIONS.filter((action) => "destructive" in action && action.destructive === true).map((action) => action.id),
);

/** The table's flag: running the command ends something, so its handler opens a confirm and it is never highlighted first. */
export function isDestructive(id: ActionId): boolean {
  return DESTRUCTIVE.has(id);
}

const BY_ID: ReadonlyMap<ActionId, PaletteCommand> = new Map(PALETTE_COMMANDS.map((command) => [command.id, command]));

export function paletteCommand(id: ActionId): PaletteCommand {
  const found = BY_ID.get(id);
  if (found === undefined) throw new Error(`No palette command ${id}`);
  return found;
}

/** The commands that answer on this screen now, in table order. `available` is the registry's query. */
export function availableCommands(available: (id: ActionId) => boolean): PaletteCommand[] {
  return PALETTE_COMMANDS.filter((command) => available(command.id));
}

/** The commands "Suggested" shows: the first {@link SUGGESTED_COUNT} of the screen's list that answer. */
export function suggestedCommands(screen: "pane" | "dashboard", available: (id: ActionId) => boolean): PaletteCommand[] {
  const list: readonly ActionId[] = SUGGESTED[screen];
  return list
    .filter((id) => available(id))
    .slice(0, SUGGESTED_COUNT)
    .map(paletteCommand);
}
