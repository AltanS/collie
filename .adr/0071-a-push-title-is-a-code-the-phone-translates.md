# 0071 — A push title is a code the phone translates

- **Status:** Accepted
- **Date:** 2026-09-27
- **Shipped in:** pending
- **Amends:** [ADR 0030](./0030-the-ui-is-translated-by-a-typed-dictionary-not-a-library.md), in
  scope. Its Consequences left push notifications untranslated "as a follow-up, not solved here",
  and its *What would justify revisiting* named the road this record declines: a per-device locale
  on the bridge, rendering with `t()` server-side. Everything else in 0030 stands, including the
  service worker's own strings staying English.
- **Trail:** ADR 0030 (Consequences, and the last *revisiting* bullet) · `bridge/error-codes.ts`
  (the code-beside-the-sentence rule this reuses) · `bridge/push-titles.ts` ·
  `bridge/notifications.ts` · `bridge/cache/warn.ts` · `bridge/index.ts` (the update push) ·
  `web/src/lib/push-title-codes.ts` · `web/src/lib/push-title-store.ts` ·
  `web/src/lib/push-titles.ts` · `web/src/lib/push-decision.ts` · `web/src/sw.ts`

## Context

A notification's headline was the one Collie sentence every operator reads every day that no
dictionary could reach. The UI's language is a per-device choice, held in the page's `localStorage`
(ADR 0030). The bridge builds a push once and fans it out to every subscribed device, and it knows
none of their languages. The service worker that renders the push knows the device, but it cannot
read `localStorage`, and it cannot load the translated dictionaries, which are lazy chunks: a service
worker may not `import()`.

ADR 0030 pointed at one way through: give each subscription a locale, and have the bridge render
every push once per language with `t()`. That road costs three things. The dictionaries would have
to become importable by the bridge, a separate type-checked tree. `Push.send` would stop being one
payload to every device and become one render per locale. And a device that changed language would
have to re-register its subscription before its next alert, or be told in the old one.

`bridge/error-codes.ts` had already solved the same shape for API errors: the bridge sends a stable
code beside its English sentence, the phone translates the code, and a code the phone does not know
falls back to the English. The bridge never learns a language.

## Decision

**A push title travels as a code beside its English, and the device picks the words.**

1. **The bridge names a code, never the words.** `bridge/push-titles.ts` is the catalogue: every
   headline the bridge sends, keyed by a code, as the English it has always sent. A send site calls
   `pushTitle(code, detail)`, which renders the English and returns `{ title, titleCode,
   titleDetail }` to spread into the `PushMessage`. `web/src/lib/push-title-codes.ts` mirrors the
   code list, and `bridge/push-titles.test.ts` reads both off disk and fails on any difference, as
   `error-codes.test.ts` does for errors.
2. **The page renders the table; the worker fills it.** Each dictionary carries one
   `pushTitle.<code>` template per code. The page writes the active language's templates, slots
   unfilled, into Cache Storage (`lib/push-title-store.ts`) at boot and on every locale change, once
   that language's dictionary has landed. The worker reads that table on a push that names a code,
   fills the slots from `titleDetail`, and shows the result.
3. **Every miss is the English, never a key or a blank.** No code (an older bridge, or a title the
   operator typed into `collie push-test`), a code this build does not know (a newer bridge), no table
   yet, or storage that refuses: the worker shows `title`, exactly as before. An older worker ignores
   both new fields and shows `title` too.
4. **Only the title.** A body is the pane's place, the names in a digest, or a release's own notes.
   Those are the operator's words and Collie's history, not Collie's UI, and they travel as they did.

## Consequences

- **The bridge still knows no language**, and `Push.send` still sends one payload to every device.
  A device that switches language is told in the new one from its next push, with nothing to
  re-register.
- **A device that has never opened the page since installing this build shows English titles** until
  it does, because nothing has written its table yet. Opening Collie once fixes it; the worker never
  guesses.
- **Adding a push title is a catalogue row, a mirror row, and one key in each dictionary.** Forgetting
  the mirror fails `bridge/push-titles.test.ts`; forgetting a dictionary fails `tsc`, the same
  completeness contract ADR 0030 set; a translation that drops or renames a `{slot}` fails
  `web/src/lib/push-titles.test.ts`.
- **`{count}` in a digest title is not a plural pair.** A digest always holds two or more agents, and
  every shipped language uses one form for every count of two or more. A future language that does
  not would need the pair, and `tn()` on the page side to pick it before the table is written.

### What would justify revisiting

- **A push body that is Collie's own prose, worth translating.** The cache warning's closing
  sentence is the only one today. A second would argue for a `bodyCode` beside `titleCode`, on the
  same terms.
- **Rendering that needs the value's locale at fill time** (a date, a grouped number). The worker
  fills slots with `String(value)`; anything locale-formatted would have to be formatted by the page,
  or carried in the table as a pattern.
