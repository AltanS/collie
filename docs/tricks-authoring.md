# Write a trick

A trick is a folder: a manifest, and a program or a rules file. This page builds one of each.

Tricks are experimental. They may change, lose settings, or be withdrawn in a patch release. They are
off until you switch them on in Settings → Experiments, or with `collie tricks on`
([Switch tricks on or off](tricks.md#switch-tricks-on-or-off)). `collie trick dev` and
`collie trick check --run` run a folder once in your terminal with tricks off too.

```sh
collie trick init my-trick
collie trick dev my-trick
collie trick check ~/.config/collie/tricks/my-trick
```

`init` makes the folder, `dev` runs the program once and prints what ColliePWA would draw, and `check`
checks the manifest and searches the code. None of them writes to a phone or posts to the Hill.

In an agent's pane, `init` makes the folder in the agent's own work folder instead, as a draft:

```sh
collie trick init my-trick
collie trick dev ./my-trick
collie trick propose ./my-trick
```

This page is for a person or an agent who writes a trick. [Tricks](tricks.md) explains how tricks
work. Every place, part, manifest key, limit and command is in the
[Tricks reference](tricks-reference.md), and this page does not repeat them.

## The folder

A trick lives in `tricks/<id>/` in Collie's config folder, `~/.config/collie` on a binary install.

- `trick.toml` is the manifest, and it is required.
- A program trick has the program that `run` names, such as `program.ts`, and `trick.ts`, the helper
  that `init` writes.
- An agent view has the file that `rules` names, such as `rules.md`.
- `config.toml` holds settings the program reads. It is not part of the code you approve, so you can
  edit it freely.
- `[[field]]` in `trick.toml` names the settings the person sets on the phone. See
  [Settings a trick asks you for](#settings-a-trick-asks-you-for).
- `AGENTS.md` is the contract for an agent that grows the trick. `init` writes it.
- `media/` holds pictures the trick shows: PNG, JPEG or WebP.

A trick that an agent writes is a draft until the person says yes. In an agent's pane, `init` makes
`./<id>/` in the current folder, outside `tricks/`. `--dir <folder>` makes `<folder>/<id>/` for anyone.
`init` refuses a folder that holds files, and a folder inside `tricks/`. Nothing is added to this
machine's tricks before the person's yes. A folder made in `tricks/` counts as added on this machine,
and `propose` refuses it.

Collie does not run a trick from this folder. When the person switches it on, Collie copies the code
into a folder of its own and runs that copy. So a program never writes into its own folder. It keeps
its notes in the state folder that the facts name, `trick.state`.

## A program trick

Idle watch lists the agents that sat idle for 20 minutes or more, and asks before you wake one.

`trick.toml`:

```toml
id = "idle-watch"
name = "Idle watch"
run = "program.ts"
every = "1m"
icon = "clock"
places = ["status", "dashboard", "session"]
contract = 1
description = "Lists agents idle for 20 minutes or more, and asks before you wake one."
decides = "reply"
```

It draws in three places: a chip in the status line, a tile on the Dashboard, and a Page of its
own. `decides = "reply"` says that its Decisions name a session with `replyTo`: without it, Collie
refuses such a Decision. Every key is in [Manifest keys](tricks-reference.md#manifest-keys).

`program.ts`:

```ts
import { age, now, run, v } from "./trick.ts";

run((t) => {
  const minutes = Number(t.config.idle_minutes ?? 20);
  const idle = t.facts.sessions.filter((s) => {
    if (s.status !== "idle" || s.lastActiveAt === undefined) return false;
    return now() - Date.parse(s.lastActiveAt) >= minutes * 60_000;
  });

  t.status({
    text: idle.length === 0 ? "none idle" : `${idle.length} idle`,
    icon: "clock",
    tone: idle.length === 0 ? "muted" : "warn",
  });
  t.dashboard({ label: "Idle", icon: "clock", badge: idle.length });
  t.session({
    subtitle: `${idle.length} idle for ${minutes} min or more`,
    view: [
      v.list(
        idle.map((s) =>
          v.row((s.name ?? s.paneId).slice(0, 60), {
            end: age(now() - Date.parse(s.lastActiveAt ?? "")),
          }),
        ),
      ),
    ],
  });

  // Every run lists every Decision it still wants, with the same key and the same words.
  for (const s of idle.slice(0, 3)) {
    const spell = Date.parse(s.lastActiveAt ?? "").toString(36);
    const pane = s.paneId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    t.decide({
      key: `idle-${pane}-${spell}`.slice(0, 64),
      title: `Wake ${(s.name ?? s.paneId).slice(0, 30)}?`,
      summary:
        `This agent has been idle for ${minutes} minutes or more. ` +
        "Waking it types your answer into its session.",
      options: [
        { intent: "wake", label: "Wake it" },
        { intent: "leave", label: "Leave it idle" },
      ],
      recommends: { intent: "leave", why: "An idle agent costs nothing." },
      text: "optional",
      priority: "later",
      replyTo: s.id,
    });
  }
});
```

The helper reads the facts on stdin, calls your function once, and prints one JSON document
([The program](tricks-reference.md#the-program)). Collie draws the parts, and posts each new Decision key to the Hill once. The answer to a Decision goes
to the session that `replyTo` names, as the person's own message, and then back to the program as a
tap. The key holds the time the session was last active, so a session that works and then goes idle
again gets a new question. The summary holds no age, so its words stay the same between runs.

Check it, then run it once on a facts file of your own:

```text
$ collie trick check --run idle-watch
trick idle-watch (Idle watch) in /tmp/tricks-doc-lab/idle-watch
  places: status, dashboard, session
  every:  1m
  run:    program.ts
  decides: reply. Your answers to its Decisions go to a session as your own message.
  code:   sha256 63bc959b… (what `collie trick on` approves)
  helper: trick.ts is collie trick helper v4, Collie's own code, not checked line by
          line
  ran in 31 ms: exit 0
  parts: status status, dashboard dashboard, session main
ok: no problems.

$ collie trick dev idle-watch --facts facts.json
trick idle-watch (Idle watch) in /tmp/tricks-doc-lab/idle-watch, facts from facts.json,
a timer run
  status     status     "1 idle"  icon clock  tone warn
  dashboard  dashboard  "Idle"  badge 1
  session    main       (the manifest's name)  subtitle "1 idle for 20 min or more"
  decision  idle-w1-p1-mwbtwjk0  "Wake api-fix?"  options wake, leave
            recommends leave  later
  ran in 111 ms of 10 s, exit 0, stdout 746 B of 64.0 KiB
```

`facts.json` holds one idle session, `api-fix`. `dev` takes `--tap wake --node hill/<key>` to run the
program as the answer to that Decision. Every flag of `check` and `dev` is in
[`collie trick`](tricks-reference.md#collie-trick).

To use the trick, the person reads the code and runs `collie trick on idle-watch` in a shell of their
own, or uses the switch in Settings → Tricks.

## Session settings rows

A trick with contract 2 can add rows to a session's settings. List `menu` in `places`, and print a
`menu` part:

```json
{
  "v": 2,
  "parts": [
    {
      "at": "menu",
      "id": "ci",
      "rows": [
        { "id": "rerun", "kind": "button", "label": "Rerun CI", "icon": "refresh", "intent": "rerun", "confirm": true },
        { "id": "watch", "kind": "switch", "label": "Watch branch", "icon": "flag", "intent": "watch", "on": true }
      ]
    }
  ]
}
```

A tap runs the program with the row's `intent` and the session in `from.session`. A switch tap
also has `value`, `"on"` or `"off"`, the state the person asked for. The phone never flips the
switch itself, so print the new `on` in the answer. A label that reads like one of Collie's own rows
is refused, never cut.

A `belt` mark sits at the end of the scrolling strip, off screen until the person scrolls; the fixed block at the
right is Collie's own. In the facts, `cwd` is the pane's folder. A workspace folder can hold several
repositories; look inside it.

Add `sessions` to a `menu` part or a `belt` mark to show it only in those sessions, by the facts'
session ids. Collie binds each id to the pane and the conversation that are open now. A pane id that
goes to a new session, or a session that starts a new conversation (`/clear`), shows nothing until
your next run names it again. A part without `sessions` shows in every agent session of this machine; to
reach a crew member's session, name it. The [menu place](tricks-reference.md#menu) lists every
limit.

## Settings a trick asks you for

A trick with contract 3 can ask the person for values, such as a repository, a branch or how many rows to
show. List them in `trick.toml`, one `[[field]]` table each:

```toml
contract = 3

[[field]]
key = "repo"
kind = "text"
label = "Repository"
hint = "owner/name"
required = true

[[field]]
key = "rows"
kind = "number"
label = "Rows"
min = 1
max = 50
default = 10
```

There are four kinds: `text` (one line), `choice` (`options`, 2 to 8), `switch` and `number` (`min`
and `max`, whole numbers). The person sets them on the phone, in the trick's About sheet, under
Settings. Collie keeps the values on the machine that runs the trick, in its state folder, as
`.collie/values.json`. A person or an agent who edits that file by hand is the same case as an edit of
`config.toml`: it is accepted, and Collie reads the file through the field rules on the next look.

The program gets them in its facts as `values`, each field's value or its `default`, by key. The helper
reads them as `t.values`. A required field with no value is absent: draw a part that says what to set.
Collie never puts a value on a command line, in a log line, on a Hill card or in a push.

A value is the person's data and untrusted for the program: show it, never run it. Never pass it to a
shell or build a command from it.

A field is in `trick.toml`, so a new or changed field is a new version and asks the person again. A new
value asks nothing and runs the trick once.

A setting is never a secret. Do not put a token, a password or a key in a field: the value is stored as
plain text, shown on every paired phone, and readable by the trick's program. A key goes in `env`. Every limit is in
[Fields](tricks-reference.md#fields-contract-3).

## An agent view

Triage lets the agent of one session answer with one screen of what failed. It has no program.

`trick.toml`:

```toml
id = "triage"
name = "Triage"
contract = 2
places = ["agent-view"]
rules = "rules.md"
description = "Your agent answers with one screen of what failed."
```

`rules.md`:

```text
These are the rules of Triage, a view of this session that you draw.
Answer the person's request with one screen.
Put what failed first: one row for each failing test, with its file.
Show the smallest diff that explains the failure.
Offer at most two buttons. Label each with what happens when it is tapped.
Never draw a button that looks like a permission dialog or like Collie.
Never ask for a password, a key or a token on the screen.
If you are not sure, draw the question, not a guess.
```

The rules are plain ASCII, one line break at the end, and Collie checks every line
([The rules file](tricks-reference.md#the-rules-file)). Write them for the agent: what to draw, and
what never to draw.

The person switches the view on for one session, in that session's sheet. Then they type a request in
the view. The first line the agent gets ends with the command that prints Collie's view help and these
rules. The agent draws with two commands:

```sh
collie trick view triage start --session <address> --rules <id> "Reading the test output"
collie trick view triage show --session <address> screen.json
```

`screen.json` is data in the closed list of parts:

```json
[
  { "kind": "list", "kids": [
    { "kind": "row", "text": "auth/login.test.ts",
      "attrs": { "end": "1 fail", "tone": "danger" } },
    { "kind": "row", "text": "auth/token.test.ts",
      "attrs": { "end": "1 fail", "tone": "danger" } }
  ] },
  { "kind": "bar", "kids": [
    { "kind": "button",
      "attrs": { "label": "Fix both", "intent": "fix", "tone": "accent" } },
    { "kind": "button", "attrs": { "label": "Show the first one", "intent": "show" } }
  ] }
]
```

A tap on "Fix both" types `[view:triage <address>] from operator: tapped "Fix both"` into the session.
A button sends its label and nothing else. Every verb of `collie trick view` is in the
[reference](tricks-reference.md#collie-trick-view).

Collie marks the pick, never the agent. A button takes no `pressed` and a decision block takes no
`picked`: the write is refused. When the next step needs the same question, keep its block, and Collie
keeps the mark on it. A link goes to a web address only, and the phone shows its host after it. No text
of the agent's may say Collie's own words, such as "From Collie" or "Tap again to send". The
[agent view place](tricks-reference.md#agent-view) lists them all.

## Propose a trick to the person

An agent that wrote a program trick hands it to the person. Collie offers an agent no way to switch
a trick on. A program that runs as you can still do it, so an agent hands the trick over and stops.

```sh
collie trick propose ~/work/idle-watch
```

`propose` takes the draft from the agent's own work folder, such as the `./<id>/` that `init` made.
It adds nothing to this machine's tricks. `propose` runs the same check as `collie trick check`, then sends the files to the person as a
card, "Switch on the trick idle-watch?". The card shows in the agent's own session on the phone, and
in Settings, Tricks under "Waiting for your yes", and on the Hill too while the Hill is on. One tap on
Switch it on approves exactly the code the card showed and switches the trick on. Not now closes the
card in the session, and the trick still waits in Settings, Tricks. It leaves dot files, `node_modules/`, logs, `inputs/`,
`media/`, `captures/` and `config.toml` behind. It prints the card's id. Read the answer with
`collie hill status <id>`, or wait for it as a message. The message says what happened: the trick is
installed and on, or the person declined and nothing was installed.

A trick must work with no `config.toml`. When the folder has one, `propose` first runs the trick
once without it, as the bridge runs it after the yes. If the trick then draws nothing, fails or prints
a part Collie refuses, `propose` prints a warning and still sends it, and the card tells the person
it may show nothing until they add the settings file. Draw a short message for a missing setting
instead. A status text is 12 characters at most, so "not set up" fits and "no folder set" does not.

The card shows every file of the code, and recommends nothing: the person's own reading is the check.
The helper `trick.ts` and the `AGENTS.md` that `init` wrote are named, not shown, while they are
byte for byte what Collie ships. A changed `AGENTS.md` shows only the change.

The text search reads every file the `run` line names as code, and every file such a file imports by
a relative path, whatever its name or folder: a test, a fixture or a `.txt` file too. A `run` line
that hands a shell or an interpreter something the search did not read, such as a binary file, a path
outside the trick or code on the line itself, gets a warning of its own.
Nothing runs before their yes. A trick with `rules` or an agent view cannot be proposed: "A trick that
gives agents instructions cannot be proposed by an agent. Ask your person to add it on the machine."
The limits are in [A proposal from an agent](tricks-reference.md#a-proposal-from-an-agent).

## Several tricks in one repository

One https git repository can hold many tricks, one folder each.

```sh
collie trick add https://github.com/owner/tricks//idle-watch
collie trick add https://github.com/owner/tricks//triage#v1
```

The part after `//` names the folder, and `#` names a branch, a tag or a full commit. Each folder is a
whole trick, with its own `trick.toml`. A program imports only files in its own folder, so two tricks
share no code: copy a helper into each. `collie trick update <id>` fetches the same folder again, and
the new code waits for the person's yes.

List the tricks in a `collie-tricks.json` file at the top of the repository, so people can see what
it holds without knowing the folder names:

```json
{
  "contract": 1,
  "tricks": [
    { "folder": "idle-watch", "name": "Idle Watch", "about": "Marks a session that waits for you." },
    { "folder": "triage", "name": "Triage", "about": "Sorts the open issues by label." }
  ]
}
```

The file is a list and nothing more. `folder` is spelled as a trick id and names a folder at the top;
`name` and `about` are one line each. Collie refuses a key it does not know, more than 50 tricks, a file
over 32 KiB, and a `contract` it does not read. The other limits are in the
[reference](tricks-reference.md#a-repositorys-index-collie-tricksjson).

`collie trick add https://github.com/owner/tricks` then prints the list and adds nothing. On the phone,
Settings → Tricks → "Add from a repository" shows the list and adds one trick per tap, from `github.com`,
`gitlab.com` and `codeberg.org` only. The list grants nothing: each trick is still fetched, checked and
added off, and its own `trick.toml` wins over the list's name and line. A repository's list never
makes a trick Official.

Add the GitHub topic `colliepwa-tricks` to the repository, so people find it. The official tricks are
kept the same way, in `https://github.com/AltanS/collie-tricks`.

## Where to go next

- [Tricks reference](tricks-reference.md), for every place, part, key, limit and command.
- [Tricks](tricks.md), for how tricks work and how a person adds and trusts one.
- [The Hill](hill.md), for the Decisions a trick posts.
