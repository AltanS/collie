# Keyboard shortcuts

Drive Collie from a keyboard the way you drive Herdr: press a prefix key, then one action key.
This page lists every action, its default keys, and how to change them in `shortcuts.toml`.

## Who it is for

The shortcuts are for a desktop browser, or a tablet with a hardware keyboard. A phone with no
keyboard never needs them. Nothing changes for you until a key press reaches the page.

The first time a key that only a hardware keyboard makes reaches the page, a small card at the top
right, under the header, says "You have a keyboard". It says that Collie takes Herdr's keys, and it
names the key for the shortcut list, the prefix and then `?`. Such a key is a letter, `Ctrl`, `Alt`,
`Cmd`, `Esc` or an F key, pressed while the on-screen keyboard is down. A phone's on-screen keyboard
never counts. The card has a **Show shortcuts** button and a close button. It waits while a sheet,
the idle lock or the shortcut bar is up, and it is gone for good once you close it, open the
[shortcut list](terminology.md#shortcut-list) from it, or press the prefix. If you unbind `help`,
the card leaves out the sentence about the key for the list.

Open the shortcut list with the prefix, then `?`. You can also open it from
**Settings → Keys and touch → Keyboard shortcuts**. That row shows once the device has seen such a key press.

The bar and the list follow the screen you are on. On the dashboard the bar names no tab or pane
key. The list opened with `?` shows what works here first, and ends with a section called "Not on
this screen" that holds the rest, dimmed, with their keys. The list opened from Settings is complete
and plain. A key that does nothing on this screen does nothing to the page, and the bar says "Not on
this screen" for two seconds.

## The prefix

The prefix is one key that says "the next key is for Collie". It is `Ctrl+B` by default, the same
as Herdr ([prefix key](terminology.md#prefix-key)).

```text
Ctrl+B   then   g      Actions: search the commands and the panes
Ctrl+B   then   s      open Settings
Ctrl+B   then   c      a new tab in this space
Ctrl+B   then   ?      the shortcut list
```

Press the prefix, let go, then press one action key. The prefix waits for as long as you like.

- Press the prefix twice to send `Ctrl+B` itself to the pane you are looking at.
- Press `Esc` to cancel the prefix.
- Press a key that is not an action and the prefix ends. The key does nothing.
- Press a key that is not for Collie, with no prefix, and it goes to the page as usual. The
  composer keeps its Enter and a sheet keeps its Escape.

While the prefix waits, a bar along the foot of the window names the mode and the keys that work
next. It follows the keys you set. `Esc` cancels it.

While the prefix waits, each control shows its key. A small key cap sits on the corner of the Actions
button, the Settings gear, the new-tab "+", each numbered tab, the three dots of the pane menu, the space
arrows, the New space button at the head of the dashboard's Spaces list, the sidebar's fold button
and the others that a key presses. On a control that is a bare icon in
a larger box, the cap stands beside the icon and touches it, never over the icon or a word. The cap shows the key you set, and nothing for an action
with no key. A key with Shift shows as one cap, `⇧N`. It shows only on a control that you can see, and
only where the key works on this screen. In a row of panes it shows on the focused pane. A sheet or the
Actions list that is open covers the page, and then only the controls inside it show a key.

## Navigate mode and Resize mode

A mode stays on until you press `Esc`. In Resize mode `Enter` leaves too, and in Navigate mode
`Enter` opens the row and leaves. The bar shows its name and its keys. A mode also stays on while the
screen changes under it, and it ends when the window loses focus, or when the new screen has no key
of the mode that can act.

| Mode | Open with | Keys inside |
| --- | --- | --- |
| [Navigate mode](terminology.md#navigate-mode) | `prefix+w` | `j` `k` move the focus ring in the sidebar, `Enter` opens the row |
| [Resize mode](terminology.md#resize-mode) | `prefix+r` | `h` makes the pane narrower, `l` makes it wider |

`prefix+w` focuses the sidebar. It opens the sidebar if it was hidden. A focus ring sits on the row
of the current pane. `j` and `k`, or the arrow keys, move the ring. They move only the ring, and the
view does not change. `Enter` opens the row, as a tap on it would, and leaves the mode. `Esc` leaves
with no change, and hides the sidebar again if the mode opened it.

In Resize mode the arrow keys do the same as `h` and `l`. A mode opens only where it has something to
act on. Resize mode does nothing on a phone or on the dashboard.

The prefix still works inside a mode. A key with `Ctrl` or `Cmd` that the mode does not name, such
as `Ctrl+C`, goes on to the page. A bare key that the mode does not name is swallowed.

## Type mode

Type mode sends each key you press to the terminal ([Type mode](terminology.md#type-mode)). While it
is on, only the prefix is taken, so everything else you type reaches the terminal. A direct binding
such as `ctrl+alt+c` is typing there, and does nothing. The prefix opens its one-shot mode as usual,
and the prefix twice sends `Ctrl+B` to the pane.

## The actions

Every action has a name, which is the name you write in `shortcuts.toml`. A key behind the prefix
is written `prefix+<key>`. A key inside a mode is a bare key.

| Action | Default keys | Group | What it does | Words |
| --- | --- | --- | --- | --- |
| `help` | `prefix+?` | General | Shows the shortcut list. | [Shortcut list](terminology.md#shortcut-list) |
| `settings` | `prefix+s` | General | Opens Settings. | - |
| `open_actions` | `prefix+g` | General | Opens Actions: the commands of this screen and the panes to go to, in one list you search. | [Actions](terminology.md#actions) |
| `open_shortcuts` | - | General | Shows every shortcut, as the Settings row does. | [Shortcut list](terminology.md#shortcut-list) |
| `open_crew` | - | General | Opens Crew, while a crew is set up. | [Crew](terminology.md#crew) |
| `open_files` | - | General | Opens Files for the pane you are in. | - |
| `switch_pane` | - | Navigation | Opens the list of panes to switch to. On a narrow screen that is the Switch pane sheet, on a large screen the sidebar. | [Pane](terminology.md#pane) |
| `open_dashboard` | `prefix+q` | Navigation | Goes to the dashboard. | - |
| `new_space` | `prefix+shift+n` | Navigation | Opens the New page, to start a new space. | [Space](terminology.md#space) |
| `new_agent` | - | Navigation | Opens the New page, as the New button does. | - |
| `rename_space` | - | Navigation | Renames the space you are in, on its page or, on a large screen, in the session view, where its multiplexer takes a rename. | [Space](terminology.md#space) |
| `previous_space` | `prefix+k` | Navigation | Goes to the space before this one. | [Space](terminology.md#space) |
| `next_space` | `prefix+j` | Navigation | Goes to the space after this one. | [Space](terminology.md#space) |
| `navigate_mode` | `prefix+w` | Navigation | Opens Navigate mode. | [Navigate mode](terminology.md#navigate-mode) |
| `navigate_down` | `j`, `down` | Navigation | In Navigate mode: moves the focus ring down one row. | [Navigate mode](terminology.md#navigate-mode) |
| `navigate_up` | `k`, `up` | Navigation | In Navigate mode: moves the focus ring up one row. | [Navigate mode](terminology.md#navigate-mode) |
| `navigate_open` | `enter` | Navigation | In Navigate mode: opens the focused row, then leaves the mode. | [Navigate mode](terminology.md#navigate-mode) |
| `new_tab` | `prefix+c` | Tabs | Makes a new tab in this space. | [Tab](terminology.md#tab) |
| `previous_tab` | `prefix+p` | Tabs | Goes to the tab before. From the first tab it wraps to the last. | [Tab](terminology.md#tab) |
| `next_tab` | `prefix+n` | Tabs | Goes to the tab after. From the last tab it wraps to the first. | [Tab](terminology.md#tab) |
| `switch_tab` | `prefix+1..9` | Tabs | Goes to the tab with that number. | [Tab](terminology.md#tab) |
| `new_shell` | - | Tabs | In a pane, makes a new tab with a shell in this space. On the dashboard, opens the New page with Shell chosen. | [Tab](terminology.md#tab) |
| `rename_tab` | - | Tabs | Renames the tab you are in. | [Tab](terminology.md#tab) |
| `close_tab` | - | Tabs | Opens the tab's menu with Close tab ready. One more tap closes the tab and every pane in it. | [Tab](terminology.md#tab) |
| `focus_pane_left` | `prefix+h` | Panes | Moves to the previous pane of the row. | [Row of panes](terminology.md#row-of-panes) |
| `focus_pane_right` | `prefix+l` | Panes | Moves to the next pane of the row. | [Row of panes](terminology.md#row-of-panes) |
| `cycle_pane_next` | `prefix+tab` | Panes | Moves to the next pane, and from the last to the first. | [Row of panes](terminology.md#row-of-panes) |
| `cycle_pane_previous` | `prefix+shift+tab` | Panes | Moves to the previous pane, and from the first to the last. | [Row of panes](terminology.md#row-of-panes) |
| `remove_from_view` | `prefix+x` | Panes | Takes the pane out of the row. The agent keeps running. | [Remove from view](terminology.md#remove-from-view) |
| `resize_mode` | `prefix+r` | Panes | Opens Resize mode. | [Resize mode](terminology.md#resize-mode) |
| `resize_narrower` | `h`, `left` | Panes | In Resize mode: makes the pane narrower. | [Resize mode](terminology.md#resize-mode) |
| `resize_wider` | `l`, `right` | Panes | In Resize mode: makes the pane wider. | [Resize mode](terminology.md#resize-mode) |
| `rename_pane` | - | Panes | Renames the pane you are in. | [Pane](terminology.md#pane) |
| `pin_pane` | - | Panes | Pins the pane to the top of the lists, or unpins it. | [Pins](terminology.md#pins) |
| `pane_menu` | `prefix+m` | Panes | Opens the pane menu, the three dots in the pane's header, beside them. Up and Down move between its rows, Enter runs one, and Esc closes it. | [Pane menu](terminology.md#pane-menu) |
| `pane_settings` | - | Panes | Opens the pane's settings. | [Pane](terminology.md#pane) |
| `close_pane` | - | Panes | Opens the pane's menu with Close pane ready. One more tap closes the pane. | [Pane](terminology.md#pane) |
| `zen_mode` | `prefix+z` | View | Turns zen mode on or off, where the pane's menu offers it. | - |
| `toggle_sidebar` | `prefix+b` | View | Folds the sidebar to its rail, or opens it. | - |
| `toggle_chat_terminal` | `prefix+t` | View | Switches the pane between Chat and Terminal. | - |
| `focus_composer` | `prefix+i` | View | Puts the cursor in the composer. | - |
| `find` | `prefix+/` | View | Opens the find bar of the terminal view. | - |
| `copy_output` | - | View | Copies the pane's output. | - |
| `conversation_history` | - | View | Opens the agent's conversation history. | - |
| `walky_messages` | - | View | Opens the pane's WalkyTalky messages. | [WalkyTalky](terminology.md#walkytalky) |

An action shown as `-` has no default key. Give it one in `shortcuts.toml`. Each of them is a row of
[Actions](terminology.md#actions), so you can also run it by its name.

An action does something only where its control is on screen. `remove_from_view` and the two
Resize keys work in the large-screen layout ([Large screens](configure.md#large-screens)), and
`find` works in the terminal view. On any other screen the key does nothing, and that is not an
error.

## shortcuts.toml

`shortcuts.toml` holds your own keys. It lives next to `keys.toml`, in the plugin config folder.

```bash
cp shortcuts.toml.example ~/.config/collie/shortcuts.toml
```

```toml
[keys]
prefix = "ctrl+a"                    # the default is "ctrl+b"
new_tab = ["prefix+c", "ctrl+alt+c"] # several bindings for one action
zen_mode = ""                        # unbind
```

The file has one table, `[keys]`. Each name is an action from the table above, or `prefix`.

- A value is a string or a list of strings.
- Your value replaces the default keys of that action whole.
- `""` or `[]` unbinds the action.
- A name you leave out keeps its default keys.
- The limits are 256 names, 64 characters in a name, 8 keys for one action and 64 characters in a key. An entry over a limit is dropped, and a table with more than 256 names loses the names after the 256th.

The bridge reads the file again when it changes, with no restart. Reload the page to see it.
`shortcuts.toml.example` lists every action and its default as a commented line.

A bad line is dropped, and the rest of the file still loads. A bad `prefix` falls back to
`ctrl+b`. When two of your lines claim one key, the first wins. The shortcut list shows each
dropped line and the reason, in a note at its foot.
`collie config check` and `collie doctor` name the dropped lines too, so you can check the file from a terminal.

## The key grammar

A binding is `prefix+<chord>`, or a direct chord with no prefix. A chord is modifiers joined with
`+`, then one key. The grammar is Herdr's. Case does not matter, except that an upper-case letter
adds `shift`.

| Part | Spelling |
| --- | --- |
| Modifiers | `ctrl` (or `control`), `shift`, `alt` (or `option`, `meta`), `cmd` (or `command`, `super`), `mod` |
| `mod` | `cmd` on a Mac, `ctrl` everywhere else |
| Named keys | `space`, `enter`, `esc`, `tab`, `backspace`, `left`, `right`, `up`, `down`, `f1` to `f12` |
| Symbols | `minus`, `comma`, `period`, `slash`, `backslash`, `quote`, `semicolon`, `backtick`, `plus` (or `++`) |
| Digits | `1..9` stands for the nine digits. Only an action that takes a number accepts it. |

A direct chord needs `ctrl`, `alt`, `cmd` or an F key. A bare letter on its own would take a key
out of the composer, so it is refused. Put it behind the prefix instead, as `prefix+<letter>`.

## Keys the browser keeps

The browser owns a few chords, and a page cannot take them: `ctrl+w`, `ctrl+t`, `ctrl+n`,
`ctrl+tab`, `ctrl+shift+tab`, `ctrl+shift+n`, `ctrl+shift+t`, `ctrl+shift+w` and `ctrl+l`. On a Mac
that is also `cmd+w`, `cmd+t`, `cmd+n`, `cmd+l`, `cmd+shift+n`, `cmd+shift+t` and `cmd+shift+w`. A
direct binding on one of them is refused and named in the shortcut list. Behind the prefix they are
free: `prefix+ctrl+w` works.

## Herdr names

You can copy a `[keys]` block from your Herdr `config.toml`. The names Herdr and Collie share
work as they are: `help`, `settings`, `new_tab`, `previous_tab`, `next_tab`, `switch_tab`,
`focus_pane_left`, `focus_pane_right`, `cycle_pane_next`, `cycle_pane_previous`, `resize_mode`,
`toggle_sidebar`, `rename_pane`, `rename_tab`, `close_pane` and `close_tab`. Collie's `close_pane` and
`close_tab` ask first: they open the menu with Close ready, and one more tap closes.

Collie names some actions after its own words ([Terminology](terminology.md)), so it does not take
Herdr's name for them. Write the Collie name:

| Herdr name | Write in Collie |
| --- | --- |
| `new_workspace` | `new_space` |
| `workspace_picker` | `navigate_mode` |
| `goto` | `open_actions` |
| `zoom` | `zen_mode` |
| `previous_workspace` | `previous_space` |
| `next_workspace` | `next_space` |
| `navigate_workspace_up` | `navigate_up` |
| `navigate_workspace_down` | `navigate_down` |
| `rename_workspace` | `rename_space` |

Any other Herdr name has no equal in Collie, for example `close_workspace`, `detach`,
`focus_pane_up` and `focus_pane_down`. Herdr moves to the pane above or below in a split. Collie shows panes
side by side in a row, with none above or below, so `previous_space` and `next_space` are a
different move. Collie drops a Herdr name it does not take, and the shortcut list names it. It says
which Collie name to write, or that Collie has no such action.

## Every shortcut has a control on screen

A shortcut is a second way to reach something. It is never the only way. Each action above has a
button, a mark or a menu entry that does the same, so you can do everything with no keyboard.
`help` has its row in **Settings → Keys and touch**, and `shortcuts.toml` reloads by itself, so it needs
no reload action. The actions with no default key are rows of [Actions](terminology.md#actions).

One key sits outside the table. In Settings, `/` puts the cursor in the search field while no text
field has the focus, so a person can find a setting without the pointer. It is not an action, you
cannot rebind it, and it never fires inside a text field or a dialog. `prefix+/` stays the `find` action
of the terminal view.

See also [Configure](configure.md#keyboard-shortcuts) for `shortcuts.toml` beside the other files.
