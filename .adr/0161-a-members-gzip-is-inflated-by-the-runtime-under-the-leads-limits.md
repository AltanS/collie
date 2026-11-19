# 0161: A member's gzip is inflated by the runtime, under the lead's limits

- **Status:** Accepted
- **Date:** 2026-11-19
- **Supersedes in part:** [ADR 0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md), rule 10's
  second sentence ("The lead asks a member for identity bytes").
- **Trail:** the project picture's review (issue 811), rounds 3 to 11, 2026-11-19. Round 3 asked every
  member for identity, because Bun's `fetch` inflates any encoded body. Round 4 measured the cost (a
  30-pane snapshot is 19,275 bytes plain against 1,872 gzipped, about 66 MB an hour per member at one
  poll a second, against 6.4). Rounds 6 to 10 had the lead inflate gzip itself with a capped decoder.
  Round 11 measured the runtime and found that it inflates as a stream, so the decoder went. Files:
  `bridge/crew/guarded-body.ts`, `bridge/crew/peer-client.ts`, `CREW_PROTOCOL.md` §9.1

## Context

ADR 0144 rule 10 keeps compression per hop, and its first record, 0023, named the way to compress the
member hop: "a second, independently negotiated hop compression, still decompressed and re-decided at the
lead. Never a pass-through." Identity on every dial costs ten times the sweep's bytes, which a member on a
hotspot or behind a relay pays. The fear that kept it was a small gzip that grows to gigabytes on the lead.

Every crew machine is the operator's own, behind pinned mutual TLS (CREW_PROTOCOL.md §8.5). The lead's
limits are for a member that is slow, stuck or broken, not for one that attacks.

## Decision

- **Every dial asks a member for `accept-encoding: gzip`, and the runtime inflates it.** Measured on Bun
  1.4.4: a read cut at 2 MB peaks at about 100 MB whether the answer inflates to 32 MB or to 1 GB, so the
  runtime inflates as a stream and the lead never holds the whole.
- **The lead's size limit counts the inflated bytes**, in one place for every encoding: 2 MB for a body
  the lead parses itself, 32 MB for every other answer.
- **The lead's headers to the phone describe the lead's bytes.** The runtime leaves the member's
  `content-encoding` and `content-length` on the inflated body; the lead copies neither. The lead still
  compresses the phone hop itself.

## Consequences

- The sweep is gzipped between machines again.
- An answer that inflates past its limit is cut at the limit; the lead's cost is the limit plus the
  runtime's stream buffers, about 100 MB at the peak.
- One number for every answer but the lead's own JSON is a known cost: a 32 MB answer the lead masks
  (History, Chat, Changes, Files) peaks at about 390 MB above the lead's base while the mask parses it
  (measured, review round 10). No member sends a Changes or Files answer near that size today.
- No version bump: every released member gzips on request (`bridge/http-cache.ts`, since 0.10.0).
