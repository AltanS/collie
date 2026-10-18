# 0111: the walky talky skill follows the update

- **Status:** Accepted
- **Date:** 2026-10-18
- **Trail:** `cli/skill-install.ts` (`syncSkills`, `cmdSkillSync`, the uninstall marker) · `cli/update.ts` (`syncSkill`, called on the detached runner's done branch, the in-place path and both terminal rollbacks) · `bridge/config-schema.ts` (`COLLIE_SKILL_SYNC`) · docs/walky-talky.md, "Install the skill" · replaces the first M62 rule "nothing writes without the verb", where `collie update` only printed a note

## Context

M62 shipped the walky talky skill with one rule: only `collie skill install` writes it, and `collie update` prints a note when an installed copy is behind. On the operator's own machine every harness still read `absent` after the update that carried the skill. A note asks a person to act at the end of an update they are not watching, and an update started from the phone prints it into a log nobody reads. The agents stayed unaware of walky talky, which is the one thing the skill is for. Altan decided on 2026-10-18 that the update keeps every harness on the machine in sync with the skill the build needs.

## Decision

**After every successful swap, the new binary runs `collie skill sync`.** That is the detached runner's done branch (update, rollback, switch and a crew member's follow), the in-place checkout path, and both terminal rollbacks. It runs through the stable name with a 30 s bound, for the reason the hooks nudge does: the process that drives the update is the old build, and its embedded text is the one that may have moved on.

**The sync installs where the harness is, and nowhere else.** Per target: `installed` stays, `stale` is rewritten in place, `absent` is installed when the harness's config folder exists on this machine (the rule `skill install all` already used; for Claude Code, each profile folder that exists), and skipped otherwise. A `refused` target is reported and never written. The guards of `skill install` hold: one backup, temp file and rename, a symlinked file refused, only our own file or block replaced.

**An uninstall is a standing no.** `collie skill uninstall` records each target it leaves without the skill in `<stateDir>/skill/uninstalled.json`. The sync skips those targets; `collie skill install` takes them off the list again.

**The sync never fails the update.** A spawn that fails, a timeout or a non-zero exit prints one note naming `collie skill sync`. A build that does not know the verb (a rollback to a version before 1.23.0) says nothing.

**`COLLIE_SKILL_SYNC=off` keeps the old behaviour**: `skill status --check` and one note. The bridge still never writes a harness file, and no bridge start touches one.

## Consequences

- An operator who never typed `collie skill install` gets the skill in every harness on the machine at the next update. That is the point; the opt-out is the switch and the uninstall marker.
- A fresh install gets the skill at its first update, or when the operator runs `collie skill sync`. `scripts/install.sh` promises to write nothing outside its own folder and `~/.local/bin`, and `collie start` runs at every start, so neither is a single fresh-install point to hook.
- The uninstall marker lives in one instance's state directory. Two instances on one machine with different binaries each render the skill with their own path, so whichever updates last owns the text, and an uninstall through one instance does not reach the other's marker. Revisit if a machine with two self-updating instances becomes ordinary.
