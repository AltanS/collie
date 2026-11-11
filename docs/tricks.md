# Tricks

A trick adds its own parts to ColliePWA on your phone: a count, a question, or a whole screen.

Collie is a web app for your phone. It lets you watch and answer the AI coding agents that run in the
terminals of your computer. A trick extends Collie. It is a folder on your computer: a small program,
or rules for an agent, or both. What it shows on the phone is drawn by Collie, in Collie's own look.

This page explains how tricks work, in the order of the animated page
[How tricks work](https://colliepwa.dev/tricks/how-it-works). Every place, part, manifest key, limit
and command is listed once, in the [Tricks reference](tricks-reference.md). To write a trick, read
[Write a trick](tricks-authoring.md).

## What a trick is

A trick is a folder that Collie runs or hands to an agent, and the phone draws what comes back.

Tricks need no cloud service from Collie. The phone talks to your own machine. Five paths carry
everything:

1. The phone talks only to the bridge, Collie's own program on your machine, over your private network.
2. The bridge runs a trick's program and reads the data it prints.
3. The bridge types a line into an agent session: a terminal pane where an agent such as Claude Code
   works.
4. An agent runs a `collie` command in its own pane, and the bridge knows which pane asked.
5. You tap on the phone. Every yes on this page is a tap of yours.

## Where a trick can show

A trick can show in seven places on the phone, and nowhere else.

A place is a spot on the phone where a trick can show (a surface). Collie owns every place. A trick
names the places it wants in its manifest, and its parts appear there, drawn by the phone with
Collie's own look.

- **Five places take a program's parts.** On the Dashboard: a tile in the strip at the top, a row
  under Tricks that opens the trick's own Page, and an item in the bottom bar. In an agent
  session: a chip in the status line, and a mark at the end of the Belt.
- **The agent view is the sixth.** It is a view of one agent session, beside Terminal and Chat, and
  that session's own agent draws it.
- **The Hill is the seventh, and it is built in.** It is the page of questions that wait for you. A
  trick posts a question there, a Decision, and does not list the Hill in its `places`.

The [Places](tricks-reference.md#places) section of the reference describes each place: where it
shows, what it takes, what a tap does, its limits and an example.

A tile, an item and a chip are not buttons. A tap on one opens the trick's Page, when the trick has
one. A mark on the Belt can run the trick when you tap it. A button on a Page runs the
trick's program once, with your tap.

A part for a place that this Collie does not know is left out, with a note, and the other parts still
show. So a trick written for a newer Collie still works on an older one.

> **Note.** A part that is out of date shows without its colour. A trick tells Collie how long its
> parts stay fresh. After that time the phone shows them as old, and says how old.

## Two kinds of trick

A trick is a program that prints parts, or rules for an agent that draws a screen.

- **A program trick** is a small program on your machine. The bridge runs it on a timer, or when you
  tap. It prints what to show, and Collie draws it in the five places and on the Hill. Its folder
  holds `trick.toml` and the program.
- **An agent view** is rules for the agent of one session. The agent answers you by drawing one
  screen, in that session's agent view. Its folder holds `trick.toml` and `rules.md`, and no program.

Both are a trick: one folder under `~/.config/collie/tricks/`, added and switched on the same way,
with the same parts to draw with. One trick can also be both: a program for its places, and a view.

## The parts

A trick sends parts, not code. So a screen can be made for one moment and still be Collie's.

Every trick draws with the same parts: a row, a number, a chip, a button, a diff, and a few more. A
part is a small piece of data that names what to show. The phone has one drawing for each.

That makes just-in-time UI possible: a screen made for one situation, at the moment it comes up, and
gone after. Nobody designed it in advance. A program or an agent put it together from what it knew
right then.

```json
{ "kind": "button", "attrs": { "label": "Fix both" } }
```

What makes this safe is the form it takes. The agent does not send code or HTML. It sends data, in a
closed list of parts. The bridge refuses any part that is not on the list, and Collie's own renderer
draws the rest. So a screen can be new every time, and still look and behave like Collie.

A kind outside the list is never drawn, and neither is a kind only Collie draws, such as its own
questions or its reply box. A trick or an agent can choose what to show. Only Collie decides how it
looks. The [Parts](tricks-reference.md#parts) section of the reference lists all 22 kinds.

## Example 1: a program trick

A trick prints data. The phone draws it with Collie's own parts.

It uses two places, the Dashboard tile and the status chip, and two parts, an item and a chip.

`trick.toml`, the manifest:

```toml
id = "disk-space"
name = "Disk space"
run = "./program.sh"
every = "5m"
icon = "archive"
places = ["dashboard", "status"]
description = "Room left in your home folder."
```

`program.sh`, the program:

```sh
#!/bin/sh
# Disk space: how much room is left in your home folder.
cat > /dev/null   # the facts on stdin; this trick needs none
kb=$(df -Pk "$HOME" | awk 'NR==2 {print $4}')
gb=$((kb / 1048576))
tone=plain
[ "$gb" -lt 10 ] && tone=warn
tile='{"icon":"archive","label":"Disk","badge":"'$gb' GB","tone":"'$tone'"}'
chip='{"icon":"archive","text":"'$gb' GB free","tone":"'$tone'"}'
echo '{"v":1,"fresh":"15m","parts":['
echo ' {"at":"dashboard","id":"dashboard","item":'"$tile"'},'
echo ' {"at":"status","id":"status","chip":'"$chip"'}]}'
```

One run goes like this:

1. The bridge's timer fires, five minutes after the last run. It runs a trick on a timer only while a
   phone is looking.
2. The bridge starts `program.sh` on your machine and hands it the facts on stdin: your sessions, your
   spaces, why it runs.
3. The program prints one JSON document and exits. It has 10 seconds and 64 KiB.
4. The bridge reads the document against Collie's closed list of places and parts. Anything it does
   not know is left out, with a note.
5. The phone draws a tile and a chip with Collie's own parts. No code from the trick reaches the phone.

A trick can be this small, or it can be bigger. Real ones list your open pull requests, or the builds
that run in your sessions now. They all work the same way: a program prints data, and Collie draws it.

## Example 2: a trick that asks

A trick can ask you a question, and your answer goes back to its program.

It uses the Hill, and the parts `bar`, `chip`, `list` and `row` on the card.

The Hill is the page of questions that wait for your tap. Each card is one Decision: one question with
its choices. A made-up trick, Release gates, posts one when a gate is red before a release. It lists
the Decision in what it prints:

```json
{
  "decisions": [{
    "key": "tag-1-28-2",
    "title": "Tag 1.28.2 with the e2e gate red?",
    "summary": "Six of the seven gates are green. The e2e gate failed once.",
    "options": [
      { "intent": "rerun", "label": "Rerun e2e first" },
      { "intent": "tag", "label": "Tag it now", "confirm": "Tag now" }
    ],
    "recommends": { "intent": "rerun", "why": "It failed on a timing budget." }
  }]
}
```

1. The bridge runs the trick's program on its timer, and hands it the facts.
2. The program prints its parts, and a list of the questions it wants open. Each has its own key.
3. The bridge posts a new key to the Hill once, with the trick as the sender. The next run with the
   same key posts nothing again.
4. The phone shows the card on the Hill. The recommended option carries a star, and nothing is chosen
   for you.
5. You tap "Rerun e2e first".
6. The bridge closes the card and runs the program once more, with your answer as a tap.
7. The program starts the rerun. The card's receipt says that the trick took your answer.

The program reads your answer on stdin, in fields of Collie's. `seen` names the version of the card
you answered, so a program that changed it since can tell:

```json
{ "kind": "tap", "node": "hill/tag-1-28-2", "intent": "rerun",
  "value": { "text": null }, "rid": "0b9e8d7c-…", "seen": "944a71314b332828" }
```

A key the program stops listing is taken back from the Hill. A changed card replaces the open one.
When the program fails, the last good cards stay.

An agent can post a Decision too, with `collie hill post`. Its answer is then typed into its session
as a short message from you. A trick's Decision can name a session too: your answer then reaches that
session as your own message, and then the program.

> **Note.** A permission needs a person's tap. A trick cannot answer a Decision, press a key or type
> into a session for you. And a recommendation you did not read never becomes the answer by default.

[The Hill](hill.md) covers the page itself, and the
[reference](tricks-reference.md#the-hill) lists every key of a Decision.

## Example 3: Morph, an agent view

Morph lets the session's own agent answer you with one screen instead of a wall of text.

It uses the agent view, and the parts `list`, `row`, `diff`, `bar`, `button`, `number` and `para`.

Morph is an agent view: a trick with no program, only rules. It adds a third view to a session, beside
the terminal and Chat. You switch it on for one session, and ask in plain words. The agent of that
session answers by drawing one screen: a list, a diff, two buttons. You tap, and the agent gets a
short line it can act on.

1. You type a request in the Morph view of a session: "Which tests broke after the rename?"
2. The bridge types it into that session, after a head that Collie writes and nobody else can.
3. The agent reads the rules once, then says what it does. The view shows its note.
4. The agent writes the screen as data, with a `collie trick view` command. The bridge checks it
   against the list of parts.
5. The phone draws the screen with Collie's own parts, under Collie's band.
6. You tap "Fix both". Collie marks your pick.
7. The bridge writes the line from the screen it stored, and types it into the session. The view shows
   you the exact line.
8. The agent does the work and answers with a new screen.

This is what reaches the agent when you send the request. It is one line:

```text
[view:morph lodge/w54:p1B#sx56] from operator: Which tests broke after the rename?
[rules: /home/you/.local/bin/collie trick view morph help --session lodge/w54:p1B#sx56]
```

The agent draws with two commands:

```sh
collie trick view morph start --session lodge/w54:p1B#sx56 --rules 3f9a07c2 \
  "Reading the test output"
collie trick view morph show --session lodge/w54:p1B#sx56 screen.json
```

A tap on "Fix both" sends this line:

```text
[view:morph lodge/w54:p1B#sx56] from operator: tapped "Fix both"
```

The head is Collie's. The words in quotes are the button's own label, which the agent wrote when it
drew the screen. The bridge quotes it from the screen it stored. A button has no hidden value: every
word a tap sends is on the screen.

A view does not send in three moments:

- **A question waits.** The agent asks a question in this session. The buttons wait, and what you
  type answers the question.
- **The agent works.** A turn runs. The buttons wait until it ends. Nothing queues.
- **Drawn in an earlier conversation.** The session started a new conversation. The screen is old,
  and its buttons are off.

A tap sends only words you saw on the screen, on one line, and the view then shows you that line.
Once a tap went, that screen takes no second tap. The screen belongs to one session and one
conversation: when the conversation changes, the screen turns old and its buttons stop.

The band at the top is Collie's. It names the trick and says who drew the screen, and the agent
cannot draw over it. Collie draws every button itself, so an agent cannot make a button that looks
like one of Collie's own questions.

## Where the thinking comes from

Collie holds no model key and calls no model.

- **Disk space: nowhere.** A shell program reads a number and prints it. No model is involved at all.
- **Release gates: nowhere.** Its program reads the gates and asks on the Hill. You do the deciding,
  and the program acts on your answer.
- **Morph: in the session's own agent.** The agent thinks once per screen, inside the session you
  already run. Collie only checks and draws the result.
- **An agent's Decision: in the agent that asked.** It wrote the question and its advice in its own
  turn. The card and your tap need no model.

The thinking comes from the agent you already run: Claude Code, Codex or another, on your own plan or
your own key. Collie only carries words between you and that session. The phone and the bridge have
no model in them.

A trick's program can call a model if its author makes it do so. That is the author's choice, and it
runs as you. Before you switch a trick on, Collie's check warns you when its code seems to call an
agent or a model on a timer.

## How an agent learns the rules

Every word your agent gets from Collie is text you can read.

An agent only knows what it reads. Collie gets its rules to an agent in three ways. A skill is a short
instruction file that an agent such as Claude Code or Codex reads when a task calls for it.

1. **The WalkyTalky and Hill rules.** Collie writes one skill into each agent's own instruction files,
   after each update, or when you run `collie skill sync`. Every agent on the machine knows them.
2. **How to write a trick, and what one installed trick asks of an agent.** The agent runs
   `collie trick guide`, or `collie trick skill <id>`, and reads what it prints. Only an agent that
   asks for it gets these words.
3. **The rules of a view, such as Morph.** They are a plain text file, `rules.md`, in the trick's
   folder. The agent runs the command named at the end of a message that your tap sent from the view.
   Only a session where you switched the view on gets them.

The message head has three parts. The head itself is Collie's: it names the view and this session's
own address, and no other door may type it. Then come your words, or the words of the button you
tapped. Last is the command that prints the rules. It goes away once the agent proves it holds them,
by the rules id the help gives it.

A view's rules are never installed as a skill. The third way is their only way in. They are plain
visible characters: Collie refuses an invisible or direction character in them. The trick's About
sheet in Settings shows them raw and whole, byte for byte what the agent gets, before you switch the
trick on.

A new version with changed rules always asks you again, with the change shown in full. It is never
taken without asking.

## Who is trusted with what

A trick runs as you. Your tap is the only yes.

A trick's program runs on your machine, as your user, with your files and your logins. Collie cannot
fence it in. So Collie does what it can do well: it checks everything the trick hands back, it keeps
every yes for you, and it tells you plainly what it found in the code.

- **Collie checks** the manifest and every part against the closed list, holds each run to 10 seconds
  and 64 KiB, runs only the code you said yes to, and searches the code for five risky things.
- **Your tap decides** Add, and the switch: a trick is off until you switch it on. It also decides
  each new version, each Decision and each view.
- **Your job** is to read the code, or to ask a session to read it for you.

### Official and community tricks

Official tricks come from Collie's own repository, `https://github.com/AltanS/collie-tricks`. Each
release names the exact version of each one, and Add fetches that version and nothing else. They
arrive switched off, like every trick.

Community tricks are anyone else's. You find them on the website, under the GitHub topic
`colliepwa-tricks`. The app never fetches a list of them. You add one by its address, and its row
says "ColliePWA did not check this code."

Collie does not check a trick's code, official or community. Read it before you switch it on.

### Add a trick

```sh
collie trick add
collie trick add design-review
collie trick add https://github.com/owner/repo//folder#v1
```

With no name, `add` lists the official tricks and adds nothing. A name means that folder of the
official repository. Any other https git repository takes an address, then optionally `//` and a
folder, and `#` and a branch, a tag or a full 40-digit commit. An address with a user name or a
password is refused, and so is any address that is not https.

On the phone, Settings → Tricks lists the official tricks with an Add button. A tap makes one git
fetch, then checks the hash of what arrived. The Hill is the first row of that card, tagged "Built
in": it comes with Collie, it is not a trick, and it cannot be removed.

`add` copies the trick into `tricks/` in Collie's config folder. That folder is `~/.config/collie` on
a binary install, and Herdr's plugin config folder on a Herdr-managed install
([Configure](configure.md#the-environment-still-wins)). It prints the commit it copied and the same
warnings as `collie trick check`. The trick stays off.

Nothing from the repository runs when you add it. Collie reads the files from git's own objects and
writes each regular file itself. It refuses a symbolic link or a submodule anywhere in the trick's
folder. It leaves out dot files, dot folders and `node_modules/`, because they are outside the code
you approve. The size caps are in the [reference](tricks-reference.md#files-of-a-trick).

Every verb of `collie trick` is in the [reference](tricks-reference.md#collie-trick).

### Switch a trick on, off, or remove it

```sh
collie trick on design-review
collie trick off design-review
collie trick remove design-review
```

A trick runs only while it is on. Switch it on in Settings → Tricks, or with `collie trick on` in a
shell. Switching on is your yes to the code as it is now. Collie copies the code to a folder of its
own and runs that copy. The row, and `collie trick on`, list any warnings from a text search of the
code first.

Switching off stops the runs and removes the trick's parts from the phone. It withdraws the trick's
open Decisions too. `remove` works only on a trick that is off.

A trick with a timer runs only while a paired phone is looking. Collie counts a phone as looking for
five minutes after its last request. A trick that calls a paid service every 30 seconds makes no call
while the phone is in your pocket.

An agent does not approve its own trick. `collie trick on` and `collie trick auto <id> on` refuse in a
pane where an agent works, and say so. Run them in a shell pane or in a terminal of your own. The check
is a speed bump, not a lock. Your user account is the real boundary
([An agent does not pair a device](security.md#an-agent-does-not-pair-a-device)).

### A new version of a trick

Collie runs the approved copy. When you edit the trick's folder, or `collie trick update` fetches new
code, the trick keeps running the old version. Its row says "A new version waits for your yes."

A card on the [Hill](hill.md) asks "Use the new version of <name>?". It shows the files that changed
and any new power the version asks for. You have three options:

- **Use the new version** approves the code on the card, and the trick runs it.
- **Use it and stop asking** does the same, and switches on "Take changes without asking". It is
  offered only when the version asks for no new power.
- **Keep the old version** declines it. Collie does not offer that version again.

Switching the trick on again, or `collie trick on <id>`, approves the new version as well.

"Take changes without asking" is a switch in the trick's About sheet, under Updates. The command is
`collie trick auto <id> on`. With it on, a new version is taken without a card only when its powers
did not change and a text search of its code finds no new kind of warning. A trick with rules never
takes one this way. A trick that took a change shows when, with Undo, which brings back the version
before.

### Powers, the environment and the warnings

A trick cannot type for you, cannot put code on your phone, and asks only through the Hill. Past
that, it can do what you can do.

**Powers.** A power is something a trick may reach beyond its own code: the environment names it asks
for (`env`), the places it draws in (`places`), and the files it reads from your agent sessions
(`inputs`). The About sheet lists them. A new version that changes one always asks you again. Collie's
own text also calls a power a right.

**The environment.** A program gets only the variables a shell tool needs, such as `PATH` and `HOME`.
A trick lists any more by name, and the About sheet shows each name. Collie never passes a `COLLIE_`
or `HERDR_` variable, or any name that ends in `_SOCK` or `_SOCKET`, even when a trick lists it.

**The warnings.** Before you switch a trick on, Collie searches its code for five things: starting
another program, reaching the network, writing a file outside the trick's own state folder, calling an
agent or a model on a timer, and importing a package Collie does not install. The search is not a
proof. A program can do any of this in a way no pattern sees.

**After a failed run** Collie waits 1 minute, then 5, then 30, and then stops the trick. A new
version, a change to `config.toml`, switching it on again, or a tap starts it again.

> **Caution.** A trick is not in a sandbox. It can do what you can do on your machine. Collie's check
> is a text search, and code can hide what it does from any search. An agent that read a view's rules
> keeps them until its conversation ends, even after you switch the view off. Your taps protect you
> from a stranger and from an agent that follows the rules. Your user account is the real wall
> ([What a program running as you can still do](security.md#what-a-program-running-as-you-can-still-do)).

### The About sheet

The About sheet is what you read before you switch a trick on. Tap the trick's name in Settings →
Tricks to open it.

- **The top** holds the trick's name, its one-line description and its longer text, then "Written by
  the trick's author. Collie did not check it."
- **What it does** holds only facts Collie knows: "Draws in: ...", the files it reads, the
  environment names it asks for, the warnings of the text search, and a view's rules, shown whole.
- **Where it comes from** says "From owner/repo @ 3f2a91c" for a trick added from a repository, or
  "Added on this machine."
- **Updates** holds the "Take changes without asking" switch, for a trick that is on.

The description and the longer text are the author's own words, and nothing checks them against the
code. Read the rows under "What it does" first.

## Write your own

Four commands, and your agent can write one with you.

```sh
collie trick init disk-space
collie trick dev disk-space
collie trick check ~/.config/collie/tricks/disk-space
collie trick on disk-space
```

`init` makes the folder, with a starter program, and also writes the notes an agent needs. `dev` runs
it once and prints what the phone would draw, and sends nothing to the phone. `check` searches the
code for the five risky things. And `on` refuses in a pane where an agent works, so the yes stays
yours.

Or ask one of your agents for the trick you want. It reads `collie trick guide`, writes the folder,
tries it with `collie trick dev`, and then proposes it to you:

```sh
collie trick propose ~/work/disk-space
```

A card appears on your Hill with the whole code on it. Collie never recommends "Switch it on": your
own reading is the check. Nothing of the trick runs before your yes, and an agent cannot switch a
trick on itself.

An agent can propose a program trick. It cannot propose a trick that carries a view or rules: an
agent must not write instructions for your other agents and get them in with one tap. You add such a
trick by hand, or from a repository.

[Write a trick](tricks-authoring.md) walks through a whole program trick and an agent view.

## Tricks in a crew

A crew's lead runs the tricks. A member runs none.

A member's Settings says "Tricks run on the lead of this crew. This machine runs none." Add a trick on
the lead's machine.

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
| No Tricks section in Settings | The config folder has no `tricks/` folder yet. `collie trick add` or `collie trick init <id>` makes it |
| "Manifest refused: ..." | `trick.toml` has an error. Run `collie trick check <folder>` and fix each line it prints |
| "A new version waits for your yes." | The folder moved past the approved copy. Open the card on the Hill, or run `collie trick on <id>` |
| "The approved copy changed on disk, so the trick stopped. ..." | A program edited the approved copy. Read the code, then switch the trick on again |
| "The approved copy holds a symbolic link, so the trick stopped. ..." | A trick holds regular files only. Replace the link, then switch it on again |
| "No version of this trick is approved yet. ..." | The switch file has no approved code for the trick. Switch it on again |
| "Stopped after repeated failures" | The program failed after 1, 5 and 30 minutes. Fix it, then switch it off and on, or tap its mark |
| "Last run failed" | The phone keeps the last good version. "Why" shows the error, and "Copy for an agent" copies it |
| "This Collie cannot draw this part" | A crew member's older Collie does not know the kind. Update Collie |
| "The Hill is off: this trick's Decisions are not shown." | Switch the Hill on in Settings → Alerts, or run `collie hill on` |
| "Tricks run on the lead of this crew. This machine runs none." | You are on a member. Switch tricks on from the lead |
| "Could not switch <name>. Try again." | The phone could not write the switch. Check that the device may write, and that the bridge answers |
| "error: collie trick on is a person's yes to the code, ..." | An agent ran the command. Run it in a shell pane, or tap the switch on the phone |
| "a trick <id> is already in <folder>. ..." | The id is taken. Use `collie trick update`, or `remove` the old one first |
| "<id> is on. Switch it off first: collie trick off <id>" | `remove` works only on a trick that is off |
| "This trick needs a newer Collie: ..." | The trick was written for a later Collie. Run `collie update` |
| "The trick is busy. Try again in a moment." | A tap came while another waited. Tap again |
| "The bridge restarted while this tap ran. ..." | Check the result, then tap again if needed |
| "A decision is answered on the Hill, not with a tap." | A Decision's card is answered on the Hill, not from the trick's Page |

A trick that runs but shows nothing on a timer may be waiting for a phone. Open the app, and give it a
minute.

To find out why a trick does what it does, read it. `collie trick check <folder>` lists what its code
starts and reaches, and `collie trick dev <folder>` runs it once and prints what the phone would draw
([Write a trick](tricks-authoring.md#a-program-trick)).

## Where to go next

- [Tricks reference](tricks-reference.md), for every place, part, key, limit and command.
- [Write a trick](tricks-authoring.md), for the person or agent who writes one.
- [The Hill](hill.md), for the Decisions a trick or an agent asks you.
- [Crews](crew.md), for tricks that read files on every machine.
- [Security](security.md), for what a program under your user can still do.
