# 0095: One-off commands and their history

- **Status:** Superseded by [ADR 0145](./0145-a-start-names-what-to-run-and-a-retry-lands-on-its-receipt.md) (2026-11-16)
- **Decided:** `POST /api/launch` takes a one-off line, `run`, which is on by default and never starts on a new branch. A run that worked joins a per-machine history of twelve lines unless it looks like a secret, and a check route reports the no-prompts flag before the first run; ADR 0145 states the rule today.
- **Full text:** `git show 0741ed872:.adr/0095-one-off-commands-and-their-history.md`
