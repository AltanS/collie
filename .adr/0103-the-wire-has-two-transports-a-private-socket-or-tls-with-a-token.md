# 0103: the wire has two transports: a private socket, or TLS with a token

- **Status:** Superseded by [ADR 0146](./0146-a-durable-agent-is-a-session-with-no-screen-that-acts-by-id.md) (2026-11-16)
- **Decided:** The wire has two transports and a peer uses exactly one: a private Unix socket of the same user, or HTTPS to a URL the person deployed with a bearer token as the only gate. The cadence follows the cost of a billed poll, the wire version stays 1, and ADR 0146 states the rule today.
- **Full text:** `git show 0741ed872:.adr/0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md`
