# 0161: A member's gzip is inflated by the lead, with a cap

- **Status:** Accepted
- **Date:** 2026-11-19
- **Supersedes in part:** [ADR 0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md), rule 10's
  second sentence ("The lead asks a member for identity bytes").
- **Trail:** the project picture's review (issue 811), rounds 3 to 5, 2026-11-19. Round 3 found that
  Bun's `fetch` inflates any encoded body with no bound, so a member could hand the lead a small gzip
  that grows to gigabytes. Round 3 then asked every member for identity; round 4 measured the cost (a
  30-pane snapshot is 19,275 bytes plain against 1,872 gzipped, about 66 MB an hour per member at one
  poll a second, against 6.4), and the lead's call of round 5 kept the sweep compressed. Files:
  `bridge/crew/bounded-gunzip.ts`, `bridge/crew/peer-client.ts`, `bridge/crew/forward.ts`,
  `CREW_PROTOCOL.md` §9.1

## Context

ADR 0144 rule 10 keeps compression per hop: the lead holds bytes it can describe, and it compresses the
phone hop itself. Its first record, 0023, named the way to compress the member hop when that hop is
worth it: "a second, independently negotiated hop compression, still decompressed and re-decided at the
lead. Never a pass-through." Identity on every dial closes the bomb and costs ten times the sweep's
bytes, which a member on a hotspot or behind a relay pays. Letting the runtime inflate keeps the bytes
low and leaves the bomb open.

## Decision

- **Every dial asks a member for `accept-encoding: gzip`, and only gzip, with the runtime's own
  decompression off** (`decompress: false`).
- **No header, or `identity`, is read as it is. Exactly `gzip` is inflated by the lead** through a
  streaming decoder that counts its output and its input. The moment either passes the caller's cap,
  the decoder stops, the member's stream is cancelled, and the answer is refused. The cap is 32 MB for
  every read that names none (twice the largest single honest object, a 16 MB blob), and 256 KB for a
  project picture.
- **Any other encoding is refused before its body is read**, with a reason that quotes no byte of the
  member's.
- **The lead's headers describe the lead's bytes.** The inflated answer carries no `content-encoding`
  and no `content-length`; the ETag stays, because it names the identity bytes (rule 10's third
  sentence, unchanged). The lead still compresses the phone hop itself.

## Consequences

- The sweep is gzipped between machines again, and a member cannot make the lead inflate without a
  bound.
- The lead spends one gunzip per gzipped member answer.
- An honest gzip body over 32 MB inflated is refused. No member route sends one today.
- No version bump: every released member gzips on request (`bridge/http-cache.ts`, since 0.10.0).
