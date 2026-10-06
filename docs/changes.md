# Changes: see what an agent changed

The Files screen shows a workspace's folder, with what changed in its git repos since the last commit
marked on it. You read it on your phone while the agent works: the changed files, their added and
removed lines, and each file's diff with syntax colour. When the agent has already committed, it
shows the last commit. A control under the header switches between **All files**, the folder as a
tree, and **Changes**, the list of changed files alone ([below](#the-all-files--changes-control)).

> **Note.** Files only reads. It never stages, commits, edits or checks out a file
> ([below](#read-only-and-safe)).

## Open it

There are two ways in.

- **From a pane.** Tap the Files button on the pane's actions belt, the tree icon left of the Switch
  mark. The screen covers the pane's whole workspace and marks the pane's own repo.
- **From the dashboard.** Tap **Files** in the dashboard's footer, after **Dashboard** (and
  **Crew** before it, when you run a crew). It lists one row per workspace with its changed-file count and the summed added and
  removed lines. A workspace with no changes stays in its place, dimmed. Tap a row to open that
  workspace's Files screen.

The dashboard counts refresh every 5 seconds, and only while the Files tab is on screen. The tab
you pick is kept per device.

## The list

The Changes segment shows a list that groups the changed files by git repo. Each file shows its status and its `+added −removed`
line counts.

| Status | Meaning |
| --- | --- |
| Modified | A tracked file changed |
| Added | A new file, staged |
| Deleted | A tracked file is gone |
| Renamed | A file moved; its diff names the old path |
| Untracked | A new file git does not track yet |

- **The base is the last commit.** Staged and unstaged changes show together. A repo with no commits
  is compared against an empty tree.
- **A new file** shows as all added lines. **A new folder** is one entry: Collie says the folder is
  new and does not list the files inside it. That keeps a fresh `node_modules` out of the list.
- **A binary file** is listed, but its lines are not shown.
- **This pane.** Opened from a pane, with more than one repo listed, the pane's own repo carries a
  **This pane** label. On the first read, the list scrolls to it.
- **List or Tree.** The **Layout** switch shows the files as one flat list per repo, or as a folder
  tree.
- **Filter files.** The filter button narrows the list by path text and by status. The list then
  says how many of its files are shown.

## Read a diff

Tap a file to read its diff. **Previous file** and **Next file** step through the list without going
back to it.

- The diff shows two line-number gutters, tinted added and removed rows, and lines that wrap.
- Common languages get syntax colour: TypeScript and JavaScript, JSON, CSS, HTML, Markdown, Python,
  Go, Rust, shell, YAML, TOML and more. A file in another language, or a diff over 2000 lines, stays
  plain.
- A very long diff stops at a limit and says so.
- If the agent reverts or commits the file while you read it, the diff stays on screen and its header
  says **No longer changed**. The view never jumps away.

## The last commit

Agents often commit their own work, so the list can be empty right after the change you want to read.
For a repo with no uncommitted changes, the view offers **Show last commit**.

The commit view shows the subject, the author, the time, the short hash and the commit's files, each
with its own diff. It compares the commit with its first parent, so a merge shows what it brought in.
It reads the newest commit only. There is no history browser.

- When the agent commits again, a quiet **A newer commit exists** waits for a tap. The files on
  screen do not change under you.
- When new uncommitted changes appear, **New uncommitted changes** takes you back to the list.

## It stays up to date

An open Changes screen reads git again every 5 seconds while the page is visible. On a diff, the open
file is read again too. A re-read that finds nothing new moves nothing on screen: your scroll, your
filter and your folded folders stay as they are.

- A hidden page stops reading, and reads once when it is visible again.
- The refresh button reads now.
- If two reads in a row fail, the header says **Not updating**, and the last good list stays. The next
  good read clears it.

## Which folder, and which repos

The list covers the pane's **workspace**, not only the pane's own folder, so every pane in one
workspace shows the same list. The header names the workspace and its folder. Collie picks that folder
in this order:

| Order | Folder |
| --- | --- |
| 1 | The workspace's own folder, when the multiplexer keeps one: Herdr's worktree, tmux's session folder |
| 2 | The deepest folder that holds every pane of the workspace |
| 3 | The pane's own folder, when the first two would be `/`, your home folder, or above it |

Collie then finds the repo that holds that folder. It also looks for repos in folders below it, even
repos the parent repo ignores. That is how a workspace repo with its member repos ignored inside it
still shows every member's changes.

Two per-device settings control that search. Both live in **Settings → Device → Changes**.

| Setting | Default | What it does |
| --- | --- | --- |
| Look for repos inside this folder | on | Also lists repos in folders below the workspace folder, even ones the parent repo ignores |
| How deep to look | 2 | How many folder levels below the workspace folder the search goes, 1 to 4 |

The search never follows a symlink. It skips dot-folders and `node_modules`, `dist`, `build`, `vendor`
and `target`. It stops at 20 repos or 5000 folder entries.

When the search stops at its depth and there are repos further down, the list ends with
"Stopped at 2 levels, with repos further down." and a **Look deeper in Settings** link. When it hits
the repo or entry limit, the list ends with "The list hit a limit" instead, because files may be
missing.

A submodule or a nested repo that the search finds shows once, as its own repo. A submodule below the
depth shows as one entry in its parent repo.

## Files

Files opens on the folder it reads, one folder at a time, with the changes marked on
them. The header says **Files** on every level, with the workspace and its folder under it. It needs no git repository, so it works for a shell pane in any folder too. Inside a repository
it also knows which entries git ignores, and hides them for you.

- A changed file shows its status letter, and its icon changes shape and takes the same colour: a
  pen for a changed file, a plus for a new one, a minus for a deleted one. A new file that git does
  not track yet counts as changed, and shows in the same green as an added file.
- A folder with changes inside it shows a dot and the number of changed files.
- A deleted file stays in its folder, struck through, with a **D**. Tap it to see what was removed.
- A folder outside every repository has no marks.

Tap a folder to open it and a file to read it. The path above the rows is a breadcrumb, and each
folder in it is a link. The back arrow goes up one level: from a file to its folder, from a folder
to the one above, and from the top to wherever Files was opened from.

### The All files | Changes control

A two-part control sits directly under the header, in every folder. It looks like the **Diff |
Source | Preview** control on a file. **All files** shows the folder with the changes marked.
**Changes** shows the list of changes alone, grouped by repository, and carries the number of
changed files in a small badge on its corner. The badge is not drawn when nothing changed. Your
choice stays on this device, and **All files** is on at first.

The list starts with a line that names the root folder on the left and the added and removed line
totals on the right. The header has a **Tree** button, which draws the changed files as a folder
tree, a **Filter** button, and a refresh button. Refresh reads the list and the folder again.

### One file

A changed file opens on its **Diff**, with **Source** and, for some types, **Preview** one tap away.
A file that did not change opens on its source or its preview. A deleted file has only its diff, and
a new file shows as all added.

Source is numbered and coloured up to 2000 lines and plain above that. A binary file shows its size
and nothing else. A file over the size limit shows its first part and says so. A symlink shows as a
link row and opens like a file.

Markdown, JSON and HTML files open on a **Preview** when they did not change.

| File | Preview |
| --- | --- |
| `.md`, `.markdown` | Formatted text. Raw HTML in the file stays as text. |
| `.json` | A tree. The first two levels are open and a folded node shows its count. |
| `.html`, `.htm` | The page in a sandboxed frame on a white ground. |

> **Note.** An HTML preview runs no scripts, sends no forms and loads no remote files. A link in the
> page does not open. Pictures stored inside the file as `data:` addresses still draw.

Links in a Markdown preview work. A relative link opens that file or folder, a `#heading` link scrolls
to the heading, and a web link opens in a new tab. A link that leaves the folder reads as plain text.

A JSON file that does not parse shows the error and its source. A tree is not drawn above 5000 values,
and the source shows instead.

In **Changes**, a changed file whose type has a preview, and that is not deleted, shows a
**Preview** button in the header of its diff. It opens the same file screen on Preview.

A folder or a file is read when you open it, and again when you tap refresh. It never updates on a
timer. The change marks follow the list of changes, which updates every 5 seconds while you look.

### Ignored files and the filter

Files hides what git ignores, such as `node_modules`, build output and logs. A quiet line under the
list says how many rows are hidden, with a **Show** action. That line is the switch: once the
ignored rows are shown, it says how many are shown and offers **Hide**. Your choice stays on this
device. The **Filter** button opens a row with a name field and a toggle with its state in words,
**Ignored hidden** or **Ignored shown**, which makes the same choice. The name field narrows the
current folder to the names that hold your text, in any case, and the button shows how many rows are
left. The name filter clears when you open another folder. Ignored rows show in a dimmer ink and
open like any other row.

- Collie asks git once for each folder it lists, and git's own rules decide. A tracked file is never
  ignored, even when an ignore rule matches its name.
- Everything inside an ignored folder is ignored too. A repository cloned inside the workspace
  folder answers by its own rules.
- With no repository, no git, or a git that does not answer within 2 seconds, nothing is hidden and
  the list still shows.
- This is a filter and not a lock. An ignored file still opens, and a request for it is answered like
  any other.

### Who may use it

- **Files needs an authorised device**, the same check as typing into a pane. The check is on only
  when a device is paired ([Security](security.md#pair-a-device--the-write-credential)) or
  `COLLIE_DEVICE_HEADER` is set. Then a device that is not paired, or not on
  `COLLIE_DEVICE_ALLOWLIST`, cannot open Files.
- **Until then, every device that can read panes can use Files.** It can browse the workspace's
  folder and read any file in it, `.env` files included. Pair your phone to close it.
- Changes stays open to any device that can read, because it shows only what changed.

### What it shows, and what it never shows

- Only files under the workspace's folder. A path that leads out of it, also through a symlink,
  is refused. A symlink is listed as a link and opens only when it points inside the folder.
- Never a `.git` folder, and never Collie's own state folder or config folder, also when they sit
  inside the workspace's folder. They are left out of the list, and a request for them is refused.
- Never a file named like a Collie state secret, such as `paired-devices.json` or
  `crew-trust.json`, wherever it sits. This hides the secrets of a second Collie on the same machine.
- Dot-files such as `.env` are shown. They are your own files. This includes the `.env` of a second
  Collie when the folder holds its config folder.
- **Credential files are shown.** A workspace opened in `~/.claude`, `~/.codex`, `~/.config/gh` or
  `~/.ssh` shows the files there, keys and tokens included.
- **A hard link is not caught.** A hard link inside the folder to a file outside it opens like any
  other file in the folder.
- A refused file gets the same answer as a missing one.

### Limits

- **2000 entries per folder.** A larger folder shows its first 2000 and says it was cut.
- **1 MiB per file.** A larger file shows its first 1 MiB and says it was cut.
- **Binary files show no text.** A file with a NUL byte in its first 8000 bytes counts as binary, git's
  own rule.
- **No folder, no files.** A workspace whose folder is your home folder, a folder above it, or `/`
  shows no folder. Files says so and offers **Show changes** when it still has a list of
  changes. A zellij pane has no Files button. A workspace folder that is a symlink to one of those
  counts as that folder.

The full rules are in [ADR 0083](../.adr/0083-the-files-view-reads-the-changes-root.md).

## Read-only and safe

Changes runs git to read, and nothing else.

- It never stages, commits, edits or checks out. It does not even refresh git's index cache.
- A repo's own hooks, filters, external diff programs and text conversions never run while Collie
  reads it. An agent may have cloned anything, and you only tapped Changes.
- It never touches the network, not even to fetch a missing file in a partial clone. That file then
  shows with zero counts and an empty diff.
- A diff is served only for a file git itself listed as changed, in a repo the search found.

The full rules are in [ADR 0065](../.adr/0065-the-changes-view-reads-git-read-only.md).

## Across a crew

In a [crew](crew.md), a pane or workspace on another machine is read on that machine. The lead
forwards the request, and that machine's git answers. That machine must run Collie 1.13.0 or later.
Files reads that machine's own disk, under that machine's own device rules, and needs Collie 1.17.0
or later there. A member that is older, or one whose git does not answer, sends no ignored marks, so
Files hides nothing for it.

## Limits

- **zellij panes have no Files button.** zellij does not report a pane's folder. The dashboard row
  for a zellij workspace reads "No folder".
- **Git must be installed** on the machine that owns the pane.
- **Git LFS files may show as modified.** With filters off, Collie compares an LFS file with its
  pointer. It can only show too much, never hide a change.
- **One workspace, one folder.** A workspace whose panes sit in unrelated folders under your home folder
  reads the asking pane's own folder instead of a merged view.
