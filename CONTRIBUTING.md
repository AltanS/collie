# Contributing to Collie

Thanks for looking. This page is the short version: which branch to open against, which gates have
to be green, and the one convention that trips people up. The long-form working agreement lives in
[`CLAUDE.md`](./CLAUDE.md).

## Base branches

**Open bugfixes against `main`** — they reach the stable line first and flow into `v1`
automatically. **Open features, and anything touching `cli/` or the bridge, against `v1`.** `main`
is in maintenance until 1.0.0 ships.

Why the split: `v1` is 327 commits ahead of `main`. A feature branched off `main` is a feature
written against a codebase that has already moved, and it has to be rewritten before it can land. A
bugfix is small enough to cross the gap in the other direction, and `main` is where users of the
0.x line get it.

When 1.0.0 ships, `main` becomes the 1.0 line and this rule collapses to "open everything against
`main`".

## Before you open a PR

Run all four. The first three are also the pre-commit and pre-push hooks; CI runs the lot.

```bash
bun run typecheck            # backend
cd web && bun run typecheck  # web — the root check does NOT cover web's test files
bun run lint                 # oxlint, one config, at the repo root
bun test ./bridge ./cli ./scripts
cd web && bun run test       # vitest — never `bun test` in web/, Bun's runner can't drive jsdom
```

The web typecheck is a separate command on purpose: a change to a shared type can leave the root
check green and still break the build on a stale test fixture. Run both, every time.

Let the hooks run these for you — `scripts/install-hooks.sh`, once. It points `core.hooksPath` at
the repo's own hooks: pre-commit guards the version, the lint and the pack wire; pre-push
typechecks, tests, and warns if you are pushing a release with no tag.

## Versions

A functional change — anything under `bridge/`, `cli/`, `web/src/`, `scripts/` or the manifest —
bumps the version in `herdr-plugin.toml`, `package.json` and `web/package.json`, and adds a
`CHANGELOG.md` entry. Doc-only changes (`*.md`) are exempt. The pre-commit hook enforces this;
`SKIP_VERSION_CHECK=1 git commit …` is the escape hatch for a single commit.

**From a fork, bump nothing.** Send the functional commits and leave all four files alone — the
version depends on what else lands in the same release, so it is the maintainer's to pick, and two
PRs both guessing the same number collide. Take the `SKIP_VERSION_CHECK=1` hatch locally. If you
want a CHANGELOG line in your own words, put it in the PR description.

## Working on the UI

Read [`DESIGN.md`](./DESIGN.md) first. Its first rule is the one that keeps getting broken: look in
`web/src/components/ui/` for an existing primitive before you build a new one, and promote one the
moment a second place needs the same visual idea. `DESIGN.md` also holds the no-shift rule, the
radius and line tokens, and the Tailwind v4 traps that each cost a day.

## Decisions that are already settled

[`.adr/`](./.adr/) holds the decisions whose reasoning would otherwise live only in a PR thread —
specifically the ones that close off an option someone will reasonably propose again. If you are
about to argue *why not* rather than *how*, check there first.
