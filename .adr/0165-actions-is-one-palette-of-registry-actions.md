# 0165: Actions is one palette of registry actions

- **Status:** Accepted (2026-11-20)
- **Date:** 2026-11-20
- **Trail:** The operator's pick of 2026-11-20, option 1 "Recent and suggested" of the design round
  `actions-palette` (three options: Recent and suggested, all commands in groups, the field alone), and
  his rule of the same day that a command shows only where it works. Roads turned down: a second sheet
  of commands beside the pane menu, a palette with its own list of which command belongs to which
  screen, and keeping `prefix+g` on Switch pane. Files: `web/src/components/actions-palette.tsx`,
  `web/src/lib/actions-palette/`, `web/src/lib/recent-panes.ts`, `web/src/lib/shortcuts/actions.ts`,
  `web/src/lib/shortcuts/herdr-names.ts`, `web/src/components/actions-row.tsx` (the Belt's pinned pill),
  `web/src/components/agent-chat.tsx`, `docs/keyboard-shortcuts.md`

## Context

Collie's acts were spread over a pane menu, a tab menu, a space menu, the Belt and the header. A person
who knew what to do had to know where it lived. M108 gave each act on a desktop a key, through one table
of actions and a registry that knows which act answers on the screen in view
(`isShortcutActionAvailable`). A phone has no keys, and most acts had no key either.

The Belt's pinned pill opened the Switch pane sheet, the list of panes. The same sheet opens from a drag
up on the Belt and from the pane-nav handle.

## Decision

**One palette, Actions, lists the commands that work on this screen and the panes to go to, and every
command in it is an action of the shortcut table.**

- **The Belt's pinned pill opens Actions.** Its place is unchanged; its glyph is the "search actions"
  key (`open-actions`) and its name is Actions. The drag up on the Belt and the pane-nav handle keep
  opening Switch pane. The dashboard's header and the large screen's space header get an Actions
  button, because neither has the Belt's pill.
- **`prefix+g` opens Actions.** `open_actions` is a global action on every screen. `switch_pane` stays
  an action with no default key, so a person who wants it binds it in `shortcuts.toml`. Herdr's `goto`
  names `open_actions`.
- **A command is a registry action, and the registry decides where it shows.** The palette lists a
  command only while its handler answers (`useAvailableShortcutActions`), and a handler registers where
  its control lives: the pane view, the tab strip, the space strip, the root. The palette keeps no list
  of screens. Commands that had no key get an action with `defaults: []`, so each can also be bound.
- **Running a command runs its handler, the same function its menu row calls.** A destructive action
  carries `destructive: true` in the table. Its handler opens the menu with the confirm armed and closes
  nothing itself; the palette never highlights such a row first, so Enter or Go never reaches one.
- **Before typing: Recent, then Suggested.** Recent is the last four panes this device showed, newest
  first, the open pane left out, stored on the device and wiped with the pairing. Suggested is four
  commands for the screen, taken from a short list in order, the first four that answer.

## Consequences

- A new act that should be searchable is one row in the table, one handler where its control is, and
  one row in `PALETTE_COMMANDS`. It shows only where its handler registers.
- The pane list lost its one-tap door on the Belt. It keeps the drag, the handle, and the Switch pane
  row of Actions. If people miss the tap, the answer is a pane row in Recent, not a second pill.
- Rename space works only on the space's page, where the space strip registers it; the dashboard does
  not ask which space. A palette that asks would be a second rename flow.
- Revisit when a command needs an argument the screen cannot supply (a target pane, a folder): the
  palette has no second step today.
