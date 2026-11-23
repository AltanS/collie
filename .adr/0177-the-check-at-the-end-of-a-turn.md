# 0177 — At the end of a turn the agent sees its open asks once, and the bridge decides when

- **Status:** Superseded by [ADR 0178](./0178-the-reminder-of-open-asks-rides-on-the-prompt.md) (2026-11-23)
- **Decided:** A second entry in Collie's own Claude Code `Stop` group (`collie beacon check`) held the turn open to show the agent its open asks once, the bridge decided when (once per turn, a brake of 2, 4, 8 turns), `collie walky keep` confirmed an ask, and the pane read as working during the check.
- **Trail:** The Asks lab of 2026-11-22 and the Asks sync review of 2026-11-23, which moved the reminder to the prompt.
- **Full text:** `git show 863988854:.adr/0177-the-check-at-the-end-of-a-turn.md`
