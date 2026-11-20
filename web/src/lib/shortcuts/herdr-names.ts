// Herdr's names for actions that Collie names differently, or lacks (M108).
//
// An operator copies a `[keys]` block from Herdr's `config.toml`. Collie does NOT accept Herdr's
// other names as aliases: an id means one thing here, and the glossary's words name it
// (docs/terminology.md). A Herdr name that is not an action of the table is dropped like any unknown
// name, and the Shortcut list says what to write instead, or that Collie has no such action.
//
// Source: `[keys]` of Herdr's `src/config/model.rs` (`KeysConfig`, its `Default` impl). Only ids that
// Collie does not use itself are listed. An id both programs share (`help`, `settings`, `new_tab`,
// `previous_tab`, `next_tab`, `switch_tab`, `focus_pane_left`, `focus_pane_right`, `cycle_pane_next`,
// `cycle_pane_previous`, `resize_mode`, `toggle_sidebar`, and since the Actions palette `rename_pane`,
// `rename_tab`, `close_pane`, `close_tab`) is a normal action and needs no row. Herdr's
// `[[keys.command]]` and `[keys.indexed]` are tables, not names, and Collie's reader skips them.
//
// A string value is the Collie id that means the same thing. `null` is "no equal in Collie": the name
// exists in Herdr and its meaning differs from every Collie action, or Collie has nothing like it.
// This file imports nothing but a type, so the core stays free of React and of the DOM.

import type { ActionId } from "./actions";

export const HERDR_NAMES: ReadonlyMap<string, ActionId | null> = new Map<string, ActionId | null>([
  // The same thing under another name.
  ["new_workspace", "new_space"],
  ["workspace_picker", "navigate_mode"],
  // Herdr's `goto` opens a searchable list of places; Collie's equal is the Actions palette (ADR 0165).
  ["goto", "open_actions"],
  ["zoom", "zen_mode"],
  ["previous_workspace", "previous_space"],
  ["next_workspace", "next_space"],
  ["navigate_workspace_up", "navigate_up"],
  ["navigate_workspace_down", "navigate_down"],
  ["rename_workspace", "rename_space"],

  // The name exists in Herdr, and Collie has no action of that meaning. `focus_pane_up` and
  // `focus_pane_down` move to the pane above and below in a split; Collie has no such layout, and its
  // `previous_space` and `next_space` are a different move. `detach` leaves the terminal client; the
  // dashboard (`open_dashboard`) is not that.
  ["focus_pane_up", null],
  ["focus_pane_down", null],
  ["navigate_pane_left", null],
  ["navigate_pane_right", null],
  ["navigate_pane_up", null],
  ["navigate_pane_down", null],
  ["detach", null],
  ["close_workspace", null],
  ["new_worktree", null],
  ["open_worktree", null],
  ["remove_worktree", null],
  ["reload_config", null],
  ["open_notification_target", null],
  ["previous_agent", null],
  ["next_agent", null],
  ["focus_agent", null],
  ["remote_image_paste", null],
  ["move_tab_previous", null],
  ["move_tab_next", null],
  ["switch_workspace", null],
  ["edit_scrollback", null],
  ["clear_pane", null],
  ["copy_mode", null],
  ["swap_pane_left", null],
  ["swap_pane_down", null],
  ["swap_pane_up", null],
  ["swap_pane_right", null],
  ["last_pane", null],
  ["split_vertical", null],
  ["split_horizontal", null],
  ["resize_pane_left", null],
  ["resize_pane_down", null],
  ["resize_pane_up", null],
  ["resize_pane_right", null],
]);

/** The message of the diagnostic for a Herdr name, in English, for the operator who edits the file. */
export function herdrNameMessage(input: { name: string; collie: ActionId | null }): string {
  if (input.collie === null) return `\`${input.name}\` is Herdr's name; Collie has no such action`;
  return `\`${input.name}\` is Herdr's name; write \`${input.collie}\``;
}
