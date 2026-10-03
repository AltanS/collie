# 0081: The Cloudflare Access token is verified, not assumed

- **Status:** Accepted
- **Date:** 2026-10-03
- **Shipped in:** pending
- **Relates to:** [ADR 0001](./0001-one-managed-front-door.md). Nothing there is retracted: Collie
  still manages one front door, and the operator still runs `cloudflared` and owns the Access app.
- **Trail:** [issue #341](https://github.com/AltanS/collie/issues/341) (@xbach, who runs the same
  check in a proxy in front of the bridge) · `bridge/access-jwt.ts` · `bridge/server.ts` (the gate
  after the peer check) · `docs/deployment.md` → *Cloudflare Tunnel*, step 5

## Context

**The Cloudflare door was a promise in the docs.** `docs/deployment.md` says Cloudflare Access is
the lock, and the bridge took that on trust. A Cloudflare Tunnel hostname is public, so when the
Access app is deleted, picks up a bypass rule, or has not propagated yet, every pane is open to
whoever finds the name. The reporter measured the last case: for several minutes after creating the
app, about one request in ten reached the origin without a challenge. Pairing still stops typing,
but the panes alone show source, environment and agent output.

**Access signs what it lets through.** Every request Access admits carries
`Cf-Access-Jwt-Assertion`, an RS256 token the bridge can verify against the team's published keys
without trusting anything on the network path.

Three roads were on the table besides this one:

1. **Keep trusting.** Rejected: a lock that is assumed, on a public hostname, fails open on exactly
   the misconfigurations the operator cannot see.
2. **Check the signature only.** Rejected: every self-hosted Access app in a team is signed with the
   same key, so a signature check admits a token issued for any other app in the team. The `aud`
   claim names the app, and it is the check that matters.
3. **Read `Cf-Access-Authenticated-User-Email`.** Rejected: it is a plain header that Cloudflare
   writes only while Access is in the path. Without Access it is whatever the client sent.

## Decision

**When the operator sets `COLLIE_ACCESS_TEAM` and `COLLIE_ACCESS_AUD`, the bridge verifies the
Access token on every request that came through the tunnel.** Signature (RS256 only, key chosen by
`kid` from the team's keys), `iss` equal to the team's issuer, `aud` containing the configured tag,
`exp` in the future and `nbf` not in it, with a minute of skew. Anything else is a `401`.

**It fails closed.** One setting without the other refuses every gated request. Keys never fetched
refuse every gated request with `503`, and the fetch retries. Keys fetched once are kept when a
refresh fails, because Cloudflare keeps the previous key valid for days after a rotation. An unknown
`kid` triggers at most one refetch every 30 seconds.

**Two things are outside the gate.** `/api/health`, the one route that was already ungated (the
updater polls it before a browser exists, and it discloses only the version every response carries).
And a local caller: a loopback `Host` with no Cloudflare edge header (`Cf-Ray`, `Cf-Connecting-Ip`,
`Cf-Visitor`, or the token itself). Such a request did not come through the tunnel, and a local
process can reach the loopback port directly anyway (`docs/security.md` → *Risk model*). The edge
adds those headers itself, so a remote client cannot strip them to pass as local.

**The crew surface is unaffected.** It answers before the gate, with its own admission (pinned
mutual TLS plus the crew secret, ADR 0013).

**Off by default, and opt-in stays the shape.** Unset, the bridge behaves exactly as before. No
existing install changes.

## Consequences

**This is not a second managed front door.** ADR 0001's criterion is that Collie manages only what it
runs and can test. Collie still runs no `cloudflared`, publishes nothing and tears down nothing. What
it adds is a verification of a signed document, and that is testable offline: the tests sign tokens
with keys they generate.

**A second outbound call, the operator's to make.** With the gate on, the bridge fetches
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` at start and hourly. It carries no data
about the operator (ADR 0034).

**No dependency.** WebCrypto verifies RS256, and the JWT envelope is three base64url segments.

**What would justify revisiting.** If Cloudflare starts signing Access tokens with another algorithm,
the RS256-only rule moves with it. If another identity proxy that signs its assertions (an OIDC
proxy, Tailscale's own identity tokens) is asked for, the same gate shape generalises, and that
request should extend this ADR's mechanism rather than add a vendor branch beside it.
