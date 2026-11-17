# 0044 — The update screen is one reducer and one shared poll

- **Status:** Superseded by [ADR 0143](./0143-how-an-install-updates-and-what-a-release-offers-it.md) (2026-11-16)
- **Decided:** One pure reducer, `update-screen.ts`, decides the update screen, and one shared store owns the poll of the front door and the standby door. Progress is counted in files, and every threshold is a named constant with its reason.
- **Full text:** `git show 38f8422b7:.adr/0044-the-update-screen-is-one-reducer-and-one-shared-poll.md`
