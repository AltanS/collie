# Tricks

A trick is a small program on your computer that adds its own parts to Collie. It can put a count on
the Dashboard, a mark on the Belt, or a question on the Hill.

Collie runs the program and reads what it prints. The phone draws that with Collie's own parts, so a
trick never ships a screen. This page is for the person who runs Collie. To write a trick, read
[Writing a trick](tricks-authoring.md).

Here is the smallest trick. It is a shell program that counts your sessions:

```sh
#!/bin/sh
facts=$(cat)
n=$(printf '%s' "$facts" | grep -o '"paneId"' | wc -l | tr -d ' ')
printf '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"icon":"plug","label":"%s","tone":"plain"}}]}\n' "$n"
```

Collie hands the program the facts on stdin. The program prints one JSON document. The phone draws
one mark at the end of the Belt, with the number of sessions on it.

## What a trick can show, and where

A trick draws in five places, and its manifest names which ones it uses.

| Place | Where it is on the phone | One per trick |
| --- | --- | --- |
| `belt` | A mark at the end of the scrolling strip of the Belt. It never takes fixed room | yes |
| `status` | One chip in the status line above the Belt, after Collie's own items | yes |
| `dashboard` | A round tile in the strip at the top of the Dashboard. The strip is hidden while no trick has a tile | yes |
| `tabbar` | An item in the Dashboard's bottom bar, after the Hill | yes |
| `session` | A session of the trick's own: a row on the Dashboard under Tricks, and a screen of its own | no |

Settings → Tricks lists these words in a trick's row, as "Draws in: belt, Dashboard".
The words there are `belt`, `session`, `Dashboard`, `status` and `Bottom bar`.

A tile, an item and a chip show a short label, an icon and a count. They are not buttons. A tap on one
opens the trick's session, when the trick has one. A mark on the Belt can run the trick when you tap
it. A session screen holds text, lists, tables, buttons, pictures and the other kinds
[Writing a trick](tricks-authoring.md#node-kinds) lists.

A trick can also ask you a question. That question is a Decision, and it appears on the
[Hill](hill.md) under the trick's name. Your answer goes back to the trick.

> **Note.** A part that is out of date shows without its colour. A trick tells Collie how long its
> parts stay fresh. After that time the phone shows them as old, and says how old.

## Add a trick

```sh
collie trick add
```

With no name, `collie trick add` lists the official tricks, the tricks of the official repository,
`https://github.com/AltanS/collie-tricks`, and adds nothing. No trick ships inside Collie, and none
is installed by default.

A trick by anyone else is a community trick. It lives in a repository of its own. Collie does not
check a trick's code, official or community: read it before you switch it on.

To add one, name it:

```sh
collie trick add design-review
```

A name means that folder of the official repository. To add a trick from any other https git
repository, give the address, then optionally a folder and a ref:

```sh
collie trick add https://github.com/owner/repo
collie trick add https://github.com/owner/repo//folder
collie trick add https://github.com/owner/repo//folder#v1
```

A ref is a branch, a tag or a full 40-digit commit. An address with a user name or a password is
refused, and so is any address that is not https.

`add` copies the trick into `tricks/` in Collie's config folder. That folder is `~/.config/collie` on
a binary install, and Herdr's plugin config folder on a Herdr-managed install
([Configure](configure.md#the-environment-still-wins)). It then prints the commit it copied and the same warnings as `collie trick check`.
The last line says "The trick is off. Read it, then: collie trick on <id>". The trick stays off until
you switch it on.

| Command | What it does |
| --- | --- |
| `collie trick list` | One row per trick: switch, origin, state, last run and last error. `NEW` in the VERSION column means a new version waits for your yes |
| `collie trick add [<name> \| <url>[//<folder>][#<ref>]]` | Copy a trick from a repository, off. With no source, list the official repository |
| `collie trick update <id> [--ref <ref>] [--dry-run]` | Fetch the same source again and replace the code. `--dry-run` prints the summary and changes nothing |
| `collie trick remove <id>` | Delete a trick that is off, with its state folder and its approved copies |

`update` keeps your `config.toml` and the trick's state folder. A trick that is on keeps running the
version you approved. The new code waits for your yes.

### What a repository may not do

Nothing from the repository runs when you add it. Collie reads the files from git's own objects and
writes each regular file itself. It refuses a symbolic link or a submodule anywhere in the trick's
folder. It refuses a folder with more than 300 files or more than 5 MB. It leaves out dot files,
dot folders and `node_modules/`, because they are outside the code you approve.

## Switch a trick on, off, or remove it

A trick runs only while it is on, and it is off until you switch it on. You switch it on in one of two
places.

1. On the phone, open Settings → Tricks and use the switch in the trick's row.
2. In a shell, run the command.

   ```sh
   collie trick on design-review
   ```

Switching on is your yes to the code as it is now. Collie copies the code to a folder of its own and
runs that copy. The row lists any warnings from a text search of the code before you switch it on.
`collie trick on` prints the same warnings above its confirmation.

```sh
collie trick off design-review
collie trick remove design-review
```

Switching off stops the runs and removes the trick's parts from the phone. It withdraws the trick's
open Decisions too. `remove` works only on a trick that is off.

A trick with a timer runs only while a paired phone is looking. Collie counts a phone as looking for
five minutes after its last request. A trick that calls a paid service every 30 seconds makes no call
while the phone is in your pocket.

### A new version of a trick

Collie runs the approved copy. When you edit the trick's folder, or `update` fetches new code, the
trick keeps running the old version. Its row says "A new version waits for your yes."

A card on the [Hill](hill.md) asks "Use the new version of <name>?". It shows the files that changed
and any new right the version asks for. You have three options.

| Option | What it does |
| --- | --- |
| Use the new version | Approves the code on the card, and the trick runs it |
| Use it and stop asking | The same, and switches on "Take changes without asking". Offered only when the version asks for no new right |
| Keep the old version | Declines it. Collie does not offer that version again |

Switching the trick on again, or `collie trick on <id>`, approves the new version as well.

"Take changes without asking" is a switch in the trick's About sheet, under Updates. The command is
`collie trick auto <id> on`. With it on, a new version is taken without a card only when its powers
did not change and a text search of its code finds no new kind of warning. Otherwise it still waits
for you. A trick that took a change this way shows when, with Undo, which brings back the version
before.

## What a trick may and may not do

A trick runs as you, so it can do what you can do. It cannot do four things that Collie keeps for
you.

| A trick | Rule |
| --- | --- |
| Runs on your machine | It runs as your user, with your files, your tools and your login. Settings says "A trick runs as you." |
| Starts only after your tap | It is off until you switch it on. The switch approves the code as it is now |
| Changes only with your tap | New code waits for your yes. A change of powers always asks again |
| Never types for you | It cannot send a message, press a key, write into a reply box or answer an agent's question |
| Never puts code on your phone | The phone draws data from a closed list of node kinds. A trick sends no script, no HTML and no link to a file |
| Asks only through the Hill | A question is a Decision. Your tap answers it, and a trick cannot answer for you |

**Powers.** A power is something a trick may reach beyond its own code. There are three: the
environment names it asks for (`env`), the places it draws in (`places`), and the files it reads from
your agent sessions (`inputs`). The About sheet lists them. A new version that changes one of them
always asks you again, even with "Take changes without asking" on. Collie's own text also calls a
power a right.

**The environment.** A program gets only the variables a shell tool needs, such as `PATH` and
`HOME`. A trick lists any more it needs by name, and the About sheet shows each name. Collie never
passes a `COLLIE_` or `HERDR_` variable, or any name that ends in `_SOCK` or `_SOCKET`, even when a
trick lists it.

**The warnings.** Before you switch a trick on, Collie searches its code for five things: starting
another program, reaching the network, writing a file outside the trick's own state folder, calling
an agent or a model on a timer, and importing a package Collie does not install. The search is not a
proof. A program can do any of this in a way no pattern sees.

**Limits of a run.** A run has 10 seconds and 64 KiB of output. At most four trick programs run at
once, and taps go first. After a failed run Collie waits 1 minute, then 5, then 30, and then stops
the trick. A new version, a change to `config.toml`, switching it on again, or a tap starts it again.

> **Caution.** Collie's taps protect you from a remote party and from an agent that follows the
> rules. A trick is not sandboxed. Read its code before you switch it on. The rest of the list of what
> a program under your user can do is in
> [What a program running as you can still do](security.md#what-a-program-running-as-you-can-still-do).

An agent does not approve its own trick. `collie trick on` and `collie trick auto <id> on` refuse in a
pane where an agent works, and say so. Run them in a shell pane or in a terminal of your own. The
check is a speed bump, not a lock. Your user account is the real boundary
([An agent does not pair a device](security.md#an-agent-does-not-pair-a-device)).

## The About sheet

The About sheet is what you read before you switch a trick on. Tap the trick's name in Settings →
Tricks to open it.

| Group | What it holds |
| --- | --- |
| The top | The trick's name, its one-line description, and its longer text. Under them: "Written by the trick's author. Collie did not check it." |
| What it does | Only facts Collie knows: "Draws in: ...", the files it reads, "Asks for the environment names ...", and the warnings of the text search |
| Where it comes from | "From owner/repo @ 3f2a91c" for a trick added from a repository, or "Added on this machine." |
| Updates | The "Take changes without asking" switch, for a trick that is on |

The description and the longer text are the author's own words, and nothing checks them against the
code. The rows under "What it does" come from the manifest and the code search, so read those first.
A trick with no text shows "This trick has no description."

## Tricks in a crew

A crew's lead runs the tricks. A member runs none, and its Settings says "Tricks run on the lead of
this crew. This machine runs none." Add a trick on the lead's machine.

On the lead, a trick sees the sessions of every machine in the crew. It can also read files from the
agent sessions of every machine, if its manifest lists them. Each member decides whether to allow
that, and the lead asks each member again for each read
([Tricks that read files on every machine](crew.md#tricks-that-read-files-on-every-machine)).

An agent on a member machine can still put a Decision on the lead's Hill
([Decisions from any machine](crew.md#decisions-from-any-machine)).

## Troubleshooting

Most problems show in the trick's row in Settings → Tricks, or in `collie trick list`.

| What you see | What it means and what to do |
| --- | --- |
| No Tricks section in Settings | The config folder has no `tricks/` folder yet. `collie trick add` or `collie trick init <id>` makes it, and the section shows on the next refresh |
| "Manifest refused: ..." | `trick.toml` has an error. Run `collie trick check <folder>` and fix each line it prints |
| "A new version waits for your yes." | The folder moved past the approved copy. Open the card on the Hill, or run `collie trick on <id>` |
| "The approved copy changed on disk, so the trick stopped. Switch it on again to approve its code as it is now." | A program edited the approved copy. Read the code, then switch the trick on again |
| "The approved copy holds a symbolic link, so the trick stopped. ..." | A trick holds regular files only. Replace the link in the folder, then switch it on again |
| "No version of this trick is approved yet. Switch it on again to approve its code as it is now." | The switch file has no approved code for the trick. Switch it on again |
| "Stopped after repeated failures" | The program failed after 1, 5 and 30 minutes. Fix it, then switch it off and on, or tap its mark |
| "Last run failed" | The last run failed and the phone keeps the last good version. The line has "Why", which shows the error, and "Copy for an agent", which copies it |
| "This Collie cannot draw this part" | The trick uses a kind a crew member's older Collie does not know. Update Collie |
| "The Hill is off: this trick's Decisions are not shown." | The Hill is off. Switch it on in Settings → Alerts, or run `collie hill on` |
| "Tricks run on the lead of this crew. This machine runs none." | You are on a member. Switch tricks on from the lead |
| "Could not switch <name>. Try again." | The phone could not write the switch. Check that the device may write, and that the bridge answers |
| "error: collie trick on is a person's yes to the code, and this runs in a pane where an agent works." | An agent ran the command. Run it in a shell pane, or tap the switch on the phone |
| "a trick <id> is already in <folder>. To fetch it again: collie trick update <id>" | The id is taken. Use `update`, or `remove` the old one first |
| "<id> is on. Switch it off first: collie trick off <id>" | `remove` works only on a trick that is off |
| "This trick needs a newer Collie: it is written for trick contract 3, and this Collie knows contract 2. Update Collie to run it." | The trick was written for a later Collie. Run `collie update` |
| "The trick is busy. Try again in a moment." | A tap came while another waited. Tap again |
| "The bridge restarted while this tap ran. It may have done its work; nothing ran again." | The bridge restarted during a tap. Check the result, then tap again if needed |
| "A decision is answered on the Hill, not with a tap." | A Decision's card is answered on the Hill, not from the trick's session |

A trick that runs but shows nothing on a timer may be waiting for a phone. Open the app, and give it a
minute.

To find out why a trick does what it does, read it. `collie trick check <folder>` lists what its code
starts and reaches, and `collie trick dev <folder>` runs it once and prints what the phone would
draw. Both are in [Writing a trick](tricks-authoring.md#try-a-trick-and-check-it).

## Where to go next

- [Writing a trick](tricks-authoring.md), for the person or agent who writes one.
- [The Hill](hill.md), for the Decisions a trick or an agent asks you.
- [Crews](crew.md), for tricks that read files on every machine.
- [Security](security.md), for what a program under your user can still do.
