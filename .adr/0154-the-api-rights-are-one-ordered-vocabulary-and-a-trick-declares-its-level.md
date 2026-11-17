# 0154: The API's rights are one ordered vocabulary, and a trick declares its level

- **Status:** Accepted (2026-11-17)
- **Date:** 2026-11-17
- **Trail:** M105 spec 04, from Altan's word of 2026-11-17 on a "crew machine CPU load" trick whose
  agent offered to put a pairing token into the trick's settings to read `/api/machines`. The roads
  argued for and turned down: a pairing token in a trick, a per-surface list in the manifest
  (`reads = [...]`), and one right `look` for the whole local tier. Files: `bridge/api/operations.ts`,
  `web/src/lib/tricks/schema.ts` (`ACCESS_LEVELS`), `web/src/lib/tricks/contract.ts`
  (`ACCESS_CONTRACT`), `cli/trick-kit/trick.ts` (`API_LEVELS`, `t.api`), `bridge/tricks/approved.ts`
  (`through`), `bridge/tricks/scan.ts` (warning kind `api`), `docs/tricks-reference.md`

## Context

[ADR 0152](./0152-one-event-bus-and-a-local-read-only-api-that-exists-where-a-trick-runs.md) gave
the local tier one right, `look`, which held every read, the text of a screen included. The first
trick that wanted to read Collie (the load of a crew's machines) showed two gaps. A trick had no
way in but a pairing token, and an agent was ready to paste one into the trick's settings. And one
right could not say on a card whether a trick reads a list of machines or what is on your screens,
which a person weighs very differently.

## Decision

1. **One ordered vocabulary for the whole API: `see` < `read` < `send` < `control`.** Each right
   holds the ones before it.
   - `see`: lists and states (`hello`, `sessions`, `brief`, `accounts`, `hill.list`, `events`,
     `machines`), never the text of a screen or a message.
   - `read`: `see`, and the text of a session's screen (`read`), always masked.
   - `send` and `control`: not built. Each comes with its own record.
2. **It replaces the word `look` in 0152's item 5.** The local tier's grant is `read`, which holds
   `see`. Nothing was released under `look`. The rest of 0152 stands as written. The remote tier,
   when it comes, starts a program key at `see` or `read`.
3. **A trick names its level in `trick.toml` as `access`:** `none` (the default, also when the key
   is absent), `see` or `read`. Any other word refuses the manifest. It is a power under the hash key
   `through`, so a version that raises it asks for a new yes, and the card says the level in one
   plain line. It needs contract 3, the number that also takes `[[field]]`: a shipped contract 2
   build would refuse `access` as an unknown key, and at 3 it says the trick needs a newer Collie.
4. **The level is what the trick declares and what the helper gives it, not a wall.** The program
   runs as the person, and the socket is open to every program of that user while tricks are on.
   The helper's `t.api` refuses an operation above the level before it dials, and the text search
   flags code that names the socket or runs `collie api` itself. No text calls the level a
   permission or says "can only". A real wall is the fence for tricks, a later milestone.
5. **No pairing token in a trick, and nothing in the environment.** The facts (stdin) carry the
   socket's path and the level; the person's yes to the trick is the grant. A token per run comes
   only with `send`, in its own spec.
6. **No per-surface list in a manifest.** A trick names a level, never the operations it calls, so
   a new operation needs no new manifest word and a card stays one line.

## Consequences

- A card can tell a person, in one line, whether a trick reads screens. The price is coarseness: a
  trick that needs one `see` operation is granted all of them.
- Until the fence exists, a dishonest trick can read more than it declares. The card, the scan
  warning and the docs say so; the level guards against mistakes and keeps the declaration honest,
  not against a hostile program of the same user.
- Revisit item 6 only if a named use needs a narrower grant than `see` and the fence can enforce
  it. Revisit item 5 with `send`, which needs a token per run and the reused-pane fix of 0152 item 7.
