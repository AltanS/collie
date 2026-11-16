# 0045 — A build below the protocol floor is a red preflight, never a silent link

- **Status:** Superseded by [ADR 0143](./0143-how-an-install-updates-and-what-a-release-offers-it.md) (2026-11-16)
- **Decided:** A member whose build is below the protocol floor is a red `version` check on the lead's preflight, naming both versions and the remedy. The floor is a named constant tied to the protocol number, and an unreadable version stays amber.
- **Full text:** `git show 38f8422b7:.adr/0045-a-build-below-the-protocol-floor-is-a-red-preflight.md`
