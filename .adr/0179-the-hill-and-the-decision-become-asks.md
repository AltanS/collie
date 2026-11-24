# 0179: The Hill and the Decision become Asks and an ask, with no alias

- **Status:** Accepted (2026-11-24), the owner's decision ("rename them all, this is experimental, i want a clean
  slate"); the lead's build 3 on the dev lane
- **Date:** 2026-11-23
- **Trail:** The Asks spec, part G (names). Files: `cli/hill.ts` (`collie asks`, the one line for an old `collie
  hill` verb), `cli/program.ts` (the `asks` tree, the hidden `hill` verb), `cli/ask.ts` (the old `dc_` id line),
  `cli/api.ts` (`hill.list`), `web/src/lib/tricks/schema.ts` (the manifest and document keys, the reserved ids, the
  tap node), `cli/trick-kit/trick.ts` (helper v12), `bridge/tricks/scan.ts` (`HELPER_VERSION`),
  `bridge/tricks/agents-notes.ts` (notes v11), `bridge/hill/store.ts` (`ASKS_DIR`),
  `web/src/router.tsx` (the one redirect), `web/src/lib/i18n/asks-words.test.ts` (the word guard),
  `cli/skills/walky-talky.md` (the `{{ASKS}}` markers).

## Context

Asks build 2 put a second way to ask beside the Hill: `collie walky ask`, with its own ids (`ak_`) and its own
screens. The product then had two names for one thing, a page called "Asks" in the bar, and an older vocabulary
(the Hill, a Decision, `collie hill post`, `t.decide`, `decisions`, `hill/<key>`) that every agent, trick author and
reader of the docs still met. The owner chose a clean slate over a compatibility layer: the feature is an
experiment, off by default, so the cost of a break is small and the cost of two vocabularies is paid every day.

## Decision

Everything a person, an agent or a trick author reads or types says Asks (the page and the feature, singular: "Asks
is off") and an ask (one question). No alias: each old name fails loudly with one sentence that names the new one.

| Old | New | How the old form fails |
| --- | --- | --- |
| `collie hill post` | `collie walky ask` | `collie hill post is now: collie walky ask`, exit 2 (usage) |
| `collie hill status <id>` | `collie walky status <id>` | the same one line, exit 2 |
| `collie hill withdraw <id>` | `collie walky cancel <id>...` | the same one line, exit 2 |
| `collie hill list` | `collie walky asks` | the same one line, exit 2 |
| `collie hill clear / state / on / off` | `collie asks clear / state / on / off` | the same one line, exit 2 |
| id `dc_` + 12 | id `ak_` + 12, every card (an agent's, a trick's, Collie's own) | `walky status` and `cancel`: `<id> is an old id: that ask is gone.`; the state reader keeps it raw and never lists it |
| trick output `decisions` | `asks` | not read, with one note on the trick's row and in `trick dev`: `"decisions" is "asks" now. Update the helper with: collie trick helper <id>.` The rest of the document still draws (below) |
| manifest `decides = "reply"` | `asks = "reply"` | refused at load: `"decides" is "asks" now: write asks = "reply".` |
| `t.decide`, `t.keepDecisions`, `t.decisions`, `tap.decision` | `t.ask`, `t.keepAsks`, `t.asks`, `tap.ask` | the helper throws `t.decide is now t.ask` (and the like) at the call |
| tap node `hill/<key>` | `asks/<key>` | refused at the tap and in `collie trick dev`: `the node hill/x is now asks/x` |
| reserved trick id `hill` | `asks` (and `hill` stays reserved) | a trick named `asks` is refused like `collie` |
| local API `hill.list` | `asks.list` | `hill.list is now asks.list.` (from `t.api` as an answer, from `collie api` with exit 2) |
| "decision block" (agent views) | "choice block" | words only; the verb `trick view <trick> choice` was already `choice` |
| app address `/hill`, `/hill/ask/:id` | `/asks`, `/asks/ask/:id` | **the one alias**: any `/hill...` opens the board (below) |
| Settings details key `hill` | `asks` | `/settings/tricks/hill` is an unknown trick's page now |
| state folder `<state>/hill/` | `<state>/asks/` (`asks.json` for the cards) | not read, not written, not deleted (below) |
| skill markers `{{HILL}}` | `{{ASKS}}` | the template holds no `hill` in any render |

The old document key is a note, not a refusal of the whole document, on purpose: a v10 or older helper writes
`decisions` on EVERY run (an empty list when the trick asks nothing), so a hard refusal would stop every installed
trick that uses the helper, also the ones that never ask. With the note its parts still draw, its asks do not
show, and the one sentence names the fix on its row. This is how the trick code treats every unknown or removed
document key today.

The helper moves to v12 (v11 renamed the Decisions to asks, v12 took `priority` out of `t.ask`) and the agent notes to v11. An older helper copy stays Collie's code (it is in
`OLDER_HELPERS`), so the update asks for no yes by itself; but its document's `decisions` key is refused, so a trick
that asks must have its helper updated (`collie trick helper <id>`) and its own code moved to `t.ask`, which is a new
version the person approves.

**The one alias is the app's address.** A bookmark or a notification already on a phone is the person's own data,
not an API: breaking it shows a blank page for something they saved. So `/hill` and every path under it replace
themselves with `/asks` (the query kept, `replace` so Back does not bounce). An old ask id in such a link is gone
anyway; the board is the honest place to land.

**The state starts clean.** The new build never reads, writes or deletes `<state>/hill/`. Put behind one constant
(`ASKS_DIR`), the folder can be moved again with one line. A person loses at the update: the switch of Asks (it is
off by default, so a person who had it on switches it on again), Here, Quiet, Away (back to Here), every open and
closed card, the receipts, the pictures stored with cards, and the tricks' key map (`tricks.json`: per trick the
generation and per key the card id, the content hash and the last state; no approval, no rights). A trick's next
run posts its asks again. Nothing is carried over: the owner decided against carrying even the switch and Here,
Quiet, Away (2026-11-23).

**What stays, on purpose, and why:**

- The crew wire between machines (`/crew/v1/hill/*`, its fields, the forwarded posts and answers): a crew runs mixed
  versions during an update, and a renamed route would cut a member off its lead. The lead of an older release may
  still mint `dc_` ids, so the wire and the phone accept `dc_` or `ak_` (`HILL_ID_RE`); only the state reader and the
  CLI take `ak_` alone.
- The HTTP routes `/api/hill/*` and the walky socket operations `hill.*` and `ask.*`: the app's calls to its own
  bridge, and the CLI's calls to its own machine's bridge. No outsider types them, and a phone that still runs the
  old cached app for a moment after the update keeps working.
- The push payload's `target: "hill"`, the notification tag `collie:hill:<id>`, audit action names, Settings row
  ids, the icon keys `hill` and `decision-*`, and the phone's own answer node `hill/<id>`: internal names no page,
  command or document shows.
- Internal code names (`HillService`, `HillDecision`, `bridge/hill/`, `web/src/lib/hill/`), the i18n keys
  (`hill.*`, only their English values changed), and test names. A mass rename of identifiers would make every
  open branch conflict for no reader's gain.
- The durable agents' API (`ask`, `pane.ask`, `ask.open`): another feature. Their English card text says "question
  card", so the two never share a word on the phone.
- Old CHANGELOG sections and old ADRs keep their words.

## Consequences

- The word guard (`web/src/lib/i18n/asks-words.test.ts`) fails on any English value with Hill, Decision, ring or
  No push, apart from its allow-list (empty today).
- The official tricks that ask (design-review and pr-inbox, pinned in `bridge/tricks/official.json`) use
  `decides = "reply"` and the v8 helper; they are refused until their repository moves to `asks` and the pin moves
  with it.
- The other languages keep the old meaning in their values until the next translation pass; their keys are the same.
- `collie walky status` reads both a message (`wt_`) and an ask (`ak_`); the id's prefix decides.

## Addendum (2026-11-23): no priority, no notification, no test card

The owner removed three more things from the same experiment.

- **Priority and the notification.** No ask and no card has a priority, and none sends a notification. The phone draws
  no Now / Today / Later groups; the board lists its cards oldest first. A trick's ask with the key `priority` is
  refused: `an ask has no priority: remove the key "priority".` The helper moves to v12. `asks.list` has no `urgency`.
  The Settings row for the notification is gone; the stored per-device field `decisions` stays in the notify prefs so a
  file round-trips, and nothing reads it for an ask. A tap on an old notification (`target: "hill"`) still opens
  `/asks`.
- **The wire shape stays.** `HillDecision.priority` and `priorityAsked` stay in every stored, served and forwarded card,
  because an older member or deputy still reads them. The bridge always writes the one constant `ASK_PRIORITY_FIXED`
  (`"today"`). A forwarded post that carries `priority: "now"` is accepted and the value is ignored.
- **The test card.** The button "Send a test ask", `POST /api/hill/test` and `bridge/hill/test-card.ts` are removed. An
  old `hill.test` audit line stays readable.
