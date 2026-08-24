# 0030 — The UI is translated by a typed dictionary, not an i18n library

Status: **Accepted** (2026-08-24)

Related: [ADR 0019](./0019-oxlint-and-vendored-anti-slop-are-the-lint-gate.md) (the `tsc` gate this
decision rides) · [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) (why the
terminal's own text is out of scope for translation) · [ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md)
(the same dependency-surface posture, applied here to a build-time dependency instead of a runtime
one).

## Context

Collie shipped six UI languages: `web/src/lib/i18n/`. The obvious tool for "translate a React app"
is a library — react-i18next, Lingui, FormatJS/react-intl — and one of those three will be proposed
again the next time someone touches this layer, because it is the default reach for the problem.

The actual shape of the problem is small: ~400 strings (395 keys in the English source at the time
of writing) and a handful of plural pairs, all UI chrome — settings, dialogs, quick replies, error
sentences. It is not a CMS, not marketing copy, not SEO content, and it does not grow with the
product's data; it grows with the number of screens, which is slow.

Three forces bear on the choice, and none of them are about developer taste:

**Completeness is a compile-time property here, or it is nothing.** A finite, literal key union
(`keyof typeof en`) lets `Dictionary = Record<MessageKey, string>` make a missing or extra key in
any of the other five files a **type error** — caught by the same `tsc` gate `collie build` already
runs (root + web, per `CLAUDE.md`), before the string ever ships. A runtime i18n library's answer to
the same problem is a missing-key fallback (English, or the key itself, printed at the call site) —
strictly weaker, because it is discovered by a user hitting the screen, not by the build failing.

**Collie is a phone PWA that can type into a live terminal** (see security posture, `CLAUDE.md`).
Every dependency in `web/` widens that surface, and the repo already pays for that carefully — a
7-day install-age gate (`bunfig.toml`), a strict CSP, `verbatimModuleSyntax` +
`erasableSyntaxOnly` on the web side. Lingui's transform relies on Babel/SWC macros that do not
coexist cleanly with `erasableSyntaxOnly`; FormatJS's ICU runtime and react-i18next's plugin
ecosystem are built for a scale of catalogue (thousands of keys, pluralisation edge cases beyond
`one`/`other`, runtime catalogue loading from a CMS) this project does not have and is not headed
toward. None of the three buys back more than they cost at ~400 strings.

**The platform already has plurals, dates and relative time.** `Intl.PluralRules` supplies the
`.one`/`.other` selection `tn()` needs; nothing in the current string set needs more categories than
that, and nothing needs `Intl.DateTimeFormat` or `Intl.RelativeTimeFormat` yet either — both are a
function call away, not a dependency away, the day something does.

## Decision

**Translation is a hand-rolled, compile-time-checked layer: `web/src/lib/i18n/` — no i18n library.**

- **One flat, dot-namespaced English dictionary is the source of truth**, `as const` so its keys form
  a literal union (`MessageKey`). The other five (`de`, `es`, `ko`, `ja`, `zh`) are typed
  `Record<MessageKey, string>` — a file missing a key, or carrying one English dropped, fails `tsc`.
- **`t(key, vars?)`** looks up a key in the active dictionary and fills `{slot}` interpolation by
  split/join (never `String.replaceAll`, which interprets `$&`/`$1` in the replacement half — see the
  comment at `interpolate()`). **`tn(keyBase, count, vars?)`** reads a `.one`/`.other` pair, chosen by
  `Intl.PluralRules` for the *active* locale, never the pinned one, so the category and the text it
  selects always agree.
- **`useLocale()`** (`web/src/hooks/use-locale.ts`) is the React face of a module-scoped store shaped
  like `use-theme.ts`: `useSyncExternalStore`, no context, no provider. A component that calls `t()`
  during render must also call `useLocale()` so it re-renders when the locale — or a lazily-arriving
  dictionary — changes.
- **English ships in the main bundle; the other five are lazy chunks** (`import()` per locale, keyed
  by a `satisfies Record<Exclude<Locale, "en">, …>` map so adding a locale without a loader row is a
  type error). `t()` serves English during the gap and repaints when the chunk lands — a missing
  translation is never a blank label.
- **The choice persists as a bare string** at `localStorage["collie:locale:v1"]`, absent meaning
  English, and tracks `<html lang>` for assistive tech and the browser's own translate offer.
- **Bridge error sentences translate through a stable code, not through i18n reaching into the
  bridge.** `bridge/error-codes.ts` puts a machine `code` (plus optional named `detail` for
  interpolation) beside every English sentence an API error body already carried; the code is a pure
  wire vocabulary, mirrored (not imported — the two trees typecheck separately) at
  `web/src/lib/api-error-codes.ts`. The web side maps a known code to a `t()`-driven sentence; an
  unknown or absent code falls back to the bridge's own English string, so an older or newer bridge
  degrades to today's behaviour rather than to a blank.

## Consequences

- **Adding a locale is a dictionary file plus two one-line rows** (`LOADERS` in `lib/i18n/index.ts`,
  `LOCALES` in `lib/i18n/locale.ts`) — both `satisfies`-checked, so forgetting one is a compile error,
  not a silent gap.
- **Adding a string touches all six dictionary files.** The English addition is what makes the other
  five fail to typecheck until they catch up — that friction is the completeness contract, not a bug
  in it.
- **What stays untranslated, on purpose, because translating it would be wrong, not merely unbuilt:**
  the terminal mirror and all agent output; quick-reply text sent to the terminal; menu/dialog option
  labels, which are the screen's own footer text echoed back
  ([ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md)); key caps; pack role names
  (pack/lead/peer/deputy); the service worker's own strings; pack-link error text
  (`bridge/pack/*`, under the wire guard, [ADR 0025](./0025-the-wire-guard-forces-a-decision-never-a-bump.md));
  the slash-command descriptions in `web/src/lib/agent-commands.ts`, which paraphrase another tool's
  own vocabulary and are deferred until that vocabulary is worth restating in six languages.
- **Push notifications are not yet localised** — they are OS-rendered (`bridge/notifications.ts`) and
  Collie has no per-device locale to render them in. Left as a follow-up, not solved here.
- **No pseudo-locale tooling, no translation-memory workflow, no CMS integration** come for free the
  way a library would offer them. At the current scale none has been needed; if the string count grows
  by an order of magnitude, or professional translators start working from extracted catalogues rather
  than editing the TypeScript files directly, that changes the trade this ADR made.

### Alternatives considered

- **react-i18next / FormatJS / Lingui.** Rejected on all three forces above: none makes the missing-
  key guarantee stronger than the existing `tsc` gate already does; each adds install-age-gated,
  CSP-relevant dependency surface a terminal-driving PWA pays extra attention to; Lingui's macro
  transform specifically fights `erasableSyntaxOnly`. Revisit only if the catalogue's scale or
  authoring workflow genuinely outgrows a hand-rolled layer (see Consequences).
- **The owner's own prior art**, a similarly hand-rolled layer in a personal project
  (`remix-lcc`). Its zero-dependency shape and `{var}` interpolation convention were adopted
  directly. Two things were not: its dictionary typed as loose `Record<string, string>` (no
  compile-time key completeness — the exact gap this ADR closes), and its locale-in-URL-segment
  routing, which exists to make translated routes crawlable. Collie is a private, tailnet-only PWA
  with no public URLs to index, so that reason does not transfer; the locale lives in `localStorage`
  instead.

### What would justify revisiting

- **The string count or plural complexity outgrows `Intl.PluralRules`** — a locale needing categories
  beyond `one`/`other` (Arabic's six, for instance) would need either a bigger hand-rolled plural
  table or a library that already carries CLDR plural rules bundled.
- **Translation moves off the engineer's desk** — if strings start being authored by non-engineers
  through an extracted catalogue (PO files, a translation-memory tool), the dictionaries stop being a
  TypeScript-native fit and a library's tooling starts paying for itself.
- **Push notifications gain a per-device locale** — that follow-up may want to reuse `t()` server-side
  from the bridge, which the current lazy-chunk, browser-only design does not support.
