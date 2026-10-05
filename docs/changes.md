# Changes: see what an agent changed

The Changes view shows what changed in a workspace's git repos since the last commit. You read it
on your phone while the agent works: the changed files, their added and removed lines, and each
file's diff with syntax colour. When the agent has already committed, it shows the last commit.

> **Note.** Changes only reads. It never stages, commits, edits or checks out a file
> ([below](#read-only-and-safe)).

## Open it

There are two ways in.

- **From a pane.** Tap the Changes button on the pane's actions belt, the icon left of the Switch
  mark. The list covers the pane's whole workspace and marks the pane's own repo.
- **From the dashboard.** Tap **Changes** in the dashboard's footer, beside **Panes** and
  **Focus**. It lists one row per workspace with its changed-file count and the summed added and
  removed lines. A workspace with no changes stays in its place, dimmed. Tap a row to open that
  workspace's list.

The dashboard counts refresh every 5 seconds, and only while the Changes tab is on screen. The tab
you pick is kept per device.

## The list

The list groups the changed files by git repo. Each file shows its status and its `+added −removed`
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

Files is the second tab on the Changes screen. It browses the folder Changes reads, one folder at a
time, and shows a file as text. It needs no git repository, so it works for a shell pane in any
folder too. Inside a repository it also knows which entries git ignores, and hides them for you.

Tap **Files** at the top of Changes. Tap a folder to open it and a file to read it. The path above the
rows is a breadcrumb, and each folder in it is a link. The back arrow goes up one level: from a file
to its folder, from a folder to the one above, and from the top to wherever Changes goes.

A file opens as numbered, coloured source. Source is coloured up to 2000 lines and plain above that.
A binary file shows its size and nothing else. A file over the size limit shows its first part and
says so. A symlink shows as a link row and opens like a file.

Markdown, JSON and HTML files open on a **Preview**, with **Source** one tap away.

| File | Preview |
| --- | --- |
| `.md`, `.markdown` | Formatted text. Raw HTML in the file stays as text. |
| `.json` | A tree. The first two levels are open and a folded node shows its count. |
| `.html`, `.htm` | The page in a sandboxed frame on a white ground. |

> **Note.** An HTML preview runs no scripts, sends no forms and loads no remote files. A link in the
> page does not open. Pictures stored inside the file as `data:` addresses still draw.

A JSON file that does not parse shows the error and its source. A tree is not drawn above 5000 values,
and the source shows instead.

A changed file whose type has a preview, and that is not deleted, shows a **Preview** button in the
header of its diff. It opens the same file in Files.

Files reads when you open a folder or a file, and again when you tap refresh. It never updates on a
timer.

### Ignored files and the filter

Files hides what git ignores, such as `node_modules`, build output and logs. A quiet line under the
list says how many rows are hidden, with a **Show** action.

The **Filter** button in the header opens a row with a name field and one chip, **Ignored**. The
name field narrows the current folder to the names that hold your text, in any case, and the button
shows how many rows are left. The name filter clears when you open another folder. The **Ignored**
chip turns the hidden rows on and off, and your choice stays on this device. Ignored rows show in a
dimmer ink and open like any other row.

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
- **No folder, no Files.** A workspace whose folder is your home folder, a folder above it, or `/`
  has no Files tab, and neither has a zellij pane. A workspace folder that is a symlink to one of those
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

- **zellij panes have no Changes button.** zellij does not report a pane's folder. The dashboard row
  for a zellij workspace reads "No folder".
- **Git must be installed** on the machine that owns the pane.
- **Git LFS files may show as modified.** With filters off, Collie compares an LFS file with its
  pointer. It can only show too much, never hide a change.
- **One workspace, one folder.** A workspace whose panes sit in unrelated folders under your home folder
  reads the asking pane's own folder instead of a merged view.
