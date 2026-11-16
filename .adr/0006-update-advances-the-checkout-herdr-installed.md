# 0006 — `update` advances the checkout Herdr installed, and never re-links it

- **Status:** Superseded by [ADR 0143](./0143-how-an-install-updates-and-what-a-release-offers-it.md) (2026-11-16)
- **Decided:** A Herdr-managed checkout advances in place by fetching a release tag and re-detaching onto it, and `update` never re-links it, because a reinstall is its way back. The amendment of 2026-09-03 moved a linked clone to a staged `versions/` layout and left the managed shape alone.
- **Full text:** `git show 38f8422b7:.adr/0006-update-advances-the-checkout-herdr-installed.md`
