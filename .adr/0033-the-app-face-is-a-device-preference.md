# 0033 — The app's face is a device preference, and an operator's fonts add to the list

Status: **Accepted** (2026-08-31)

Related: [ADR 0018](./0018-operator-command-rows-replace-the-catalog.md) (the trio's replace-law,
which this file deliberately does **not** extend) ·
[ADR 0030](./0030-the-ui-is-translated-by-a-typed-dictionary-not-a-library.md) (why the family
names here are untranslated and the notes are not) ·
[ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md) (the other place a feature
opts into touching the operator's disk, and how it stays declinable).

## Context

Two decisions are recorded here because they arrived together and only make sense together.

**1. The app face was the maker's choice, and it is not any more.** `DESIGN.md` §5 said so
plainly — "the app's face is the maker's choice and has no setting" — and two comments in the code
restated it as law under the name "round-4 F-D1", one in `font-settings.tsx` and one in
`settings.tsx`. Those comments went further than the design did: *do not build a picker, do not add
it to display prefs, do not leave a hook "just in case"*.

That was a defensible call and it was made for a real reason. A typeface is the loudest thing about
an app's voice, Space Grotesk was chosen to sit beside the mark (same geometric skeleton, same
monotone stroke, same cut terminals), and a picker invites every user to make a choice that only
one person has the context to make well. The asymmetry with the terminal font was the argument: the
face you read *another program's* output in is yours, the face the app talks about *itself* in is
ours.

**The maker asked for the setting.** That is not a bug report and it is not a vote; it is the one
person the old rule reserved the decision for, exercising it. There is nothing left to protect: the
argument for "no setting" was that the choice belongs to the maker, and the maker's choice is now
that it should not be his alone.

**2. An operator wants to bring their own font, and that is a different question.** Collie already
has three operator-authored TOML files beside the operator's `.env` — `commands.toml`, `keys.toml`,
`quick-replies.toml` — sharing one reader and one posture. A font is the natural fourth. But the
posture that binds those three is exactly wrong for a font, and adopting it by reflex would have
been the easy mistake.

## Decision

### The face is a per-device preference with a shipped default

Three shipped choices: `system`, `grotesk` (Space Grotesk — **stays the default**) and `aldrich`
(new, self-hosted, 8 KB subset). The Typeface card in Settings writes `collie:design:v1`.

> **Amended 2026-08-31:** the maker moved the default to **Aldrich**. Everything below about "the
> default" still holds — the default wears no class, is preloaded, and keeps JavaScript off the
> first-paint path — the face filling that role changed, and every mechanism named here followed it
> (`DEFAULT_UI_FONT_URL`, the index.html preload, the splash mirror, the operator `var()` fallback).
> `:root.font-grotesk` now exists instead of `:root.font-aldrich`.

**Space Grotesk stays the default, and the default costs nothing.** A device that never opens the
card gets byte-for-byte the first paint it got before this feature existed: the same preloaded
file, the same metric-matched twin, and — because the default is spelled as the absence of a class
rather than as a class — **no JavaScript on the first-paint path at all**.

**The choice is a root class, never a JavaScript-written property.** `index.css` owns
`:root.font-system`, `:root.font-aldrich` and `:root.font-operator`, each setting `--font-sans` and
`--default-font-family`. `public/theme-init.js` reads the key before first paint and adds one
class; `lib/design.ts` swaps it afterwards. **Neither ever holds a font stack.** The alternative —
JavaScript setting `--font-sans` to a stack it carries — would put every fallback list in two files
and guarantee they drift, and would make the pre-paint script a place where a stylesheet lives.
Because the pre-paint script can import nothing, the two sides agree on a *key name* and *class
names* only, and a test reads both files and fails when even those drift.

**The store is an object, for one field.** `{ font }` under `collie:design:v1`. This is the seed of
theming — an accent colour, a density — and the extensibility is the point: a bare string would mean
a second storage key per idea, a second pre-paint read, and a migration the first time one grew a
sibling.

**Aldrich declares `font-weight: 400`, and the synthesized bold is accepted.** Upstream ships one
weight. The app asks for 500 and 600 in a hundred places, so on Aldrich every one of them is the
browser thickening the regular outlines. Declaring `400 700` would be worse, not better: it would
tell the browser those weights already exist, suppress synthesis, and flatten every bold in the app
to regular. The cost is disclosed in the note under the picker rather than discovered.

### What survived the reversal, and it is the half that mattered

**The chosen face dresses chrome and never an agent's words.** `font-mono` and `font-content` do
not resolve through `--font-sans`, so the setting *cannot* reach the pane mirror, the transcript,
rendered markdown or the labels the interactive blocks lift out of a dialog — and must not be
taught to. F-D1 bundled two rules under one name; only one of them was ever load-bearing, and it is
untouched. This is why reversing the other one is cheap.

### Operator fonts ADD to the shipped list. They never replace it

`theme.toml`, the fourth file on the operator-file contract — same reader, same mtime liveness,
same hold-the-last-good-rows failure posture. Named for a theme rather than for fonts so a colour
block can join it later without becoming a fifth operator file.

**This is the opposite posture to ADR 0018, and 0018 is untouched.** A `commands.toml` row
*shadows* a shipped command: the operator's `/deploy` and Collie's catalog compete for the same
tap on the same pane, so a merge would leave the operator unable to say "not that one", and 0018
resolves that by letting a declaration replace the list whole. **A font cannot fire an action.**
There is nothing for it to shadow, nothing it could make unsayable, and no guarantee Collie is
vouching for that an extra entry dilutes — it costs one more line in a picker. The two files differ
in posture because they differ in *force*, not in taste, and neither rule should be generalised
over the other.

### The bridge serves those files without becoming a second place a request builds a path

The law in `bridge/journal/files.ts` is **restated, not excepted**: *the journal is the only place a
client-supplied value becomes a path* — and even there it is a pane id. `GET /api/fonts/<basename>`
does not join it, because it builds nothing:

1. `theme.toml`'s rows are the declared set. The request's name is **looked up** in it; a name
   nobody declared is refused before any path exists.
2. The row's own `file` is a **bare name**, checked to be one — no separator, no dot-segment, no
   leading dot, `.woff2` only.
3. The candidate is joined to `<config-dir>/fonts` and put through the journal's own
   `containedRealpath`, on the real paths, after symlink resolution. Step 2 is a grammar; this is
   the filesystem's answer. Two independent checks, because one of them being subtly wrong is the
   failure a single check cannot survive.
4. Size is capped at serve time by `stat`, so a file that grew past the cap stops being served
   without anyone re-reading the config.

Every refusal answers **404**, identically. A client must not be able to tell "not declared" from
"missing" from "escaped its directory" from "too big".

**The fonts directory is `<config-dir>/fonts`, beside `commands.toml`** — not the state dir. The
operator trio lives in the config dir, and a font the operator authored is configuration, not
runtime state.

### Every field is validated on both sides, because it enters CSS

A family name, a weight and a file name all end up inside a stylesheet on a phone. That makes this
an injection boundary, and the rule is: **rows are rebuilt from validated parts, never escaped.** A
family matches a closed charset (`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`, minus the CSS generic and
CSS-wide keywords) and is quoted, or it is dropped. An escaper is a thing that can have a bug; a
closed charset is not.

The bridge checks and skips with a log line; **the web checks again and drops.** "The server
promised" is not a property a client can verify, and the client is the one putting the string in a
stylesheet. The two sides carry the same literal rather than importing one module, because
`web/src/lib/types.ts` is already a deliberate duplicate of the bridge's domain model so the web app
builds without the Bun server's source tree — a shared predicate would be the single import that
broke that. A test reads the bridge's file and pins the two to the same characters.

**The wire carries `{ family, basename, weight }` and never a URL.** The client builds
`/api/fonts/<encoded basename>` itself, so there is exactly one place that decides what a font
request looks like, and no path the bridge resolved is ever echoed to a phone.

### The list rides `/api/config`, and there is no `GET /api/fonts` index

`operatorFonts` joins the existing config payload, omitted when empty, read through the store that
already holds the other three operator files. Live on the bridge via mtime; reaching a device on
reload. **That is the same contract `commands.toml` has**, stated rather than left to be discovered.
A second route would be a second thing to gate, a second thing to cache, and a second answer to a
question `/api/config` already answers.

### The service worker never sees an operator font, and that is by position

Shipped faces live under `/fonts/`, are named in `UI_FONT_URLS`, and are cached first-use and swept
on activate. **Operator faces live under `/api/` and the SW registers no runtime route matching
it** — so it never sees these requests at all.

This corrects a plausible-sounding wrong reason. It is *not* the navigation denylist that makes
`/api/` safe here: that list governs **navigations**, and a font is a subresource. It is that
`sw.ts` registers exactly one caching decision beyond the precache, and none of it matches `/api/`.
A test asserts no operator URL can begin `/fonts/`, because a URL that did would be fetched, cached,
and then swept on the next activate — forever, on every cold load.

### Two costs, accepted and written down

**An operator font shifts layout when it swaps.** Every shipped face has a metric-matched twin
computed by `scripts/build-ui-font.sh` from the actual file, so its swap moves nothing. No such twin
can exist for a file Collie has never seen. Accepted: the alternative is refusing operator fonts, or
measuring one in the browser and writing overrides at runtime, which is a great deal of machinery
for a swap that happens once per cold load.

**An operator face has no pre-paint path.** Its family name only exists once `/api/config` answers,
so `theme-init.js` — which must import nothing and touch nothing else — has no way to apply it. It
is mitigated rather than solved: the accepted row is **mirrored into `collie:design:v1`** when the
reader picks it, so later cold loads inject the `@font-face` from the first frame. The swap happens
once, at the moment of choosing, and never again. The mirror is a cache and never the authority —
the server's rows supersede it wholesale, which is how a face the operator *deleted* stops
rendering.

**An unresolvable choice renders the DEFAULT SHIPPED STACK, never bare `sans-serif`, and the
preference is not cleared.** Offline, mid-load, or after the operator removed the row, no
`--font-operator-family` is emitted and `index.css`'s `var()` fallback puts Space Grotesk at the head
of the stack. Clearing the preference would mean a phone that was briefly offline silently forgot a
choice it will be able to honour again in a minute.

## Consequences

- `DESIGN.md` §5's opening block is rewritten rather than patched. A design rule that has been
  reversed should not read as a rule with an exception.
- Both "round-4 F-D1" comments are rewritten to state the new law and name this ADR. Neither is
  deleted: a reader who finds the old rule quoted elsewhere needs to be told it fell.
- `scripts/build-ui-font.sh` now distinguishes **shipped** faces from **playground-only auditions**,
  and grew a static-face branch (Aldrich carries no `fvar`, so there is no instancer step to run).
  `index.css` mirrors the shipped list; `fonts.test.ts` fails until the two agree.
- The playground's typeface card stops being where the choice is *made* and becomes where a
  candidate is **auditioned**. Aldrich left its Google CDN `@import` and now resolves through
  `index.css`, so the card compares the same bytes the app renders rather than a differently-subset
  copy that happens to share a name.
- The three operator files gain a fourth sibling with a different posture. Anyone reading ADR 0018
  now has to read this one too — which is the correct cost of the two rules genuinely differing.
