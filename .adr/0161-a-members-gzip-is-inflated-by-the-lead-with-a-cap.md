# 0161: A member's gzip is inflated by the lead, with a cap

- **Status:** Accepted
- **Date:** 2026-11-19
- **Supersedes in part:** [ADR 0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md), rule 10's
  second sentence ("The lead asks a member for identity bytes").
- **Trail:** the project picture's review (issue 811), rounds 3 to 7, 2026-11-19. Round 3 found that
  Bun's `fetch` inflates any encoded body with no bound, so a member could hand the lead a small gzip
  that grows to gigabytes. Round 3 then asked every member for identity; round 4 measured the cost (a
  30-pane snapshot is 19,275 bytes plain against 1,872 gzipped, about 66 MB an hour per member at one
  poll a second, against 6.4), and the lead's call of round 5 kept the sweep compressed. Round 7's
  independent review measured that a 32 MB default let a 146 KB body cost the lead about 1 GB in
  `JSON.parse`, so the caps became per kind of answer. Files: `bridge/crew/bounded-gunzip.ts`,
  `bridge/crew/guarded-body.ts`, `bridge/crew/peer-client.ts`, `bridge/crew/forward.ts`,
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
  the decoder stops and the member's stream is cancelled.
- **Every dial names its cap; none has a default.** The cap follows what the lead does with the
  answer, because `JSON.parse` turns a body of tiny values into about 30 times its size. A body the lead
  parses itself takes 2 MB (an honest 300-pane snapshot is about 190 KB). A forwarded answer takes its
  route's cap (`bodyCapOf`): 256 KB for a project picture, 8 MB for Changes and Files, 32 MB for log
  answers (History, Chat, Sent, pins), 32 MB for raw bytes (blobs and pictures, which a member never
  gzips), 2 MB for the rest. A text answer the lead masks is also refused past a million JSON values.
- **Past the cap, the end depends on where the body goes.** A body the lead reads ends as an unreachable
  member. A body already streaming to the phone, which has its status and headers, breaks off with an
  error, never as a short body that looks whole, and the lead's log says it was cut.
- **Any other encoding is refused before its body is read**, with a reason that quotes no byte of the
  member's.
- **The lead's headers describe the lead's bytes.** The inflated answer carries no `content-encoding`
  and no `content-length`; the ETag stays, because it names the identity bytes (rule 10's third
  sentence, unchanged). The lead still compresses the phone hop itself.

## Consequences

- The sweep is gzipped between machines again, and a member cannot make the lead inflate without a
  bound.
- The lead spends one gunzip per gzipped member answer.
- At the JSON cap a hostile member costs the lead at most about 62 MB while its answer is parsed, and
  four at once about 230 MB (measured). An honest answer over its route's cap is refused; no member
  route sends one today.
- No version bump: every released member gzips on request (`bridge/http-cache.ts`, since 0.10.0).
