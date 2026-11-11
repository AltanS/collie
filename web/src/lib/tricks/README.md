# Collie tricks: the schema and the renderer

Formerly mods, renamed to tricks 2026-11-08.

A trick is a small program on the machine. The bridge runs it with facts on stdin and reads one JSON
document from stdout. The document says WHAT to show, in a closed subset of the Tree UI vocabulary.
Collie decides HOW, with its own primitives, so the look stays Collie's. The design is the "Collie
tricks" milestone in the tracker.

`schema.ts` is the contract. It holds every type a trick reads or writes, the caps, the closed lists
(tones, icons, places, node kinds) and one total parser per document. It imports only `../json` and
`./contract` (the contract number), so the bridge, the CLI and the web all load it by relative path,
with no DOM and no `@/` alias.

## The contract

Everything a trick and Collie exchange has one version number, the trick contract, `TRICK_CONTRACT`
in `contract.ts`. The bridge (through `schema.ts`), the CLI and the helper's tests read it there; the
helper (`cli/trick-kit/trick.ts`, a file a trick folder copies) carries the same literal as
`CONTRACT`, held to it by a test. This Collie speaks contracts 1 and 2. A trick that names none is a
contract 1 trick (`TRICK_CONTRACT_DEFAULT`), and `collie trick init` writes `contract = 1`.

**The manifest**, `trick.toml`: `id`, `name`, `run`, `every`, `icon`, `places`, `env`, `contract`,
`inputs` (contract 2), the later `watch`, `on` and `mode`, and two texts for a person, `description` (one
line, at most 140 characters, shown under the name in Settings → Tricks) and `about` (at most 1200
characters, paragraphs split by a blank line, shown in the trick's About sheet). Both are plain text, with
no markdown, HTML or link drawn, and both are allowed in contract 1 and 2. They are text, not rights: they
stay out of `powersOf` and are part of the code hash like any manifest change. A value past its cap, or
with a control or direction character, refuses the manifest like a long `name`; `collie trick check` gives
a soft note when `about` is missing. `contract` is the number the trick is
written for, a whole number, 1 when left out. A trick that names a higher number than this Collie knows
is refused with one line, "This trick needs a newer Collie: it is written for trick contract 3, and
this Collie knows contract 2. Update Collie to run it.", and nothing else is checked. At the same number an unknown key is
refused, so a typo shows. A place word this Collie does not know is left out with a `later` note.

**The facts**, one JSON document on stdin: `contract`, `trigger` (`start`, `timer`, or `tap` with
`rid`, `node`, `intent`, `value`, `from` and, for an answer, `seen`), `trick` (`id`, `dir`, `state`),
`memberId`, `host`, `sessions` (each `id`, `memberId`, `sessionId`, `paneId`, `host`, `name`, `agent`,
`status`, `cwd`, `space`, `tab`, `lastActiveAt`, and on a crew's lead `reachable`; for a contract 2
trick with `inputs`, `inputs`), `spaces` (`name`, `folder`) and `sessionsOmitted` when the caps cut
sessions. `contract` is the trick's own number. A program ignores a field it does not know: a later
Collie at the same number may add one.

**The output**, one JSON document on stdout: `{ v, parts, decisions?, asOf?, fresh? }`. `v` is the
contract number. A part is `{ at, id, ... }` with the keys its place takes (below); a view is a list of
nodes `{ kind, text?, attrs?, kids? }` of the 22 kinds (below), every attribute a string: `card`,
`group`, `list`, `row`, `bar`, `chip`, `button`, `para`, `line`, `run`, `code`, `link`, `image`,
`meter`, `spacer`, `number`, and the display kinds `compare`, `table` (with its `col` and `cell`),
`diff` and `spark`. A part's `image` names a file of the trick's `media/` folder by `src`; a Decision's
view names one of the Decision's own pictures by `ref`, and both take `caption`, `fit` and `focus`.

**The places**: `belt`, `session`, `dashboard`, `status` and `tabbar`, each drawn by the phone (see
"Places"). Nothing else: a place no surface draws is not in the contract.

**The limits**: 64 KiB of stdout and 10 s per run, 24 parts of at most 16 KiB each, 24 nodes at a
view's top, 6 levels and 300 nodes in a view, 20 decisions, `every` and `fresh` from 5 s to 24 h, 32
names in `env`, an image of at most 2 MB from the trick's `media/` folder. Every text cap is in
`schema.ts` beside its field.

**Where a trick runs: the approved copy.** A trick does not run from its folder. When a person switches
it on, the bridge copies its code into `tricks/.collie-approved/<id>/<hash16>/` beside the trick folders
(`bridge/tricks/approved.ts`, the first 16 hex digits of the code hash) and runs that copy: `trick.dir` in the facts, the working
folder and the `media/` the phone reads all name the copy. An edit of the trick folder never stops the
trick. The bridge copies the new code to `.collie-pending/` and the row says "A new version waits for your
yes."; switching the trick on again approves it, and so does the card on the Hill (see "The new version
card" below). A new version whose `env` and `places` are unchanged, and in which the text search finds no warning
kind the approved copy did not have (network, spawn, write, model, import), is taken without asking when the
trick has `collie trick auto <id> on`, or the switch "Take changes without asking" in Settings → Tricks. So a program must not write
into its own code folder: the copy's code files are read-only (not on Windows, where the hash check
alone catches it), and a change there stops the trick with "The approved copy changed on disk". It keeps its notes in `trick.state`, the
state folder, which is never copied. `media/` and `captures/` are seeded into the copy once (at most
500 files and 64 MiB) with their pictures only: a file named `.png`, `.jpg`, `.jpeg` or `.webp` whose first
bytes are a PNG, JPEG or WebP picture. Anything else in those two folders stays behind, so a program in the
copy can never import a file the hash and the card left out; the rule an author reads is "media/ and
captures/ hold pictures, code goes anywhere else". They stay writable; `inputs/` starts empty. Dot files,
dot folders and `node_modules/` are not copied, as with `collie trick add`. A symbolic link anywhere the
code hash looks (a top-level `media/` or `captures/` link included) refuses the trick with a plain reason,
as `collie trick add` refuses one, and a file name with a control or invisible character does too: the
card could not show it. A copy made before links were refused stops with "The approved copy holds a
symbolic link". `collie trick on` and `collie trick auto
<id> on` refuse in a multiplexer pane where the running bridge sees an agent (the walky socket's `pane`
op): an agent does not approve its own trick. In a shell pane they work. With no bridge, or a bridge
that does not know the op or the pane, they do not refuse. It is a speed bump, not a lock: the user
account is the real boundary, and the person approves from the phone or a terminal. A `switches.json` from an older Collie (version 1 or 2) is moved to the approved-copy layout at the
bridge's first look: a trick whose approved copy is still on disk, or whose folder still matches the hash
a person approved, keeps running from that copy, and any other waits, on, for a new yes. The file is
written as `"v": 2` with `"layout": 3` (`bridge/tricks/switches.ts`), so the previous build still reads
every switch after a rollback, and a write by it keeps every switch and hash; it drops `auto`,
`previous` and `declined`, which the next migration reads as off, none and none.

**The new version card.** When the folder of a trick that is on moves past its approved copy, the bridge
puts one Decision of kind `collie` on the Hill (`bridge/tricks/version-card.ts`): "Use the new version
of <name>?". It is minted inside the bridge only (`HillService.postCollie`); the walky socket and the
crew routes make kind `agent`, the trick runner makes kind `trick`, and a decision of kind `collie` is
read only from the bridge's own store. Its `from.ref` is `{ type: "version", id, hash }`, the pending
snapshot's code hash. The summary counts the changed files and names any new right (an `env` name or a
place). The view shows a chip per new right, a line per warning kind that is new since the
approved copy, a table of the files with their `+` and `-` counts, the diffs of the largest text changes
as many as fit, and "and N more files"; it stays under 8 KiB. The counts and diffs come from `git diff
--no-index -U2` run from `/` with the Files view's hardening, `--no-ext-diff`, `--no-textconv`, 5 s and
256 KiB per run (`bridge/tricks/version-diff.ts`); every line is masked like screen text, and a character
the view refuses becomes `?`. Without git the table lists the files only. Collie recommends "Use the new
version" only when the rights did not change, the text search finds nothing new, and every changed file
is shown whole: its whole diff in the view, no line cut at 200 characters, no key masked, git's output
not cut. A change that does not fit one card shows whole on a group of cards (see "A group of cards"
under `collie trick propose`): every line, masked lines masked and said so, and no recommendation when
any is. Past 8 cards, for a file that is not text, or without git, the summary says how much is shown
("1 of 3 files shown."), and a card with no view at all says "The change is too large to show here. Read it on the machine before you say yes." The options are "Use the new version", "Use it and stop asking" (only when no new right
is asked) and "Keep the old version". A tap acts on exactly the hash on the card: when the folder moved
since, the tap is refused with "The trick changed again since this card. A new card replaces this one."
and the card stays open. A newer change replaces the card; approving elsewhere, the folder going back,
or the trick going off withdraws it. After a change taken without asking, the row in Settings → Tricks
says when, with Undo, which brings back the version before (`POST /api/tricks/<host>/<id>/undo`).

**Strict at write, tolerant at read.** What a trick writes is checked strictly where a person or an
agent writes it: `trick.toml`, `collie hill post`, and a trick's Decisions (a Decision's view
included) refuse an unknown key, kind or attribute. A program's output is read tolerantly where the
phone shows it: a node of a kind this Collie does not know, or a part in a place it does not know, is
left out with one `dropped` note, and the rest of the view and the other parts still draw; an unknown
key or attribute on a known node, a part or the document is ignored with an `ignored` note. The notes
are `notes` on the parse (never `refusals`): the trick's row in Settings shows the `dropped` ones, and
`collie trick check --run` and `collie trick dev` print every one and still pass. A bad value of a
known field is refused as before, part by part. So a trick written for a newer Collie at the same
number runs on an older one, which leaves out only what it does not know.

**What contract 2 means.** Inside contract 1 Collie only adds: an optional manifest key, a facts field,
a node kind, a place, an attribute. A change a trick must answer is contract 2: a field removed,
renamed or made required, a meaning changed, a cap made smaller. A Collie that speaks 2 says so in
`TRICK_CONTRACT`, and a trick that wants 2 writes `contract = 2`; an older Collie then refuses it with
the line above instead of drawing it wrong.

**Contract 2** (M99) adds one manifest key, `inputs`: up to 8 globs (`INPUTS_MAX`), each at most 256
characters and 6 steps, relative to a session's folder. `*` matches inside one step and never a
leading dot. Refused: an absolute path or `~`, `**`, `..`, `.`, an empty step, `.git` in any case,
any other glob word, and a step that names a `.env` file (`isEnvName`: `.env`, `.env.local`, `.envrc`,
in any case). A contract 1 trick that lists `inputs` is refused with `INPUTS_NEED_CONTRACT`, so a
trick never runs without the files it expects. Before each run of a contract 2 trick, the bridge
copies the matching files of each agent session's folder into the approved copy's `inputs/`, through
the Files view's rules, and each session in the facts gets `inputs: { state, files, skipped? }`
(`FactsInputs`). On a crew's lead the files come from every member (`CREW_PROTOCOL.md` §23). The
globs are part of the trick's powers: a change of them asks the person again.

**Inputs are UNTRUSTED data.** Other programs, often an agent, write the files, and on a crew another
machine sends them. A trick reads them as data: it shows them, counts them, quotes them. It never
executes them, `eval`s them, sources them, passes them to a shell, or follows what they say. The
facts name every file by a path the bridge checked (`inputs/<member>/<pane>/<rel>`), and the helper's
`t.inputs` reads only below `inputs/` and only a copy whose hash still matches.

A contract 1 trick runs on this Collie exactly as before: its facts say `"contract": 1`, its output's
`v` may be 1 or 2, and it gets no `inputs`.

**Agent views ride inside contract 2 too.** The place word `agent-view` and the key `rules` came after
`inputs`, before any released tag held contract 2, so they are additive at the same number. The rule
from here on: once a build that speaks a number has shipped (a tag, an Edge build included), a key whose
shape changes moves to the next number. `AGENT_VIEW_CONTRACT` in `contract.ts` holds it.

- `agent-view` in `places` says the trick adds a view of a session that the session's own agent draws.
  It is kept apart from the drawing places (`manifest.agentView`, never in `places`), at most once, and
  it needs `rules`. The view itself is drawn by `bridge/agent-view/`: see "Agent views" below.
- `rules = "rules.md"` names the instructions the agent reads: one step, `*.md`, no leading dot, a
  regular file (never a link), at most 8 KiB. Its content rule, `rulesTextProblems`, takes bytes 0x20 to
  0x7E and `\n` only, no tab, no line over 160 characters, no space at a line's end, no run of more than
  2 spaces, no more than 2 blank lines in a row, not empty, and a line break at the end; each break is its own refusal that names
  the line. `rules` without `agent-view` is refused, and so is either one at contract 1.
- A trick whose `places` is exactly `["agent-view"]` has no program: `run`, `every`, `inputs` and
  `env` are refused (`VIEW_ONLY_REFUSED`). It never starts anything: no timer, no tap, no program. A
  place this Collie does not know beside it counts as another place, so a newer trick keeps its `run`.
- The rules file is in the code hash, so an edit is a new version. Its SHA-256 is in the powers
  (`powersOf` adds `rules` only when the manifest names it, so every other trick's powers hash is the
  same as before), so a change of the rules is a change of rights. A trick with rules never takes a
  version without asking: `collie trick auto <id> on` and the card's "always" refuse, the About sheet
  draws no "Take changes without asking", and the version card shows the rules' change whole, with the
  chip "new agent instructions", on a card group when it does not fit one card.
- The rights words are fixed: `AGENT_VIEW_WORDS`, `AGENT_VIEW_TAP_WORDS` and `RULES_WORDS`. The About
  sheet holds the rules behind "Read the instructions", the file's text whole, monospace, wrapped, never
  markdown.
- An agent cannot propose a trick with `rules` or `agent-view`, nor a new version that adds them:
  `has_rules`, "A trick that gives agents instructions cannot be proposed by an agent. Ask your person
  to add it on the machine."
- The `has_rules` refusal keeps an agent that follows the rules from proposing instructions. It is not a
  barrier: an agent with a shell can write `rules.md` into a live trick folder, or a whole folder, by
  hand. The edit is then a new version, and the version card, with the rules' change on screen, is the
  only gate before it runs (a trick with rules never takes changes without asking).
- On Windows there is no `O_NOFOLLOW`. The rules file is checked with `lstat` (a regular file, never a
  link), then opened and checked with `fstat`; a program that swaps the file for a link between the two
  can make the bridge read another regular file of at most 8 KiB that passes the content rule. What the
  card shows and what is hashed still come from that one read, so the yes still names the bytes shown.
- For a later build that serves the rules to an agent, one rule is fixed now: Collie's frame around them
  uses a delimiter the rules cannot copy, a non-ASCII marker and a line with the byte length. The rules
  are printable ASCII only, so no line of theirs can close the frame or open a new one.
- The ids `walky-talky`, `hill`, `collie` and `view` are reserved (`RESERVED_TRICK_IDS`).
- Approve what you read (every trick, not only one with rules): a row carries `approves`, the code hash
  a switch on takes (the waiting version's, else the folder's). The phone sends it back with the switch,
  and the bridge refuses another (409 `moved`, `SWITCH_MOVED`) and copies only code that hashes to it.
  `collie trick on` approves the code it hashed and prints the rules' sha256 and where to read them.

## Writing a trick in TypeScript

`collie trick init <id>` makes `<config dir>/tricks/<id>/` with five files: `trick.toml` with
`run = "program.ts"`, `program.ts` (about 25 lines: a status chip, a Dashboard tile, a session with a
row per session, and a Decision commented out), `trick.ts` (the helper), `config.toml` (settings the
program reads) and `AGENTS.md` (the contract for an agent that grows the trick). `collie trick init
--sh <id>` writes the shell sample instead (`program.sh`, one belt mark).

```ts
import { run, v } from "./trick.ts";

run((t) => {
  const busy = t.facts.sessions.filter((s) => s.status === "working").length;
  t.status({ text: `${busy} busy`, tone: busy > 0 ? "accent" : "muted" });
  t.session({ view: [v.list(t.facts.sessions.map((s) => v.row(s.name ?? s.paneId, { end: s.status })))] });
});
```

`trick.ts` is one self-contained file (`cli/trick-kit/trick.ts` in this repo, held in the binary as
text). It imports only `node:` built-ins and Bun, and its first line names its version, `// collie
trick helper v4`. `collie trick helper <id>` rewrites it with the version this Collie carries; the
helper is part of the trick's code, so a trick that is on keeps running the approved copy, and the new
helper waits for a person's yes.
`collie trick check` lists a `trick.ts` whose bytes are a helper this Collie ships as "helper v4" (an
older one with the command to update it) and does not grep it; a changed one is grepped as the trick's
own code and called a modified helper.

| API | What it does |
| --- | ------------ |
| `run(async (t) => { ... })` | reads the facts from stdin, calls the function, prints the document once, exits 0 |
| `t.facts` | the facts, typed: `contract`, `trigger`, `trick` (`id`, `dir`, `state`), `host`, `memberId`, `sessions`, `spaces` |
| `t.config` | `config.toml` of the trick folder, parsed with `Bun.TOML`; `{}` when there is none |
| `t.tap` | the tap that started the run, or null; one shape from every place: `{ rid, node, intent, value, decision, text, from, seen }`. A part's tap has `value` (a string or null) and `from`; an answer to a Decision has `decision` (its key), `text` (the person's words or null) and `seen`. The fields a tap does not have are null |
| `t.status({ text, icon?, tone? })` | the chip in the status line (part id `status`) |
| `t.belt({ label, icon?, tone?, badge?, intent? })` | the mark at the end of the Belt (part id `belt`) |
| `t.dashboard(item)`, `t.tabbar(item)` | the Dashboard tile and the bottom bar item, `{ label, icon?, badge?, tone? }` |
| `t.session({ id?, name?, subtitle?, badge?, progress?, actions?, view })` | the trick's session; keep the default id `main` |
| `v.card`, `v.group`, `v.list`, `v.row`, `v.bar`, `v.chip`, `v.button`, `v.para`, `v.line`, `v.run`, `v.code`, `v.link`, `v.image`, `v.meter`, `v.spacer`, `v.number`, `v.compare`, `v.table`, `v.diff`, `v.spark` | one builder per node kind; a number attribute may be a number, a flag `true`. `v.image(ref, { caption?, fit?, focus? })` names a Decision's picture, `v.image(src, alt, w, h, look?)` a file of the trick's `media/` folder; `focus` is `{ x, y, zoom? }`. `v.table({ columns, rows })` writes the heads and cells for you, `v.diff(lines, { file? })` takes a list or a text, `v.spark(values, { tone?, label? })` a list of numbers |
| `v.beforeAfter(aRef, bRef, { before?, after?, fit?, focus? })`, `v.checks([{ label, ok, note? }], { label? })`, `v.stat(value, label, { trend?, tone?, unit? })` | recipes made of the kinds above: a compare of two of the Decision's pictures cropped to one point; a list of rows with a green check or a red cross and the note as the second line (with `label`, a labelled group of those rows, which may sit where a list may not); a number, with a spark under it when `trend` gives the numbers |
| `t.decide({ key, title, summary, options, recommends?, body?, text?, priority?, about?, replyTo?, media?, links?, view? })` | asks the person on the Hill; `view` is a list of display nodes under the summary (see "A Decision's view") |
| `t.keepDecisions()` | leaves the `decisions` key out: the open Decisions stay as they are |
| `t.state.get(name, fallback)`, `t.state.set(name, value)` | JSON files in the trick's state folder, written whole (a temp file, then a rename); a name may hold folders (`cache/ci`), never `..` or a dot first |
| `t.log(name)` | an append-only JSON-lines file `<name>.jsonl` in the state folder: `.append(entry)`, `.all()`, `.last(n)`, `.has(rid)`, and `.once(rid, entry)`, which appends only when no entry has that rid and says whether it wrote |
| `t.cached(name, ttlMs, loader)` | a read kept in `<name>.json` with its time: `{ value, at, stale, error }`. A fresh value is served as it is; else the loader runs and its value is kept. A loader that throws serves the old value with `stale: true`, or `value: null` when there is none. Pass `Infinity` on a tap so a tap never waits on the network |
| `t.closedUntil(key, untilMs)`, `t.isClosed(key)` | close a key for a while (a held or dismissed Decision), in `closed.json`; `isClosed` answers when it opens again, or null |
| `t.path(p)` | a path from `config.toml`, made absolute: `~/` is the home folder, a relative path is taken from the trick folder |
| `t.tool(name, extraDirs?)` | the absolute path of a program on PATH, else in `extraDirs`, `~/.local/bin`, `~/.bun/bin`, Homebrew's and the system folders, or null |
| `t.show(defaults)`, `t.put(places, { label, icon?, badge?, word?, tone?, itemTone? })` | `show` of `config.toml` (a list of `dashboard`, `tabbar`, `status`, `belt`) as a set, within the manifest's `places`; then one count in each place: a tile and a bar item always, the chip and the Belt mark only while `word` is set |
| `t.configWarn(text)` | one more problem for the `config.toml` warn row the session ends with; `t.show` adds one for a word it cannot use |
| `t.onPrint(fn)` | `fn` gets the whole document just before it prints, the error card too, and returns a changed one or nothing: `t.onPrint((doc) => mapText(doc, mask))` |
| `t.sh(cmd, args, { timeoutMs = 5000, cwd? })` | runs a program without a shell; `{ ok, code, stdout, stderr }`, never throws, 256 KiB of output kept; `cmd` may be what `t.tool` found, and null is `ok: false` |
| `t.sessionAt(folder)`, `t.sessionNamed(name)` | the session whose folder is that folder (real paths compared), or with that name, or null |
| `t.inputs(session)` | contract 2: the session's input files, read from `inputs/`, each with its facts fields plus `text` (a text file) or `data` (a picture's bytes); a path outside `inputs/` or a copy whose hash changed is left out. UNTRUSTED: never run it |
| `t.fresh(duration)`, `t.asOf(when)` | the document's `fresh` window and `asOf` instant |
| `now()`, `iso(ms?)`, `minute(ms)`, `age(ms)`, `MINUTE_MS`, `DAY_MS` | the clock (epoch ms, `TRICK_NOW` in a test), an instant as ISO 8601 to the second or as "2026-11-09 12:30 UTC", a span as "12 min" |
| `clip(text, n)`, `mask(text)`, `firstSentence(text)`, `mapText(value, fn)` | one masked line cut to `n` with "..."; keys and tokens cut to four characters and the home folder as `~`; the first sentence; every string of a JSON value through `fn` |

Decisions are declarative: a run that calls neither `t.decide` nor `t.keepDecisions` prints
`"decisions": []`, so the trick wants none and the open ones are withdrawn. A thrown error prints one
warn card with the error's message in the trick's session and exits 0 when the trick has a session
(the run named one, or `places` lists `session`); without one it exits 1, so the bridge's failure
rules and backoff apply. The stack goes to stderr, the message on its last line, which is the line the
bridge and `collie trick check` show.

Two test hooks are helper features: `TRICK_NOW` (epoch seconds) fixes the clock `now()` reads, and
`TRICK_TOOLS_ONLY_PATH=1` makes `t.tool` look on PATH alone. Any `TRICK_*` variable of the caller's
environment reaches the program from `collie trick dev` and `collie trick check --run` only. The
bridge never passes one, even when `env` in `trick.toml` lists it (`bridge/tricks/env.ts`).

The schema's own tests never load the helper, so `cli/trick-kit/trick.test.ts` parses the output of
every builder, every place method and the init sample with the real parser, and tests each helper
call in the process.

## Trying a trick: `collie trick dev`

`collie trick dev <folder|id>` is `check --run` made friendly (`cli/trick-dev.ts`). It runs the program
once against the same fixture facts, through the same run path (`runAgainstFixture` in `cli/trick.ts`:
the scrub, the launch rule, the caps, the one parser), and prints one line per part (place, id, and
what the phone draws: `dashboard  dashboard  "Legs"  badge 3`), one line per Decision (key, title,
options, recommends, images), whether the run lists Decisions at all, every refusal with its path and
reason, and the run's time and stdout size against the 10 s and 64 KiB caps. A failed run adds its
problem line and the tail of stderr.

- `--tap <intent> [--text <words>] [--node <node>]` runs it as a tap. `--node` defaults to `main`; a
  `hill/<key>` node carries `{ text }`, as a Decision's answer does.
- `--rid <uuid>` is the request id of that tap. It goes with `--tap` only, and it must be a UUID. Without
  it each run gets a fresh one.
- `--facts <file.json>` runs the program on your facts instead of the fixture's. The file goes through
  `parseFacts`; a missing file, a file that is not JSON, or a refused one prints each refusal with its
  path (`error: --facts f.json: /sessions/0/status: ...`) and exits with 2 before anything runs. The
  `trick` field (id, dir, state) is always this run's own. Without `--tap` the file's trigger is used,
  and that may be a tap; `--tap` replaces it.
- `--state <dir>` uses this state folder instead of a scratch one, and keeps it. It is created when
  missing and never removed, so a program that keeps notes there sees them on the next run. With
  `--watch` every run uses the same folder. `--json` then adds `"state"`.
- `--inputs <dir>` reads a contract 2 trick's `inputs` globs from `dir` as the first agent session's
  folder, through the bridge's own read and delivery (`bridge/tricks/inputs.ts`), into the folder's
  `inputs/`. It writes `inputs/` only when there is none yet or when an earlier `--inputs` run made it
  (the mark `.collie-dev-inputs`), so a folder of the author's own by that name is never emptied.
- `--json` prints the parsed result: the parts, the Decisions, the refusals, the outcome and the sizes.
- `--watch` runs it again when a file in the folder changes, 300 ms after the last change (code and
  `config.toml`; never a `*.log`, a dot file, `media/` or `captures/`). Ctrl-C stops it.

It never talks to the bridge and never posts: nothing reaches a phone or the hill.

## Adding a trick from a repository: `collie trick add`

No trick ships in the binary and none is installed by default; the person picks one.

```
collie trick add                                   # the official repository's tricks; adds nothing
collie trick add legs                              # the folder legs of the official repository
collie trick add https://github.com/o/r//legs#v1   # any https git repository, a folder, a ref
collie trick update legs [--ref <ref>] [--dry-run]
collie trick remove legs                           # only while it is off
```

The official repository is `https://github.com/AltanS/collie-tricks` (`OFFICIAL_TRICKS_REPO` in
`cli/trick-add.ts`). A source is `<https-url>[//<folder>][#<ref>]`, and `#<ref>//<folder>` reads too; a
ref is a branch, a tag or a full 40-digit commit. A `refs/` name must be `refs/heads/...` or
`refs/tags/...`: `refs/pull/N/head`, which GitHub serves through the repository's own URL, is refused. A
short name is looked up as exactly a tag or a branch of that name, so `pull/5/head` never reaches a pull
request through git's own lookup. The official repository takes no commit id at all: a fork's commit is
reachable there by its id too. The official repository is written one way only,
`https://github.com/AltanS/collie-tricks`: a spelling GitHub also serves (`.git`, a trailing `/`, another
case, `www.`) is refused with a sentence that names the URL, and every check of "is this the official
repository" compares one form (`bridge/tricks/origin.ts` `canonicalRepoUrl`), so a record written another
way by hand reads as not on the list. A URL with a user name or a password is refused. The
list with no source names each folder of the official repository that holds a `trick.toml`, with the
manifest's `name` and its first comment line as the description.

**What a repository may not do.** Nothing from it runs, and git never writes a working tree. The fetch
goes into a fresh bare repository in a temp folder under the state folder, depth 1, no tags, no
submodules, https only, no hook, no LFS smudge, no prompt, with a timeout; the header of
`bridge/tricks/fetch.ts` has the git lines (the CLI and the bridge run the same code). The tree is read from git's own objects, so a symlink or a
submodule anywhere in the trick's folder refuses it on every platform, and Collie writes each regular
file itself. Then the strict manifest reader must accept `trick.toml` at this contract, the caps must
hold (300 files and 5 MB, `ADD_LIMITS` in `bridge/tricks/fetch.ts`), and the id must be free. Dot files, dot folders and
`node_modules/` are not copied: they are outside the code hash, so they would be code nobody approved.
Every refusal exits 1 with one reason, and the temp folder goes on every path.

**The trick stays off.** `add` prints what it copied, the commit, and the same warnings as `collie trick
check`, then "The trick is off. Read it, then: collie trick on <id>". It writes one dot file,
`.collie-origin.json` (`bridge/tricks/origin.ts`): the URL, the ref asked, the commit it resolved to,
the folder and the time. The code hash leaves dot files out, so the record never stops a trick. The
bridge shows it as the trick's provenance (`From AltanS/collie-tricks @ 9c41d07`), and `collie trick
list` in its ORIGIN column.

**`update` replaces the code and keeps your part.** It fetches the same source (the same ref unless
`--ref`), checks it the same way, and prints the old and new commit, how many code files are added,
changed and removed, and the warnings that are new. Then it swaps the folder in two renames, keeping
`config.toml` and the trick's state folder, and rewrites the origin record. The new code hashes
differently, so a trick that was on keeps running the version the person approved, the new one waits
for their yes, and the verb says so.
`--dry-run` prints the summary and changes nothing. A folder without an origin record has nothing to
update from.

**The warnings show at the switch.** The grep of `collie trick check` lives in `bridge/tricks/scan.ts`,
read by the CLI and the bridge alike. `collie trick on` prints its warnings above the confirmation, with
one line that they come from a text search and are not a proof, and still switches on. The bridge puts
them on the row of a trick that is off or changed (`WireTrickInfo.warnings`: one `{ kind, text }` per
kind, at most 8; a waiting version carries the ones new since the approved copy in
`WireTrickInfo.pending.warnings`), and Settings → Tricks lists them under that trick before the switch. They never
refuse, and the switch stays one tap.

## Official tricks: the list on the phone

Each Collie release carries a short list of official tricks: `bridge/tricks/official.json`, built into
the binary, read strictly by `bridge/tricks/official.ts`. An entry is a trick id, its name, one line
about it, the repository (`https://github.com/AltanS/collie-tricks`, the only one the reader accepts),
the folder in it, a full commit, the code hash that folder has at that commit, an extras hash over what
an add installs beside the code (`config.toml` and `media/`, code-hash.ts `officialExtrasHash`), and
`rules`: the SHA-256 of the instructions a contract 2 trick gives its agents, or null. The code hash
already covers that file; the pin lets the phone say "Gives your agents instructions written by its
author." before Add without a fetch, and the add (and an update) refuses a folder whose rules differ. The
list carries no rules text, so the not-added About sheet says "Read the instructions after you add it. It
stays off until you switch it on." The added trick's own About sheet shows them before the switch. Settings, Tricks shows
the entries that are not added under "Official tricks", each with an Add button. On a fresh install, with no tricks
folder yet, the card shows too when the list is not empty (the bridge sends `tricksRev` for it), and holds
only the list and the foot line; the first add makes `<configDir>/tricks/` (0700), and the next scan reads
it with no restart. A crew member, which runs no tricks, shows no card without a folder, as before. Nothing ships switched on,
and no trick code ships in the binary.

**What a tap does.** `POST /api/tricks/official/<id>/add` (write, like the switch: a paired phone only,
never the local credential an agent can hold, and no WalkyTalky op reaches it). The bridge fetches that
one commit with the fetch of `collie trick add` (`bridge/tricks/fetch.ts`), reads the folder by the same
rules, and takes its code hash and its extras hash. Only when both are the list's does it write the folder, off, with an
origin record `{ url, commit, subdir, official: true }` and no approved copy. The person's switch makes
the approved copy, as for any trick. A hash that differs adds nothing: "The code did not match.
Nothing was added." The same holds for a `config.toml` or a picture in `media/` other than the list's,
and for any other file the code hash leaves out (`captures/`, `inputs/`, a `.log`): an official trick
ships none, so the add refuses it. One add runs at a time, the whole add has a two-minute cap, and the temp folder under
`<stateDir>/tricks/` goes on every path; one a stopped bridge left behind (`.fetch-official-*`) goes at
the next bridge start.

**Two caps on the fetch.** Time: every git run ends by two minutes after the tap, and a kill takes git's
whole process group, so `git-remote-https` goes with it. Size: the temp repository may hold at most 20 MiB
(`OFFICIAL_FETCH_BYTES_MAX`). It is measured while git runs and once after; past the cap the fetch is
killed and refused as `too-large`, before anything is read from it, and the phone says the same line as
for a hash that differs. git offers no size limit of its own on a fetch.

**The one network request.** A tap on Add or Update makes one git fetch over https from
`github.com/AltanS/collie-tricks`: depth 1, the listed commit only, no redirects, no credential helper,
no global git config. Nothing else in this feature touches the network: the list comes from the
binary, `GET /api/tricks/official` reads only the tricks folder, and there is no background check and
no count. Offline, the tap says "GitHub did not answer. Nothing was added." That line is also true
when the repository no longer serves the commit.

**The trust root is the binary.** The commit pins what git fetches, and the hash pins what Collie
writes. A repository that serves other content at that commit fails git's own object check or the hash.
Changing the list on a machine means changing the binary.

**States.** `GET /api/tricks/official` answers each entry's state on this machine: `absent` (no folder of
that id), `added` (a folder the list put there: its origin record says `official: true` and names this
repository and folder at the listed commit), `update` (the same, at a commit an earlier release listed:
the entry's `previous`, kept by the maintainer script, at most 8), and `taken` (any other folder of that
id, a link or a file: a proposal, a hand-made trick, another repository). A taken folder is never written
over, also when one appears during the fetch. A folder from this repository and folder that is not a
version of the list (`collie trick add` at a branch or tag nobody listed, a record without `official`, or
`official` written by hand at a commit the list never named) is `taken` with `unlisted: true`: its row says
"Added from the repository, not from the official list.", and its trick row reads "From AltanS/collie-tricks
@ 5e1f00d, not on the official list", never as the list. A crew member answers an empty list with `runsOn`.

**Update.** On a new release the list may name another commit; the installed row then offers Update
(`POST /api/tricks/official/<id>/update`). The bridge fetches and checks the same way, then moves only
code, by the rule of a proposal's version write: each file the code hash walks is written or removed,
and every other entry of the folder, at any depth, stays untouched (`config.toml`, `media/`,
`captures/`, `inputs/`, logs, dot files). The new version's own `config.toml` and pictures are not taken.
**An update never moves or removes a file of yours.** Before anything changes, the bridge takes the
folder's code hash: it must be the hash the list names for the commit in the origin record (the current
entry or one in `previous`), so every code file is still one Collie wrote. A code edit, or a plain file
you added beside the code (`notes.txt` is code by the hash's rule), makes that hash another: the From
Collie row then reads "You edited its files. Update it on the machine." (state `taken`, `changed: true`),
and an update tap answers 409 `changed` with the same line. Nothing is moved or removed; `collie trick
update` on the machine is the way. A name the new code needs where an entry of yours stands refuses the
update (409 `blocked`, "Your own files block it. Nothing was changed."), and nothing changes. The check
runs again in the runner's lane, right before the write. A trick that is on keeps
running the approved copy, and the new version waits for the yes on its version card, the path every
changed trick takes. **With `auto` on for that trick, a tap on Update is the yes:** the runner takes the
new version with no card once the folder settles, unless its powers change (its `env`, `places` or `inputs`)
or a warning of a new kind appears; then the card waits as without `auto`. Undo on the row restores the
version before. Remove stays as it is.

**The maintainer script.** `bun scripts/official-tricks.ts --repo-dir <checkout> --commit <sha>` writes
the commit, each hash (the real hash function, over the folder git holds at that commit), each extras
hash (the same function the add checks with), the earlier versions in `previous`, and each manifest's
name into the list. It refuses a commit that is not on `origin/main` of the checkout, and a folder with a
non-code file other than `config.toml` and `media/`; `--check` writes nothing and fails when the list is stale. `collie trick
list --official` prints the list and each state here; it fetches nothing.

## Handing a trick to the person: `collie trick propose` and `collie trick guide`

An agent writes a trick; only the person switches it on. Two verbs connect the two (crew slice 8).

```
collie trick guide [--json]                         # how to write a trick, as plain text; needs no bridge
collie trick propose <folder> [--request-id <uuid>] [--json]
```

**The guide** (`cli/trick-guide.ts`) is its own text, not part of the WalkyTalky skill or the Hill
rules. Its key list and place list are typed against `MANIFEST_KEYS` and `PLACE_KINDS`, so a new key
or place is a compile error until the guide describes it, and its numbers come from the constants the
bridge checks with. `--json` prints `{ guide, manifestKeys, places }`.

**Propose** reads the folder as `collie trick check` reads it (a trick it refuses is never sent), then
reads the files the hardened way (`readTrickFolder`): regular files only, a symbolic link anywhere
refuses the folder, at most 300 files, 5 MB and 8 folders deep, the caps of `collie trick add`. Dot
files and dot folders, `node_modules/`, `*.log`, the top `inputs/`, `media/` and `captures/` folders
and `config.toml` stay behind (a proposal carries code only: the person adds pictures and settings on
the machine), and the verb says how many. The files go as one line on the walky socket,
`{"op":"trick.propose",...}`, which may be up to 8 MiB because it opens with that op; a line that does
not is held to the walky cap. The bridge reads at most two such lines at once, each within 30 seconds;
a line's slot comes back once the line is read, and the answer closes the connection. Before
`JSON.parse`, the line's structure outside strings is counted: more than 4096 `{`, `[`, `,` or `:`, or
nesting deeper than 8, is refused unread ("The proposal has more parts than a trick's files need, so
it was not read."). A proposal of 300 files needs about 2400.

**Where it goes.** A lead or a solo bridge keeps the proposal (`bridge/tricks/proposals.ts`). A crew
member reads every file with the same reader and forwards the proposal to its lead over the signed
`POST /crew/v1/tricks/propose` (`CREW_PROTOCOL.md` §24), and keeps no copy. All three use one reader,
`readProposal` in `bridge/tricks/propose-wire.ts`: a relative path of at most 256 characters and 8
steps, no `.` or `..` step, no dot step, no `node_modules` or `inputs` step, no backslash or colon, no
control, bidi or invisible character, NFC only; no two names that fold to one (case and Unicode
compatibility forms, `NFKC` then lower case), files and folders alike, and the reserved names compared
folded too; no name used as a file and a folder; nothing in `media/` or `captures/` and no
`config.toml` ("A proposal cannot carry a config.toml. Your person sets the trick up on the
machine."); `trick.toml` at most 64 KiB, read by the
strict manifest reader; an id Collie does not keep for itself (`collie`, `trick`, `tricks`, `hill`,
`settings`).

**Inert until the yes.** A proposal for a new trick is stored, never installed:
`<configDir>/tricks/.collie-proposed/<id>/<hash16>/`, folders 0700 and files 0600 with no executable
bit (the mark is kept in `<stateDir>/tricks/proposals.json`). The scanner never reads a dot folder, so
nothing there runs or is listed. Collie posts a card on the Hill as its own sender, through a door no
agent and no crew member reaches (`HillService.postCollie`):

- title `Switch on the trick <id>?`, no recommendation, options "Switch it on" (asks twice: "Yes,
  switch on") and "Not now", no text box, priority today, and it closes after 3 days;
- the summary says who proposes ("An agent session (repo#one) on minibuch proposes it.", "An agent
  session on minibuch proposes it." or, with no agent pane placed, "Someone on minibuch proposes it.
  Collie could not confirm which session."), "It replaces an earlier proposal from the same session."
  when it does, how many files, and the rights the manifest asks for; the view lists every right,
  every `inputs` glob and every warning of the code search in full (as chips when each fits a chip and
  one bar holds them all, else as paragraphs), then the author's name, description and About under
  "Its author's words. Collie did not check them." (at most 3 paragraphs and 400 characters), and the
  code. The facts are never cut: when they alone do not fit a Decision's view, the proposal is refused
  (`card_too_large`, "This trick asks for more than a card can show, so it was not proposed. Ask your
  person to add it on the machine.").

**A group of cards.** A proposal shows all of its code, never a part. Code that fits one card whole
keeps one card, as before. Otherwise the card is one Decision with a `group` of 2 to 8 cards
(`bridge/tricks/card-group.ts`, `bridge/hill/group.ts`):

- card 1 is the facts and never code: who proposes, every right and warning in full, "7 files, on cards
  2 to 4.", a table of the files with their size (a version: the change and its line counts) and the
  cards each is on, then the author's words when they still fit (they never push a fact off);
- cards 2 to n hold every line of every file, whole files in a fixed order: `trick.toml`, the file `run`
  names, then the rest by path in byte order. A file that goes on to the next card ends with "continues
  on the next card", and the next card starts with "continued from the last card". A line longer than a
  row (200 characters) goes on in the rows after it, each marked `↪`. No line is dropped;
- the capacity is a named constant: 7 cards of code (`GROUP_CODE_CARDS`), 6 KiB of code each
  (`GROUP_CARD_CODE_BYTES`), so 42 KiB (`GROUP_CODE_BYTES`) and 64 files (`GROUP_FILES_MAX`) in all,
  every card under the one Decision view cap. `collie trick guide` prints it, and `collie trick check`
  says "This trick shows as N cards.", or an error that it cannot be proposed (the check still
  passes: the trick runs on the machine);
- a `trick.ts` whose bytes are a helper this Collie ships (by SHA-256, as the code search already
  knows it) is Collie's own code: card 1 names it ("trick.ts is the helper Collie ships (v4), byte for
  byte, so no card shows it.") and it takes no room. A changed helper is the author's code and counts;
- refused before anything is stored, by the CLI before it sends (counting the whole trick) and again
  by the lead (counting what it shows): code larger than the group (`too_large`, "This trick is too
  large to show on the phone, so it was not proposed. Ask your person to add it on the machine."), and a
  file that is not UTF-8 text or a line the card would mask or show with `?` (`cannot_show`, "This trick
  holds text that a card cannot show as it is (a key, or a hidden character), so it was not proposed.
  Ask your person to add it on the machine."). The single card of before showed such a line masked and
  said "N of M files shown."; a proposal now never shows code other than as it is. A hidden
  character is any one `web/src/lib/hidden-chars.ts` names: a control but the line feed and the tab, a
  format or direction character, U+2028 and U+2029 (a JavaScript line end), a zero-width joiner, a
  variation selector, a blank-looking letter (U+3164, U+115F, U+2800), a space that is not U+0020, a
  private-use or unassigned code point. The phone's `diff` rule refuses the same characters. Windows
  line ends (CRLF) are proposed: the CR of a CRLF line end is the line's end and shows nothing. A CR
  inside a line (old or mixed line ends) is a hidden character, and when it is the only one the refusal
  says so and names the file ("This trick holds a file with old or mixed line ends (program.ts), so it
  was not proposed. Save it with Unix line ends, or ask your person to add it on the machine."). A line
  with a run of more than 40 spaces (a tab counts as two) is refused too (`cannot_show`): on a Decision's
  card the phone soft-wraps code, each row that goes on marked `↪` in the sign column, and such a run
  would still push the code after it far down and out of the reader's way. A new version whose diff
  against the running one failed, or names no file while its code is another, is refused
  (`cannot_show`, "Collie could not compare this version with the one that runs, so it was not
  proposed. Try again, or ask your person to add it on the machine."), and the stored copy is read back
  and hashed once its card is made: a copy that moved meanwhile is not posted;
- each card is stored with the SHA-256 of its view, and the group with a digest over the Decision's ref
  and the cards' hashes in order. Only `postCollie` makes a group: a post that carries `group` or
  `parts` from an agent, a trick, the walky socket or a crew member is refused, and the decisions file
  drops a group whose hashes do not match;
- the yes needs the group's digest and every card opened on the phone. A yes without them is a
  rejected receipt that keeps the card open: "Open all N cards first.", "These cards changed since this
  phone showed them. Open them again from card 1.", or, from an app before groups, "This app does not
  show a group of cards yet. Reload Collie on this phone, then open every card and answer again." "Not
  now" and a dismiss need neither. At the install the stored bytes are hashed again, as before.

The runner's own version card (above) groups its diff by the same rule, with masked lines shown masked,
a note on that card, and no recommendation. Past 8 cards, for a file that is not text, or with more
files than a group lists, it keeps the one card and its words.

The session's name on the card is the lead's own word for that session, or none; a member cannot name
it. A session named "Collie" (folded) is named by its machine only, and on any Decision a session or a
trick of that name shows as "Collie (a session)" or "Collie (a trick)". The proposer may read the card (`collie hill status`) and is told the answer in WalkyTalky, but it
can neither answer nor withdraw it: the card is Collie's, and every answer comes from the phone.

**The yes.** "Switch it on" reads the stored bytes back, hashes them, and installs only a hash equal to
the card's (`PROPOSAL_CHANGED` otherwise). The files become `<configDir>/tricks/<id>/` through a staged
sibling and one rename, never over a folder that appeared meanwhile; the code written is approved as it
is and switched on, by `proposal` in the switch file and the audit. A dot file
`.collie-origin.json` records the proposal (`by`, `host`, `label`, `at`): `collie trick list` shows it as
`proposed by agent on minibuch`, and the wire's `provenance` carries `proposed: { by, host }`, so the
Settings row says "Proposed by an agent on minibuch" and the About sheet "Proposed by an agent session
on minibuch." With no agent pane placed they say "Proposed from minibuch, session not confirmed" and
"Proposed from minibuch. The session is not confirmed." "Not now", a dismiss, the expiry, or a newer
proposal from the same session removes the stored copy.

**A trick that exists.** Only a trick a proposal made takes a new version by proposal. Before the
person's yes, nothing a proposer sends changes a file outside `.collie-proposed/` and
`proposals.json`: the new version is stored inert like a new trick, and the trick's folder, its approved
copy and the switch file stay as they are. Its card is minted by the proposals module with the
`proposal` ref, so there is one answer path: title "Use the new version of <id>?", the proposer named
first, the changed files against the approved copy fitted as the runner's version card fits them, the
new rights and new warnings, no "Use it and stop asking", never a recommendation. Options "Use the new
version" (asks twice: "Yes, use it") and "Keep the old version". On the yes the stored bytes are hashed
again, the trick must still be the one the card was made against (the same approved hash, its folder
unchanged), then only its code files change, in place: old code files the new version lacks are
removed, and each new one is written to a temp file beside it and renamed. Every file the code hash
does not read (`config.toml`, `media/`, `captures/`, `inputs/`, logs, dot files, `node_modules/`) stays
byte for byte. A new file whose name the person's own files hold refuses the yes ("The new version needs
the name <x>, where the trick's folder holds something of your own, so nothing was changed."). Exactly
the code written is approved. The trick stays on, and "Undo" in Settings goes back to the version
before. No scan runs between the write and the approval, so the runner never posts a version card of
its own for it. "Keep the old version", a dismiss and the expiry remove the stored copy and change
nothing else. When the bridge starts, it cleans up after a write a crash cut short: a staged folder or
a temp file goes, and a set-aside trick folder whose place is empty comes back.

A proposal is refused, in plain words, for a trick from a repository ("This trick comes from <repo>.
Change it there."), one added on this machine ("<id> was added on this machine. Change it there.": the
person owns that folder), one that is off, one with a change waiting, one that runs no approved copy.
DECISION: a trick on auto takes a proposal. Auto takes the person's own folder edits without asking;
a proposal comes from an agent, so it still waits for the yes on its card, and auto stays as it was.

**The limits** (`proposals.ts`): one sender (a session, or one machine's terminal) at most 2 open
proposals and 6 in an hour; one crew machine 4 open and 12 in an hour, its sessions and its terminal
together; the lead 8 open and 32 MiB stored. One open proposal per trick id: the same session's next
one replaces it, anybody else's is refused. A proposal with no agent pane placed never replaces one
("A proposal of <id> from this machine already waits for your person's answer. Collie cannot confirm
which session sent it, so it is not replaced."): the lead cannot tell who sent it. A request id
answers what it answered for 24 hours; with other files it is refused. While the person has the card
open in the answer sheet, a replacement is refused (`answering`). The refresh timer sweeps closed cards
and copies no proposal names.

## The run line

`run` in `trick.toml` takes two forms (`bridge/tricks/run.ts`, `launchOf`, the one rule the bridge's
runner and `collie trick check --run` share):

- **A script**: `run = "program.ts"` (or `.js`, `.mjs`, `.mts`), one relative path inside the trick
  folder with no shell words. Collie runs it with its own runtime: the compiled `collie` is a Bun
  executable, and the runner spawns it on the script with `BUN_BE_BUN=1` added to the scrubbed
  environment, so the bridge's unit needs no `bun` on its PATH. Under plain `bun` (a source checkout,
  the tests) the runner spawns that `bun` without the variable. Nothing is installed and nothing is
  fetched (`--no-install`): a script imports only relative files in its own folder and the `node:`
  and `bun:` built-ins. `collie trick check` warns on each line that imports a package by a bare name.
  `BUN_BE_BUN` is visible to the script, so a script that starts `collie` itself removes it from the
  child's environment first (the helper's `t.sh` does).
- **A shell command line**: anything else (`./legs.sh`, `bun program.ts`, `darius due --json`), run
  by `/bin/sh -c` (or `cmd.exe /c`) in the trick folder, as before. It never sees `BUN_BE_BUN`: the
  environment scrub never passes it, even when `env` lists it.

`collie trick check` greps only code. README.md, SKILL.md, AGENTS.md, every `*.md`, `*.toml`,
`*.json` and `*.txt`, a `test.sh`, a `*.test.*` file and anything under `fixtures/` are listed as not
grepped, and they still count in the code hash. In a code file a command counts only where a program
runs it: a whole string literal (`t.sh("git", ...)`, `Bun.spawn(["gh", ...])`), `t.sh(`, a spawn or a
`fetch(`, never a word like `node` in a name, a comment or a sentence. A shell file keeps the bare
words, since every word there is in command position.

## The parsers

- `parseManifest(toml)`: `trick.toml` after the TOML parse. A later field (`watch`, `on`, `serve`)
  or a later place is skipped with a `later` refusal, and the trick still loads. `env` lists the
  environment names the program needs past the bridge's allow-list (`bridge/tricks/env.ts`); the list
  and `collie trick check` show each one, and a `COLLIE_*`, `HERDR_*`, `*_SOCK` or `*_SOCKET` name is
  never passed, even when listed.
- `parseFacts(json)`: a facts document, for `collie trick check --run` with fixture facts.
- `parseTrickDocumentText(stdout, opts)` and `parseTrickDocument(json, opts)`: the program's output.
  `opts.declared` is the manifest's `places`, `opts.places` and `opts.kinds` what this Collie draws
  (default: all of them). A bad part is refused alone, and `refusedParts` names it so the runner keeps
  its last good version, stale. `documentRefused` says no part was read at all. `notes` lists what
  the tolerant read left out or ignored ("Contract 1").
- `parseTapRequest(json)`: the body of `POST /api/tricks/<host>/<id>/tap`.

None of them throws. Each refusal has a JSON pointer `path`, a `code` and a plain `reason`.

## The facts

The bridge writes `{ contract, trigger, trick, memberId, host, sessions, spaces, sessionsOmitted? }` on stdin.

- `memberId` names the bridge that runs the trick: its crew member id, or on a solo install its
  install id, `m_` and ten of `[a-z0-9]`, minted once into `<stateDir>/bridge-id.json`. It stays the
  same when the machine is renamed. Key anything a program keeps on it.
- `host` is the machine's name, for display only. It changes with a rename. Never key on it.
- Each session has `id`, its scope key `<memberId>:<paneId>` (pass it back in `about`, `replyTo`,
  `href`), its own `memberId` (read it instead of parsing `id`), `sessionId` (opaque), `paneId`,
  and `host` (display only), then `name`, `agent`, `status`, `cwd`, `space`, `tab`, `lastActiveAt`.
- On a crew's lead the sessions are every member's, the lead's own first, each with `reachable` (did
  the lead's last sweep reach its machine). The facts hold at most `FACT_SESSIONS_MAX` sessions and
  `FACT_SESSIONS_MAX_BYTES` of them; `sessionsOmitted` counts the rest. A trick may name a member's
  session in a Decision's `about` and `replyTo` only when that session is in its run's facts.
- For a contract 2 trick with `inputs`, each session has `inputs`: `state` is `ok`, `offline` (its
  machine did not answer), `older` (its machine runs a Collie before 1.29.0), `refused` (its machine
  switched trick reads off) or `none` (a shell, or no folder); `files` lists each copy (`rel`, `path`
  relative to `trick.dir`, `bytes`, `sha256`, `mtime`, `kind` `text` or `image`); `skipped` counts
  what the caps left out (a text file over 256 KiB, a picture over 2 MB, another type, past 32 files,
  past 8 MiB in one answer or 24 MiB in one run), and a file whose name holds a control, bidi or
  zero-width character (`unsafeText`), which is never read. A Decision's `media` may name a picture by its
  `path`.

The parts a trick prints are keyed by (member id, trick, part) on the bridge. The wire names the
member id `host` in a part, a list entry, a tap path and a trick session id, a name kept from
slice 1. Its value is the member id, never the host name.

## The document

```json
{ "v": 1, "parts": [{ "at": "session", "id": "legs", "view": [{ "kind": "number", "text": "23/34" }] }],
  "decisions": [], "asOf": "2026-11-08T09:41:00Z", "fresh": "90s" }
```

`v` is the contract number. There is no `draft` and no `open` (a document that still sends one has
the key ignored, with a note). A trick never writes into a reply box, and a tap never moves the
phone. What a trick wants to show is a `link`. What it wants to tell the person is a decision.

A document with no `decisions` key leaves the trick's decisions on the hill as they are. An empty
list, `"decisions": []`, withdraws every open one. So a run that only redraws its parts (a tap on a
part, a quick timer) may leave the key out.

## The view is a list

A part's `view` is a list of nodes. They flow down the place's frame with one gap; there is no
`stack`. A node is `{ kind, text?, attrs?, kids? }`, and every attribute value is a string.

The 22 kinds, and what each may hold:

| Kind     | Holds                                                      | Notes                                                     |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `card`   | para, line, chip, button, meter, image, bar, group, number, spacer, compare, table, diff, spark | `tone` draws as Collie's edge, never a fill |
| `group`  | row, group, bar, para, line, link, meter, number, spacer, image, compare, table, diff, spark | `label`, `badge`; `fold` open or closed makes the head a toggle |
| `list`   | row, group                                                 | the rows framed together                                  |
| `row`    | para (its second line), chip, button (one, trailing)       | `href`, `end`, `badge`, `tone`, `icon`, `cut`, `disabled` |
| `bar`    | button, chip, link                                         | the one row; chips with `state` draw the step strip       |
| `chip`   | words                                                      | `state`, `current`, `short`, a clock (`at`, `clock`)      |
| `button` | words                                                      | `intent`, `value`, `confirm`, `does: copy`, `hint`, `badge`, `pressed`, `disabled` |
| `para`   | run, link                                                  | `role` body, heading or quote; `bullet`, `term`           |
| `line`   | run, link                                                  | mono; `style` words, `role` text, status or note          |
| `run`    | words                                                      | `style`, `code`, `href`, a clock                          |
| `code`   | line                                                       | `lang`, `max` lines; the phone's copy button              |
| `link`   | words                                                      | `href`, `rel`, `icon`, `badge`                            |
| `image`  | nothing                                                    | in a part `src` in the trick's `media/` folder, `alt`, `w`, `h`; on a Decision's view `ref` instead; both take `caption`, `fit` (contain or cover) and `focus` ("x y" or "x y zoom", percent and 1 to 8) |
| `meter`  | nothing                                                    | `value`, `max`, `label`, `tone`; `role` meter or progress |
| `spacer` | nothing                                                    | an optional `label`                                       |
| `number` | words                                                      | the big figure; `label`, `unit`, `tone`                   |
| `compare` | two image                                                 | side by side at one height, labelled Before and After unless a `caption` names a side; stacked below 300 px |
| `table`  | col (1 to 4, first), then cell (rows as wide as the heads, at most 12) | `col` has its head as words and `align` start or end; `cell` its words (may be empty) and `tone`; a column of figures keeps the end side |
| `col`, `cell` | words                                                 | only inside a table                                       |
| `diff`   | words                                                      | the lines (at most 40, each at most 200 characters), `+`, `-`, `@@` tinted; `file` |
| `spark`  | nothing                                                    | `values`: 2 to 32 numbers with one space between, oldest first; `label`, `tone` |

A view's top level takes card, group, list, bar, para, line, code, meter, image, spacer, number,
compare, table, diff and spark.

## The renderer

`render.tsx` draws each kind with the `ui/` primitives (Card, ListGroup, Button, OneOf, Collapse,
CopyableBlock, Progress, SectionLabel). Ink comes from `TONE_TEXT_CLASS` only, through `tone.ts`; a
`style` word inks through the same map (red is `danger`, green `ok`, yellow `warn`), never the
terminal's palette. Icons come from `TRICK_ICON_LUCIDE` only. A part past its fresh window draws
every status tone as `unknown`.

- **Fixed heights** (`layout.ts`). Every leaf states its height from its shape, never its data. A
  `para` reserves its lines from its text's length (about 40 characters a line, at most 8, a heading
  at most 2). A `code` with `max` reserves `max` lines. A `list` reserves its kids. A `number`, a
  `meter`, a `chip`, a `button`, a `spark` and a step strip are one height each. An `image` reserves its box
  from `w` and `h`, a `compare` from the taller of its two. A `table` reserves its head and a two-line
  floor per row; a `diff` reserves its lines, and the file line when it has one. A new form waits while a finger is down (`part-frame.tsx`).
- **Taps.** A `button` sends its intent with the part key, its `value` and its path in the view, so
  the busy and unknown states land on that control. With `confirm` it arms on the first tap, shows
  the confirm words in the danger ink for 4 s, and sends on the second. With `does: copy` it copies
  its `value` on the phone and sends nothing.
- **Links.** A `row` with `href` and a `link` go to `onLink`: an http(s) address opens in the browser,
  a session's scope key opens that Session one level down. A row with a trailing button is two tap
  targets side by side, never one inside the other.
- **Clocks.** `at` (epoch ms as digits) with `clock`: `ago`, `elapsed`, `left` or `time`, on the
  bridge's clock.
- **The placeholder.** A kind this Collie does not know (a crew member on a newer version) draws one
  box of the tap floor's height: "This Collie cannot draw this part".
- **The error line.** `part-frame.tsx` draws the last good part, says the run failed, and its button
  copies the masked line on the phone for an agent. It never fills a reply box.

`href` accepts only an `http://` or `https://` URL or a session's scope key (`memberId:paneId`).
Anything else, `javascript:alert(1)` included, is refused at the bridge.

## The intent shape

A tap is `{ rid, node, intent, value, from }`, the tree's `POST /intent`. `node` is the part id or
`hill/<key>`. `from` names the session the phone was on. A receipt is one of `ok`, `changed`,
`rejected`, `gone`, `denied` or `unknown`; `ok` and `changed` may carry new parts. The store
(`store.ts`) holds one tap per part: a second tap on that part is ignored until the receipt lands,
and an `unknown` shows on the pressed control until the next tap.

## Decisions

`decisions` is the trick's one path to the person's attention: a list of `{ key, title, summary,
body?, options?, recommends?, priority?, text?, about?, replyTo?, media?, links?, expiresAt?, view? }`. Keys
are 1 to 64 characters of `[a-z0-9-]`, unique per document. Every other cap and rule is the hill's
(M96), imported from `../hill/wire.ts`, never copied here: a title of 120, a summary of 280, a body of
4000, up to 5 options, an option label of 40 and a detail of 120, a `confirm` of 24, a why of 200, up
to 5 links with a label of 40 and an address of 500, 20 decisions per trick. An option's `intent` is
the hill's: a lower-case word of up to 32 characters of `[a-z0-9-]`, starting with a letter, never
`answer` or `dismiss`. `recommends.intent` is one of the options and is shown as "Recommended", never
pre-selected. `confirm` is the second label of the tree's button, so the phone arms the option on the
first tap and sends the intent on the second, and the bridge sees one intent. `text` is `optional`
(the default), `required` or `none`; `none` needs at least one option. `about` is a session's scope
key (the facts' `id`, `memberId:paneId`) whose Chat the card opens. `replyTo` is a session's scope key:
the person's answer reaches it as the person's own walky message. `media` is up to 4 images, each `{
file, caption? }`: `file` names an image in the trick's own folder by a relative path with no `..`
(`shots/red.png`), and `caption` is up to 80 characters.

With the Hill switched off (`bridge/hill/switch.ts`, Settings → Alerts, `collie hill on|off`) the
bridge posts, replaces and withdraws none of a trick's Decisions and keeps its map of the posted ones
as it was. The trick still runs, and its row in Settings → Tricks says its Decisions are not shown.
The first run after the Hill is back on syncs the list again.

The crew state (`bridge/hill/crew-state.ts`, 1.29.0: `here`, `quiet` or `away`, set at the top of the
Hill or with `collie hill state` from a terminal) changes nothing for a trick. Its Decisions post,
replace and withdraw as always; under quiet and away a `now` Decision sends no notification, as an
agent's does not, and the tap that answers it carries no crew state line. "Tell all sessions now"
types into agent sessions only, never into a trick.

### Wording a Decision

The person opens the card cold, between other things. The words are `HILL_WRITING` in
`cli/hill-rules.ts`, which `collie hill post --help` prints and `collie trick init` writes into
AGENTS.md:

- **Title**: the decision itself, as a question the options answer, about 8 words, at most 60
  characters, with no inner names the person would not know. "Ship 1.28.1 to Stable now?", not "Are
  the new kinds right?".
- **Summary**: at most two sentences. The first says what the recommended option does, the second gives
  the one fact that decides it. The evidence goes in the view or the body.
- **Options** start with a verb and say what happens: "Hold until CI", never a bare Yes or No.
- **Priority** `now` sends a notification to the person's phone, so use it only for what cannot wait.

`collie hill post` (on stderr), `collie trick dev` and `collie trick check --run` warn about a title
past 60 characters or with no question mark, a summary past two sentences or 200 characters, and an
option that is only Yes, No or OK (`hillWordingWarnings`). A warning never refuses.

### A Decision's view

`view` (M96) puts the facts behind the question on the card, under the summary and under the images
when there are some: a strip of gates, a few rows with their proof, a hunk of a diff. It is a list of
nodes like a part's view, read by one function, `parseDecisionView` in `schema.ts`, for a trick's
document, an agent's `collie hill post --view <file.json>` and the phone alike.

- **Display only.** It takes group, list, row, bar, chip, para, line, run, code, link, meter, spacer,
  number, image, compare, table (with col and cell), diff and spark. No button and no card: the options
  are the taps.
- **The Decision's own pictures.** An `image` on a view names one of the Decision's `media` by its
  place, `ref` (0 is the first), never by a file: `src`, `alt`, `w` and `h` are refused there, and a
  `ref` past the pictures the Decision holds is refused with its path. `focus` crops the picture on the
  phone, so the poster needs no image tool. A `compare` holds two such images. A picture the view
  places is drawn among the facts and not again in the row of images above; a tap opens it at full
  size, and the sheet pages through a compare's two.
- **Nothing acts.** `intent`, `does`, `confirm` and `href` are refused on every node, except the
  `href` of a link and of a row. That `href` must be a web address, `https://` or `http://`. A session's
  scope key and `rel: "pane"` are refused. The card shows the host.
- **Small.** At most 8 KiB of compact JSON, 100 nodes and 4 levels deep.
- A view that breaks a rule refuses its decision alone in a trick's document (the path names the node,
  `/decisions/0/view/1/kind`), and refuses an agent's post with `bad_body` and the same path. The
  view is part of the content hash and of the post's digest; a decision without one keeps the hash
  and the digest it always had.
- **The card.** The phone draws the view in a quiet frame captioned "From <sender>", with the trick
  renderer and no tap handler. A link, and a row with an `href`, show their host and open in a new tab. A bar wraps instead of
  clipping. Past 240 px the frame folds behind "Show all", with no scroller inside the card. The phone
  reads a stored view whole, and when that fails, node by node at the top level: a node it cannot read
  is dropped and the rest draws (a newer poster's kind, a `ref` past the pictures it got). A view with
  nothing left is dropped and the decision stays; one that throws while it draws shows the placeholder.
- **The rhythm.** In the card a labelled group after other facts opens a section, with more space
  above it and its head close to its own rows; rows that stand together keep one icon lane, so their
  titles start on one edge.

```json
{ "key": "tag-1-28-2", "title": "Tag 1.28.2 with the e2e gate red?", "summary": "Six of seven gates are green.",
  "options": [{ "intent": "rerun", "label": "Rerun e2e first" }, { "intent": "tag", "label": "Tag it now" }],
  "view": [
    { "kind": "bar", "kids": [{ "kind": "chip", "text": "unit", "attrs": { "tone": "ok", "icon": "check" } },
                              { "kind": "chip", "text": "e2e", "attrs": { "tone": "danger", "icon": "x" } }] },
    { "kind": "list", "kids": [{ "kind": "row", "text": "e2e: pane glide", "attrs": { "end": "1 of 18" },
                                 "kids": [{ "kind": "para", "text": "612 ms against a 400 ms budget" }] }] }
  ] }
```

### How the runner posts them

After a run that succeeded, the runner (`bridge/tricks/hill.ts`) makes the hill agree with the list,
by key. The trick is one sender: its name is the card's, its id and the key ride on the decision as
`from.trickId` and `from.trickKey`.

- A new key posts once. Its request id is derived from the trick, the key and the content, so a second
  run or a bridge restart posts nothing twice.
- The same key with changed content (the title, summary, body, options, recommends, text, links,
  priority, about, replyTo, the view, or an image's bytes or caption) posts the new version, which replaces the
  open one.
- A key the list no longer holds is withdrawn, "by the trick".
- A key the person answered or dismissed stays closed while its content is unchanged. To ask again,
  change the content, or drop the key for a run and list it again.
- A key that closed without the person (undeliverable, expired, or withdrawn by someone other than the
  trick) posts again on a later run that still lists it, at most once every 10 minutes.
- A document with no `decisions` key changes nothing on the hill; `[]` withdraws them all.
- A failed or timed-out run changes nothing: the last good decisions stay. So does a list refused as a
  whole, and a decision the parser refused alone.
- Switched off or removed, every open decision of the trick is withdrawn, "the trick is off". A trick
  whose folder changed since it was switched on keeps its open decisions and keeps running the
  approved copy.
- `about` and `replyTo` are mapped to the session's walky address when the decision posts. A key that
  names no live session on this machine is refused alone, and the others post.
- `media` reaches the card as it does for an agent's decision. The runner joins each `file` to the
  trick folder's real path and the hill reads it. The trick's own folder is the one place inside the
  config folder the hill reads a trick's image from, and only for that trick's own decisions. Every
  other rule is the hill's: at most 4 images of 2 MB each, PNG, JPEG or WebP by the file's first bytes
  (never its name), a regular file, and no symlink on the way. An image the hill refuses refuses that
  one decision, and the version already on the hill stays.
- The content hash holds each image's bytes and caption. A new screenshot under the same key replaces
  the open decision, and asks again when the person had answered the old one. The runner reads an
  image again only when its size or modification time moved.
- A refusal of the hill (past 20 open, an expiry in the past) lands in the trick's refusals with the
  hill's words, the list `collie trick check` and Settings show.

`<stateDir>/hill/tricks.json` keeps, per trick, which decision each key is on the hill and its content
hash. It sits beside the hill's own files, not in the trick's state folder, which is its program's.

### The answer comes back as a tap

When the person answers, the program runs once with a `tap` trigger on `hill/<key>`, with the
answer's own `rid`, the chosen `intent` (an option's, `answer` for words alone, or `dismiss`), and
`value: { text }`, the person's words or `null`:

```json
{ "kind": "tap", "rid": "0b9e8d7c-...", "node": "hill/case-24", "intent": "rerun",
  "value": { "text": "Rerun it, then tell me." }, "seen": "944a71314b332828" }
```

`seen` is the content hash of the version of the decision the person saw: the runner's hash of the
fields above, its images included, as hex. A trick that changed the decision since can tell an answer to the old words from
one to the new; it is absent only when the bridge lost track of it. With `replyTo`, the walky message
goes first, then the tap. The receipt on the phone says whether the program took it ("recorded by"),
and a failed run is never retried. The phone's own tap route refuses a `hill/` node: a decision is
answered on the Hill.

## Places

| `at`            | Place                                     | This Collie                                 |
| --------------- | ----------------------------------------- | ------------------------------------------- |
| `belt`          | a mark at the end of the scrolling strip of the Belt; it never takes fixed room | draws         |
| `status`        | one item in the status line above the Belt | draws                                      |
| `session`       | a trick session: Dashboard row and screen | draws                                       |
| `dashboard`     | a tile in the strip at the top of the Dashboard | draws                                 |
| `tabbar`        | an item in the Dashboard's bottom bar, after the Hill | draws                           |
| `header.line`   |                                           | refused, code `later`, the place named      |
| `menu:<match>`  |                                           | refused, code `later`, the place named      |
| `settings`      |                                           | refused, code `later`, the place named      |

In a program's output, a part at a place this Collie does not draw (a later place, a newer Collie's,
or the `tab`, `tab:<match>` and `view:<match>` of the first schema, removed by M94 review 11 because
no surface drew them) is left out with a `dropped` note, and the other parts draw. In `places` such a
word is a `later` note; a manifest with no place left is refused.

A `status` part is `{ at: "status", id, chip: { text, icon?, tone?, at?, clock? } }`: one chip, with
the tree's chip attributes and no others, in the usage row after Collie's own items, in manifest
order. `text` is 1 to 12 characters. There is no `state` and no `intent`: the chip is not a control,
and a tap opens the trick's session when it has one. One per trick. When the line is wider than its
room the trick items hide first, the newest (the last) before the older, and Collie's own items never
move (`status.ts`, measured by `ModelTag`). Past `fresh` the chip loses its tone and its tap says its age.

A `dashboard` part and a `tabbar` part are `{ at, id, item: { label, icon?, badge?, tone? } }`: one
item, an icon over a short name. `label` is 1 to 16 characters and truncates on the glass. `badge` is
a count from 0 to 9999 (0 draws none) or a short word of 1 to 12 characters, drawn as a quiet outlined
badge, never the red count, which means "waiting on you". `icon` falls back on the manifest's icon.
There is no `intent` and no status shape: the item is not a control, and a tap opens the trick's
session when it has one; without one the item is drawn and takes no tap. One of each per trick. A
`dashboard` tile stands in a strip at the top of the Dashboard view, under the header and above the
summary line, which scrolls sideways when it overflows and is not drawn at all while no trick has a
tile (`components/trick-place-items.tsx`, on `ui/tile-strip.tsx`). A `tabbar` item stands in the
Dashboard's bottom bar after the Hill; with at least one, the bar's views and the Hill keep a fixed
width and stay pinned, and the items scroll after a thin divider (`ui/tab-bar.tsx`, ADR 0066 and
ADR 0085 as amended on 2026-11-10). Past `fresh` either loses its tone. The first schema's `dashboard`
took a whole `view` that nothing drew; a part that still sends one has the key ignored, with a note
that says it is one `item` now.

A mark is `{ icon, label, badge, tone, intent }`: `label` is the face word, `badge` a count or the dot
when empty. A mark is always the same control. One with nothing to do is the same button,
`aria-disabled`. Marks never use Collie's status shapes.

## Rights

| Who          | Action                               | Needs                                 |
| ------------ | ------------------------------------ | ------------------------------------- |
| a phone      | read the parts (`GET /api/tricks`)   | a device key with `read`              |
| a phone      | read a picture of a trick's `media/` | a device key with `read`              |
| a phone      | tap an intent, answer a decision     | a device key with `write`             |
| a phone      | switch a trick on or off             | a device key with `write`             |
| the trick    | redraw its parts, post a decision    | its own run, from the bridge          |
| the trick    | send, press a key, write a reply box, answer an ask | never                  |
| the bridge   | set `composer.draft`                 | never                                 |

`TRICKS_ROUTE_RIGHTS` in `bridge/tricks/routes.ts` is the one home of the route levels.

## Pictures

An `image` node's `src` is `media/` and a file in the trick's own `media/` folder (`media/chart.png`),
with no step that starts with a dot, and a `.png`, `.jpg`, `.jpeg` or `.webp` name. The folder is
outside the code hash, so a program may write a new picture there between runs. The phone reads it at
`GET /api/tricks/<memberId>/<id>/media/<file>` (`trickMediaPath`), with the pairing token
(`authedObjectUrl`, through `TrickView`), and the part's rev as a query, so a new version of the part
fetches again; a new picture under the same name shows when the part changes. The bridge
(`bridge/tricks/media.ts`) serves it only for its own trick that is switched on, and reads it with the
hill's checks (`readPostedImage`): the trick folder's real path, no symlink anywhere below it, a
regular file of at most 2 MB, opened without following a link, and PNG, JPEG or WebP by its first
bytes, never its name. Every miss is the same 404, and the answer carries `no-store` and a sandboxed
CSP. Until the bytes arrive, and when they fail, the box keeps its size and says its `alt`.

## Agent views

A trick that lists `agent-view` lets the agent of one session draw one screen on the phone, in the trick
node kinds, in place of Chat or the terminal. The machine is `bridge/agent-view/` (service, store, media,
mark), the agent's verbs are `collie trick view <trick> <verb>` (`cli/trick-view.ts`), and the wire is
`web/src/lib/agent-view/wire.ts`. A view is keyed by (trick, session); the session is the walky address.

**The gate, at every use.** Every agent write and every send from a view asks the tricks service
(`viewGate`, `viewGateFresh`): the trick is known, switched on, approved at its current hash, has no
version waiting, and its approved manifest lists `agent-view`. Then the person's switch for that
(trick, session) must be on. Else the answer is refused with a typed code (`no_trick`, `trick_off`,
`not_a_view`, `view_off`) and nothing is stored or typed. A view whose trick is shut reads off on the
phone (`off: "trick_off"`), with no screen and no head. The gate is asked again under the pane lock,
right before the first key of a send.

**Only the person switches a view.** `POST /api/trick-views/switch { trick, session, on }`. There is no
socket op for on or off. Turning one trick's view on turns every other trick's view of that session off.

**The socket ops** (one JSON line on the walky socket, each with `trick` and `session`):
`trick.view.start { note?, rules? }`, `trick.view.show { view, title?, images?, choice? }`,
`trick.view.set { id, node, place, images? }`, `trick.view.pending { id, label, place }`,
`trick.view.remove { id }`, `trick.view.keep { ids | all }`, `trick.view.choice { choice | null }`,
`trick.view.clear`, `trick.view.status`, `trick.view.help`. A success answers `{ ok: true, trickView }`;
a refusal answers `{ ok: false, error, code, trickView: true }`.

**The routes.** `GET /api/trick-views?since=<rev>` answers `{ rev, views: [...] }`; with `since` equal to
the rev, `{ rev, unchanged: true, views: [] }`; with an older one, the views that moved and `keys`, the
(trick, session) of every view held. The snapshot carries `trickViewsRev`. `GET /api/trick-views/media/
<set>/<id>` serves a picture of a view that is on, passes the gate and is not stale, behind the read gate;
every miss is the same 404. Set ids and picture ids are minted at random by the bridge.

**A send from a view.** `POST /api/send` with `view: { trick, session, rev, control }` for a tap, or
`text` and `view: { trick, session }` for typed text. Only a paired device's own token may send it; the
host's local credential, a device known by its header alone, a crew route and a read-only device get 403.
The bridge builds the line from its own stored screen, under the pane lock:
`[view:<trick> <address>] from operator: tapped "<label>"`, then ` in "<group>"` when the button sits in a
labelled group, then ` [rules: ...]` while the session does not hold the rules. Labels have `"` and `\`
escaped. A button carries no `value` and no `does`, so every word a tap sends is on the screen. The rev
must equal the stored one, and the screen must not be stale (`stale_view`). A tap is refused at a
question, a dialog or an answer box (`question`, `not_free`), and any view send while a turn runs
(`busy`): nothing queues, nothing steers. Typed text gets the head only while the session is free; with a
question open, a turn running or a command, it goes plain, as the person's own send. A refusal before
the protocol is HTTP 409 `{ error, code, view: true }`; a send that reached it answers its receipt and
`view: { line }`, the exact text typed, which the view also keeps in `sent`.

**Stale screens.** A screen is bound to the pane mark at its write: the harness and the conversation the
harness reported. Another mark makes it stale. A harness that reports no conversation cannot show a
`/clear`, so its screen goes stale at the first person turn that did not come from the view.

**One head, one door.** Only the view's own send may type a line that starts with a view head or the old
`[morph` head. The Send Protocol refuses it `bad_head` for every other request (the composer, a steer, a
held send, a crew-forwarded send, the bridge's own callers), WalkyTalky refuses it in a message and in a
crew hop, and a Hill receipt or tell turns its bracket into a parenthesis.

**The rules.** `collie trick view <trick> help --session <address>` asks the bridge, which answers only
to a session whose view is on: Collie's core view rules, then the trick's APPROVED `rules.md` between two
frame lines of Collie's that start with three U+2501 characters. A rules file is printable ASCII, so no
author line can hold the frame. A line before the frame gives the rules' length in lines, and a sentence
after it says they apply only to a message whose first line starts with that session's head. The rules id
is the first 8 hex characters of the SHA-256 of the core help and the rules bytes; `start --rules <id>`
with the current id drops the `[rules: ...]` tail until the pane's mark changes.

**Caps and record.** One send in flight per session and 20 a minute; 120 agent writes a minute per
(trick, session). Each switch, send and refusal writes one audit line (`trick.view.switch`,
`trick.view.send`, `trick.view.refused`) with the device, trick, session and reason.

**The lead only.** Views exist on the lead (or a solo Collie). A crew member answers every op, the
switch and every send `not_on_lead`, and a deputy carries no views: its state folder holds no
`trick-views/`, and a promoted deputy starts with every view off.

## Known limits (security)

These gaps are known and still open. The next security review starts from this list. Each one is
written as what a trick, or a person who controls one, can do today.

- **A relative import can reach outside the approved copy.** The approved copy holds only code a
  person saw, but a program in it can still import `../../somewhere/else.ts`. That file is not in the
  hash and is not on the version card.
- **A bare import looks in parent folders.** An import such as `import "pkg"` with no `node_modules/`
  in the copy is looked up in the folders above the copy, the way the runtime always does. A package
  placed there runs with the trick and was never shown.
- **A change to `config.toml` takes effect without a yes.** The file is outside the hash on purpose,
  and the bridge copies a new one into the approved copy and restarts the trick. A program that reads
  a command, a path or a URL from its config can be steered this way.
- **The `replyTo` of a WalkyTalky message is not checked as the sender's own.** An agent can name
  any message id as the one it answers. Collie does not check that this message was sent to it.
- **The media upload has no read timeout of its own.** A slow sender can keep an upload open, as no
  timer of the upload's own ends it.
- **The files a trick's inputs fetch are data, but nothing stops approved code from running them.**
  They land in `inputs/` of the approved copy, outside the hash, and change on every run. The code
  that would import or execute one is on the version card; the file itself never is.
- **An `inputs` glob reads any file it matches in a session's folder, except what the Files view
  hides.** `.git`, `.env` files, symbolic links, Collie's state and the private folders are never
  read. A secret in any other file the glob names, such as a key file or a credentials JSON, is read
  and handed to the trick. Text files are masked only when the bridge's key mask is on, and a
  picture is never masked. The person approves the globs, not the files they match.
- **The `description` and `about` texts are the author's claim, and nothing checks them against the
  code.** A trick can say it only reads and still write. The About sheet says so under the text
  ("Written by the trick's author. Collie did not check it."). The rows under "What it does" and the
  warnings are the bridge's own facts, from the manifest and the code search.
- **A program that runs as the user can switch a trick on, or pair a device, without a tap.**
  `collie trick on` and `collie pair` refuse in an agent's pane, but a program that writes the switch
  file, an approved copy or the device store skips both. The list of what such a program can do is in
  [`docs/security.md`, "What a program running as you can still do"](../../../../docs/security.md#what-a-program-running-as-you-can-still-do).

- **The deputy holds the lead's trick settings, secrets included.** A crew's lead copies each ON
  trick's `config.toml` to its deputy, so it can start the trick after a takeover. A token or a key in
  that file then rests on the deputy too, in its state folder at 0600, until the machine stops being
  the deputy. Keep a secret the deputy must not hold out of `config.toml`, or name a deputy you trust as
  much as the lead.
- **What a takeover starts is what the lead sent.** The deputy checks every carried trick against the
  code hash the lead says the person approved, and the page names each trick before the tap. A
  compromised lead can still send a trick it switched on itself; it starts only when a person takes
  over by hand on the deputy.
- **A lead can put a card on the deputy's Hill.** The lead's open Decisions come along at a takeover,
  and the deputy cannot tell a real one from one a compromised lead made up. Of Collie's own cards only
  the notice that a carried trick did not start comes along, with its one OK answer; a new version card
  and a proposal card are dropped, so no carried card acts on the deputy. Proposals stay on the old
  lead; ask for them again on the new one.
- **A proposal's origin record is a dot file in the trick's folder, and an agent on the lead can write
  it.** `.collie-origin.json` is outside the code hash, like the repository record. An agent with write
  access to the tricks folder could put a false "proposed by" there. It is a label, never a right.
- **Any agent can propose a new version of a trick a proposal made.** That includes an agent on a crew
  member, and a different agent from the one that proposed the trick. Nothing is written before the
  person's yes, and the card names the proposer, but the person must read who it is.
- **The session on a proposal card is a claim checked against a live pane, not a proof.** The machine
  is known: the walky socket is that machine's, and a member's call is signed. The session is placed
  by the pane markers the caller sends. Any process of the same user can send another live pane's
  markers, so it can propose, or replace a proposal, as that session. The card says when it replaces
  one. A call with no markers has no session, says so, and never replaces.
- **A pane label reaches the card.** The session's name (folder and branch, or the Dashboard's name)
  is agent-influenced. It is cleaned and cut to 40 characters, and a name that folds to "Collie" is
  marked, but a look-alike such as "Colli3" is not.
- **"Every card opened" is the phone's claim, a display check, not proof of reading.** The answer
  names the cards the phone opened, and the bridge refuses a yes that does not name them all, or names
  another digest. A phone, or anything that holds the phone's session, can send the list without
  showing a card. It stops a yes from a tap on card 1 alone in the app; it does not prove a person
  read the code.
- **A version proposal is counted twice, differently.** The CLI counts the whole trick against the
  capacity; the lead counts only the changed files. A version of a trick that was added on the machine
  past the capacity cannot be proposed from the CLI, even when its change is small.
- **A proposal costs memory before it is checked.** Each machine's walky socket reads up to 2 lines of
  8 MiB at once, and the lead's crew route up to 2 bodies of 8 MiB, apart from the other routes. The
  structure is counted before `JSON.parse`, so the parsed form stays near the text's size. On the crew
  route a slot is taken after the crew secret is checked but before the signature is, because the
  signature covers the body: only an enrolled machine can take one, for at most 60 seconds.

- **The official states read the origin record, and check it.** A false `.collie-origin.json` with
  `official: true` makes a folder from the list only at a commit the list names, and only while the
  folder's code hash is that commit's listed hash: a hand-made folder under a forged record reads
  `taken` (`unlisted`, or `changed`), and an update of it is refused. What is left: someone who can write
  the tricks folder can copy the listed code there with a forged record; that folder then is exactly the
  list's code.
- **The changed check and the write are two steps.** The code hash is taken in the runner's lane right
  before the write; a file edited in the instant between them is replaced as code.
- **The byte cap measures the disk, not what git inflates.** The 20 MiB cap reads the temp repository's
  size every 200 ms and once after the fetch. git inflates each object it receives in memory to check its
  id, and a small pack of few objects is unpacked as loose objects: a highly compressed object can take
  far more memory than the disk shows before the cap sees anything. The file caps (5 MB, 300 files) are
  checked from git's own sizes before any file is read out, so such an object is never written into the
  tricks folder.
- **A server with a valid github.com certificate can hold the bridge for up to two minutes.** Whoever
  answers for `github.com` with a certificate the system trusts (a captive proxy with an installed root, a
  compromised CA) can stream data until the byte cap or the two-minute cap ends the fetch, using memory,
  disk under `<stateDir>/tricks/` and one git process group meanwhile. What it sends is refused unless the
  commit, the code hash and the extras hash are the list's; nothing of it is written into the tricks folder.

- **An agent view shows what an agent drew, not what is true.** The agent can be wrong, or steered by a
  page or a file it read. Collie draws the buttons and checks every line a tap sends, but not that the
  screen's words are true.
- **A tap speaks for the person.** It sends a message in their name to that agent. The view keeps the
  exact line the bridge typed; it is the person's to read, as any message they send.
- **A trick's rules are its author's words to your agents.** Collie shows every word before the switch
  and asks again when the words change. It cannot tell whether the words are honest.
- **An agent keeps the rules it read.** After `help`, the agent holds a trick's rules until its
  conversation ends, also after the view is switched off. A new conversation forgets them.
- **A picture is any file the user can read.** An agent can show any picture the user account reads,
  except Collie's own files and `.git` folders, and every paired device with read access can see it.
- **A link opens on the phone's network.** A link in a view shows its host, and a link text that reads as
  an address must be that address; the person still looks before tapping.
- **Any program of the user can draw.** The walky socket takes a view write from any process that runs as
  the user on that machine, in any session's view that is on. The rest of Collie has the same limit.
- **The lead only.** Agent views work only for sessions on the lead machine in this version.

## Places in the app

`places.ts` takes the panes of `kind: "trick"` out of the snapshot's lists into
`HomeData.trickSessions`, so no count, triage or push path meets one. The root loader calls
`syncTricks(snap.tricksRev)`. A trick session id is `trick:<memberId>:<trick>:<part>`, with a colon
because a pane id is one path segment. `hooks/use-trick-handlers.ts` is where a link goes.

## Fixtures

`fixtures/index.ts` exports one document per place (`PLACE_DOCUMENTS`), one node per kind
(`NODE_FIXTURES`, `nodeDocument`), the two first tricks (`LEGS_DOCUMENT`, `TRACKER_DOCUMENT`), tap
replies, manifests, facts, and `REFUSED` with the exact refusal paths. `sessionPartOfBytes` and
`documentOfBytes` build documents of an exact size for cap tests. The legs trick as a whole folder
(`trick.toml`, `program.sh`, `test.sh`) is in `bridge/tricks/fixtures/legs/`.
