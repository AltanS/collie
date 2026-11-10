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

## Contract 1

Everything a trick and Collie exchange has one version number, the trick contract, `TRICK_CONTRACT`
in `contract.ts`. The bridge (through `schema.ts`), the CLI and the helper's tests read it there; the
helper (`cli/trick-kit/trick.ts`, a file a trick folder copies) carries the same literal as
`CONTRACT`, held to it by a test. This Collie speaks contract 1.

**The manifest**, `trick.toml`: `id`, `name`, `run`, `every`, `icon`, `places`, `env`, `contract`, and
the later `watch`, `on` and `mode`. `contract` is the number the trick is written for, a whole number,
1 when left out. A trick that names a higher number than this Collie knows is refused with one line,
"This trick needs a newer Collie: it is written for trick contract 2, and this Collie knows contract
1. Update Collie to run it.", and nothing else is checked. At the same number an unknown key is
refused, so a typo shows. A place word this Collie does not know is left out with a `later` note.

**The facts**, one JSON document on stdin: `contract`, `trigger` (`start`, `timer`, or `tap` with
`rid`, `node`, `intent`, `value`, `from` and, for an answer, `seen`), `trick` (`id`, `dir`, `state`),
`memberId`, `host`, `sessions` (each `id`, `memberId`, `sessionId`, `paneId`, `host`, `name`, `agent`,
`status`, `cwd`, `space`, `tab`, `lastActiveAt`) and `spaces` (`name`, `folder`). A program ignores a
field it does not know: a later Collie at the same number may add one.

**The output**, one JSON document on stdout: `{ v, parts, decisions?, asOf?, fresh? }`. `v` is the
contract number. A part is `{ at, id, ... }` with the keys its place takes (below); a view is a list of
nodes `{ kind, text?, attrs?, kids? }` of the 16 kinds (below), every attribute a string.

**The places**: `belt`, `session`, `dashboard`, `status` and `tabbar`, each drawn by the phone (see
"Places"). Nothing else: a place no surface draws is not in the contract.

**The limits**: 64 KiB of stdout and 10 s per run, 24 parts of at most 16 KiB each, 24 nodes at a
view's top, 6 levels and 300 nodes in a view, 20 decisions, `every` and `fresh` from 5 s to 24 h, 32
names in `env`, an image of at most 2 MB from the trick's `media/` folder. Every text cap is in
`schema.ts` beside its field.

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
the line above instead of drawing it wrong. Whether a Collie that speaks 2 still runs a trick written
for 1 is decided with contract 2.

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
trick helper v3`. `collie trick helper <id>` rewrites it with the version this Collie carries; the
helper is part of the trick's code, so a trick that is on stops until a person switches it on again.
`collie trick check` lists a `trick.ts` whose bytes are a helper this Collie ships as "helper v3" (an
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
| `v.card`, `v.group`, `v.list`, `v.row`, `v.bar`, `v.chip`, `v.button`, `v.para`, `v.line`, `v.run`, `v.code`, `v.link`, `v.image`, `v.meter`, `v.spacer`, `v.number` | one builder per node kind; a number attribute may be a number, a flag `true` |
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
- `--json` prints the parsed result: the parts, the Decisions, the refusals, the outcome and the sizes.
- `--watch` runs it again when a file in the folder changes, 300 ms after the last change (code and
  `config.toml`; never a `*.log`, a dot file, `media/` or `captures/`). Ctrl-C stops it.

It never talks to the bridge and never posts: nothing reaches a phone or the hill.

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

The bridge writes `{ contract, trigger, trick, memberId, host, sessions, spaces }` on stdin.

- `memberId` names the bridge that runs the trick: its crew member id, or on a solo install its
  install id, `m_` and ten of `[a-z0-9]`, minted once into `<stateDir>/bridge-id.json`. It stays the
  same when the machine is renamed. Key anything a program keeps on it.
- `host` is the machine's name, for display only. It changes with a rename. Never key on it.
- Each session has `id`, its scope key `<memberId>:<paneId>` (pass it back in `about`, `replyTo`,
  `href`), its own `memberId` (read it instead of parsing `id`), `sessionId` (opaque), `paneId`,
  and `host` (display only), then `name`, `agent`, `status`, `cwd`, `space`, `tab`, `lastActiveAt`.

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

The 16 kinds, and what each may hold:

| Kind     | Holds                                                      | Notes                                                     |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `card`   | para, line, chip, button, meter, image, bar, group, number, spacer | `tone` draws as Collie's edge, never a fill       |
| `group`  | row, group, bar, para, line, link, meter, number, spacer   | `label`, `badge`; `fold` open or closed makes the head a toggle |
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
| `image`  | nothing                                                    | `src` in the trick's `media/` folder, `alt`, `w`, `h`     |
| `meter`  | nothing                                                    | `value`, `max`, `label`, `tone`; `role` meter or progress |
| `spacer` | nothing                                                    | an optional `label`                                       |
| `number` | words                                                      | the big figure; `label`, `unit`, `tone`                   |

A view's top level takes card, group, list, bar, para, line, code, meter, image, spacer and number.

## The renderer

`render.tsx` draws each kind with the `ui/` primitives (Card, ListGroup, Button, OneOf, Collapse,
CopyableBlock, Progress, SectionLabel). Ink comes from `TONE_TEXT_CLASS` only, through `tone.ts`; a
`style` word inks through the same map (red is `danger`, green `ok`, yellow `warn`), never the
terminal's palette. Icons come from `TRICK_ICON_LUCIDE` only. A part past its fresh window draws
every status tone as `unknown`.

- **Fixed heights** (`layout.ts`). Every leaf states its height from its shape, never its data. A
  `para` reserves its lines from its text's length (about 40 characters a line, at most 8, a heading
  at most 2). A `code` with `max` reserves `max` lines. A `list` reserves its kids. A `number`, a
  `meter`, a `chip`, a `button` and a step strip are one height each. An `image` reserves its box
  from `w` and `h`. A new form waits while a finger is down (`part-frame.tsx`).
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

### A Decision's view

`view` (M96) puts the facts behind the question on the card, under the summary and under the images
when there are some: a strip of gates, a few rows with their proof, a hunk of a diff. It is a list of
nodes like a part's view, read by one function, `parseDecisionView` in `schema.ts`, for a trick's
document, an agent's `collie hill post --view <file.json>` and the phone alike.

- **Display only.** It takes group, list, row, bar, chip, para, line, run, code, link, meter, spacer
  and number. No button, card or image: the options are the taps, and the images are `media`.
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
  clipping. Past 240 px the frame folds behind "Show all", with no scroller inside the card. A stored
  view the phone cannot read is dropped and the decision stays; one that throws while it draws shows
  the placeholder.

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
  whose code changed since it was switched on keeps its open decisions; it only stops running.
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
