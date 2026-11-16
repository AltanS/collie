# 0115: usage numbers come from the operator's own statusLine

- **Status:** Superseded by [ADR 0149](./0149-usage-figures-are-what-the-agent-states-and-the-account-is-asked-with-its-own-login.md) (2026-11-16)
- **Decided:** Usage figures come from a wrapper around the operator's own statusLine, and Collie declines to read a login. Its amendments moved the context to the beacon hooks and the journals and made the wrap the default, and 0118 reversed its refusal to read a login (see ADR 0149).
- **Full text:** `git show c3ee48dbf:.adr/0115-usage-numbers-come-from-the-operators-own-statusline.md`
