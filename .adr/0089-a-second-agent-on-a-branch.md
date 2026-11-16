# 0089: A second agent on a branch

- **Status:** Superseded by [ADR 0145](./0145-a-start-names-what-to-run-and-a-retry-lands-on-its-receipt.md) (2026-11-16)
- **Decided:** A pane's menu starts a second agent on a new branch, and the create carries a request id and a receipt, so a retry lands on the first worktree. Its points that Herdr runs the create, that the route stays on the lead and that `trust_repository` is never sent were overtaken by ADR 0126 and ADR 0127, and ADR 0145 states the rule today.
- **Full text:** `git show 0741ed872:.adr/0089-a-second-agent-on-a-branch.md`
