# Collie tricks: the schema and the renderer

Formerly mods, renamed to tricks 2026-11-08.

A trick is a small program on the machine. The bridge runs it with facts on stdin and reads one JSON
document from stdout. The document says WHAT to show, in a closed subset of the Tree UI vocabulary.
Collie decides HOW, with its own primitives, so the look stays Collie's. The design is the "Collie
tricks" milestone in the tracker.

`schema.ts` is the contract. It holds every type a trick reads or writes, the caps, the closed lists
(tones, icons, places, node kinds) and one total parser per document. It imports only `../json`, so
the bridge, the CLI and the web all load it by relative path, with no DOM and no `@/` alias.

## The parsers

- `parseManifest(toml)`: `trick.toml` after the TOML parse. A later field (`watch`, `on`, `serve`)
  or a later place is skipped with a `later` refusal, and the trick still loads.
- `parseFacts(json)`: a facts document, for `collie trick check --run` with fixture facts.
- `parseTrickDocumentText(stdout, opts)` and `parseTrickDocument(json, opts)`: the program's output.
  `opts.declared` is the manifest's `places`, `opts.places` and `opts.kinds` what this Collie draws
  (default: all of them). A bad part is refused alone, and `refusedParts` names it so the runner keeps
  its last good version, stale. `documentRefused` says no part was read at all.
- `parseTapRequest(json)`: the body of `POST /api/tricks/<host>/<id>/tap`.

None of them throws. Each refusal has a JSON pointer `path`, a `code` and a plain `reason`.

## The document

```json
{ "v": 1, "parts": [{ "at": "session", "id": "legs", "view": [{ "kind": "number", "text": "23/34" }] }],
  "decisions": [], "asOf": "2026-11-08T09:41:00Z", "fresh": "90s" }
```

There is no `draft` and no `open`. A trick never writes into a reply box, and a tap never moves the
phone. What a trick wants to show is a `link`. What it wants to tell the person is a decision.

## The view is a list

A part's `view` is a list of nodes. They flow down the place's frame with one gap; there is no
`stack`. A node is `{ kind, text?, attrs?, kids? }`, and every attribute value is a string.

The 16 kinds, and what each may hold:

| Kind     | Holds                                                      | Notes                                                     |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `card`   | para, line, chip, button, meter, image, bar, group, number, spacer | `tone` draws as Collie's edge, never a fill       |
| `group`  | row, group, bar, para, line, meter, number, spacer         | `label`, `badge`; `fold` open or closed makes the head a toggle |
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
| `image`  | nothing                                                    | `src` in the trick folder, `alt`, `w`, `h`                |
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

`href` accepts only an `http://` or `https://` URL or a session's scope key (`host:paneId`).
Anything else, `javascript:alert(1)` included, is refused at the bridge.

## The intent shape

A tap is `{ rid, node, intent, value, from }`, the tree's `POST /intent`. `node` is the part id or
`hill/<key>`. `from` names the session the phone was on. A receipt is one of `ok`, `changed`,
`rejected`, `gone`, `denied` or `unknown`; `ok` and `changed` may carry new parts. The store
(`store.ts`) holds one tap per part: a second tap on that part is ignored until the receipt lands,
and an `unknown` shows on the pressed control until the next tap.

## Decisions

`decisions` is the trick's one path to the person's attention: a list of `{ key, title, summary,
body?, options?, recommends?, priority?, text?, about?, replyTo?, media?, links?, expiresAt? }`. Keys
are 1 to 64 characters of `[a-z0-9-]`, unique per document. Every other cap and rule is the hill's
(M96), imported from `../hill/wire.ts`, never copied here: a title of 120, a summary of 280, a body of
4000, up to 5 options, an option label of 40 and a detail of 120, a `confirm` of 24, a why of 200, up
to 5 links with a label of 40 and an address of 500, 20 decisions per trick. An option's `intent` is
the hill's: a lower-case word of up to 32 characters of `[a-z0-9-]`, starting with a letter, never
`answer` or `dismiss`. `recommends.intent` is one of the options and is shown as "Recommended", never
pre-selected. `confirm` is the second label of the tree's button, so the phone arms the option on the
first tap and sends the intent on the second, and the bridge sees one intent. `text` is `optional`
(the default), `required` or `none`; `none` needs at least one option. `about` is a session's scope
key (the facts' `id`, `host:paneId`) whose Chat the card opens. `replyTo` is a session's scope key:
the person's answer reaches it as the person's own walky message. `media` is up to 4 images, each `{
file, caption? }`: `file` names an image in the trick's own folder by a relative path with no `..`
(`shots/red.png`), and `caption` is up to 80 characters.

### How the runner posts them

After a run that succeeded, the runner (`bridge/tricks/hill.ts`) makes the hill agree with the list,
by key. The trick is one sender: its name is the card's, its id and the key ride on the decision as
`from.trickId` and `from.trickKey`.

- A new key posts once. Its request id is derived from the trick, the key and the content, so a second
  run or a bridge restart posts nothing twice.
- The same key with changed content (the title, summary, body, options, recommends, text, links,
  priority, about, replyTo, or an image's bytes or caption) posts the new version, which replaces the
  open one.
- A key the list no longer holds is withdrawn, "by the trick".
- A key the person answered or dismissed stays closed while its content is unchanged. To ask again,
  change the content, or drop the key for a run and list it again.
- A failed or timed-out run changes nothing: the last good decisions stay. So does a list refused as a
  whole, and a decision the parser refused alone.
- Switched off or removed, every open decision of the trick is withdrawn, "the trick is off".
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
| `tab:<match>`   | a mark on the tabs that match             | parses, a later slice draws                 |
| `tab`           | the trick's own tab in a Space            | parses, a later slice draws                 |
| `view:<match>`  | a view on the sessions that match         | parses, a later slice draws                 |
| `dashboard`     | a section of the Dashboard                | parses, a later slice draws                 |
| `header.line`   |                                           | refused, code `later`, the place named      |
| `menu:<match>`  |                                           | refused, code `later`, the place named      |
| `settings`      |                                           | refused, code `later`, the place named      |

A `status` part is `{ at: "status", id, chip: { text, icon?, tone?, at?, clock? } }`: one chip, with
the tree's chip attributes and no others, in the usage row after Collie's own items, in manifest
order. `text` is 1 to 12 characters. There is no `state` and no `intent`: the chip is not a control,
and a tap opens the trick's session when it has one. One per trick. When the line is wider than its
room the trick items hide first, the newest (the last) before the older, and Collie's own items never
move (`status.ts`, measured by `ModelTag`). Past `fresh` the chip loses its tone and its tap says its age.

A mark is `{ icon, label, badge, tone, intent }`: `label` is the face word, `badge` a count or the dot
when empty. A mark is always the same control. One with nothing to do is the same button,
`aria-disabled`. Marks never use Collie's status shapes.

## Rights

| Who          | Action                               | Needs                                 |
| ------------ | ------------------------------------ | ------------------------------------- |
| a phone      | read the parts (`GET /api/tricks`)   | a device key with `read`              |
| a phone      | tap an intent, answer a decision     | a device key with `write`             |
| a phone      | switch a trick on or off             | a device key with `write`             |
| the trick    | redraw its parts, post a decision    | its own run, from the bridge          |
| the trick    | send, press a key, write a reply box, answer an ask | never                  |
| the bridge   | set `composer.draft`                 | never                                 |

`TRICKS_ROUTE_RIGHTS` in `bridge/tricks/routes.ts` is the one home of the route levels.

## Places in the app

`places.ts` takes the panes of `kind: "trick"` out of the snapshot's lists into
`HomeData.trickSessions`, so no count, triage or push path meets one. The root loader calls
`syncTricks(snap.tricksRev)`. A trick session id is `trick:<host>:<trick>:<part>`, with a colon
because a pane id is one path segment. `hooks/use-trick-handlers.ts` is where a link goes.

## Fixtures

`fixtures/index.ts` exports one document per place (`PLACE_DOCUMENTS`), one node per kind
(`NODE_FIXTURES`, `nodeDocument`), the two first tricks (`LEGS_DOCUMENT`, `TRACKER_DOCUMENT`), tap
replies, manifests, facts, and `REFUSED` with the exact refusal paths. `sessionPartOfBytes` and
`documentOfBytes` build documents of an exact size for cap tests. The legs trick as a whole folder
(`trick.toml`, `program.sh`, `test.sh`) is in `bridge/tricks/fixtures/legs/`.
