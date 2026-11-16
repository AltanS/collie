# Contributing to Collie

This guide covers the essentials: which CI checks must pass and the convention that most often
trips people up. Read [`CLAUDE.md`](./CLAUDE.md) for the full working agreement.

## Base branch

**Open every PR against `main`.** There is one line of development, and `main` is it.

## Before you open a PR

Run all four checks. The first three match the pre-commit and pre-push hooks, and CI runs every
suite.

```bash
bun run typecheck            # backend
cd web && bun run typecheck  # web — the root check does NOT cover web's test files
bun run lint                 # oxlint, one config, at the repo root
bun test ./bridge ./cli ./scripts
cd web && bun run test       # vitest — never `bun test` in web/, Bun's runner can't drive jsdom
```

The web typecheck runs separately by design. Changing a shared type can pass the root check while
breaking stale test fixtures. Run both commands every time.

CI also runs a browser suite in Playwright, a second job that opens the app in Chromium at a phone
size and a tablet size. You do not need to run it locally to open a PR. If you want to run it
yourself, `cd web && bun run e2e`. It is not part of the pre-commit or pre-push hooks, so a green
push does not guarantee it passed; check the CI run. See `CLAUDE.md` → "Browser tests" for the
tiers, the fixtures, and how to add a case.

You can automate this by running `scripts/install-hooks.sh` once. It sets `core.hooksPath` to the
repo hooks. The pre-commit hook checks the version, linting, and package wire. The pre-push hook
runs typechecks, executes tests, and warns if you push an untagged release.

## Versions

Functional changes in `bridge/`, `cli/`, `web/src/`, `scripts/`, or the manifest require bumping
the version in `herdr-plugin.toml`, `package.json`, and `web/package.json`, plus adding an entry
to `CHANGELOG.md`. Place the entry as a single line at the end of the `## [Unreleased]` list
without sub-headings or commit hashes. Documentation-only changes (`*.md`) are exempt. The
pre-commit hook verifies these updates. Run `SKIP_VERSION_CHECK=1 git commit …` to bypass the
hook for a single commit.

**From a fork, do not bump versions.** Submit your functional commits and leave those four files
unmodified. The release version depends on other merged changes, so maintainers set it to avoid
collisions between competing PRs. Use `SKIP_VERSION_CHECK=1` locally. If you want a specific
CHANGELOG entry, include it in the PR description.

### Renaming something

A rename depends on the surface. A **wire** field (a JSON key a cached browser bundle reads) is never
renamed for vocabulary: add the new name, keep the old one for one MINOR release, remove it in the
next, with a CHANGELOG note. An **operator-visible** name (`COLLIE_*` keys, action ids in
`herdr-plugin.toml`, the unit name, CLI verbs) is frozen: a rename is MAJOR. Action ids carry a second
freeze, because Herdr before 0.8.0 caches the action set at install. **Cosmetic** text (action titles,
in-app strings) is free to reword. **Free** surfaces (directories, internal type names, doc prose, test
names) are renamed when their file changes for another reason. A rename lands as one change with its
own CHANGELOG entry, never inside feature work, and never as a repo-wide mechanical sed. An alias
exists only for a frozen surface, and it ships with a stated removal release.

## Working on the UI

Read [`DESIGN.md`](./DESIGN.md) before writing code. Check `web/src/components/ui/` for an existing
primitive before you build a new one, and extract a component as soon as two places share the same
visual pattern. `DESIGN.md` also documents the layout stability constraints, radius and border
tokens, and the Tailwind v4 issues that cause regressions.

Check UI states in the design reference (`web/design.html`, `cd web && bun run design`) before
changing a banner, the mark, the boot splash, the idle lock, or the crew page. Its search field finds
an entry by title, id or keyword. Every card there carries a `data-state` handle, so a browser case
can address it directly instead of matching its prose label.

To add an icon set that a theme can name, follow
[Add an icon set to Collie](./docs/themes.md#add-an-icon-set-to-collie): one pull request that maps
an open-licensed icon library to every icon key.

## Decisions that are already settled

[`.adr/`](./.adr/) records decisions whose rationale would otherwise stay buried in PR threads. It
focuses on choices that rule out alternatives contributors frequently propose again. Check there
first if you are about to ask why a particular approach was not used.
