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

## Working on the UI

Read [`DESIGN.md`](./DESIGN.md) before writing code. Check `web/src/components/ui/` for an existing
primitive before you build a new one, and extract a component as soon as two places share the same
visual pattern. `DESIGN.md` also documents the layout stability constraints, radius and border
tokens, and the Tailwind v4 issues that cause regressions.

## Decisions that are already settled

[`.adr/`](./.adr/) records decisions whose rationale would otherwise stay buried in PR threads. It
focuses on choices that rule out alternatives contributors frequently propose again. Check there
first if you are about to ask why a particular approach was not used.
