# 0093: A branch's folder is named by its parent, and checked on every use

- **Status:** Superseded by [ADR 0145](./0145-a-start-names-what-to-run-and-a-retry-lands-on-its-receipt.md) (2026-11-16)
- **Decided:** A branch's folder is a parent that the bridge checks on every use, and the child is named after the branch; the note of 2026-11-13 added one "Worktree folder" setting per machine. Since ADR 0126 the bridge, not Herdr, puts the checkout there, and its point 9 (lead-local) no longer holds; ADR 0145 states the rule today.
- **Full text:** `git show 0741ed872:.adr/0093-a-branch-folder-is-named-by-its-parent.md`
