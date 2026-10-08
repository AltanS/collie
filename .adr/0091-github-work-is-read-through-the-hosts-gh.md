# 0091: GitHub work is read through the host's `gh`, opt-in and read-only

- **Status:** Accepted
- **Date:** 2026-10-08
- **Shipped in:** pending
- **Relates to:** [ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) (an
  outbound call the operator did not ask for is off by default; this one is asked for by a key) ·
  [ADR 0086](./0086-reads-need-the-pairing-token.md) (the route is a read, so it needs the pairing
  token like every other) · [ADR 0049](./0049-no-child-inherits-a-relocated-repository.md) (the
  `gh` child gets no git relocator) · [ADR 0085](./0085-the-dashboards-tabs-are-dashboard-crew-and-changes.md)
  (the dashboard's tabs stay three; the screen is reached from the meta footer).
- **Trail:** @aryrabelo's request, which names the road this closes: a `launchers.toml` row that
  opens the `herdr-dashboard` TUI in a
  new Space and mirrors it to the phone, plus the roads proposed with it (a token in `.env`, the
  phone calling GitHub itself, one REST call per PR) · `bridge/github-work.ts` (`GITHUB_WORK_QUERY`,
  `GithubWork`, `ghEnv`, `classifyGhRun`) · `bridge/server.ts` (`serveGithubRoute`) ·
  `bridge/config-schema.ts` (`github`, `COLLIE_GITHUB`) · `bridge/crew/forward.ts` (`FORWARDABLE`,
  `GITHUB_READ_BUDGET_MS`) · `CREW_PROTOCOL.md` · `web/src/routes/github.tsx` ·
  `web/src/components/github-work-lists.tsx` · `web/src/components/github-footer-link.tsx` ·
  `web/src/lib/github.ts` · `web/src/hooks/use-github-work.ts` · `docs/configure.md` → *GitHub work*

## Context

The operator drives agents from the phone, and the agents' work ends on GitHub: pull requests that
wait on a check, a review or a conflict, PRs somebody asked him to review, issues assigned to him.
Following that meant leaving Collie. The one bridge into it was a launcher row that opens a PR
dashboard TUI in a new Space. On a phone that is a mirrored terminal, hard to read, and it only knew
the PRs of the multiplexer's own workspaces.

Measured on 2026-10-08 against api.github.com, as `aryrabelo`:

- One GraphQL query with three `search` aliases (my open PRs, review requested, assigned issues),
  30 items each, with the status-check rollup and its per-state counts, costs **2 points** and takes
  **7 to 9 s**. Most of that is GitHub's search: dropping the rollup still left 4.7 s.
- At 50 items per list the same query fails with **HTTP 502 after about 11 s**.
- The account had 86 open PRs, 150 open assigned issues and **1060 open issues it had authored**,
  most filed by agents under the operator's name.
- `mergeable` is computed lazily by GitHub and often reads `UNKNOWN` on the first ask.

The account differs by machine: `aryrabelo` on one, a work account on another. So "my PRs" is a
question about a machine's `gh` login, not about the phone.

## Decision

**The bridge reads GitHub through the host user's `gh`, only when a paired device asks, only when
the operator turned it on, and it never writes.**

1. **Off by default.** The config key `github` (`COLLIE_GITHUB`) turns it on, per machine. Off, the
   route answers `off` without starting a process, and the phone hides the entry. This is the shape
   ADR 0034 sets for any outbound call: the operator asks for it in a place he is looking.
2. **The credential is `gh`'s, on the host.** The bridge runs `gh api graphql` with argv only, never
   a shell. No token is added to `.env`, and none reaches the phone. Whatever `gh` is logged in as on
   that machine is the account, and the answer names it (`login`) beside the machine (`machine`).
3. **One query per refresh, and it is a query.** A constant GraphQL document with three searches,
   30 items each, `issueCount` carried as the total. Its text starts with `query` and contains no
   `mutation`; a test pins that. Merging, approving, commenting and closing are out of this decision
   and need one of their own.
4. **A cache with a 60 s TTL, single-flight, stale while revalidating.** Only a request starts a
   fetch; no timer does. An expired answer is served at once marked `stale` while one refresh runs.
   A failed refresh keeps the last good answer, marked with the error. `fresh` skips the TTL but not
   a 10 s floor. `peek` never starts a process, so the dashboard footer can ask on every visit.
5. **The `gh` child is bounded.** 20 s timeout, an output cap, the bridge's `COLLIE_*` variables and
   git relocators removed, prompts disabled.
6. **`UNKNOWN` is "unknown".** A PR whose mergeability GitHub has not computed is never shown as free
   of conflicts.
7. **Per host, through the same `?host=` selector.** The route sits beside `/api/launchers` and is
   forwardable on the crew link, additive-optional (CREW_PROTOCOL.md §7.1). A member that predates it
   answers 404 and the phone says the machine does not offer it. Each member reads its own `gh`.
8. **A screen, not a tab.** `/github` is a dashboard-level page reached from a line in the meta
   footer. ADR 0085's three tabs stay as they are.

## Consequences

- **The bridge now has a second operator-enabled outbound path**, beside speech-to-text (ADR 0029).
  It is `gh`'s traffic to api.github.com, with `gh`'s credential, and it exists only while the key
  is on and a phone is looking.
- **The lists are capped at 30.** The screen says "30 of 86" rather than paging. Raising the cap is
  bounded by the 502 measured at 50.
- **Issues the operator authored are left out.** 1060 open authored issues is not a list a phone can
  show. Revisit if a filter (a label, a repo set) makes that list small.
- **A first look waits for GitHub**, 7 to 9 s, because nothing is fetched ahead of a request. Every
  look after that within the TTL is immediate, and a stale one is immediate too.
- **`gh` must be on the service's `PATH`** and logged in for the user the service runs as. The
  screen names which of the two is missing, on which machine.
- **Revisit** when a write is wanted (merge, approve, comment): it needs its own ADR, its own gate
  level, and the machine's GitHub publish gate, which refuses mutations today.
