# 0032 — A worktree is opened by the multiplexer, not by Git

- **Status:** Superseded by [ADR 0126](./0126-collie-makes-a-worktree-with-git-and-opens-it-as-a-space.md) (2026-11-02)
- **Decided:** A worktree verb asks the multiplexer, never Git, through three declared capabilities: `listWorktrees`, `createWorktree` and `openWorktree`. Since 2026-11-02 Collie makes a worktree with `git worktree add` and opens it as a space.
- **Full text:** `git show 38f8422b7:.adr/0032-a-worktree-is-opened-by-the-multiplexer-not-by-git.md`
