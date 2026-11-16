# 0037 — A staged update confirms its runner before it exits

- **Status:** Superseded by [ADR 0143](./0143-how-an-install-updates-and-what-a-release-offers-it.md) (2026-11-16)
- **Decided:** A staging process confirms that its runner has left its cgroup before it exits, and a launch tier that cannot confirm refuses to start from inside a service. The `systemd-run` client is waited for, up to fifteen seconds.
- **Full text:** `git show 38f8422b7:.adr/0037-a-staged-update-confirms-its-runner-before-it-exits.md`
