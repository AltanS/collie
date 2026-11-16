# 0065 — The Changes view reads git, read-only

- **Status:** Superseded by [ADR 0150](./0150-files-and-changes-read-under-a-root-the-bridge-picks.md) (2026-11-16)
- **Decided:** Changes reads git only, against HEAD, and never writes: the root is the workspace folder, a diff is served only for a repo and a path git listed, and git runs hardened and offline. Its rule 3 (every pane in a workspace shows the same list) was replaced by ADR 0112 and is now ADR 0150 rule 2.
- **Full text:** `git show 21ab922c7:.adr/0065-the-changes-view-reads-git-read-only.md`
