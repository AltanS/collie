# 0028 — The standby door is a second listener that arms on silence

- **Status:** Superseded by [ADR 0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md) (2026-11-16)
- **Decided:** The deputy binds a second listener, the standby door, that is never published and exists only when `COLLIE_STANDBY_PORT` is set. It arms on a verified warrant, a silent lead and a non-empty synced pairing list, and the pairing credential alone spends it.
- **Full text:** `git show 38f8422b7:.adr/0028-the-standby-door-is-a-second-listener.md`
