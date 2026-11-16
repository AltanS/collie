# 0114: a host with no process keeps its state in the log

- **Status:** Superseded by [ADR 0146](./0146-a-durable-agent-is-a-session-with-no-screen-that-acts-by-id.md) (2026-11-16)
- **Decided:** A host with no process keeps every fact the phone can see in its log before it answers, and rebuilds the wire from the log on every request. Its epoch belongs to the log and the schema, asks, answers and receipts live in one journal per run, and a stop takes the session over; its point that `steer` is false became an opt-in by the agent's caps, and ADR 0146 states the rule today.
- **Full text:** `git show 0741ed872:.adr/0114-a-host-with-no-process-keeps-its-state-in-the-log.md`
