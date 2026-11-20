// THE action table of the desktop shortcuts (M108). Help, the mode bar and the keymap read this
// table and nothing else, so a list kept by hand cannot drift from what runs.
//
// The grammar of `defaults` is Herdr's (README of the milestone, "The Herdr model we copy"): an
// optional `prefix+`, then `mod+mod+key`. A value in the operator's `shortcuts.toml` replaces an
// action's defaults whole.
//
// Two kinds of row:
//   * a global action: its bindings live in the normal mode (a direct chord) or behind the prefix.
//   * a mode action (`scope` set): its bindings live inside that sticky mode, as bare keys, and
//     never behind the prefix. The mode itself is opened by an action with `opensMode`.
//
// Every row needs a visible control in the app: a shortcut is a second path, never the only one.
// Since the Actions palette (ADR 0165) every command the palette lists is a row here too, most with no
// default key (`defaults: []`), so a person can bind any of them; the palette is their second control.
// Checked on 2026-11-19 against the app: every row has one (the Settings gear, the pane list,
// the header's way home, New, the tab bar's "+", the strip's width presets, zen mode, the sidebar
// toggle, the Chat/Terminal choice, the composer, the find bar) except two. `reload_config` is left
// out: nothing in the app re-reads a file by hand, and `shortcuts.toml` reloads live. `help` stays: its
// control is the Keyboard shortcuts row in Settings, Device (components/shortcut-settings-row.tsx).
//
// This file imports nothing but a type, so the core stays free of React and of the DOM.

import type { MessageKey } from "../i18n/messages/en";

/** The prefix chord when none is configured, or the configured one is invalid. Same as Herdr. */
export const DEFAULT_PREFIX = "ctrl+b";

/** A sticky mode: it stays until `Esc` (or a key the mode names). */
export type ModeId = "navigate" | "resize";

export type ActionGroup = "global" | "navigation" | "tabs" | "panes" | "view";

export interface ActionDef<Id extends string = string> {
  /** The name the operator writes in `shortcuts.toml`. Herdr's name where the action matches. */
  readonly id: Id;
  readonly group: ActionGroup;
  /** Bindings in Herdr's grammar. Empty means unbound by default. */
  readonly defaults: readonly string[];
  /** The help row's description. */
  readonly labelKey: MessageKey;
  /** The binding is a `1..9` range (or one digit) and the hit carries the number. */
  readonly indexed?: true;
  /** Running the action enters this sticky mode. */
  readonly opensMode?: ModeId;
  /** The bindings live inside this sticky mode, not in the normal one. */
  readonly scope?: ModeId;
  /**
   * Running the action ends something that cannot be taken back (a pane, a tab). Its handler only
   * opens the confirm the menu row shows; the Actions palette never highlights such a row first, and
   * Enter on it opens that confirm, as a tap does.
   */
  readonly destructive?: true;
  /** Running the action ends the sticky mode it lives in, after it ran. */
  readonly leavesMode?: true;
  /**
   * The action that answers this one's keys while this one is switched off (a setting, today the Actions
   * palette's). The keymap moves every key bound to this action, the default or a person's own, onto the
   * stand-in: the key runs the stand-in's handler, and the shortcut bar and the list name it as the
   * stand-in, never as this action (lib/shortcuts/keymap.ts, `disabled`).
   */
  readonly standIn?: Id;
}

export interface ModeDef {
  readonly id: ModeId;
  readonly labelKey: MessageKey;
  /** Keys that leave the mode besides `Esc`, which always does. Fixed, never configurable. */
  readonly exits: readonly string[];
}

// `navigate` moves a focus ring over the rows of the sidebar and changes nothing on screen until
// `navigate_open` (Enter) opens the focused row and leaves; `Esc` leaves with no change. `resize`
// acts live: its keys step the width, and `Enter` or `Esc` leaves.
export const MODES = [
  { id: "navigate", labelKey: "shortcuts.mode.navigate", exits: [] },
  { id: "resize", labelKey: "shortcuts.mode.resize", exits: ["enter"] },
] as const satisfies readonly ModeDef[];

export const GROUPS = [
  { id: "global", labelKey: "shortcuts.group.global" },
  { id: "navigation", labelKey: "shortcuts.group.navigation" },
  { id: "tabs", labelKey: "shortcuts.group.tabs" },
  { id: "panes", labelKey: "shortcuts.group.panes" },
  { id: "view", labelKey: "shortcuts.group.view" },
] as const satisfies readonly { readonly id: ActionGroup; readonly labelKey: MessageKey }[];

export const ACTIONS = [
  { id: "help", group: "global", defaults: ["prefix+?"], labelKey: "shortcuts.action.help" },
  { id: "settings", group: "global", defaults: ["prefix+s"], labelKey: "shortcuts.action.settings" },
  { id: "open_actions", group: "global", defaults: ["prefix+g"], labelKey: "shortcuts.action.open_actions", standIn: "switch_pane" },
  { id: "open_shortcuts", group: "global", defaults: [], labelKey: "shortcuts.action.open_shortcuts" },
  { id: "open_crew", group: "global", defaults: [], labelKey: "shortcuts.action.open_crew" },
  { id: "open_files", group: "global", defaults: [], labelKey: "shortcuts.action.open_files" },

  // Since the Actions palette (ADR 0165) `prefix+g` opens Actions; the pane list keeps its action, unbound.
  { id: "switch_pane", group: "navigation", defaults: [], labelKey: "shortcuts.action.switch_pane" },
  { id: "open_dashboard", group: "navigation", defaults: ["prefix+q"], labelKey: "shortcuts.action.open_dashboard" },
  { id: "new_space", group: "navigation", defaults: ["prefix+shift+n"], labelKey: "shortcuts.action.new_space" },
  { id: "new_agent", group: "navigation", defaults: [], labelKey: "shortcuts.action.new_agent" },
  { id: "rename_space", group: "navigation", defaults: [], labelKey: "shortcuts.action.rename_space" },
  { id: "previous_space", group: "navigation", defaults: ["prefix+k"], labelKey: "shortcuts.action.previous_space" },
  { id: "next_space", group: "navigation", defaults: ["prefix+j"], labelKey: "shortcuts.action.next_space" },
  { id: "navigate_mode", group: "navigation", defaults: ["prefix+w"], labelKey: "shortcuts.action.navigate_mode", opensMode: "navigate" },
  { id: "navigate_down", group: "navigation", defaults: ["j", "down"], labelKey: "shortcuts.action.navigate_down", scope: "navigate" },
  { id: "navigate_up", group: "navigation", defaults: ["k", "up"], labelKey: "shortcuts.action.navigate_up", scope: "navigate" },
  { id: "navigate_open", group: "navigation", defaults: ["enter"], labelKey: "shortcuts.action.navigate_open", scope: "navigate", leavesMode: true },

  { id: "new_tab", group: "tabs", defaults: ["prefix+c"], labelKey: "shortcuts.action.new_tab" },
  { id: "previous_tab", group: "tabs", defaults: ["prefix+p"], labelKey: "shortcuts.action.previous_tab" },
  { id: "next_tab", group: "tabs", defaults: ["prefix+n"], labelKey: "shortcuts.action.next_tab" },
  { id: "switch_tab", group: "tabs", defaults: ["prefix+1..9"], labelKey: "shortcuts.action.switch_tab", indexed: true },
  { id: "new_shell", group: "tabs", defaults: [], labelKey: "shortcuts.action.new_shell" },
  { id: "rename_tab", group: "tabs", defaults: [], labelKey: "shortcuts.action.rename_tab" },
  { id: "close_tab", group: "tabs", defaults: [], labelKey: "shortcuts.action.close_tab", destructive: true },

  { id: "focus_pane_left", group: "panes", defaults: ["prefix+h"], labelKey: "shortcuts.action.focus_pane_left" },
  { id: "focus_pane_right", group: "panes", defaults: ["prefix+l"], labelKey: "shortcuts.action.focus_pane_right" },
  { id: "cycle_pane_next", group: "panes", defaults: ["prefix+tab"], labelKey: "shortcuts.action.cycle_pane_next" },
  { id: "cycle_pane_previous", group: "panes", defaults: ["prefix+shift+tab"], labelKey: "shortcuts.action.cycle_pane_previous" },
  { id: "remove_from_view", group: "panes", defaults: ["prefix+x"], labelKey: "shortcuts.action.remove_from_view" },
  { id: "resize_mode", group: "panes", defaults: ["prefix+r"], labelKey: "shortcuts.action.resize_mode", opensMode: "resize" },
  { id: "resize_narrower", group: "panes", defaults: ["h", "left"], labelKey: "shortcuts.action.resize_narrower", scope: "resize" },
  { id: "resize_wider", group: "panes", defaults: ["l", "right"], labelKey: "shortcuts.action.resize_wider", scope: "resize" },
  { id: "rename_pane", group: "panes", defaults: [], labelKey: "shortcuts.action.rename_pane" },
  { id: "pin_pane", group: "panes", defaults: [], labelKey: "shortcuts.action.pin_pane" },
  { id: "pane_settings", group: "panes", defaults: [], labelKey: "shortcuts.action.pane_settings" },
  { id: "close_pane", group: "panes", defaults: [], labelKey: "shortcuts.action.close_pane", destructive: true },

  { id: "zen_mode", group: "view", defaults: ["prefix+z"], labelKey: "shortcuts.action.zen_mode" },
  { id: "toggle_sidebar", group: "view", defaults: ["prefix+b"], labelKey: "shortcuts.action.toggle_sidebar" },
  { id: "toggle_chat_terminal", group: "view", defaults: ["prefix+t"], labelKey: "shortcuts.action.toggle_chat_terminal" },
  { id: "focus_composer", group: "view", defaults: ["prefix+i"], labelKey: "shortcuts.action.focus_composer" },
  { id: "find", group: "view", defaults: ["prefix+/"], labelKey: "shortcuts.action.find" },
  { id: "copy_output", group: "view", defaults: [], labelKey: "shortcuts.action.copy_output" },
  { id: "conversation_history", group: "view", defaults: [], labelKey: "shortcuts.action.conversation_history" },
  { id: "walky_messages", group: "view", defaults: [], labelKey: "shortcuts.action.walky_messages" },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]["id"];
