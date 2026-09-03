# 0006 — `update` advances the checkout Herdr installed, and never re-links it

Status: **Accepted** (2026-08-04)

## Context

Collie has two install paths, and they leave **different git shapes on disk**:

| Path | What lands |
| --- | --- |
| `git clone` + `herdr plugin link` (dev) | a normal clone, on a branch, full history |
| `herdr plugin install AltanS/collie` (turnkey) | `git init` + `git fetch --depth 1 origin HEAD` + `git checkout --detach FETCH_HEAD` — **detached, shallow, no remote-tracking refs**, under `~/.config/herdr/plugins/github/<hashed-id>` |

The second is not a clone, and nothing documents that it isn't. `collie-ctl.sh update` ran a bare
`git pull --ff-only`, which has no branch to pull into there, so it failed with *"You are not
currently on a branch"* — from 0.1.0 until 0.23.1, for **every** turnkey install, while the in-app
banner kept telling those users a new release was out ([#63](https://github.com/AltanS/collie/issues/63)).
It went unnoticed for 23 releases because the maintainer's own host is a linked clone — the one shape
that worked.

Herdr has no `plugin update`; its documented refresh is to **reinstall**, which replaces the managed
checkout and re-runs `[[build]]` but does **not** restart the service. Two options were weighed
(reviewed by a second model before implementation), and both are the kind that get re-proposed.

## Decision

**`update` advances whatever shape the checkout is in.** One predicate — `git symbolic-ref -q HEAD` —
picks the strategy: fast-forward the branch for a linked clone, or fetch the default-branch tip and
re-detach onto it for a managed one, the way Herdr got there.

**We do not defer to `herdr plugin install` as the refresh path for managed installs.** Reinstall
doesn't restart the bridge, so it is a two-command dance with a version-skew window in the middle:
`web/dist` is served off disk at request time, so the new UI goes live against the old bridge process
the instant the swap lands. The one-command action is the thing Collie's banner, README and update
notice all point at.

**`--depth 1` only when the checkout is already shallow**, so an update can never truncate the history
of a full clone that someone happens to have detached.

**The detach is `--force`.** `cmd_build` runs bare `bun install` in both trees and the lockfiles are
tracked, so a rewritten `bun.lock` would leave a dirty tree that blocks the *next* checkout — the
update path would silently re-break itself into exactly the state this ADR exists to fix.

**`update` never re-links a Herdr-managed checkout.** `herdr plugin link` re-registers the plugin with
`source.kind = local`, and `ensure_replacement_allowed` then **refuses** `herdr plugin install`
("already linked from a local path") — removing the operator's only other way to refresh. The re-link
stays for linked clones, where it is safe and still useful.

## Consequences

- **A managed install can always be repaired from outside.** This is the reason for the re-link rule.
  Self-update is a convenience; reinstall is the floor under it, and a plugin that quietly disables
  its own recovery path in the name of tidying a registry entry has traded a cosmetic win for an
  unrecoverable one.
- **The registry's `resolved_commit` goes stale after a self-update.** Accepted: it is display-only
  (install preview and the `github:owner/repo@sha` summary string), no logic keys off it, and a later
  reinstall re-derives it.
- **On Herdr <0.8.0 a managed install keeps a stale cached action set.** Which imposes a standing
  constraint: **never rename the `update` / `restart` actions or move `scripts/collie-ctl.sh`** —
  those users invoke the definition Herdr cached at install time. Herdr ≥0.8.0 re-reads the manifest
  from disk on every registry refresh, so this expires on its own.
- **We depend on an undocumented internal.** The detached-shallow shape is read off `git_checkout()`
  in Herdr's `src/cli/plugin.rs`, not off a contract. The dependency is deliberately soft: if Herdr
  ever switches to cloning on a branch, the predicate routes to the `git pull` branch and keeps
  working. Re-read that function before touching this path.
- **A fix shipped inside the checkout can't repair the checkout that can't update.** Installs made
  before 0.23.1 need one reinstall to take the fix — documented in the README, the CHANGELOG's
  `Upgrading` block (which the release workflow renders onto the GitHub Release page the update banner
  links to), and on #63.

### What would justify revisiting

- **Herdr ships a real refresh verb** — `herdr plugin update <id>`, or a manifest-declared
  post-install action it invokes after the swap. Asked for upstream in
  [herdrdev/herdr#2250](https://github.com/herdrdev/herdr/issues/2250). Either would let the detached
  branch delegate instead of hand-rolling git, and would retire the re-link rule with it.
- **Herdr starts recording enough source metadata for a plugin to refresh itself in-band** (e.g. an
  API that updates `resolved_commit`), which would remove the staleness this ADR accepts.
- Evidence that operators actually *want* a pinned `--ref` install to stay pinned across `update`.
  Today "update means latest"; that reading is a judgement call, not a constraint.

## Amendment — 2026-09-03: a LINKED CLONE stages its update; a MANAGED checkout still advances in place

Status: **Accepted** (2026-09-03). Amends the Decision above for one of the two shapes. Everything
this ADR says about a **Herdr-managed** checkout stands unchanged — including the re-link rule, the
`--depth 1` rule and the `--force` detach.

### What changed

A **linked clone** no longer advances in place. `collie update` resolves the target release tag,
adds a git **worktree** for it at `<install-root>/versions/vX.Y.Z`, builds inside that worktree, and
goes live by flipping the `<install-root>/current` symlink with the single `rename(2)` a binary
install already uses (`cli/update.ts`). Every version shares the one `.git`, so a version costs a
checkout of the tree and not a second object store. The first staged update creates `versions/` and
`current` inside the existing clone; no operator moves anything by hand.

### Why

The consequence this ADR accepted is the one that got expensive: advancing the live tree means a
failed build leaves **new code on disk and the old artifacts being served** — the skew shape this
ADR exists to prevent, mitigated by a message rather than removed. `cli/update.ts` had to say
"the checkout advanced but the build failed" because there was nothing else it could truthfully say.

Staging removes the shape instead of naming it. Until the flip, nothing the operator can see has
moved: a failed build is a no-op that names the stage it failed at, and the version that was live is
still on disk, which is what makes `collie update --rollback` work on a checkout at all. The
completeness marker (`.collie-build`, written last) is what makes a killed build a **refusal** at the
flip rather than a symlink pointing at a half-built tree.

### Why a Herdr-managed checkout is excluded

Not caution — shape. A managed checkout is detached and **shallow**, its root is Herdr's own plugin
directory under `~/.config/herdr/plugins/…`, and Herdr's registry names that path. Laying a
`versions/` layout inside a directory Herdr owns, and pointing the registry at a symlink in it, is a
second contract with an undocumented internal on top of the one this ADR already accepts. The
turnkey install's recovery path is a reinstall, and a reinstall replaces that directory wholesale —
which is exactly the property staging would put at risk. So it keeps advancing in place, and the
re-link rule above still governs it.

### Consequences

- **Two update shapes, one layout.** A staged checkout and a binary install now differ in how a
  version is *produced* (a worktree that is built, versus a payload that is downloaded and verified)
  and in nothing else: one `versions/` directory, one `current` symlink, one flip, one retention rule
  (`current` plus the two newest previous versions).
- **The plugin root of a migrated clone moves under `versions/`.** `bridge/root.ts` resolves the
  running binary's own directory, and `process.execPath` is realpath-resolved, so the answer is
  `versions/vX.Y.Z` and never `current` — the same property a binary install already has.
- **The service unit and the PATH name follow the flip.** The restart is performed by the NEW binary
  through `current`, because this process is the old version and its own `restart` would pin the
  supervisor to the version being left; `~/.local/bin/collie` is re-pointed at `current/bin/collie`
  on migration, keeping ADR 0021's pointer-not-a-copy rule true across versions.
- **Herdr is re-registered at `current`**, not at a version, so a plugin action always runs what is
  live. The re-link is still refused on a managed checkout, for the reason above.
- **Retention is not collected by `update`.** Pruning during staging would destroy the rollback
  target of the run that may need it, so `pruneVersions` is exported for the health gate to call
  after a restart has proven the new version, and an update itself removes nothing.
