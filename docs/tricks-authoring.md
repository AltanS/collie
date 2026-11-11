# Write a trick

A trick is a folder: a manifest, and a program or a rules file. This page builds one of each.

```sh
collie trick init my-trick
collie trick dev my-trick
collie trick check ~/.config/collie/tricks/my-trick
```

`init` makes the folder, `dev` runs the program once and prints what ColliePWA would draw, and `check`
checks the manifest and searches the code. None of them writes to a phone or posts to the Hill.

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
- `AGENTS.md` is the contract for an agent that grows the trick. `init` writes it.
- `media/` holds pictures the trick shows: PNG, JPEG or WebP.

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
```

It draws in three places: a chip in the status line, a tile on the Dashboard, and a session of its
own. Every key is in [Manifest keys](tricks-reference.md#manifest-keys).

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

## Propose a trick to the person

An agent that wrote a program trick hands it to the person. It never switches it on itself.

```sh
collie trick propose ~/work/idle-watch
```

`propose` runs the same check as `collie trick check`, then sends the files to the person's Hill as a
card, "Switch on the trick idle-watch?". It leaves dot files, `node_modules/`, logs, `inputs/`,
`media/`, `captures/` and `config.toml` behind. It prints the card's id. Read the answer with
`collie hill status <id>`, or wait for it as a message.

The card shows every file of the code, and recommends nothing: the person's own reading is the check.
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

Add the GitHub topic `colliepwa-tricks` to the repository, so people find it. The official tricks are
kept the same way, in `https://github.com/AltanS/collie-tricks`.

## Where to go next

- [Tricks reference](tricks-reference.md), for every place, part, key, limit and command.
- [Tricks](tricks.md), for how tricks work and how a person adds and trusts one.
- [The Hill](hill.md), for the Decisions a trick posts.
