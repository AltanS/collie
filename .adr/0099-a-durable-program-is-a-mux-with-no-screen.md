# 0099: a durable program is a mux with no screen

- **Status:** Superseded by [ADR 0146](./0146-a-durable-agent-is-a-session-with-no-screen-that-acts-by-id.md) (2026-11-16)
- **Decided:** A durable program is a mux adapter with no screen behind the mux port, it declares what it lacks, Chat is its only view, and the crew is unchanged. Its points on a socket with no token, an example SDK and one peer per mux were replaced by ADR 0103, 0105 and 0104, and ADR 0146 states the rule today.
- **Full text:** `git show 0741ed872:.adr/0099-a-durable-program-is-a-mux-with-no-screen.md`
