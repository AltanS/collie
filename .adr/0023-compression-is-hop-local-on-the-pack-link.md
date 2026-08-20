# 0023 — Compression is hop-local on the pack link, and the ETag names the identity bytes

Status: **Accepted** (2026-08-20)

Protocol: [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) §9.1 · Code:
[`bridge/pack/forward.ts`](../bridge/pack/forward.ts), [`bridge/http-cache.ts`](../bridge/http-cache.ts) ·
Related: [ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) (the lead consumes a peer's
Collie API, so a forward is a proxy over two independent HTTP hops)

## Context

A forwarded pane read crosses two hops: phone→lead, and lead→peer. They are separate HTTP
conversations with separate clients, and the cheap thing to do is treat them as one pipe — forward
the phone's `Accept-Encoding` to the peer, let the peer gzip once, and pass the compressed bytes and
the `content-encoding` header straight through. One compression for two hops.

**That was effectively the behaviour before 0.32.0-beta.9, and it shipped a blank pane.** Bun's
`fetch` supplies its own `accept-encoding: gzip, deflate, br, zstd` when the init carries none, so the
peer compressed; `fetch` then transparently decompressed the body but — unlike the Fetch spec's
step — left `content-encoding: gzip` on the response headers. The lead copied that header onto bytes
that were already plain. The phone's `fetch` threw inflating them, the loader's catch degraded to a
stale mirror, and **every** peer pane rendered "(no recent output)". `curl` without `--compressed`
ignores the header, which is why every shell check looked green.

beta.9 fixed it by pinning the peer hop to `accept-encoding: identity` and dropping the peer's
`content-encoding` from the proxied header set, so the lead's headers describe the lead's bytes. The
correct fix, and the honest one. Its cost was that the lead→phone hop then went out **plain for
forwarded routes only** — measured at ~136 KB per poll where the same pane served locally ships ~6 KB
gzipped. On cellular that is roughly 20×, on the app's own polling interval, and it is paid by the
one surface v1 exists for.

The tempting repair is to go back: "the mismatch was a bug in *how* we passed it through, not in
passing it through — forward the phone's `Accept-Encoding` and be careful." It will be proposed
again, because it looks like it saves a compression. It does not survive contact with the parts:
the lead is a `fetch` client whose runtime decides for itself whether to decompress, so the lead can
never be sure whether the bytes in hand match the header it received; a forwarded route can be a
`304`, a multipart upload echo or an image, each with a different right answer; and a peer's
`Content-Length` and the phone's are then two different numbers derived from one header. Every one of
those is a lie in a field the phone trusts.

There is also a load-bearing invariant already in the repo that makes the alternative unnecessary.
`gzipJsonResponse` (`bridge/http-cache.ts`) hashes the **pre-gzip** body, compresses on top of that,
and declares `vary: accept-encoding`. So an ETag in Collie has always named the *identity*
representation, and compression has always been a property of one transfer rather than of the
resource. A hop may therefore compress or not without touching the ETag — which is exactly the
freedom the two-hop shape needs.

## Decision

**Each hop negotiates its own compression, and the ETag names the identity bytes on both sides.**

- **The peer hop is `Accept-Encoding: identity`**, always, and the phone's own value is never
  forwarded. The lead holds identity bytes by construction rather than by inference.
- **The peer's `content-encoding` is never re-emitted**, and neither is its `content-length`. They
  describe the other hop.
- **The lead compresses the phone hop itself**, on the phone's own `Accept-Encoding`, and does it as a
  **stream transform** (`CompressionStream("gzip")`) — never by buffering. §9.1's "the body is
  streamed, never read" is not weakened: a 400-turn history is transformed chunk by chunk.
- **The predicate is narrow and explicit**: the phone asked for gzip · the status is not `304`/`204` ·
  there is a body · the content type is `application/json*` or `text/*`. Anything else streams through
  exactly as before.
- **`etag` rides through verbatim, and `accept-encoding` is MERGED into the peer's `Vary`** (set when
  the peer sent none). A proxied route and a local route therefore read identically to a cache.
- **This is lead-side only.** The peer surface (`/pack/v1/*`) is unchanged; no wire field moves.

## Consequences

- **The 20× regression is closed** without reopening the header/bytes mismatch: the lead's headers
  still describe the lead's bytes, because the lead is now the one that produced them.
- **The lead spends CPU it used to save** — one gzip per forwarded read, on top of the peer's own for
  its local phones. That is the trade: a tailnet-class link between lead and peer is cheap, a cellular
  link to the phone is not, so the compression is bought where it pays.
- **A mid-stream peer failure now truncates a gzip stream instead of truncating JSON.** The phone gets
  a decode error where it used to get a parse error — the same failure class, the same `catch`, the
  same degraded-to-stale rendering. Accepted knowingly; it is not a new way to fail, only a new name
  for one.
- **No `content-length` on a compressed forward**, so the phone cannot show progress for one. It could
  not for a streamed identity forward either — the header was never copied — so nothing regresses.
- **What would justify revisiting this:** a peer hop that is no longer tailnet-class (a pack member
  across the public internet, §16's territory). Then compressing lead→peer becomes worth having — and
  the way to get it is a *second, independently negotiated* hop compression, still decompressed and
  re-decided at the lead. Never a pass-through.
