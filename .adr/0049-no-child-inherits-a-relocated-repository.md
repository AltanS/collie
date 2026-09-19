# 0049 — No child inherits a relocated repository

- **Status:** Accepted
- **Date:** 2026-09-19
- **Shipped in:** 1.10.2
- **Trail:** `cli/sys.ts` (`GIT_RELOCATORS`, `withoutGitRelocators`, `realExec`) ·
  `cli/sys.test.ts` · `cli/remote.ts` (`git bundle create`) ·
  `cli/install-kind.ts` (`isGitCheckout`) · issue
  [#243](https://github.com/AltanS/collie/issues/243)

## Context

**`-C` is not the last word.** `GIT_DIR`, and the seven names beside it, tell git where a repository
actually is. Git obeys them from any working directory, and they beat `git -C` and every path on the
command line. They do not adjust discovery; they replace it.

Collie handed its whole environment to every child it started. So a `collie` run with `GIT_DIR`
exported asked every git question about somebody else's repository. `isGitCheckout` reported a
checkout in a directory with no `.git` at all. `originOf` read that repository's remote. `update`
would have advanced it.

**Two ordinary ways in, and the project has already been bitten by one.** An operator's shell
profile exports them for a dotfiles manager, which is the same population
[#243](https://github.com/AltanS/collie/issues/243) came from. And git sets `GIT_DIR` and
`GIT_PREFIX` for every hook it runs, so a hook that calls `collie` hands them over with nobody
writing them down.

`scripts/collie-cli.test.sh` records the cost at its top. That suite runs from pre-push, an
inherited `GIT_DIR` turned its `git -C "$sandbox" init` into a re-init of the caller's repository,
and from a linked worktree that wrote `bare = true` into the shared config and left a developer's
checkout unusable. The suite has defended itself with `unset "${!GIT_@}"` ever since. The shipped
binary never grew the same guard.

## Decision

**A child of Collie never inherits a variable that relocates a git repository.** Every git question
is about the directory Collie names, never the one the environment names.

1. **Eight names are stripped**, in `GIT_RELOCATORS`: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
   `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`,
   `GIT_PREFIX`. Each names a location. Nothing else qualifies.
2. **The seam is `realExec`, applied to every child and not only to git.** All five construction
   sites go through it, the bridge's included, so one line covers them. A child that is itself a
   launcher would otherwise pass the variables on, and the git call that misreads them then happens
   one process further down where nothing is looking.
3. **The filter runs after the `envAdd` merge, not only on the closure's env.** Otherwise `envAdd`
   is the one way a stripped name comes back. No caller passes a git name today, and the invariant
   is not allowed to depend on that staying true.
4. **A git child started outside `Exec` applies the rule by hand.** There is exactly one,
   `git bundle create` in `cli/remote.ts`, and it is named here so the next one is not missed.

**Three groups are deliberately NOT stripped.** `GIT_CEILING_DIRECTORIES` only stops discovery
walking up, so it can turn a "checkout" answer into a "not a checkout" answer and never the reverse;
that direction ends in a refusal, never in a deletion. `GIT_CONFIG_*` can reach a repository through
`core.worktree`, but only after discovery has already found a real one, and the hermetic build and
update paths set those names on purpose. `GIT_SSH_COMMAND` and the credential names decide how git
authenticates rather than which repository it is looking at; stripping them would break real updates
to fix a theoretical exposure.

## Consequences

- **`isGitCheckout` is answerable.** Its `--show-prefix` probe compares depth inside a repository,
  which is only meaningful once the repository is the one on the command line.
- **A hook that calls `collie` is safe.** This is the case nobody writes down, and it needed no
  operator action to become true.
- **A crew bundle is the repository it says it is.** Without the by-hand strip, a lead with
  `GIT_DIR` exported would bundle a different repository and hand it to a peer, and the
  `rev-parse HEAD` check before it would pass while doing so, because that call reads the same
  redirected repository.
- **The rule has to be obeyed at new spawn sites.** `cli/remote.ts` shows it is easy to miss. A new
  child that runs git and does not go through `Exec` must call `withoutGitRelocators` itself.
