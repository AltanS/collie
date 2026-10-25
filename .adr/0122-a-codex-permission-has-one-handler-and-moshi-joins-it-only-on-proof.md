# 0122: a Codex permission has one handler, and Moshi joins it only on proof

- **Status:** Proposed (unreleased: native Codex hooks)
- **Date:** 2026-10-25
- **Trail:** `cli/codex-hook.ts` · `cli/codex-broker.ts` · `cli/codex-moshi.ts` · `cli/codex-native.ts` ·
  `cli/codex-attribution.ts` · openai/codex `rust-v0.164.0` `codex-rs/hooks/src/events/permission_request.rs`

## Context

Codex 0.164.0 runs every matching `PermissionRequest` hook at once, waits for all of them, and lets
any deny win. Moshi already answers a Codex permission from a phone through such a hook. The obvious
way to add Collie's phone view is a second entry beside Moshi's.

Root's spike on moshi-hook 0.4.37 (issue #595) found that entry is not a decision provider. It posts
one `session.update` to the Moshi daemon, gets an ack and exits 0 with empty stdout in under a second.
The card lives in the daemon, which later types `y` into the terminal. Nothing documented withdraws a
card by action id. When Collie decides first, so that Codex never draws its own prompt, the card stays
about twelve seconds, and a late tap on a stale card was seen to approve an unrelated prompt.

Whether a provider can take its remote request back is a fact about that provider, and nothing in its
binary shows it. A clean exit after a signal means the process stopped, not that the prompt left the phone.

## Decision

1. There is one `PermissionRequest` handler: Collie's. A Moshi entry on that event makes the hold install
   refuse, and nothing starts Moshi as a decision provider.
2. The broker (`--with-moshi`) is the generic contract for a provider that does decide and does withdraw. It
   would replace the exact provider entry in its slot (saved as it was, so uninstall puts it back) and
   start the original command with the unchanged payload beside the Collie hold. The first valid allow or
   deny wins once. The loser is cancelled and waited for (bounded), because Codex kills the hook's process
   group when the hook ends. A late answer is dropped. Anything that is not a clean allow or deny is no
   decision, and no decision prints `{}`. The broker builds its output itself and never forwards
   `updatedInput`, `updatedPermissions` or `interrupt`.
3. The broker is enabled only by a recorded runtime proof of withdrawal for the installed provider, made by
   someone who watched the phone. The record names the executable's path and sha256, so an update voids it,
   and moshi-hook 0.4.37 is refused by digest whatever a record says. No proof, or a void one, means the
   install writes nothing and an installed broker runs the provider alone.
4. A hook is placed on a pane only through its verified `codex` parent process (start times checked
   against pid reuse). Never by "the Codex in the same folder", and never for the shared app-server
   daemon, whose environment names whichever pane started it.

## Consequences

- No Moshi version works with a Collie hold today. Revisit when Moshi documents a withdraw-by-action-id and
  binds an answer to its own prompt (the two things the spike asked for), and re-prove after every update.
- A Codex whose hooks run from the app-server daemon gets no edges and no hold until Codex says which
  client a session belongs to. The screen read still covers those panes.
- Revisit 4 when Codex passes a client or
  pane identity in the hook payload (openai/codex#48064).
