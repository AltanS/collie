# 0023 — Compression is hop-local on the pack link, and the ETag names the identity bytes

- **Status:** Superseded by [ADR 0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md) (2026-11-16)
- **Decided:** Each hop of a forwarded request negotiates its own compression: the lead asks a member for identity bytes and compresses the phone hop itself as a stream. The ETag names the identity bytes.
- **Full text:** `git show 38f8422b7:.adr/0023-compression-is-hop-local-on-the-pack-link.md`
