# 0168: A trick that is off is removed on its machine, through one function

- **Status:** Accepted (2026-11-21), security read by the lead, 2026-11-21
- **Date:** 2026-11-21
- **Trail:** The desktop pass of 2026-11-21 asked for a Remove section on a trick's details page.
  Before it, only `collie trick remove <id>` removed a trick, from a shell on the machine. Files:
  `bridge/tricks/remove.ts`, `bridge/tricks/aside.ts`, `bridge/tricks/remove-receipts.ts`, `bridge/tricks/service.ts`
  (`remove`, `busy`, the run marks in `begin`), `bridge/tricks/routes.ts`, `bridge/server.ts`,
  `cli/trick-add.ts`, `web/src/components/trick-remove-section.tsx`, `web/src/routes/settings-trick.tsx`.
  The lead's security read changed four points: the sweep's names (5), the confirm as a modal (Consequences),
  a broken trick (2) and one request id per confirm (7). Counsel before the release (four advisors) changed
  five more: one commit point (5), an unreadable switch file (3), the other writers (11), the command while a
  bridge runs (1) and the request id per ask (7).

## Context

A trick is a folder of code that runs as the user. Removing it deletes files, so a phone that can
remove one is a phone that can delete in the config folder. The command did it in a few lines:
check the switch, then delete the folder, the state folder and the approved and pending copies. It
read no link check, and nothing stopped a run that was still going after the switch went off: an
off kills a run's tokens, not its program, and a run may last 10 seconds. A route from the phone
needed the same work with the guards of a write, and the two must not drift.

## Decision

**One function, `removeTrick` in `bridge/tricks/remove.ts`, removes a trick for the command and for
the route `POST /api/tricks/<host>/<id>/remove`. It removes only a trick that is off, that no run of
holds, and whose four folders are real folders in their own places.**

1. **One function.** `cmdTrickRemove` and the route call `removeTrick`. They differ in two inputs:
   how a run going is seen (`busy`) and what is forgotten beside the files (`forget`). The command first asks
   its own bridge (`GET /api/tricks`, the read-only local key): when any answer comes, the bridge holds the
   trick's stores in memory, and the command has no write credential to ask it to remove, so it refuses with
   one line (remove it in the app, or `collie stop` first). With no answer it works on the files.
2. **The id is a name.** It must pass `isTrickId` (no dot, no slash). The folder, the state folder,
   `.collie-approved/<id>` and `.collie-pending/<id>` must each be a real folder whose real path is the
   real path of its base joined with the id. A link, a file or a path elsewhere refuses the whole
   remove, and nothing is deleted. A tricks root that is itself a link is followed, as every reader does.
   The route also refuses an id the service does not hold after a fresh scan (404, nothing touched). A
   broken trick is held: a folder the scan refuses (a `trick.toml` that is not TOML, a refused right) is
   still found, with its refusals, so it is listed as skipped, has its details page and can be removed.
   A trick folder that is gone while its other places are there (an older crash, a person's `rm -rf`)
   is removed too: the leftovers go and the answer is `removed`. Ids are lower case and at most 32
   characters (`TRICK_ID`), so `.gone-<id>-<12 hex>` stays far under NAME_MAX; a folder that differs from
   an id only by case is no trick id and is never a target.
3. **Off, and no run going.** Inside the switch file's lock (`withSwitchLock`; `takeLock` throws after
   `SWITCH_LOCK_WAIT_MS` and never goes on without it) the function reads the switch file. A file that is
   there and does not read as switches (empty, not JSON, a folder) refuses with `RemoveUnreadable`
   ("nothing was removed"), never reads as off and is never rewritten; a missing file is fine. Then it
   checks the places again, that the trick is not on, then `busy(id)`. The bridge's `busy` is a run going, a
   run queued or a Hill answer waiting for that trick. `begin` sets `running` before its first await. An off
   withdraws the trick's open Decisions, refuses new taps, and a queued answer meets the off switch and
   ends, so no decision keeps an off trick busy for more than a run. The command reads run marks: each run writes
   `<stateDir>/tricks/.runs/<id>` (pid and start time) before it reads the switch file again, and
   deletes it when it ends; a mark counts while its pid lives and for at most 5 minutes. A refusal
   says "A run of this trick is still going. Try again in a few seconds."
4. **No run starts during a remove.** Every run, from a timer, a tap, a reaction, a start or a Hill
   answer, goes through `begin`, which reads the switch file before it starts the program. A run that
   begins after the check sees the trick off and starts nothing.
5. **One commit point; only a committed aside is deleted** (`bridge/tricks/aside.ts`). In the lock the
   places there are renamed aside to `.gone-<id>-<token>`, one token for the batch, the trick folder LAST,
   so until the commit the trick is still listed. Then the batch is committed: one file,
   `<stateDir>/tricks/.aside-commits/<id>-<token>`, written exclusively and synced. Before the commit any
   failure puts every path back, newest first; a put-back that fails names both paths in the error and the
   log. After the commit the answer is `removed`: `forget` and each delete run on their own, a failure is
   logged and returned as a leftover. At the bridge's start `sweepGone`, under the same lock, deletes a
   committed aside, and renames an uncommitted one (a crash between the renames, a failed put-back) back
   when its name is free, else leaves and logs it. So a crash before the commit leaves the trick as it was
   after the next start. It reads only names of exactly that shape (`isGoneName`), so a person's own
   `.gone-` folder stays. `forgetLeftovers` before an add uses the same commit.
6. **What goes.** The four places, the trick's agent views and its Hill keys (the route hands the
   bridge's live stores, the command a disk-only forget), then at the next scan its row, its parts, its
   open Decisions and its run tokens. An official trick shows again as one to add. Nothing else. A crash
   between the commit and `forget` is closed at the scan: after every good scan the bridge drops the views
   and Hill keys of each id with no folder and no approved switch entry (`pruneTrickStores`), and writes
   nothing when there is none, so a later add of the id inherits nothing.
7. **A write, once.** The route takes the write right (`TRICKS_ROUTE_RIGHTS.remove`), POST only, and a
   body of `{ rid }` alone. The host's local credential is read-only, so `collie` on the machine cannot
   call it. A request id keys one receipt in `<stateDir>/tricks/remove-receipts.json` (the trick id,
   the device label, the outcome, no content), written before anything moves. A replay answers the
   first answer and removes nothing, also after a restart; a marker a crash left answers `unknown`. Each
   receipt has a `v`; a record of a later `v` or an outcome this build does not know is kept and answers
   `unknown`, never acts. The newest 200 receipts are kept, so an old `rid` never touches a later trick of
   the same id while its receipt is among them. The app mints the id when the confirm opens and sends it
   with every tap of that ask. A definite answer ends it (a refusal is stored, so the next ask gets a new
   id); a lost answer (no answer, or a 5xx) keeps it, so the next confirm replays what the bridge did.
8. **One audit line.** `trick.remove` with the device label and the trick id, at the time of the line.
9. **This machine only.** A request for a crew member is refused (400). A crew member's tricks are
   removed on the member, from its own Collie or its own shell. The app offers Remove only on the
   details page, for the tricks the list carries, which are this bridge's own.
10. **A trick cannot call it.** A trick's program gets no pairing token and no `COLLIE_*` or `HERDR_*`
    name (`bridge/tricks/env.ts`), and its run token reaches only the local API socket, which has no
    remove. The route gives a trick's program nothing it could not already do as the user.
11. **The other writers check the folder in the lock.** Every write that switches a trick on (the phone's
    yes, a promote, an agent's written trick, a crew carry) writes its entry with `updateSwitchesFor`, which
    writes nothing when the trick folder is not a folder inside the lock; the answer is "The trick's folder
    is gone, so it was not switched on." Adds rename a fresh folder in only where none is, and a crew carry
    does it inside the lock. A new version's files (`replaceCode`) make their subfolders one level at a time
    below the trick folder and never the folder itself, so a removed folder is never made again.

## Consequences

- The command now refuses a link, and refuses while a run of the trick goes. It did neither before.
- The route refuses while tricks are off on the machine and on Windows, as its sibling routes do. The
  command does not: it works on the files.
- The details page's Remove section and its confirm are in the screen list (`settings-trick-remove`,
  `settings-trick-remove-confirm`). The confirm blocks until it is answered, so it is a `Modal` over a
  scrim (0167), not a sheet; its focus starts on Cancel, and Escape and the scrim close it except while
  the write flies.
- Settings draws no status line, so it carries `StatusLive`, a live region a person does not see: a
  screen reader hears "Removed <name>." The trick leaving the list is the visible sign.
