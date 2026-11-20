# Keyboard shortcuts

Drive Collie from a keyboard the way you drive Herdr: press a prefix key, then one action key.
This page lists every action, its default keys, and how to change them in `shortcuts.toml`.

## Who it is for

The shortcuts are for a desktop browser, or a tablet with a hardware keyboard. A phone with no
keyboard never needs them. Nothing changes for you until a key press reaches the page.

The first time a hardware key press reaches the page, a small card at the top right says
"You have a keyboard" and names the prefix. It is gone for good once you close it, open the
[shortcut list](terminology.md#shortcut-list) from it, or press the prefix.

Open the shortcut list with the prefix, then `?`. On a wide window you can also open it from
**Settings → Device → Keyboard shortcuts**. That row shows once the device has seen a key press.

## The prefix

The prefix is one key that says "the next key is for Collie". It is `Ctrl+B` by default, the same
as Herdr ([prefix key](terminology.md#prefix-key)).

```text
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

## Navigate mode and Resize mode

A mode stays on until you press `Esc` or `Enter`. The bar shows its name and its keys.

| Mode | Open with | Keys inside |
| --- | --- | --- |
| [Navigate mode](terminology.md#navigate-mode) | `prefix+w` | `h` `l` move between panes, `j` `k` between spaces, `1` to `9` pick a tab |
| [Resize mode](terminology.md#resize-mode) | `prefix+r` | `h` makes the pane narrower, `l` makes it wider |

The arrow keys do the same as `h`, `j`, `k` and `l`. In Navigate mode the move happens at once, as
it does with the prefix keys, and the mode stays on. A mode opens only where it has something to
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
| `switch_pane` | `prefix+g` | Navigation | Opens the list of panes to switch to. On a narrow screen that is the Switch pane sheet, on a large screen the sidebar. | [Pane](terminology.md#pane) |
| `open_dashboard` | `prefix+q` | Navigation | Goes to the dashboard. | - |
| `new_space` | `prefix+shift+n` | Navigation | Opens the New page, to start a new space. | [Space](terminology.md#space) |
| `previous_space` | `prefix+k` | Navigation | Goes to the space before this one. | [Space](terminology.md#space) |
| `next_space` | `prefix+j` | Navigation | Goes to the space after this one. | [Space](terminology.md#space) |
| `navigate_mode` | `prefix+w` | Navigation | Opens Navigate mode. | [Navigate mode](terminology.md#navigate-mode) |
| `navigate_left` | `h`, `left` | Navigation | In Navigate mode: moves to the previous pane. | [Pane](terminology.md#pane) |
| `navigate_down` | `j`, `down` | Navigation | In Navigate mode: moves to the next space. | [Space](terminology.md#space) |
| `navigate_up` | `k`, `up` | Navigation | In Navigate mode: moves to the previous space. | [Space](terminology.md#space) |
| `navigate_right` | `l`, `right` | Navigation | In Navigate mode: moves to the next pane. | [Pane](terminology.md#pane) |
| `navigate_tab` | `1..9` | Navigation | In Navigate mode: goes to the tab with that number. | [Tab](terminology.md#tab) |
| `new_tab` | `prefix+c` | Tabs | Makes a new tab in this space. | [Tab](terminology.md#tab) |
| `previous_tab` | `prefix+p` | Tabs | Goes to the tab before. From the first tab it wraps to the last. | [Tab](terminology.md#tab) |
| `next_tab` | `prefix+n` | Tabs | Goes to the tab after. From the last tab it wraps to the first. | [Tab](terminology.md#tab) |
| `switch_tab` | `prefix+1..9` | Tabs | Goes to the tab with that number. | [Tab](terminology.md#tab) |
| `focus_pane_left` | `prefix+h` | Panes | Moves to the previous pane of the row. | [Row of panes](terminology.md#row-of-panes) |
| `focus_pane_right` | `prefix+l` | Panes | Moves to the next pane of the row. | [Row of panes](terminology.md#row-of-panes) |
| `cycle_pane_next` | `prefix+tab` | Panes | Moves to the next pane, and from the last to the first. | [Row of panes](terminology.md#row-of-panes) |
| `cycle_pane_previous` | `prefix+shift+tab` | Panes | Moves to the previous pane, and from the first to the last. | [Row of panes](terminology.md#row-of-panes) |
| `remove_from_view` | `prefix+x` | Panes | Takes the pane out of the row. The agent keeps running. | [Remove from view](terminology.md#remove-from-view) |
| `resize_mode` | `prefix+r` | Panes | Opens Resize mode. | [Resize mode](terminology.md#resize-mode) |
| `resize_narrower` | `h`, `left` | Panes | In Resize mode: makes the pane narrower. | [Resize mode](terminology.md#resize-mode) |
| `resize_wider` | `l`, `right` | Panes | In Resize mode: makes the pane wider. | [Resize mode](terminology.md#resize-mode) |
| `zen_mode` | `prefix+z` | View | Turns zen mode on or off, where the pane's menu offers it. | - |
| `toggle_sidebar` | `prefix+b` | View | Folds the sidebar to its rail, or opens it. | - |
| `toggle_chat_terminal` | `prefix+t` | View | Switches the pane between Chat and Terminal. | - |
| `focus_composer` | `prefix+i` | View | Puts the cursor in the composer. | - |
| `find` | `prefix+/` | View | Opens the find bar of the terminal view. | - |

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

The bridge reads the file again when it changes, with no restart. Reload the page to see it.
`shortcuts.toml.example` lists every action and its default as a commented line.

A bad line is dropped, and the rest of the file still loads. A bad `prefix` falls back to
`ctrl+b`. When two of your lines claim one key, the first wins. The shortcut list shows each
dropped line and the reason, in a note at its foot.

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
`ctrl+tab`, `ctrl+shift+tab`, `ctrl+shift+n`, `ctrl+shift+t`, `ctrl+shift+w` and `ctrl+l`, with
`cmd` in place of `ctrl` on a Mac. A direct binding on one of them is refused and named in the
shortcut list. Behind the prefix they are free: `prefix+ctrl+w` works.

## Herdr names

You can copy a `[keys]` block from your Herdr `config.toml`. The names Herdr and Collie share
work as they are: `help`, `settings`, `new_tab`, `previous_tab`, `next_tab`, `switch_tab`,
`focus_pane_left`, `focus_pane_right`, `cycle_pane_next`, `cycle_pane_previous`, `resize_mode` and
`toggle_sidebar`.

Collie names some actions after its own words ([Terminology](terminology.md)), so it does not take
Herdr's name for them. Write the Collie name:

| Herdr name | Write in Collie |
| --- | --- |
| `new_workspace` | `new_space` |
| `workspace_picker` | `navigate_mode` |
| `goto` | `switch_pane` |
| `zoom` | `zen_mode` |
| `previous_workspace` | `previous_space` |
| `next_workspace` | `next_space` |
| `navigate_workspace_up` | `navigate_up` |
| `navigate_workspace_down` | `navigate_down` |
| `navigate_pane_left` | `navigate_left` |
| `navigate_pane_right` | `navigate_right` |

Any other Herdr name has no equal in Collie, for example `close_pane`, `detach`, `focus_pane_up`
and `focus_pane_down`. Herdr moves to the pane above or below in a split. Collie shows panes
side by side in a row, with none above or below, so `previous_space` and `next_space` are a
different move. Collie drops a Herdr name it does not take, and the shortcut list names it. It says
which Collie name to write, or that Collie has no such action.

## Every shortcut has a control on screen

A shortcut is a second way to reach something. It is never the only way. Each action above has a
button, a mark or a menu entry that does the same, so you can do everything with no keyboard.
`help` has its row in **Settings → Device**, and `shortcuts.toml` reloads by itself, so it needs
no reload action.

See also [Configure](configure.md#keyboard-shortcuts) for `shortcuts.toml` beside the other files.
