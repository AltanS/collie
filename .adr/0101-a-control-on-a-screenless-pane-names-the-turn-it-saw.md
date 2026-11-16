# 0101: a control on a screenless pane names the turn it saw

- **Status:** Superseded by [ADR 0146](./0146-a-durable-agent-is-a-session-with-no-screen-that-acts-by-id.md) (2026-11-16)
- **Decided:** A send or an abort on a screenless pane names the turn or the ask the phone saw, plus a request id, and the bridge refuses a stale name with 409 before anything reaches the program. Raw keys do not exist there; ADR 0146 states the rule today, and a plain send on the agent's own machine now runs through the Send Protocol's structured driver.
- **Full text:** `git show 0741ed872:.adr/0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md`
