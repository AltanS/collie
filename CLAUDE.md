# CLAUDE.md — working agreement for this repo

**Collie** (repo `AltanS/collie`) — a phone web UI for the AI agents running in your terminal,
served over Tailscale. A mobile-first PWA (Vite + React + TS + Tailwind v4 + shadcn) plus a Bun/TS
bridge that mirrors ONE multiplexer per install — Herdr, tmux or zellij — letting you monitor and
reply to agents from a phone. Herdr is one adapter among the three, not the product: it is the
default, it is the only one that talks over a Unix socket, and its plugin route stays supported —
plugin id `herdr.collie` (manifest: `herdr-plugin.toml`). Orientation:
[`README.md`](./README.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) · the UI's visual
language [`DESIGN.md`](./DESIGN.md) · verified API [`HERDR_API.md`](./HERDR_API.md) ·
decisions [`.adr/`](./.adr/) · adding a harness
[`HARNESS_CONTRIBUTING.md`](./HARNESS_CONTRIBUTING.md) · adding a multiplexer
[`MUX_CONTRIBUTING.md`](./MUX_CONTRIBUTING.md).

## Decision records — read before reopening a settled question

[`.adr/`](./.adr/) holds the decisions whose reasoning would otherwise live only in a PR thread —
specifically the ones that **close off an option someone will reasonably propose again**. If you're
about to argue *why not* rather than *how*, check there first; if the answer isn't there and the
decision is that shape, add one (numbering + format: [`.adr/README.md`](./.adr/README.md)).

Rules elsewhere in this file stay short and normative and link to the ADR for the argument. Don't
restate an ADR's reasoning here, and don't edit a superseded ADR into agreement with the present —
mark it superseded and write the next one.

## Versioning — MANDATORY

Collie is **SemVer**ed, and the version is **enforced**, so it never silently drifts.

**The version lives in three files that must always agree, plus a matching CHANGELOG entry:**
`herdr-plugin.toml` (canonical — Herdr reads it) · `package.json` · `web/package.json` ·
newest *numbered* `## [x.y.z]` heading in `CHANGELOG.md`. `## [Unreleased]` is not numbered and is
not part of that agreement.

**Two kinds of commit. A functional commit records; only the release commit bumps.** Never bump a
version because you fixed something; the version moves once, when the release is cut.

**Before committing any functional change** (anything under `bridge/`, `cli/`, `web/src/`,
`web/public/`, `scripts/`, `systemd/`, or the manifest / package files) you MUST, **in the same
commit**, add **one line** to `CHANGELOG.md` under `## [Unreleased]`, beneath `### Added`,
`### Changed` or `### Fixed` — create the sub-heading if it isn't there yet. **Style: super crisp
and short** — one line per change, no prose paragraphs. End the line with the issue or PR it
answers where one exists (`… (#147)`), and with **no commit hash**: the hash doesn't exist yet, and
the release commit adds it. Do not touch the three version files.

**Cutting a release is one `chore(release): x.y.z` commit** that does all of this and nothing else:

1. **Pick the axis** from the *sum* of the Unreleased entries — what the operator has to do, not how
   visible any one change is:
   - **PATCH** (`0.2.0 → 0.2.1`): the code now does what it was always meant to do — bug fixes and
     internal refactors. A fix may well change what you see; that alone never promotes it. When the
     correction is big enough that someone should read the notes, say so loudly in the CHANGELOG
     entry rather than inflating the bump.
   - **MINOR** (`0.2.0 → 0.3.0`): something is there that wasn't — a new capability, setting,
     surface, or action. Existing setups keep working untouched.
   - **MAJOR** (`0.2.0 → 1.0.0`): the operator must change something — a config key renamed or
     removed, a contract broken, a workflow that used to work and now doesn't.
2. **Bump** all three version files to that number.
3. **Rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`**, real date, and **append each line's
   short commit hash** in the file's link style —
   `([abc1234](https://github.com/AltanS/collie/commit/abc1234))`. Tidy while you're there: merge or
   reorder lines that grew untidy, and delete lines for changes that were reverted before the
   release ever shipped.
4. **Re-create an empty `## [Unreleased]` heading above it.**
5. **Run `scripts/check-version.sh`** — it must print `✓`. Then tag and push (next paragraph).

**A PR from a fork is the exception: leave all four files alone.** Bump nothing, add no CHANGELOG
line — send the functional commits only. The version is the maintainer's to pick, because it depends
on what else lands in the same release and on which axis the *sum* of those changes sits; a bump
guessed at PR time collides with the `chore(release):` commit that actually cuts the release, and two
PRs both guessing `0.26.1` conflict with each other. `scripts/check-version.sh` stays green either
way — all four files simply keep the version they already agree on. The pre-commit hook may object
locally; `SKIP_VERSION_CHECK=1 git commit …` is the intended escape hatch here. If you'd like a
CHANGELOG line in your words, put it in the PR description and it'll be used. (Maintainer side: the
Unreleased line is yours to write on merge — cherry-pick the functional commits with `-x`, then add
the line in a follow-up `docs(changelog):` commit or by amending the merge. When a fork PR does carry
a release commit, drop that one — authorship is preserved and `main` stays unreleased until you cut
it.)

Doc-only changes (`*.md`) need neither a bump nor a CHANGELOG line. This is enforced two ways, but
**you are the first line — do it as part of the change, not after**:

**A docs change reaches colliepwa.dev only with a release.** Collie's `release.yml` tells the website
on every tag, and the website re-quotes `docs/*.md` at the newest published release — so a doc-only
fix pushed to `main` and not released sits unpublished, and the website's daily cron will not pick it
up either. To publish sooner, run the website's sync by hand against a ref:
`gh workflow run sync-docs.yml -R AltanS/collie-website -f ref=main`.

- `scripts/check-version.sh` runs inside `collie build` (a release can't build while versions
  disagree).
- A **git pre-commit hook** (`scripts/git-hooks/pre-commit`, activate once with
  `scripts/install-hooks.sh`) blocks a functional commit that neither adds a line under
  `## [Unreleased]` nor bumps the version, and blocks a release commit (version bumped) whose
  `## [Unreleased]` section still has lines in it. Escape hatch for a single commit:
  `SKIP_VERSION_CHECK=1 git commit …` (every `SKIP_*` hatch is listed under *Linting* below).

**Publish every release you cut — tag it when you push it.** Cutting a release means the three
version files + the newest numbered `CHANGELOG.md` heading agree on `x.y.z`, and `## [Unreleased]`
is empty again (the release recipe above). A cut version that never gets a tag is not a release at
all: `.github/workflows/release.yml` triggers on
`push: tags: ["v*.*.*"]` and nothing else creates the GitHub Release the in-app update banner links
to, so an untagged version exists only as a CHANGELOG heading and nobody can install it. So when
that release lands and you push, **always push a matching annotated git tag with it** —
`git tag -a vX.Y.Z -m "Collie X.Y.Z" && git push origin vX.Y.Z` (or `git push --follow-tags` so the
tag ships *with* the release). One `v<x.y.z>` tag per shipped version on the remote.

`scripts/check-tag.sh` checks this: with no arguments it asks whether the version the repo currently
claims has a tag; given a rev-list selector it asks the same of every `chore(release):` commit the
selector picks, reading the version from *that commit's* manifest. The **pre-push hook runs it over
the range being pushed and WARNS** — loudly, last, with the exact `git tag -a` command. It warns
rather than blocks because the tag may legitimately be cut after CI has looked at the release
commit; skip it once with `SKIP_TAG_CHECK=1 git push`. Nothing checks the remote, so the last step is
still yours.

**Betas 33 to 41 are unreachable on purpose. Do not back-fill them.** They were cut in the version
files and the CHANGELOG and never tagged — not even locally — which is the failure the guard above
exists to stop repeating. Their commits are superseded by the betas that followed, and a tag cut
today would claim a release nobody ever tested.

**Update notice (user-facing).** The app's in-app update banner links to the newest release's GitHub
page and shows the command to run. Pushing a `v*` tag auto-creates that GitHub Release (with the
commands) via `.github/workflows/release.yml`. **On a Herdr-managed install, always express
user-facing update/restart instructions as Herdr plugin actions** — `herdr plugin action invoke
update --plugin herdr.collie` (or `restart`) — never `bin/collie …` / `systemctl … collie`, which
depend on the caller's cwd and the unit name; the Herdr action runs from anywhere. A **binary
install** (`scripts/install.sh`'s versioned layout) is not a Herdr plugin and has no such actions:
there the spelling is `collie update` / `collie restart`, and a string that may be read on either
kind must come from the install kind (`cli/install-kind.ts`), never assume one.

## Docs style (`docs/*.md`, published to colliepwa.dev)

The website re-quotes these pages, so they are read on a phone: the renderer scrolls a code block
instead of wrapping it, renders a `>` blockquote as a card, and silently drops raw HTML. Write every
page to be skimmed.

- **Commands before prose.** A section that has something to run opens with the command, then
  explains it.
- **One numbered step is one sentence and one command.** A step that needs a code block holds the
  block indented under it. Explanation past one sentence goes in a paragraph after the list, never
  inside the step.
- **A callout is a real blockquote** (`> **Note.**`, `> **Experimental.**`), never a bold sentence
  buried in a paragraph. The site renders the blockquote as a card; the bold sentence is lost.
  The site colours the card by its bold lead word: `Note.` blue; `Experimental.`, `Caution.`,
  `Warning.` amber; `Never`, `Danger.` red; else neutral. A callout needing severity opens with
  one of these words bold; the phrase may continue (`**Experimental in 1.0.**` keys experimental).
- **One idea per paragraph, about four lines at 80 columns.** A caveat still stays in the same
  sentence as the claim it qualifies. Split the material around it rather than let the paragraph
  grow.
- **A fact the reader needs now is stated inline**, the default, the path, the command, and the
  link comes after, for the rest. `see X for where that lives` is the shape to avoid.
- **Enumerable facts go in a table:** variables, flags, per-multiplexer differences.
- **A code line fits 90 columns, trailing comment included.** The renderer scrolls, it does not
  wrap, so a long comment goes on its own line above the value.
- **Every `##` opens with a one-line summary**, before any detail.
- **No raw HTML and no `<details>`.** The site drops both without a word. Tables and blockquotes are
  safe.

## Build / run (operational facts that are easy to forget)

- **Every verb is spelled `bin/collie <verb>`** and implemented once, in `cli/`.
  `scripts/collie-ctl.sh <verb>` is a bootstrap shim that compiles the binary when the checkout has
  none and `exec`s it — it implements nothing, and its path is frozen because Herdr <0.8.0 invokes
  the action set cached at install time
  ([ADR 0006](./.adr/0006-update-advances-the-checkout-herdr-installed.md)). Teach the binary; don't
  add logic to the shim.
- **`collie link` publishes `~/.local/bin/collie` as a SYMLINK to the checkout's binary** — never a
  copy, never a wrapper script, and never as a side effect of `build`/`update`
  ([ADR 0021](./.adr/0021-the-path-name-is-a-pointer-never-a-copy.md)). `unlink` removes that name
  only when it points at this checkout.
- **There are two checkout shapes, and `update` handles both.** `herdr plugin install` does not clone
  — it leaves a **detached, shallow** checkout, so `git pull` cannot run there; a linked clone sits on
  a branch. One predicate (`git symbolic-ref -q HEAD`) picks the strategy, and the same predicate
  stops `update` re-linking a managed checkout — a re-link re-registers the plugin as local and Herdr
  then refuses `herdr plugin install`, the operator's only other way to refresh
  ([ADR 0006](./.adr/0006-update-advances-the-checkout-herdr-installed.md)).
- **Frontend changes** (`web/`): rebuild with `bun run build` (root) or `cd web && bun run build`.
  The bridge serves `web/dist` **from disk at request time**, so on the deployment host
  a rebuild is **immediately live — no restart**.
- **Backend changes** (`bridge/*.ts`): Bun does **not** hot-reload the service — you must
  `systemctl --user restart collie`. Forgetting this is the #1 "my change didn't take" trap.
- `bun run build` (root) is now **one definition**: it runs `collie build`, which gates on
  `scripts/check-version.sh`, installs both trees, **typechecks both sides** (root tsc + web tsc),
  compiles `bin/collie`, builds web to `dist-staging`, and swaps both artifacts in **last** — a
  failed build never empties a live `web/dist` and never replaces the running binary. The binary is
  always renamed into place, never written through (the running service keeps its old inode until
  it restarts). Bare `cd web && bun run build` skips all of that; don't ship from it.
- **Typecheck, and the trap in it:** the ROOT `bun run typecheck` does **not** cover `web/`'s test
  files. Only `cd web && bun run typecheck` does. So a change to a shared type can leave the root
  check green while `bun run build` — and therefore `make deploy` — fails on stale test fixtures.
  Run **both**, every time: `bun run typecheck` at the root *and* `cd web && bun run typecheck`.
  This has shipped a broken tip to `origin/v1` once; it is not theoretical.
- **Tests:** frontend `cd web && bun run test` (Vitest + jsdom + Testing Library + MSW; no headless
  browser); backend `bun run test` at the root — Bun's own runner over every pure-logic module in
  `bridge/` (access checks, state engine, config, journal adapters, notifications, uploads, …) plus
  `scripts/collie-cli.test.sh`, which drives every verb of the compiled binary in a sandboxed HOME,
  and `scripts/collie-ctl.test.sh`, which pins the shim's delegation and bootstrap.
  A **pre-push hook** (`scripts/git-hooks/pre-push`) runs **both** before
  every push — override once with `SKIP_TESTS=1 git push` (see *Linting* → escape hatches). The bits that genuinely need `Bun.serve` /
  `Bun.connect` (HTTP handlers, the socket client) stay unit-untested — Vitest-on-Node can't run them,
  so keep new backend logic pure/injectable enough for `bun test`, or exercise it through `web/`.
- Service: `systemd --user` unit `collie` on the deployment host; logs `journalctl --user -u collie -f`.
- **Dependencies must be 7 days old to install** (`bunfig.toml` + `web/bunfig.toml`, mirrored in
  `.npmrc` for npm users) — a compromised release is usually pulled within hours. A brand-new
  version resolving to an older one is the rule working, not a bug; CI's `--frozen-lockfile` is
  unaffected.
- TS is strict on both sides, with `noUnusedLocals/Parameters` everywhere. **`web/` additionally**
  enforces `verbatimModuleSyntax` + `erasableSyntaxOnly` (use `import type`, no parameter-property
  shorthand there). The **bridge** tsconfig does not enable those two — bridge code uses
  parameter-property shorthand by convention; keep each side consistent with itself.

## Linting — one linter, one config

- **oxlint is the linter and `bun run lint` is how you run it** — oxlint's own
  correctness/suspicious/perf catalog plus all 15 rules of the vendored
  [anti-slop](./tools/oxlint/README.md) plugin, at `error`. Don't add ESLint or biome
  ([ADR 0019](./.adr/0019-oxlint-and-vendored-anti-slop-are-the-lint-gate.md)).
- **One config, `.oxlintrc.json` at the root** — the editor, the PostToolUse hook, pre-commit and
  CI all shell out to it with no flags of their own. `web/` has no lint script;
  the root config already covers `web/src`. Only the **full-tree** run (CI) defines "passing".
- **`collie build` does NOT lint, and must not learn to.** `build` is the operator's path — a clean
  install and `update` both run it on the operator's machine — and oxlint's allocator SIGABRTs below
  roughly 7 GB of RAM, which bricked installs on ordinary boxes (1.0.0-beta.44). The mux-name check
  left with it; CI covers it through `scripts/check-mux-names.test.ts`.
- **A finding is fixed in the code, never suppressed and never cleared by downgrading a rule.**
  There are zero `oxlint-disable` comments in the tree and that is the policy. A `// SAFETY:`
  comment must state the invariant that makes the assertion sound — "safe, trust me" clears the
  rule and fails review.
- **Changing what's enforced goes through the rationale table in
  [ADR 0019](./.adr/0019-oxlint-and-vendored-anti-slop-are-the-lint-gate.md)**, which also holds the
  fix-shapes for the rules you'll trip most and the reasoning for the scoped `no-runtime-typeof`
  parse-boundary overrides. Per-rule reasons live as comments at the rule in `.oxlintrc.json`.
- **Don't edit `tools/oxlint/anti-slop/`** — it's a vendored copy, overwritten at the next
  re-vendor. Re-pinning upstream is the maintainer's deliberate act, and the diff gets a human
  read: vendored code is copied, not installed, so the 7-day dependency age gate never sees it.
- **`overrides.files` globs match the full path** — a glob must start with `**/` or it silently
  matches nothing. Verify any new one with a planted violation in-scope and a negative control out.

### Escape hatches (all of them, in one place)

Each guard has its own name on its own surface, so skipping one never disarms another. Use one for
a single command; never export one.

| variable | surface | skips |
| --- | --- | --- |
| `SKIP_VERSION_CHECK=1` | `git commit` (pre-commit hook) | the version-consistency + bump-on-change guard |
| `SKIP_LINT_CHECK=1` | `git commit` (pre-commit hook) | oxlint over the staged files |
| `SKIP_PACK_WIRE_CHECK=1` | `git commit` (pre-commit hook) | the pack-wire decision guard |
| `SKIP_TYPECHECK=1` | `bun run build` / `collie build` | both typecheck steps |
| `SKIP_TESTS=1` | `git push` (pre-push hook) | both test suites |
| `SKIP_TAG_CHECK=1` | `git push` (pre-push hook) | the untagged-release warning |

The pre-commit hook's three guards are **independent** — `SKIP_VERSION_CHECK=1` does not disarm the
lint guard or the pack-wire guard.

## Frontend data layer (React Router, not TanStack)

- **The UI has a written design language — read [`DESIGN.md`](./DESIGN.md) before building a
  visual component.** Its first rule is the one that keeps getting broken: look in
  `web/src/components/ui/` for an existing primitive, and promote one the moment a second
  place needs the same visual idea. It also holds the no-shift rule, the radius and line
  tokens, the mono-vs-sans split, and the Tailwind v4 traps that each cost a day.
- **Before adding any recurring visual pattern, check `web/src/components/ui/` for the
  primitive; if none exists, the primitive comes first, in its own commit.** A pattern built at
  a call site first is one that never gets promoted — the alert family cost six components that way.
- **Check UI states in the playground** (`web/src/playground/`, `cd web && bun run playground`,
  README → "The states playground") before changing a banner, the mark, the boot splash, the idle
  lock, or the pack page — it renders every state at once. Never import playground code from app
  code.
- Data flows through **React Router** (`createBrowserRouter`, data mode): route **loaders**
  (`web/src/lib/loaders.ts`) fetch the snapshot + pane; **polling is `useRevalidator()` on an
  adaptive interval** (`web/src/hooks/use-polling.ts`); mutations are direct `lib/api.ts` calls
  followed by `revalidator.revalidate()`. There is **no TanStack Query** — don't reintroduce it.
- Routes (`web/src/router.tsx`): `/`, `/space/:spaceId`, `/settings`, `/pane/:paneId` and
  `/pane/:paneId/history`. The router instance is module-scoped so it keeps its location.
- **The idle lock pauses; it does not gate.** It only appears when Collie is left *open, visible and
  untouched* — a hidden page never locks, and returning to the foreground auto-resumes. It covers a
  still-mounted router (unmounting it ate in-progress composer drafts) and pauses polling through
  `lib/idle.ts`. Don't restore it as a security control or re-describe it as one
  ([ADR 0007](./.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md)).
- **"Type into terminal" is armed by a named choice and dies with the pane view.** Long-pressing Send
  opens a menu; the hold never arms it alone. It disarms on a pane switch, a composer lock (gone pane,
  read-only, idle pause), a hidden page, and a failed batch — never persisted, never restored. Don't
  lift it, and don't add the reply guard's `composerReady` pre-flight to it; the reasoning for both
  sits in `web/src/components/send-mode-menu.tsx`'s header.
- **The phone moves the operator's terminal only on the "Show in terminal" tap** (`setFocus`, one
  row in the pane sheet). `MuxPane.focused` is a fact the snapshot reports, and the terminal never
  moves the phone in the other direction — that may not become a side effect of navigation
  ([ADR 0031](./.adr/0031-freshness-is-a-declared-promise.md)).
- **The operator's rows in `commands.toml` replace the shipped command catalog on the panes they
  address, never merge into it** ([ADR 0018](./.adr/0018-operator-command-rows-replace-the-catalog.md));
  the bridge re-reads the file behind an mtime check, so edits are live and need no restart.
- **`keys.toml` is `commands.toml`'s sibling** — the operator's rows replace the Keys tray's shipped
  Ctrl presets on the panes they address (ADR 0018 again), and only those presets: the tray's
  keyboard is fixed. Both files share one reader (`bridge/operator-file.ts`) and one scope ladder
  (`web/src/lib/operator-scope.ts`); teach both, never one.
- **`quick-replies.toml` is the third on that contract** — the operator's groups replace the Quick
  dock's shipped phrases on the panes they address (ADR 0018 once more), shell panes included when
  a row is scoped to them. Same reader, same scope ladder: the three files differ in grammar and
  never in posture, so teach all three or none.
- **`theme.toml` is the operator's fourth file, and it is the one that ADDS rather than replaces** —
  its `[[font]]` rows put extra UI typefaces UNDER the shipped three in the Settings picker, and the
  bridge serves the files read-only from `<config-dir>/fonts` at `GET /api/fonts/<basename>`. Same
  reader, same mtime liveness; the opposite posture, because a font cannot fire an action and so
  shadows nothing ([ADR 0033](./.adr/0033-the-app-face-is-a-device-preference.md)). Don't dilute
  ADR 0018's replace-law to cover it.
- **`launchers.toml` is the operator's fifth file, and the only one whose rows CREATE a pane** — its
  rows are the allowlist `POST /api/launch` matches exactly, so the client names a row and never
  supplies a command line. Same reader, same mtime liveness; no scope ladder, because a row that
  makes its own pane has nothing to address. Do not add a second allowlist and do not let the client
  supply a command line.
- **Every user-facing string goes through `t()`/`tn()` from `@/lib/i18n`**, and a component that
  calls them subscribes via `useLocale()` so it re-renders on a locale (or lazy-dictionary) change.
  `messages/en.ts` is the source of truth; all six dictionary files change together, enforced by
  `tsc`. Not translated: terminal/agent output, quick replies, menu/dialog labels the screen printed,
  key caps, pack role names, push notifications, service-worker strings, pack-link errors, and the
  slash-command descriptions in `web/src/lib/agent-commands.ts` (another tool's vocabulary — deferred)
  ([ADR 0030](./.adr/0030-the-ui-is-translated-by-a-typed-dictionary-not-a-library.md)).
- **PWA** via `vite-plugin-pwa` (`web/vite.config.ts`): manifest + `sw.js`, registered manually
  from `virtual:pwa-register` in `main.tsx` (bundled = CSP-safe). Install/SW need a **secure
  context** — over plain HTTP they no-op silently (Chrome insecure-origin flag, or HTTPS, to test).
- **The app's UI typeface is a per-device SETTING, not the maker's choice** — System / Space Grotesk /
  Aldrich (default), plus whatever the operator declared, applied pre-paint as a root class by
  `web/public/theme-init.js` and stored in `collie:design:v1` (`web/src/lib/design.ts`). CSS owns
  every stack; JavaScript only swaps a class name. What survives the reversal is the other half of
  the rule: **the chosen face never dresses agent-authored text** — `font-mono` and `font-content`
  are untouched by it ([ADR 0033](./.adr/0033-the-app-face-is-a-device-preference.md)).
- **The bundled Nerd Font subsets stay lazy and out of the precache** — `unicode-range` per face,
  version in the filename, cached first-use by `sw.ts`. Don't add them to `globPatterns`, don't
  widen a range, don't move subsetting into the build; the reasoning for each sits at the line that
  would change (`web/src/index.css`, `web/vite.config.ts`, `scripts/build-nerd-font.sh`).

## Herdr socket gotchas (see HERDR_API.md for the full, verified contract)

- RPC is **one-shot**: one request per connection; the server closes after one reply. `id` must be
  a **string**. Only `events.subscribe` streams.
- `pane.send_keys` grammar is **`+`-joined, not tmux**: `ctrl+c` (NOT `C-c`), `shift+tab`, `Up`,
  `Tab`, `Escape`, `Enter`, `Backspace`. `PageUp`/`Home`/`End`/`Delete` are unsupported.
- **A long send to Claude is verified via its paste placeholder** — anything past Claude's paste
  threshold collapses in the input box to `[Pasted text #N +M lines]`; the guard accepts that token as
  send evidence only when it is consistent with the message just typed. Don't try to dodge the
  threshold by chunking sends ([ADR 0010](./.adr/0010-long-sends-are-verified-via-the-paste-placeholder.md)).
- **A password prompt is recognised so Collie can SAY what it is, never so it can send** — no
  automatic Enter, no relaxed verification, no secret channel; the remedy offered is the operator's
  own tap on "Type" ([ADR 0017](./.adr/0017-recognising-a-password-prompt-changes-what-collie-says.md)).
  Recognition does one thing on its own: it drops the stored draft and stops persisting keystrokes.
- Pane output is rendered as **React text nodes** (never `innerHTML`); the ANSI parser only derives
  colors/weights. Keep it that way — it's the XSS boundary. Strict CSP + same-origin gate stay.
- **Collie runs no terminal emulator** — `pane.read` returns Herdr's already-rendered grid, so the
  parser needs colour and nothing else. Don't add one on either side, and don't reach for
  `terminal session observe`/`control`: a stale mirror is a transport problem, cursor position is an
  upstream ask, and `control` resizes the *shared* PTY
  ([ADR 0008](./.adr/0008-collie-does-not-run-a-terminal-emulator.md)).
- **A table pans; the mirror around it keeps wrapping** — `lib/table-run.ts` groups a table's rows
  into a single scroller inside the wrapping `<pre>` (`ansi-output.tsx`). One scroller per table,
  never one per row. Each grammar anchors on a row nothing else prints — a markdown delimiter row,
  a `+---+` rule, a frame row carrying a **cross** — and then grows by agreement, so a menu, a
  chrome box or a rule beside a table is never claimed. `table-run.test.ts` gates it against every
  capture in `fixtures/panes`; the argument sits in `table-run.ts`'s header.
- **Never use a `dark:` variant inside the mirror `<pre>`** — it tracks the root theme, which is
  backwards in a surface that renders dark under every theme and inverts in light
  ([ADR 0002](./.adr/0002-invert-the-light-terminal-mirror.md)). Fails silently;
  `ansi-output.test.tsx` guards it.
- **The plan dialog's last row is a text input, and it is never a button** — its label is only a
  placeholder while the box is empty, and its digit merely focuses the field. While `❯` sits on it the
  terminal swallows every digit as a character, so no button on that dialog may be pressable; while it
  holds text, Collie must not type into it (the caret resets to position 0, so it would prepend). A
  long value **wraps** the row rather than windowing it, which re-flows the screen above — so nothing
  may read that row as one line, and no mid-flight identity may reach above the question.
  Feedback is sent as a verified sequence, never a keystroke — the ground truth for every state is
  [`PLAN_FEEDBACK_NOTES.md`](./web/src/lib/grammar/PLAN_FEEDBACK_NOTES.md); re-walk it before touching
  `harness/claude/prompt-select.ts` or `lib/prompt-action.ts`.
- **A generically-detected menu emits only the keys the screen printed** — the footer's
  `<key> to <verb>` hints plus the arrows it advertised. Never synthesise a digit from a numbered row:
  in the `/model` picker a digit confirms *and* persists the user's default. The generic grammar
  (`harness/claude/menu.ts`) runs LAST, after every specific detector declines, and an unrecognised
  modal refuses composer typing via the adapter's `composerReady` pre-flight
  ([ADR 0009](./.adr/0009-a-generic-menu-is-driven-by-the-keys-it-names.md)).
- **A composed key queue never outlives its dock** — closing Keys discards it (guarded by a two-tap
  confirm on the drawer transition, not the ✕). Don't lift or persist it: a queue surviving into a
  later open would let Send fire a stale sequence into a pane that has moved on
  ([ADR 0005](./.adr/0005-a-composed-key-queue-never-outlives-its-dock.md)).
- **The statusline-run bound in `chrome.ts` guards less than it looks** — a dialog below the box is
  refused by the border/prompt checks and by the blank line Claude paints above its footer hint, never
  by the row count. Size it up if a real statusline needs more rows; don't delete it, and don't credit
  it with protection it doesn't provide
  ([ADR 0004](./.adr/0004-the-statusline-run-is-bounded.md)). `chrome.test.ts` pins both halves.
- **The Herdr socket is never dialled across a machine boundary, and no Herdr vocabulary crosses a
  pack link** — the lead consumes a peer's Collie API, never its Herdr socket
  ([ADR 0011](./.adr/0011-the-pack-protocol-is-the-mux-driver-seam.md)).
- **How soon Collie sees an out-of-band change is DECLARED (`topologyLatency`), never measured**, and
  `refresh()` is on the floor of the port so the phone can ask for a look now
  ([ADR 0031](./.adr/0031-freshness-is-a-declared-promise.md)). Every mutating route refreshes before
  it answers; `POST /api/refresh` is a read because it mutates nothing.

## The journal (scrollback the mirror can't give you)

`bridge/journal/` reads the agent's own session log off disk, per harness (`claude` / `codex` / `pi`,
registered in `registry.ts`). Two other things touch the filesystem, and neither is an exception to
the rule below: `stt.json` in the state dir when the operator ran `collie stt setup`
([ADR 0029](./.adr/0029-speech-to-text-is-a-provider-seam-collie-owns.md)), and the operator's own
font files under `<config-dir>/fonts`, served read-only through `bridge/operator-fonts.ts`
([ADR 0033](./.adr/0033-the-app-face-is-a-device-preference.md)).

**The law is that the journal is the only place a CLIENT-SUPPLIED value becomes a path** — and even
there it is a pane id, never a path. `GET /api/fonts/<basename>` does not become a second such place:
the request's name is **looked up** in the rows the operator's own `theme.toml` declared and that
row's path is taken, so a name nobody declared is refused before any path exists. The containment
rule in [`files.ts`](./bridge/journal/files.ts) then runs anyway, on both surfaces and as an
independent second check: **every** path about to be read goes through `containedRealpath` — after
symlink resolution, on the real paths, including paths derived from one already checked. Reuse that
function; don't write a third answer to the sentence in bold. Run
`bun scripts/journal-probe.ts` against real logs after touching an adapter; unit tests pin the
grammar, the probe catches on-disk format drift.

## Security posture (don't regress)

Loopback bind only · exactly one hardened front door — `tailscale serve` (never `funnel`) or a
conforming reverse proxy per docs/deployment.md Variant C (`COLLIE_SKIP_SERVE=1`) · same-origin gate ·
optional identity/device gates · strict CSP. A socket call can type into a real terminal — treat a
collie as remote shell access.

**The loopback gates fail closed, and the pack link is exempt by construction, never by relaxation.**
Host validation is on by default (`COLLIE_ALLOW_ANY_HOST=1` opts out), `COLLIE_TRUSTED_USER` rejects
an ABSENT `Tailscale-User-Login` as well as a wrong one (`COLLIE_TRUSTED_USER_OPTIONAL=1`), a
non-loopback bind refuses to start (`COLLIE_ALLOW_NON_LOOPBACK_BIND=1`), and a non-loopback TCP peer
is refused. **A collie in a pack is exempt from the bind refusal and `/pack/v1/*` from the peer
check** — a member is dialled across a machine boundary and that surface carries pinned mutual TLS
plus the pack secret ([ADR 0013](./.adr/0013-a-peer-listens-without-becoming-a-front-door.md)). The
exemption is granted by POSITION — the peer check sits after the federated dispatch in
`bridge/server.ts` — so no pack path is ever spelled there. The standby door is its own listener on
its own `COLLIE_STANDBY_HOST` and neither gate reaches it; don't route it through the front door's
`fetch` to share them.

**The bridge makes no outbound call and spawns no long-running child for content — unless the
operator ran `collie stt setup`.** Speech-to-text (`bridge/stt/`, CLI `cli/stt.ts`) is a registered
provider seam, absent until that verb writes `stt.json`: it then holds a provider credential at 0600,
opens an operator-configured outbound path carrying microphone audio, and on the `codex` provider
spawns a `codex app-server` child. All three costs are declined by doing nothing, the local-engine
configuration keeps the egress on loopback, and the wire identity is probed honest-first and recorded
([ADR 0029](./.adr/0029-speech-to-text-is-a-provider-seam-collie-owns.md)). Setup is a CLI act, never
a web form, for the reason pairing is.

**Two device gates guard writes, independently, and compose by AND.** `COLLIE_DEVICE_HEADER` trusts
a name a proxy injects; **pairing** (`bridge/pairing.ts`, `collie pair` / `collie devices`) requires a
bearer credential the device holds, and is on exactly when the registry is non-empty. Reads stay
ungated by both. Neither applies to `/pack/v1/*`, which has its own two factors. The reasoning sits in
`bridge/pairing.ts`'s header; don't collapse the two gates into one.

**Collie manages exactly one front door: `tailscale serve`** — the CLI (`cli/serve.ts`) publishes it,
records the mapping in `tailscale-managed-handler`, and only ever tears down a mapping matching that
record.
Every other tunnel (NetBird, ZeroTier, Cloudflare Tunnel) is `COLLIE_SKIP_SERVE=1` + docs/deployment.md
Variant E: the operator owns the ingress, Collie publishes nothing. **Don't add a second managed front
door** — [ADR 0001](./.adr/0001-one-managed-front-door.md).

**The pack link (lead↔peer, `/pack/v1/*`) is specified in [`PACK_PROTOCOL.md`](./PACK_PROTOCOL.md)**
— two factors gate it (pinned mutual TLS + pack secret), and a peer publishes no front door
([ADR 0013](./.adr/0013-a-peer-listens-without-becoming-a-front-door.md)); the one exception is the
**deputy's standby door** — bound, never published, armed by silence and spent by the operator's
pairing credential ([ADR 0027](./.adr/0027-the-deputy-is-named-ahead-of-time.md) ·
[ADR 0028](./.adr/0028-the-standby-door-is-a-second-listener.md)).

**Touching the pack wire surface forces a protocol decision** — a commit staging one of the
wire-shape files in `bridge/pack/` must also stage `PACK_PROTOCOL.md` (additive-optional, §7.1) or
bump `PACK_PROTOCOL_VERSION` (not expressible that way). `scripts/check-pack-wire.sh` is guard C of
the pre-commit hook; a pure refactor takes the `SKIP_PACK_WIRE_CHECK=1` hatch
([ADR 0025](./.adr/0025-the-wire-guard-forces-a-decision-never-a-bump.md)).

**Code reaches a peer over the operator's own SSH, never over the pack link** — `pack add` installs
it and `pack update` levels it, both pushing the lead's own commit as a `git bundle`; the link
carries runtime data and never becomes a distribution channel
([ADR 0016](./.adr/0016-updates-ride-the-operators-ssh.md), addendum 2026-09-04: a peer may also
level ITSELF to the release its lead is running, fetching that public tag from GitHub over anonymous
HTTPS on its own decision, which adds no code, route or verb to the link). How the operator
reached a member is remembered locally in `pack-ops.json`, which is never a wire field and never merged into the trust
store.
