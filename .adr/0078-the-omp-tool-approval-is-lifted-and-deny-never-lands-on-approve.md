# 0078: The omp tool approval is lifted, and Deny never lands on Approve

- **Status:** Superseded by [ADR 0151](./0151-a-dialog-becomes-a-card-by-its-own-words-and-a-tap-sends-what-the-screen-printed.md) (2026-11-16)
- **Decided:** omp's `bash` and `write` tool approval is lifted so that a race never turns a Deny into an approval, and the card declines rather than cut any row of the subject. Its fixed Deny plan was replaced by walk, read back, then confirm with edge keys (ADR 0080).
- **Full text:** `git show 21ab922c7:.adr/0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md`
