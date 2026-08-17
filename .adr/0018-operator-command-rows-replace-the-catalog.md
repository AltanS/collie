# 0018 — The operator's command rows replace the catalog, never merge into it

Status: **Accepted** (2026-08-17)

## Context

The Agent-commands sheet ships a small per-harness catalog (`web/src/lib/agent-commands.ts`) whose
sourcing rule is strict: a row must be a command *every* user of that harness has, because Collie
vouches for what a tap will do. That rule is also the sheet's ceiling — a command registered by a
plugin or by the operator exists on one machine only, so the catalog can never carry it, and it is
exactly the command worth one tap (omp's `/fork-in-herdr`, a Claude Code custom command, your own
`/deploy`).

PR #109 adds operator-declared rows. The question with a blast radius is what a declaration does to
the shipped catalog on a pane it addresses: **replace it, or merge into it**. Merge is the option
someone will reasonably propose again — it reads as strictly additive ("why did declaring one row
cost me the ten I had?").

Two facts frame the choice:

- The sheet is a handful of one-thumb shortcuts, and its value is that *someone chose the list
  whole*. A list half-chosen by the operator and half-guessed for them inherits the guarantees of
  neither: the operator no longer knows what's on it, and Collie no longer vouches for all of it.
- Nothing is lost that the operator can't get back. The agent's own `/` completion already renders
  in the mirrored pane, live and complete — discovery belongs to the harness. And there is nothing
  to merge *from* on the machine level: the real command set is registered at runtime inside the
  agent process (omp has no `commands --json`, no on-disk list), and scraping the completion popup
  back through `pane.read` is per-agent grammar over four wrapped visible rows in the user's live
  session. The sheet is not a discovery surface and cannot become one honestly.

## Decision

**On a pane the operator's rows address, those rows are the whole palette.** A pane none of them
address keeps the shipped catalog untouched; an operator who declares nothing gets every pane
exactly as shipped.

**Merging is refused, not deferred.** An operator who wants "the catalog plus one" restates the
shipped rows they still want. That cost is the point: every list on the sheet stays a list somebody
chose end to end, and a tap never fires a row nobody put there.

**Naming a shipped command inherits its brakes.** A declaration that re-words a catalog row keeps
that row's confirm — re-describing a session wipe cannot make it one-tap.

## Consequences

- The restating cost is real and recurring: when a shipped catalog gains a row, panes the operator
  addressed do not see it until the operator adds it themselves. Accepted — an addressed pane's
  list is the operator's, updates included.
- "Why not merge?" issues get this document, not a debate. A future mode that merges anyway (an
  `append:` sigil, a `+` prefix) is the same proposal wearing a costume and is covered by the same
  refusal.
- Revisit if the sheet's premise changes — if it grows groups or pages and stops being a handful of
  one-thumb shortcuts — or if harnesses grow a trustworthy, enumerable command registry, which
  would reopen *generation* of rows, not merging of lists.
