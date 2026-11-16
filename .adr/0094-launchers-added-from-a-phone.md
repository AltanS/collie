# 0094: Launchers added from a phone live on the machine, under the operator's switches

- **Status:** Superseded by [ADR 0145](./0145-a-start-names-what-to-run-and-a-retry-lands-on-its-receipt.md) (2026-11-16)
- **Decided:** A phone's added launcher rows live in a state file the bridge owns, merged into the allowlist at read time under the operator's `[phone]` switches, and the bridge never writes `launchers.toml`. Its points that rows stay on one machine and that each machine has its own list were replaced by ADR 0127, and ADR 0145 states the rule today.
- **Full text:** `git show 0741ed872:.adr/0094-launchers-added-from-a-phone.md`
