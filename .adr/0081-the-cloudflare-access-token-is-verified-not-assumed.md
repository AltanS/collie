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

**The promise.** With Access configured, every remote request needs a verified Access token. Only a
true local process is exempt. The crew surface (its own admission) and `/api/health` stay outside
the gate. The exemption reaches past this gate only, never past pairing: a local caller still needs
a paired device to type, exactly as before.

**When the operator sets `COLLIE_ACCESS_TEAM` and `COLLIE_ACCESS_AUD`, the bridge verifies the
Access token on every request that is not exempt.** The algorithm first: the header must say RS256,
and anything else (`none`, HS256, RS512, no `alg`) fails before a key is looked at. Then the key
the `kid` names, exactly, with no fallback to the first or only key; the signature; `iss` equal to
the team's issuer; `aud` containing the configured tag, whether `aud` is a string or an array; `exp`
required and in the future; `nbf`, when present, not in the future. Both times allow a minute of
skew. Anything else is a `401`.

**The team names one host, and only that host.** `COLLIE_ACCESS_TEAM` is `myteam`,
`myteam.cloudflareaccess.com` or `https://myteam.cloudflareaccess.com`, where `myteam` is one DNS
label. It is also where the keys come from, so any other value (another domain, a port, a path,
userinfo, plain http) names no issuer and counts as half a configuration.

**It fails closed.** One setting without the other, or a team that names no issuer, refuses every
gated request with `503` and logs one line at start naming the setting that is wrong. Keys never
fetched refuse every gated request with `503`; the first failure logs one line with the cause, and
the fetch retries on a ladder that starts at 2 seconds. Keys fetched once are kept when a refresh
fails, because Cloudflare keeps the previous key valid for days after a rotation.

**The key fetch is bounded.** A 5-second timeout, a 64 KiB body cap, no redirects, and only the
`keys` member of the answer (`public_cert` and `public_certs` are ignored). An unknown `kid`
triggers at most one refetch every 30 seconds across all requests, and concurrent callers share the
fetch in flight, so a spray of made-up kids costs Cloudflare one request per 30 seconds. That window
does not hold back a cold start, which retries on its own ladder.

**What is outside the gate, and why each is safe under the promise.**

- `/api/health`, the one route that was already ungated. The updater polls it before a browser
  exists, and it discloses only the version every response carries.
- The crew surface, `/crew/v1/*`. It sits in front of the gate on purpose: it answers first, with
  its own admission (pinned mutual TLS plus the crew secret, ADR 0013), and a browser credential
  never admits a crew request. A lead's forward to a member (`bridge/crew/forward.ts`) and a
  deputy's calls travel only over `/crew/v1/*`; the member dispatches them into its own handlers in
  process (`bridge/crew/router.ts`, `dispatch`), so a member with Access on still answers its lead.
- A local caller: a loopback `Host` and none of `Cf-Ray`, `Cf-Connecting-Ip`, `Cf-Visitor`,
  `Cf-Access-Jwt-Assertion`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`,
  `Forwarded` or `X-Real-Ip`.

**Why a header check is enough for the local caller.** The Cloudflare edge always adds `Cf-Ray` and
`Cf-Connecting-Ip`, and `cloudflared` forwards them, so a request that came through Cloudflare
cannot look local. A tunnel set to `originRequest: httpHostHeader: localhost` is still gated,
because of `Cf-Ray`. Every other front door (`tailscale serve`, Caddy, nginx, Traefik) adds a
forwarding header, so it is gated too. To pass as local, a process must already reach the loopback
port and send a crafted request, and such a process is a local caller in practice: it could read
the port directly anyway (`docs/security.md` → *Risk model*). The peer-address check still runs
before the gate, so the request must also arrive from loopback.

**The one residual.** A second proxy on the same host, between `cloudflared` and the bridge, that
rewrites `Host` to loopback and strips every `Cf-*` and forwarding header. Its requests look local.
The documented setup is one front door at a time, and `docs/deployment.md` names this case.

**A second residual: a non-loopback bind.** With `COLLIE_ALLOW_NON_LOOPBACK_BIND=1` the peer-address
check is off, so a client that reaches the port directly can send `Host: localhost` and no forwarding
header and pass the gate. Pairing still guards it. Access does not protect a bridge bound to a
non-loopback address; bind to loopback.

**A consequence of the promise: one door for browsers.** A host that serves both a tunnel and a
tailnet name loses the tailnet door for browsers once Access is on. `tailscale serve` sends a
tailnet `Host` and `X-Forwarded-For` and carries no Access token, so its requests get `401`. That is
the safe answer and it stays.

**The standby door is out of scope.** It is a separate listener (`COLLIE_STANDBY_PORT`, bound on
`COLLIE_STANDBY_HOST`) with three routes under `/standby/*` (`bridge/crew/standby.ts`). It shows no
pane, no PWA and no `/api/*`: two read-only status pages and one takeover confirm gated by pairing.
It is meant for the operator's failover proxy, when the normal ingress is broken, and it already
refuses to depend on that ingress (it ignores `COLLIE_DEVICE_HEADER` for the same reason). Making
it depend on Cloudflare would break the one path it exists for, and the gate's promise is about the
panes, which it does not serve.

**`collie doctor` passes as a local caller.** It dials the bridge on loopback with no forwarding
header, so it never meets the gate. A green doctor proves nothing about the remote path: it does not
show that the keys loaded or that a token verifies. The bridge's log line is the operator's signal.

**No streams, so every request is checked.** The bridge holds no WebSocket or event stream open; the
phone polls. The gate runs in `fetch` before every route, so each poll is checked on its own, and an
expired token is refused on the next request. A stream added later would be checked only once, at
connect, and would outlive its token; the wiring test fails first, so that change revisits this ADR.

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

**Do not add Access bypass rules for Collie paths.** Access adds the token to every request it lets
through, cookie-based or not, so the service worker script, the icons and the app shell all carry
it. A path behind a bypass rule carries no token and gets `401`. The gate does not exempt more
routes for this.

**What would justify revisiting.** If Cloudflare starts signing Access tokens with another algorithm,
the RS256-only rule moves with it. If another identity proxy that signs its assertions (an OIDC
proxy, Tailscale's own identity tokens) is asked for, the same gate shape generalises, and that
request should extend this ADR's mechanism rather than add a vendor branch beside it.
