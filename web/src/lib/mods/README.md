# Collie mods: the schema

`schema.ts` is the contract between a mod and Collie. It holds every type a mod reads or writes,
the caps, the closed lists (tones, icons, places, node kinds), and one total parser per document.
It imports only `../json`, so the bridge, the CLI and the web all load it by relative path, with no
DOM and no `@/` alias. The design is the "Collie mods" milestone in the tracker.

## The parsers

- `parseManifest(toml)`: `mod.toml` after the TOML parse. Later fields (`watch`, `on`, `serve`, a
  later place) are skipped with a `later` refusal, and the mod still loads.
- `parseFacts(json)`: a facts document, for `collie mod check --run` with fixture facts.
- `parseModDocumentText(stdout)` and `parseModDocument(json)`: the provider's output. A bad part
  is refused alone; `refusedParts` names it so the runner keeps its last good version, stale.
  `documentRefused` says no part was read at all.
- `parseTapRequest(json)`: the body of `POST /api/mods/<host>/<id>/tap`.

None of them throws. Each refusal has a JSON pointer `path`, a `code` and a plain `reason`.

## Slice 01, the runner

Read stdout with `parseModDocumentText(text, { declared: manifest.places, afterTap })`. Pass
`kinds: CORE_NODE_KINDS` until slice 08 lands, so the phone never gets a kind it cannot draw.
Store each accepted part under `partKey({ host, mod, part })` with a rev, and send `ModsReply` and
`ModTapReply`. `freshWindowMs` gives the window of a part with no `fresh`. `isScopeKey`,
`modSessionId` and `matchesSession` cover facts, drafts and `view:<match>`.

## Slice 02, the renderer

Draw `ViewNode` by `kind`. The reserved heights are `text.lines`, `list.rows`, `table.rows` and
`log.lines`; `VIEW_LIMITS` holds the ranges. Ink comes from `TONE_TEXT_CLASS` only, and icons
from `MOD_ICON_LUCIDE` only. A part past its fresh window draws as tone `unknown`.

## Slice 03, the two first places

`places.ts` takes the panes of `kind: "mod"` out of the snapshot's lists into
`HomeData.modSessions`, so no count, triage or push path meets one. The root loader calls
`syncMods(snap.modsRev)`. A mod session id is `mod:<host>:<mod>:<part>`, with a colon because
a pane id is one path segment. `hooks/use-mod-handlers.ts` places a draft only in an empty box.

## Fixtures

`fixtures/index.ts` exports one document per place (`PLACE_DOCUMENTS`), one node per kind
(`NODE_FIXTURES`, `nodeDocument`), the two first mods (`LEGS_DOCUMENT`, `TRACKER_DOCUMENT`), tap
replies, manifests, facts, and `REFUSED` with the exact refusal paths. `sessionPartOfBytes` and
`documentOfBytes` build documents of an exact size for cap tests.
