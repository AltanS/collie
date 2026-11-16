# 0020 — A major upgrade is consented by flag; routine update follows tags within the installed major

- **Status:** Superseded by [ADR 0143](./0143-how-an-install-updates-and-what-a-release-offers-it.md) (2026-11-16)
- **Decided:** Routine `update` stays inside the installed major, and crossing one needs the flag `--major`, never a prompt, because a Herdr action has no TTY. It also rejected a channel or pin file; ADR 0110 replaced that with `update-line.json`, and ADR 0143 states it today.
- **Full text:** `git show 38f8422b7:.adr/0020-a-major-upgrade-is-consented-by-flag.md`
