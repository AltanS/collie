# 0083 — The Files view reads the Changes root

- **Status:** Superseded by [ADR 0150](./0150-files-and-changes-read-under-a-root-the-bridge-picks.md) (2026-11-16)
- **Decided:** Files lists one folder or reads one text file relative to the Changes root, checked on real paths with a deny list and one refusal. Its reads were open until ADR 0086; they now need the pairing token, and the race its first text accepted is closed on the opened file.
- **Full text:** `git show 21ab922c7:.adr/0083-the-files-view-reads-the-changes-root.md`
