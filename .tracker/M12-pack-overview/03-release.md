---
updated: 2026-08-26
depends_on:
  - 01-the-pack-status-endpoint.md
  - 02-the-pack-overview-page.md
agent: typescript-expert
template: generic
---

# Release — version bump, CHANGELOG, deploy

## Goal

Land the pack-overview feature as a MINOR bump, keep the four version sources agreeing, and prove it
on the running deploy from the workspace root.

## Ground Truth

- **`herdr-plugin.toml:3`**, **`package.json:3`**, **`web/package.json:3`** all currently read
  `version = "1.0.0-beta.26"` / `"version": "1.0.0-beta.26"`. **`CHANGELOG.md`**'s newest heading is
  `## [1.0.0-beta.26] - 2026-08-26`.
- **`scripts/check-version.sh`** requires all four to agree exactly (`toml_v`, `pkg_v`, `web_v`,
  `log_v` compared verbatim) and prints `✓ ... consistent across manifest` on success — this is the
  gate M6 and M7's own release specs both cite.
- **The project is pre-1.0 and still on a `-beta.N` prerelease train** — M7's own README states the
  convention explicitly: "Both verbs are additive — the MINOR axis, inside the `1.0.0-alpha.N`
  numbering." The same convention applies here: this feature is additive (a new read-only route and
  endpoint, no behaviour change to anything existing), so it bumps the beta counter rather than
  crossing to `1.0.0` or bumping a PATCH-shaped number within the prerelease.
- **The workspace root** (`/var/home/altan/projects/collie-workspace/`) owns `make deploy` and
  `make health` — **not** this repo. Its `CLAUDE.md` names the exact commands and warns that
  `bun run build:cli` is insufficient (it skips the web bundle) — only `make deploy` runs the full
  `bun run build`, restarts the units, and verifies each port. Read
  `/var/home/altan/projects/collie-workspace/README.md` before running either command if anything
  about ports or instances is unclear.

## Overview

This is the smallest spec in the milestone by design: no logic, just the version ledger and the
deploy-and-verify step every other milestone in this tracker ends with (M6, M7). It runs last,
after specs 01 and 02 are both merged, so the CHANGELOG entry describes what actually shipped rather
than what was planned.

## Requirements

- **Bump all three version files together**, `1.0.0-beta.26` → `1.0.0-beta.27` (confirm the next free
  number against `CHANGELOG.md`'s history at merge time — another milestone may have bumped it first):
  `herdr-plugin.toml`, `package.json`, `web/package.json`.
- **A new `CHANGELOG.md` heading**, `## [1.0.0-beta.27] - <merge date>`, under an `### Added` section,
  naming: the read-only `GET /api/pack` endpoint, the `/pack` overview page, and its two entry points
  (ServerSwitcher footer, Settings) — worded for an operator reading the changelog, not for a
  developer reading the diff (match the existing entries' voice, e.g. the `beta.26` entry above).
- **`scripts/check-version.sh` prints `✓`.**
- **`make deploy instance=v1`** run from the workspace root
  (`/var/home/altan/projects/collie-workspace/`), per its `CLAUDE.md`: full `bun run build`, unit
  restart, port verification.
- **`make health`** run from the workspace root afterward, confirming the deployed instance is up and
  the new route answers as expected (200 on the lead, 404 on solo/peer, per spec 01).

## Verification Checklist

### Implementation

- [x] All four version sources agree on the new number
  - Command: `bash scripts/check-version.sh`
  - Expected: `stdout contains "consistent across manifest"`
- [x] The CHANGELOG entry exists and names the feature
  - Command: `head -20 CHANGELOG.md | grep -A5 "^## \[1.0.0-beta.27\]"`
  - Expected: mentions `/api/pack` and `/pack`

### Integration Tests

- [x] Full bridge + frontend suites still green at the bumped version (nothing in this spec should
      touch logic, but confirm no version-string test broke)
  - Command: `bun test ./bridge && (cd web && bun run test)`
  - Expected: `exit 0`

### Manual

- [x] `make deploy instance=v1` from the workspace root completes and every port verifies
  - Evidence: transcript in `.tracker/worklog/M12-pack-overview.md`
- [x] `make health` from the workspace root is green afterward
  - Evidence: transcript in `.tracker/worklog/M12-pack-overview.md`
