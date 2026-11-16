# 0110: two release lines, Stable and Edge, and the state-shape rule

- **Status:** Superseded by [ADR 0143](./0143-how-an-install-updates-and-what-a-release-offers-it.md) (2026-11-16)
- **Decided:** Each machine is on one release line, Stable or Edge, read by one resolver; switching installs nothing, and a lower version is reached only by a rollback or a person's switch back to Stable. State files only grow, so the last Stable can read what a newer build wrote.
- **Full text:** `git show 38f8422b7:.adr/0110-two-release-lines.md`
