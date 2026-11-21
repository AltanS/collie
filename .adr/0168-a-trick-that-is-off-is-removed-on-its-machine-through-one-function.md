# 0168: A trick that is off is removed on its machine, through one function

- **Status:** Proposed (2026-11-21)
- **Date:** 2026-11-21
- **Trail:** The desktop pass of 2026-11-21 asked for a Remove section on a trick's details page.
  Before it, only `collie trick remove <id>` removed a trick, from a shell on the machine. Files:
  `bridge/tricks/remove.ts`, `bridge/tricks/remove-receipts.ts`, `bridge/tricks/service.ts`
  (`remove`, `busy`, the run marks in `begin`), `bridge/tricks/routes.ts`, `bridge/server.ts`,
  `cli/trick-add.ts`, `web/src/components/trick-remove-section.tsx`, `web/src/routes/settings-trick.tsx`

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
   how a run going is seen (`busy`) and what is forgotten beside the files (`forget`).
2. **The id is a name.** It must pass `isTrickId` (no dot, no slash). The folder, the state folder,
   `.collie-approved/<id>` and `.collie-pending/<id>` must each be a real folder whose real path is the
   real path of its base joined with the id. A link, a file or a path elsewhere refuses the whole
   remove, and nothing is deleted. A tricks root that is itself a link is followed, as every reader does.
   The route also refuses an id the service does not hold after a fresh scan (404, nothing touched).
3. **Off, and no run going.** Inside the switch file's lock (`updateSwitches`) the function checks the
   places again, then that the trick is not on, then `busy(id)`. The bridge's `busy` is a run going, a
   run queued or a Hill answer waiting for that trick. The command reads run marks: each run writes
   `<stateDir>/tricks/.runs/<id>` (pid and start time) before it reads the switch file again, and
   deletes it when it ends; a mark counts while its pid lives and for at most 5 minutes. A refusal
   says "A run of this trick is still going. Try again in a few seconds."
4. **No run starts during a remove.** Every run, from a timer, a tap, a reaction, a start or a Hill
   answer, goes through `begin`, which reads the switch file before it starts the program. A run that
   begins after the check sees the trick off and starts nothing.
5. **Rename in the lock, delete after.** In the lock the four places are renamed aside to dotted
   `.gone-<id>-<random>` names, as `forgetLeftovers` does; a failed rename puts back what moved. The
   deletes run after the unlock. A crash in between leaves only dotted names: no scan, no add and no
   approval reads them, and `sweepGone` at the bridge's start deletes them, now also in the tricks
   folder itself. A later add of the same id finds no folder and starts clean.
6. **What goes.** The four places, the trick's agent views and its Hill keys (the route hands the
   bridge's live stores, the command a disk-only forget), then at the next scan its row, its parts, its
   open Decisions and its run tokens. An official trick shows again as one to add. Nothing else.
7. **A write, once.** The route takes the write right (`TRICKS_ROUTE_RIGHTS.remove`), POST only, and a
   body of `{ rid }` alone. The host's local credential is read-only, so `collie` on the machine cannot
   call it. A request id keys one receipt in `<stateDir>/tricks/remove-receipts.json` (the trick id,
   the device label, the outcome, no content), written before anything moves. A replay answers the
   first answer and removes nothing, also after a restart; a marker a crash left answers `unknown`. An
   old `rid` never touches a later trick of the same id. The newest 200 receipts are kept.
8. **One audit line.** `trick.remove` with the device label and the trick id, at the time of the line.
9. **This machine only.** A request for a crew member is refused (400). A crew member's tricks are
   removed on the member, from its own Collie or its own shell. The app offers Remove only on the
   details page, for the tricks the list carries, which are this bridge's own.
10. **A trick cannot call it.** A trick's program gets no pairing token and no `COLLIE_*` or `HERDR_*`
    name (`bridge/tricks/env.ts`), and its run token reaches only the local API socket, which has no
    remove. The route gives a trick's program nothing it could not already do as the user.

## Consequences

- The command now refuses a link, and refuses while a run of the trick goes. It did neither before.
- The route refuses while tricks are off on the machine and on Windows, as its sibling routes do. The
  command does not: it works on the files.
- `sweepGone` also clears `.gone-*` names in the tricks folder. A person's own folder whose name
  starts with `.gone-` there would go too.
- The details page's Remove section and its confirm are in the screen list (`settings-trick-remove`,
  `settings-trick-remove-confirm`). The confirm is a `BottomSheet`, which a wide window draws centred
  (0167, addendum); its focus starts on Cancel through the sheet's new `initialFocus`.
