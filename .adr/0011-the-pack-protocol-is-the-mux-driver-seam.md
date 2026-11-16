# 0011 — The pack protocol is the mux-driver seam, and peers are full collies

- **Status:** Superseded by [ADR 0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md) (2026-11-16)
- **Decided:** The lead consumes a member's Collie HTTP API under `/crew/v1/*` and never its multiplexer socket, so no multiplexer method name crosses the link and a member that fronts another multiplexer is invisible to the protocol. `COLLIE_HERDR_DIAL` never takes a host.
- **Full text:** `git show 38f8422b7:.adr/0011-the-pack-protocol-is-the-mux-driver-seam.md`
