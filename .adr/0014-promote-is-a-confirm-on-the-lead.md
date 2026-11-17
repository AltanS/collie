# 0014 — Promotion is a confirm on the receiver, not a command from the claimant

- **Status:** Superseded by [ADR 0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md) (2026-11-16)
- **Decided:** Promotion is a confirm on the machine being taken from: `collie crew approve-promote` on the old lead mints a ten-minute, single-use approval bound to the member and its pinned key, and only then does `collie promote` demote the lead. `promote --force` is for a lead that is gone, and every member then re-joins.
- **Full text:** `git show 38f8422b7:.adr/0014-promote-is-a-confirm-on-the-lead.md`
