# Writing a trick

A trick is a folder with a `trick.toml` and a program. Collie runs the program with facts on stdin and
reads one JSON document from stdout. This page is for a person or an agent who writes one. If you
only run tricks, read [Tricks](tricks.md).

```sh
collie trick init my-trick
collie trick dev ~/.config/collie/tricks/my-trick
```

`init` makes the folder, and `dev` runs the program once and prints what the phone would draw. Both
write nothing to a phone and post nothing to the Hill.

## The folder

A trick lives in `tricks/<id>/` inside Collie's config folder. The folder's name is the trick's id.

| File | What it is |
| --- | --- |
| `trick.toml` | The manifest. Required |
| `program.ts` | The program. Any file the `run` line names |
| `trick.ts` | The helper, one self-contained file. `collie trick init` writes it, and `collie trick helper <id>` rewrites it with the newest version |
| `config.toml` | Settings the program reads. Not part of the code hash, so you can edit it freely |
| `AGENTS.md` | The contract for an agent that grows the trick. `init` writes it |
| `SKILL.md` | Optional. What the trick asks of an agent. `collie trick skill <id>` prints it while the trick is on |
| `media/` | Pictures the trick shows. PNG, JPEG or WebP |
| `captures/` | More pictures. Collie copies it like `media/` |

`collie trick init <id>` writes the first five files. `collie trick init --sh <id>` writes a shell
program instead, with no helper.

A trick does not run from its folder. When a person switches it on, Collie copies the code into a
folder of its own and runs that copy. `trick.dir` in the facts, the working folder and the `media/`
the phone reads all name the copy. So a program must not write into its own code folder. It keeps its
notes in `trick.state`, a state folder that is never copied.

- Collie leaves out dot files, dot folders and `node_modules/`.
- A symbolic link anywhere in the code refuses the trick.
- A file name with a control or invisible character refuses it too.
- `media/` and `captures/` are copied with their pictures only. A file counts as a picture when its
  name ends in `.png`, `.jpg`, `.jpeg` or `.webp` and its first bytes are a PNG, JPEG or WebP picture.
  Code goes anywhere else.

## The manifest

`trick.toml` holds these keys. A key that is not in the table is refused, so a typo shows.

Every key, with its type, its limit, the contract it needs and an example, is in the [Tricks reference](tricks-reference.md#manifest-keys). The words `watch`, `on` and `mode` are kept for a later Collie: this Collie leaves them out with a note and runs the trick on its timer and taps.

`description` and `about` are plain text, with no Markdown, HTML or link drawn. A value with a control
or direction character is refused, like a long `name`. `collie trick check` gives a soft note when
`about` is missing. Both texts are the author's claim, and Collie does not check them against the
code.

`contract` is the number the trick is written for. A trick that names a higher number than this Collie
knows is refused with one line, and nothing else is checked: "This trick needs a newer Collie: it is
written for trick contract 3, and this Collie knows contract 2. Update Collie to run it." A place word
this Collie does not know is left out with a note, and the other places still draw. A manifest with no
place left is refused.

`env` lists the environment names the program needs past the base list. The base list is `PATH`,
`HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TZ`, `TERM`, `TMPDIR`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`,
`XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `NVM_DIR`, `BUN_INSTALL` and every `LC_*`. A name
that starts with `COLLIE_` or `HERDR_`, or ends in `_SOCK` or `_SOCKET`, is never passed, even when
listed. `collie trick check` shows each name and says which ones are never passed.

An example:

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

## The program

`run` takes two forms.

| Form | Example | How Collie runs it |
| --- | --- | --- |
| A script | `run = "program.ts"` | One relative path inside the trick folder, with no shell words. The extension is `.ts`, `.js`, `.mjs` or `.mts`. Collie runs it with its own runtime and installs nothing |
| A shell command line | `run = "./legs.sh"` | Anything else. `/bin/sh -c` runs it in the trick folder (`cmd.exe /c` on Windows) |

A script imports only relative files in its own folder and the `node:` and `bun:` built-ins.
`collie trick check` warns on each line that imports a package by a bare name.

### What the program receives

Collie writes one JSON document, the facts, on stdin. The program ignores a field it does not know,
because a later Collie at the same contract may add one.

| Field | What it holds |
| --- | --- |
| `contract` | The trick's own contract number, 1 when it names none |
| `trigger` | Why this run happened (below) |
| `trick` | `id`, `dir` (the approved copy's folder) and `state` (the state folder) |
| `memberId` | The bridge that runs the trick: its crew member id, or on a solo install its install id (`m_` and ten characters). It stays the same when the machine is renamed. Key anything the program keeps on it |
| `host` | The machine's name, for display only. It changes with a rename. Never key on it |
| `sessions` | The agent sessions, up to 256 (below) |
| `spaces` | Each space's `name` and `folder`, up to 64 |
| `sessionsOmitted` | How many sessions the caps left out. Absent when none |

A session has `id`, `memberId`, `sessionId`, `paneId`, `host`, and then `name`, `agent`, `status`,
`cwd`, `space`, `tab` and `lastActiveAt`. `id` is the scope key `<memberId>:<paneId>`. Pass it back in
a Decision's `about` and `replyTo`. `status` is `idle`, `working`, `blocked`, `done` or `unknown`.
`lastActiveAt` is an ISO 8601 time. On a crew's lead the sessions are every member's, the lead's own
first, and each has `reachable`, which says whether the lead's last sweep reached that machine. For a
contract 2 trick with `inputs`, each session also has `inputs`.

A trigger is one of three:

| `trigger.kind` | When | Other fields |
| --- | --- | --- |
| `start` | The first run after the trick loads, is switched on, a new version is approved or its `config.toml` changes | |
| `timer` | Every `every` after the last run, while a phone watches | |
| `tap` | A person tapped a control, or answered a Decision | `rid` (request id), `node`, `intent`, `value`, `from`, and for an answer `seen` |

A tap on a control of the trick's own part has `node` set to the part's id. An answer to a Decision
has `node` set to `hill/<key>`, `intent` set to the chosen option, `answer` for words alone or
`dismiss`, and `value` set to `{ "text": ... }`, the person's words or `null`. `seen` is the hash of
the version of the Decision the person saw.

A retried tap carries the same `rid`, and Collie runs nothing twice for one `rid`. A program that
records an answer keys the record on `rid`.

### What the program prints

The program prints one JSON document on stdout and exits 0.

```json
{ "v": 1, "parts": [ ... ], "decisions": [ ... ], "asOf": "2026-11-11T09:41:00Z", "fresh": "90s" }
```

| Key | What it is |
| --- | --- |
| `v` | The contract number from the facts |
| `parts` | Up to 24 parts, each at most 16 KiB (see [Parts](#parts)) |
| `decisions` | Up to 20 Decisions (see [Decisions](#posting-a-decision-from-a-trick)). Left out, the open Decisions stay as they are. `[]` withdraws them all |
| `asOf` | When the data was true, as an ISO 8601 time, when it is older than the run |
| `fresh` | How long the parts stay fresh, `5s` to `24h`. Left out, three times `every`, at least a minute, or ten minutes for a trick with no timer. Past it, the phone shows the parts as old |

There is no `draft` and no `open`. A trick never writes into a reply box, and a tap never moves the
phone. What a trick wants to show is a `link`. What it wants to tell the person is a Decision.

### Limits of a run

The limits of a run are in the [Tricks reference](tricks-reference.md#a-run). A trick runs one at a time: a timer tick while one runs is skipped, and a phone tap queues one deep.

A run that exits with a failure, times out or prints a document Collie refuses as a whole is a failed
run. The phone keeps the last good parts and says they are old. The error line is masked and capped.

### Strict at write, tolerant at read

Collie checks strictly what a person or an agent writes: `trick.toml`, `collie hill post` and a
trick's Decisions. An unknown key, kind or attribute is refused. It reads a program's output
tolerantly. A node of a kind this Collie does not know, or a part in a place it does not know, is left
out with a `dropped` note, and the rest still draws. An unknown key on a known node is ignored with an
`ignored` note. A bad value of a known field is refused, part by part. So a trick written for a
newer Collie runs on an older one, and the older one leaves out only what it does not know.

## The helper

`trick.ts` is the helper for a TypeScript trick. `run((t) => { ... })` reads the facts, calls your
function once and prints the document. These are its main calls:

| Call | What it does |
| --- | --- |
| `t.facts`, `t.config`, `t.tap` | The facts, `config.toml` parsed (`{}` when there is none), and the tap that started the run or null |
| `t.status({ text, icon?, tone? })` | The chip in the status line |
| `t.belt({ label, icon?, tone?, badge?, intent? })` | The mark at the end of the Belt |
| `t.dashboard(item)`, `t.tabbar(item)` | The Dashboard tile and the bottom bar item: `{ label, icon?, badge?, tone? }` |
| `t.session({ name?, subtitle?, badge?, progress?, actions?, view })` | The trick's session. Keep the default id `main` |
| `v.card`, `v.list`, `v.row`, and one builder for each other [node kind](#node-kinds) | Build a view |
| `t.decide({ key, title, summary, options, ... })` | Ask the person on the Hill |
| `t.keepDecisions()` | Leave the `decisions` key out, so the open Decisions stay |
| `t.state.get(name, fallback)`, `t.state.set(name, value)` | JSON files in the state folder |
| `t.log(name)` | An append-only JSON-lines file: `.append`, `.all`, `.last`, `.has(rid)` and `.once(rid, entry)` |
| `t.cached(name, ttlMs, loader)` | A read kept with its time. A loader that throws serves the old value, marked stale |
| `t.sh(cmd, args, { timeoutMs?, cwd? })` | Runs a program without a shell. Never throws. Keeps 256 KiB of output |
| `t.tool(name)` | The path of a program on `PATH`, or in common user folders, or null |
| `t.fresh(duration)`, `t.asOf(when)` | The document's `fresh` and `asOf` |
| `now()`, `age(ms)`, `iso(ms?)`, `mask(text)`, `clip(text, n)` | The clock, a span as words, and masking for text that may hold a key |

A run that calls neither `t.decide` nor `t.keepDecisions` prints `"decisions": []`, so it withdraws the
open ones. A thrown error prints one warning card in the trick's session and exits 0 when the trick
has a session. Without one, the run exits 1, so the failure rules apply. `collie trick helper <id>`
rewrites `trick.ts` with the newest helper. The helper is part of the trick's code, so a trick that is
on keeps running the approved copy, and the new helper waits for a yes.

## Parts

A part is `{ at, id, ... }`. `at` is the place. `id` is 1 to 32 of `a-z`, `0-9` and `-`, and each part
needs its own. A trick has one `belt`, one `status`, one `dashboard` and one `tabbar` part, and any
number of `session` parts, 24 parts in all.

Each place, with its keys, limits and an example, is in the [Tricks reference](tricks-reference.md#places).

A `view` is a list of nodes that flow down the place's frame. A mark is always the same control, and
a mark with nothing to do is the same button, disabled. A part past its `fresh` window draws every
status tone as unknown.

## Node kinds

A node is `{ kind, text?, attrs?, kids? }`, and every attribute is a string. There are 22 kinds. A
view holds at most 24 nodes at its top, 6 levels and 300 nodes in all. A Decision's view is smaller
(see [Posting a Decision](#posting-a-decision-from-a-trick)).

Every kind, with what it holds, its text, each attribute with its type and limit, and an example, is in the [Tricks reference](tricks-reference.md#parts).

The words that attributes take (tones, icons, states, clocks, styles, intents and the focus point) are in the [Tricks reference](tricks-reference.md#shared-values).

`href` takes only an `http://` or `https://` address, or a session's scope key. Anything else,
`javascript:` included, is refused. `rel` `file` is refused: a trick opens no file. An `image` names a
file of the trick's `media/` folder by `src`, such as `media/chart.png`, and the phone reads it with
Collie's own checks. A `button` sends its `intent` with the part's id and its `value`. With `confirm`,
the first tap arms it and the second sends. With `does` set to `copy`, it copies its `value` on the
phone and sends nothing.

These words are refused as kinds, each with a hint on what to write instead: `stack`, `grid`, `kv`,
`steps`, `time`, `section`, `divider`, `log`, `text`, `progress`, `badge`, `icon` and `ring`. So are
the kinds that only Collie draws: `mark`, `screen`, `sheet`, `toast`, `form`, `field`, `select`,
`option`, `composer`, `prompt`, `tool`, `turn`, `chat`, `pane` and `think`.

### Icons

`archive`, `back`, `bell`, `branch`, `camera`, `chat`, `check`, `clock`, `close`, `copy`, `crew`,
`delete`, `down`, `download`, `edit`, `eye`, `file`, `flag`, `flask`, `folder`, `git-pull-request`,
`image`, `info`, `key`, `link`, `lock`, `machine`, `menu`, `mic`, `minus`, `more`, `move`, `next`,
`note`, `pause`, `pin`, `play`, `plug`, `plus`, `refresh`, `search`, `send`, `settings`, `share`,
`star`, `tag`, `terminal`, `up`, `upload`, `warn` and `x`.

A session action's icon is one of `play`, `pause`, `check`, `x`, `refresh`, `archive`, `flag`, `star`,
`send`, `note`, `search` and `more`.

## Posting a Decision from a trick

A trick asks the person with `decisions`. Each one is a card on the [Hill](hill.md) under the trick's
name.

Every key of a Decision, with its type and limit, is in the [Tricks reference](tricks-reference.md#the-hill).

A trick holds at most 20 open Decisions. A Decision's `about` and `replyTo` must name a session that is
in the run's facts, and on a crew's lead that may be a member's session.

**The view.** A `view` puts the facts behind the question on the card. It takes group, list, row, bar,
chip, para, line, run, code, link, meter, spacer, number, image, compare, table, diff and spark. It
has no button and no card, because the options are the taps. A `link`, and a `row` with an `href`,
open a web page. The view is at most 8 KiB of compact JSON, 100 nodes and 4 levels. An `image` on a
view names one of the Decision's own `media` by its place, `ref`, with 0 as the first.

**The list is the truth.** After each run that succeeded, Collie makes the Hill agree with the list,
by key.

- A new key posts once. A second run, or a restart, posts nothing twice.
- The same key with changed content posts the new version, which replaces the open one. Content is
  the title, summary, body, options, recommendation, text mode, links, priority, `about`, `replyTo`,
  the view, and each picture's bytes and caption.
- A key the list no longer holds is withdrawn, "by the trick".
- A key the person answered or dismissed stays closed while its content is unchanged. To ask again,
  change the content, or drop the key for one run and list it again.
- A key that closed without the person (undeliverable, expired, or withdrawn by someone else) posts
  again on a later run that still lists it, at most once every 10 minutes.
- A document with no `decisions` key changes nothing. `[]` withdraws every open one.
- A failed or timed-out run changes nothing.

So list every Decision you still want on every run, and keep the words stable. Words that change on
each run, such as an age in minutes, make Collie post a new version every time and ask again.

**The answer comes back as a tap.** When the person answers, the program runs once with a `tap`
trigger on `hill/<key>`. It has the answer's own `rid`, the chosen `intent`, and the person's words in
`value.text`. With `replyTo`, the message to that session goes first, then the tap. Into a session
other than the poster's, the message carries only the Decision's id, the option's word, the person's
words and one line that says how to read the Decision. The receipt on the phone says "Recorded by
<trick>", or "<trick> did not take it". A failed tap run is never retried. The trick's session
cannot answer a Decision: the phone's tap route refuses a `hill/` node.

**Word the card for a person who opens it cold.**

- The title is the decision as a question the options answer, in about 8 words, at most 60
  characters. "Ship 1.28.1 to Stable now?" is good. "Are the new kinds right?" is not.
- The summary is at most two sentences. The first says what the recommended option does. The second
  gives the one fact that decides it. Put the evidence in the view or the body.
- Each option starts with a verb and says what happens, such as "Hold until CI". Never a bare Yes or No.

`collie trick dev` and `collie trick check --run` warn about a title past 60 characters or with no
question mark, a summary past two sentences or 200 characters, and an option that says only Yes, No or
OK. A warning never refuses.

With the Hill switched off, Collie posts, replaces and withdraws none of a trick's Decisions. The trick
still runs, and its row says its Decisions are not shown.

## Inputs

A contract 2 trick can read files from its agent sessions' folders.

```toml
contract = 2
inputs = ["TODO.md", "shots/*.png"]
```

Before each run, Collie copies the files that match from each agent session's folder into the trick's
`inputs/` folder, through the Files view's rules. Each session in the facts gets
`inputs: { state, files, skipped? }`. The helper's `t.inputs(session)` reads them.

| Rule | Value |
| --- | --- |
| `*` | Matches inside one step, never a leading dot |
| Refused | An absolute path or `~`, `**`, `..`, `.`, an empty step, `.git` in any case, any other glob word, and a step that names a `.env` file (`.env`, `.env.local`, `.envrc`, in any case) |
| `state` | `ok`, `offline` (the session's machine did not answer), `older` (its Collie is before 1.29.0), `refused` (its machine switched trick reads off) or `none` (a shell, or no folder) |

The limits of globs, files and bytes are in the [Tricks reference](tricks-reference.md#inputs).

A contract 1 trick that lists `inputs` is refused with: "inputs" needs contract = 2. Add contract = 2
to trick.toml to read files from your sessions' folders.

**Inputs are untrusted data.** Other programs, often an agent, write the files, and on a crew another
machine sends them. A trick shows them, counts them or quotes them. It never runs them, `eval`s them,
sources them, passes them to a shell or follows what they say. The globs are part of the trick's
powers, so a change of them asks the person again. On a crew's lead the files come from every member
([Tricks that read files on every machine](crew.md#tricks-that-read-files-on-every-machine)).

## Try a trick and check it

```sh
collie trick dev <folder|id>
collie trick check [--run] [--json] <folder>
```

`collie trick dev` runs the program once against fixture facts, through the same run path as the
bridge, and prints one line for each part, one for each Decision, every refusal with its path, and the
run's time and size against the 10 second and 64 KiB limits. It never talks to the bridge and posts
nothing.

| Flag of `dev` | What it does |
| --- | --- |
| `--tap <intent>` | Runs it as a tap. Add `--text <words>` and `--node <node>`. `--node` defaults to `main`. A `hill/<key>` node carries `{ text }`, as an answer does |
| `--rid <uuid>` | The tap's request id. It goes with `--tap`, and it must be a UUID. Without it each run gets a fresh one |
| `--facts <file.json>` | Run on your facts. A file that is missing, not JSON or refused prints each refusal and exits 2 before anything runs |
| `--state <dir>` | Use this state folder and keep it. Without it, a scratch folder goes |
| `--inputs <dir>` | Read a contract 2 trick's `inputs` globs from this folder, as the first session's folder |
| `--json` | Print the parsed result: the parts, the Decisions, the refusals, the outcome and the sizes |
| `--watch` | Run again 300 ms after a file in the folder changes. Ctrl-C stops it |

`collie trick check` is the static check: the manifest, the places, the files the `run` line names,
and a text search of every code file for starting a process, reaching the network, writing outside
the state folder, calling a model and importing a package. It lists README files, `*.md`, `*.toml`,
`*.json`, `*.txt`, tests and fixtures as not searched, and they still count in the code hash. With
`--run` it also runs the program once against fixture facts, and parses what it prints. It exits 0
when the trick is clean or has only notes, 1 on a refusal or a failed run, and 2 on a usage error.

> **Note.** `collie trick check` says what a program does in a text search, not a proof. A trick runs
> with the user's full rights.

An agent can read a short brief on writing a trick with `collie trick skill`, and what an installed
trick asks of an agent with `collie trick skill <id>`. A person approves the trick. An agent never
runs `collie trick on`.

## A worked example

This trick lists agents that sat idle for 20 minutes or more. It draws a status chip, a Dashboard tile
and a session, and it asks on the Hill before a person wakes one. The answer, and any words the person
adds, reach that agent as the person's own message. The example was built in an empty folder, and
every output below is what ran.

The folder holds `trick.toml`, `config.toml`, `program.ts` and `trick.ts`. `trick.ts` is the helper
that `collie trick init` writes. It is long, so it is not shown here.

`trick.toml`:

```toml
# Idle watch: shows the agents that sat idle for a while, and asks before waking one.
id = "idle-watch"
name = "Idle watch"
run = "program.ts"
every = "1m"
icon = "clock"
places = ["status", "dashboard", "session"]
contract = 1
description = "Lists agents idle for 20 minutes or more, and asks before you wake one."
about = """
Idle watch reads the list of your agent sessions once a minute.

It shows how many agents have been idle for 20 minutes or more. For each one it \
puts a Decision on the Hill: wake it, or leave it. Your answer, and any words \
you add, reach that agent as your own message.

It reads only the session list that Collie gives it. It starts no program and \
uses no network.
"""
```

`config.toml`:

```toml
# Settings that Idle watch reads as t.config. This file is not part of the code hash.
idle_minutes = 20
```

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

  // A tap on a Decision: keep one line per answer. A retried tap has the same rid.
  if (t.tap?.decision) {
    t.log("answers").once(t.tap.rid, {
      key: t.tap.decision,
      intent: t.tap.intent,
      text: t.tap.text,
    });
  }
});
```

The key of a Decision holds the time the session was last active. So a session that works and then
goes idle again gets a new key and a new question. The summary holds no age, so its words stay the
same between runs.

The fixture facts of `collie trick dev` hold no idle session, so the example has its own facts file,
`facts.json`. `trick.dir` and `trick.state` in it are replaced by the run's own.

```json
{
  "contract": 1,
  "trigger": { "kind": "timer" },
  "trick": {
    "id": "idle-watch",
    "dir": "/tmp/tricks-doc-lab/idle-watch",
    "state": "/tmp/tricks-doc-lab/state-x"
  },
  "memberId": "m_abc1234567",
  "host": "laptop",
  "sessions": [
    {
      "id": "m_abc1234567:w1-p1", "memberId": "m_abc1234567", "sessionId": "s1",
      "paneId": "w1-p1", "host": "laptop", "name": "api-fix", "agent": "claude",
      "status": "idle", "lastActiveAt": "2026-11-11T08:00:00Z"
    },
    {
      "id": "m_abc1234567:w1-p2", "memberId": "m_abc1234567", "sessionId": "s2",
      "paneId": "w1-p2", "host": "laptop", "name": "docs", "agent": "codex",
      "status": "working", "lastActiveAt": "2026-11-11T09:58:00Z"
    }
  ],
  "spaces": []
}
```

I ran these commands from the folder that holds `idle-watch` and `facts.json`:

```text
$ collie trick check idle-watch
trick idle-watch (Idle watch) in /tmp/tricks-doc-lab/idle-watch
  places: status, dashboard, session
  every:  1m
  run:    program.ts
  code:   sha256 63bc959bcc4963815318f0987c927d4d69364909828ba8a193cd418727c2c580 (what `collie trick on` approves)
  helper: trick.ts is collie trick helper v4, Collie's own code, not checked line by line
ok: no problems.
(exit 0)

$ collie trick check --run idle-watch
trick idle-watch (Idle watch) in /tmp/tricks-doc-lab/idle-watch
  places: status, dashboard, session
  every:  1m
  run:    program.ts
  code:   sha256 63bc959bcc4963815318f0987c927d4d69364909828ba8a193cd418727c2c580 (what `collie trick on` approves)
  helper: trick.ts is collie trick helper v4, Collie's own code, not checked line by line
  ran in 31 ms: exit 0
  parts: status status, dashboard dashboard, session main
ok: no problems.
(exit 0)

$ collie trick dev idle-watch --facts facts.json
trick idle-watch (Idle watch) in /tmp/tricks-doc-lab/idle-watch, facts from facts.json, a timer run
  status     status     "1 idle"  icon clock  tone warn
  dashboard  dashboard  "Idle"  badge 1
  session    main       (the manifest's name)  subtitle "1 idle for 20 min or more"  view 2 nodes (list)
  decision  idle-w1-p1-mwbtwjk0  "Wake api-fix?"  options wake, leave  recommends leave  later
  ran in 111 ms of 10 s, exit 0, stdout 746 B of 64.0 KiB
(exit 0)
```

The `check` runs report no problems. `dev` shows one idle session, `api-fix`, and one Decision for it.
The `docs` session works, so it has no row and no Decision. Then I ran an answer to that Decision, as
the person's tap on "Wake it" with a few words:

```text
$ collie trick dev idle-watch --facts facts.json --state state-x --tap wake \
    --node hill/idle-w1-p1-mwbtwjk0 --text "Run the tests" \
    --rid 0b9e8d7c-1111-4222-8333-444455556666
trick idle-watch (Idle watch) in /tmp/tricks-doc-lab/idle-watch, facts from facts.json, a tap: wake on hill/idle-w1-p1-mwbtwjk0
  state kept in /tmp/tricks-doc-lab/state-x
  status     status     "1 idle"  icon clock  tone warn
  dashboard  dashboard  "Idle"  badge 1
  session    main       (the manifest's name)  subtitle "1 idle for 20 min or more"  view 2 nodes (list)
  decision  idle-w1-p1-mwbtwjk0  "Wake api-fix?"  options wake, leave  recommends leave  later
  ran in 81 ms of 10 s, exit 0, stdout 746 B of 64.0 KiB
(exit 0)

$ cat state-x/answers.jsonl
{"key":"idle-w1-p1-mwbtwjk0","intent":"wake","text":"Run the tests","rid":"0b9e8d7c-1111-4222-8333-444455556666"}
```

The tap run lists the same Decision again, so Collie keeps it. The record holds the answer once,
keyed on its `rid`.

To use the trick, a person copies the folder into `tricks/` in Collie's config folder, reads the
code, and runs `collie trick on idle-watch`. To share it, publish the folder in an https git
repository. Anyone adds it with `collie trick add <https-url>//<folder>`
([Tricks](tricks.md#add-a-trick)).

## Limits

Every limit is in the [Tricks reference](tricks-reference.md#limits). The caps for each text are in its tables, beside the field they limit.
