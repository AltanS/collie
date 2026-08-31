# Deployment variants B–E

The bridge always binds **loopback only**; what changes between deployments is *what sits in front
of it* and *how a request proves who it is*. [Variant A](./README.md#variant-a--tailscale-serve--person-identity-default) —
plain `tailscale serve`, identity by tailnet person — is the default and lives in the README. The
four shapes here are for everything else. Pick one.

- [Variant B — identity-aware proxy + per-device authorisation](#variant-b--identity-aware-proxy--per-device-authorisation)
- [Variant C — reverse proxy as the only front door (no Tailscale)](#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale)
- [Variant D — off-host identity proxy over the tailnet](#variant-d--off-host-identity-proxy-over-the-tailnet)
- [Variant E — any other mesh or tunnel](#variant-e--any-other-mesh-or-tunnel-netbird-zerotier-cloudflare-tunnel)
- [Several Collies on one host](#several-collies-on-one-host) — a URL per developer on a shared box
- [The standby door — a pack's failover path](#the-standby-door--a-packs-failover-path) (packs only)

Not a variant, but it crosses all of them: [Several Collies on one host](#several-collies-on-one-host).

The security rules in [docs/security.md](./docs/security.md)
are not relaxed by any of them. None of these is a prerequisite for authorising individual devices —
[pairing](./docs/security.md#pair-a-device--the-write-credential) does that with no proxy at all, and
composes with every variant here.

## Variant B — identity-aware proxy + per-device authorisation

Use this when some devices should **drive** agents and others should be **read-only** — e.g. your
phone can reply, but a shared/less-trusted device can only watch. Collie reads an opaque device id
from a request header (`COLLIE_DEVICE_HEADER`) and checks it against `COLLIE_DEVICE_ALLOWLIST`:
allow-listed → full access, any other id → read-only, header absent → read-only as well.

Collie side (`.env`):

```bash
COLLIE_HOST=127.0.0.1                       # keep loopback (default)
COLLIE_DEVICE_HEADER=X-Device-Id            # the header your proxy injects
COLLIE_DEVICE_ALLOWLIST=my-phone,my-laptop  # ids allowed to drive agents; others → read-only
# COLLIE_ALLOWED_ORIGINS=https://collie.example.com   # only if the proxy does NOT forward the public Host
# COLLIE_PUBLIC_HOSTS=collie.example.com    # REQUIRED unless the proxy forwards a Host Collie already knows
# COLLIE_ALLOW_ANY_HOST=1                   # opt out of Host validation entirely (re-opens DNS rebinding)
# COLLIE_TRUSTED_USER still composes on top if your ingress also injects Tailscale-User-Login
# COLLIE_TRUSTED_USER_OPTIONAL=1            # accept a request carrying no Tailscale-User-Login at all
```

Your fronting proxy **must**:

1. **Authenticate the device** by some means it controls — mTLS client certs, an SSO/forward-auth
   layer (oauth2-proxy, Pomerium, Cloudflare Access), Tailscale node identity, etc. How you derive a
   stable per-device id is up to you; Collie treats it as opaque.
2. **Set (override) the device header** on *every* upstream request — never merely add it, so any
   client-supplied copy is discarded. This override is what makes the header trustworthy.
3. **Proxy to Collie on loopback** (`127.0.0.1:$COLLIE_PORT`). The loopback bind is the trust
   anchor — nothing but the proxy can reach Collie to set the header.
4. **Satisfy the same-origin gate.** Collie accepts a request when the browser's `Origin` host
   equals the `Host` Collie receives. So either **forward the public `Host` unchanged**, or — if
   your proxy rewrites Host — list the exact public origin in `COLLIE_ALLOWED_ORIGINS`. Otherwise
   every API call 403s `cross-origin rejected` (the page loads but stays empty).

Illustrative nginx — the auth layer is yours; the load-bearing lines are the **override** and the
**loopback** `proxy_pass`:

```nginx
location / {
    # $device_id comes from your auth (client-cert CN, auth_request, SSO header, …).
    # SETTING it replaces any client-supplied X-Device-Id — that's what kills spoofing.
    proxy_set_header X-Device-Id $device_id;
    proxy_set_header Host        $host;       # forward the public Host → same-origin gate passes
    proxy_pass http://127.0.0.1:8787;
}
```

**Is it actually working?** Run both from a device that reaches Collie *through the proxy*:

```console
$ curl -s https://collie.example.com/api/snapshot | jq -c .device
{"enforced":true,"device":"my-laptop","authorized":true}

$ curl -s -H 'X-Device-Id: my-phone' https://collie.example.com/api/snapshot | jq -c .device
{"enforced":true,"device":"my-laptop","authorized":true}
```

The first proves the proxy injects an id and that the id is allow-listed. The second is the one
people skip: you supplied a *different* id and the answer still names the proxy's. If it comes back
`"device":"my-phone"`, your proxy is **adding** the header rather than setting it, and any client can
name itself whatever it likes.

Treating an absent header as read-only is the point: switching this on is you asserting that your
proxy sets the header on every request, so a request without one did not come through that proxy and
must not drive a terminal. **Device-auth only works behind a reverse proxy that authenticates the
device and injects the header.** It is not a standalone flag.

> ⚠️ **Do not enable `COLLIE_DEVICE_HEADER` on plain `tailscale serve`.** `tailscale serve` injects
> only its own `Tailscale-*` headers and *forwards* an arbitrary `X-Device-Id` untouched, so a
> client that *sets* `X-Device-Id: my-phone` itself is trusted. Spoofing is what makes this unsound,
> and only a proxy that **overrides** the header (requirement 2 above) closes it.

Note what "read-only" means here: the gate covers writes (replies, keys, uploads, pane and tab
create/close). Reading panes, polling the snapshot and listing sessions stay open to any caller that
gets past the same-origin and Host checks, exactly as they do for a device that is simply not on the
allowlist. Pane text can contain anything your agents printed, so the header is not a confidentiality
boundary.

Two consequences worth knowing before you turn this on:

- **Collie's own loopback URL becomes read-only.** `http://127.0.0.1:$COLLIE_PORT` bypasses your
  proxy, so the PWA loaded from it sends no device header and shows its read-only state. Drive the
  herd through the proxied URL instead.
- **To drive a pane from the host by hand**, send an allowlisted id yourself, against loopback
  rather than the public URL (the proxy's mandatory override in requirement 2 above would
  replace your header): `curl -H 'X-Device-Id: my-laptop' http://127.0.0.1:$COLLIE_PORT/api/...`

Revoke a device by dropping its id from `COLLIE_DEVICE_ALLOWLIST` and restarting
(`herdr plugin action invoke restart --plugin herdr.collie`). With the header set but the allowlist
**empty**, every device is read-only (fail-closed), and so is a request that arrives without the
header. In that state nothing can drive a pane, including a hand-made `curl`; recovery is an `.env`
edit plus a restart.

This variant assumes the proxy is **on the same host**, reaching Collie on loopback. If your
proxy runs on a *different* node and its upstream is the host's own `tailscale serve` URL, the
trust story changes — see [Variant D](#variant-d--off-host-identity-proxy-over-the-tailnet).

## Variant C — reverse proxy as the only front door (no Tailscale)

A reverse proxy (Caddy, Nginx, …) is the **sole ingress** — no Tailscale in the path. Choose this
when the host isn't on a tailnet, or when you already run a TLS-terminating proxy with its own access
control (SSO, mTLS, a VPN gateway) and want Collie behind it like any other upstream.

Set `COLLIE_SKIP_SERVE=1` so `collie start` builds, starts and supervises Collie but
**never touches `tailscale serve`** — the proxy owns ingress. Collie still binds loopback only;
your proxy reaches it on `127.0.0.1:$COLLIE_PORT`.

The **four proxy requirements from
[Variant B](#variant-b--identity-aware-proxy--per-device-authorisation) apply verbatim** — the proxy
*is* the identity-aware front door here. A minimal Caddy front door:

```caddyfile
collie.example.com {
    # TLS is automatic (Let's Encrypt). Put YOUR access control here
    # (forward_auth / mTLS / SSO) — it also yields the per-device id below.
    reverse_proxy 127.0.0.1:8787 {
        header_up X-Device-Id {your_device_id}   # SET from your auth — overrides any client-supplied copy
        header_up Host {host}                     # forward the public Host → same-origin gate passes
    }
}
```

Required env (`.env`):

```bash
COLLIE_SKIP_SERVE=1                                 # proxy is ingress; never run tailscale serve
COLLIE_PUBLIC_HOSTS=collie.example.com              # REQUIRED — Host validation fails closed, and
                                                    # `collie start` discovers no tailnet name here
# COLLIE_ALLOW_ANY_HOST=1                           # opt out of Host validation (re-opens DNS rebinding)
COLLIE_ALLOWED_ORIGINS=https://collie.example.com   # exact public origin for the same-origin gate
COLLIE_DEVICE_HEADER=X-Device-Id                    # the header your proxy injects…
COLLIE_DEVICE_ALLOWLIST=my-phone,my-laptop          # …and the ids allowed to drive; others → read-only
# COLLIE_PUBLIC_URL=https://collie.example.com      # optional — status banner, `collie qr`, and the
                                                    # address a lead hands joining machines (pack)
```

> ⚠️ **`COLLIE_TRUSTED_USER` does nothing here.** It gates on `Tailscale-User-Login`, which only
> `tailscale serve` injects — with no Tailscale in the path there is no injector, so the check has
> nothing to compare against and every request passes it. It fails *open*, not closed, and Collie
> logs a startup warning saying so. **Per-device auth (`COLLIE_DEVICE_HEADER`) is the write gate**,
> and the **proxy must provide TLS and its own access control** — anyone who reaches the proxy gets
> read access to every pane. Give the proxy the same respect you'd give the tailnet.

> ⚠️ **Never blanket-cache, and never refuse the static bundle to a signed-out client.** Both are
> the same fact: a service worker that goes stale or can't be fetched never self-heals. Collie
> marks hashed assets (`/assets/*`) immutable and everything else — notably `/sw.js` and
> `index.html` — `no-cache`; a proxy cache that ignores that holds installed PWAs on old code with
> no way to notice (Caddy and stock Nginx `proxy_cache` honor origin headers by default, CDNs often
> need it turned on). Likewise, let everything except `/api/` and page navigations through even when
> the session has lapsed: it is public client code with no secrets in it, and it is the only way an
> installed app can receive an update. Refuse `/sw.js` to a lapsed client and `registration.update()`
> throws, so that device stays on the build it had forever.

**Serve your sign-in page under `/auth/`.** Collie reserves that path for you and routes nothing
there.

```caddyfile
collie.example.com {
    handle /auth/* {
        # your sign-in / device-enrolment flow, exempt from the auth check that guards the rest
        reverse_proxy 127.0.0.1:9091
    }
    handle {
        forward_auth 127.0.0.1:9091 { ... }
        reverse_proxy 127.0.0.1:8787 { ... }
    }
}
```

Why that path and not `/`: an installed app's service worker answers navigations from its own cache
without touching the network, so a sign-in page anywhere Collie owns is invisible to it — `/auth/`
and everything beneath it is the one prefix always passed through. (`/cdn-cgi/access/` is reserved
too, so Cloudflare Access works untouched.) Collie's refusal banner links to `/auth/` on a 401/403,
so a signed-out phone has a tappable way back in; a `?rd=`/`?next=` return-to parameter is fine, and
if your flow lives somewhere you can't move, redirect `/auth/` to it. When Collie answers there
itself, nothing claimed the path — that placeholder is your signal that the proxy rule is missing.

**Forward-auth proxies that turn refusals into redirects are supported, but Collie does not follow
the login flow for you.** API requests are made with redirects disabled; if the front door still
answers a lapsed session with a 3xx, Collie treats that response as a 401 so the existing **Sign in**
link appears instead of a misleading connection error. `/auth/` must therefore remain a real,
operator-owned sign-in entry. For Authentik, redirect that entry into its standard
`/outpost.goauthentik.io/start` flow (with the appropriate `rd` return URL); the fixed
`/outpost.goauthentik.io/` start/callback namespace is also passed straight to the network by the
service worker so an installed PWA cannot replace the auth flow with its cached app shell.

> **Devices locked out before 0.18.0 can't pick this up.** They can't fetch the new service worker,
> so the `/auth/` link never appears — clear that site's data once (browser settings → the site →
> clear data) and load it fresh. New installs and devices that updated while signed in are fine.

**Is it actually working?** Two checks against the public URL:

```console
$ curl -s https://collie.example.com/api/snapshot | jq -c .device
{"enforced":true,"device":"my-phone","authorized":true}

$ curl -sI https://collie.example.com/sw.js | grep -i '^cache-control'
cache-control: no-cache
```

The first proves the proxy injects an allow-listed id. The second proves the proxy is passing the
service worker through with the origin's own caching rules rather than holding or refusing it — the
failure mode that leaves installed phones frozen on an old build.

## Variant D — off-host identity proxy over the tailnet

Choose this when you already run a **central ingress node** for your tailnet — one forward-auth/SSO
layer, one wildcard cert, a row of services behind it — and you want Collie to be another entry in
that table rather than a second auth stack configured on the agent host.

The proxy is on a *different machine*, so it can't reach Collie on loopback. The agent host
publishes Collie **tailnet-only** with `tailscale serve --http`, and the proxy's upstream is that
tailnet URL:

```
  phone ──── https ────► ingress node          TLS + forward-auth; SETS the device header
                            │
                            │  http, never leaves the tailnet (WireGuard encrypts it)
                            ▼
                        host.your-tailnet.ts.net:8787     tailscale serve --http, tailnet-only
                            │
                            ▼
                        127.0.0.1:8787                    Collie
```

Plain HTTP on the middle hop is fine *because it rides the tailnet* — TLS terminates at the proxy.
That is not the same thing as serving Collie over plain HTTP publicly, which is what the
`COLLIE_SERVE_MODE=http` warnings elsewhere are about.

The **four proxy requirements from
[Variant B](#variant-b--identity-aware-proxy--per-device-authorisation) apply**, except (3): proxy to
the host's tailnet URL rather than `127.0.0.1`.

> ⚠️ **A Tailscale ACL is mandatory in this variant.** Collie's tailnet URL has to stay reachable
> or the proxy couldn't reach it either, so there is a permanent second path to Collie that skips
> your forward-auth entirely — and **`tailscale serve` forwards a client-supplied device header
> untouched** (verified: it arrives at Collie unmodified). Your proxy's mandatory *override* only
> protects the proxy path; on the direct path there is no override, so a tailnet peer who supplies an
> allow-listed id gets full write access. Device ids are human-readable names, so treat them as
> guessable, not secret. **Restrict who can reach the port at all.**
>
> On Tailscale (or headscale ≥ 0.29), `grants`:
>
> ```jsonc
> "grants": [
>   { "src": ["tag:ingress"], "dst": ["tag:agent-host"], "ip": ["tcp:8787"] },
> ]
> ```
>
> On **headscale ≤ 0.28** `grants` does not exist, and an unparseable policy will take the control
> plane down rather than fail safe — use the older `acls:` form. Tags may not be an option either:
> 0.28 makes tag ownership and user ownership mutually exclusive, so tagging a node can detach it from
> its user. Name the nodes or users directly instead:
>
> ```yaml
> acls:
>   - action: accept
>     src: ["ingress-node"]
>     dst: ["agent-host:8787"]
> ```
>
> **Adding that rule is not enough on its own.** These policies are default-deny, so a broad rule you
> already have (`dst: ["agent-host:*"]`) will keep the port open to everyone it covers. The port has
> to be *carved out* of the broader grant, which in practice means splitting the range:
>
> ```yaml
>   - action: accept
>     src: ["my-phone", "my-laptop"]
>     dst: ["agent-host:1-8786", "agent-host:8788-65535"]   # everything EXCEPT Collie's port
> ```
>
> Per-device auth is still required, and it does real work: since 0.15.0 a request arriving *without*
> the header is read-only, so a stray client, another service or the host's own loopback URL can watch
> but never drive. What it cannot do is stop a caller who deliberately sets the header. The ACL is
> what stops that, and the two together are the posture.

**Host and Origin are different values here** — the one place this trips people up. `tailscale serve`
Host-routes on the host's own MagicDNS name, so the proxy generally must rewrite `Host` to the
upstream (in Traefik, `pass_host_header: false`). Collie then sees the *tailnet* Host while the
browser's Origin is your *public* name, so the two settings take different values:

```bash
COLLIE_SERVE_MODE=http                                # proxy terminates TLS; this hop is tailnet-internal
COLLIE_HOST=127.0.0.1                                 # keep loopback (default)
COLLIE_DEVICE_HEADER=X-Tailnet-Device                 # header your forward-auth injects — REQUIRED here
COLLIE_DEVICE_ALLOWLIST=my-phone,my-laptop            # ids allowed to drive; others + header-less → read-only
COLLIE_PUBLIC_HOSTS=host:8787,host.your-tailnet.ts.net:8787   # REQUIRED — the Host the proxy forwards.
                                                      # COLLIE_TAILSCALE_HOSTS carries the bare tailnet
                                                      # name `collie start` found; a rewritten Host is
                                                      # yours to list. COLLIE_ALLOW_ANY_HOST=1 opts out.
COLLIE_ALLOWED_ORIGINS=https://collie.example.com     # the public origin the browser actually uses
```

> **`COLLIE_TRUSTED_USER` is not a person gate in this shape.** `tailscale serve --http` *does* still
> inject `Tailscale-User-Login`, but it names the **calling node's owner** — through the proxy that's
> the ingress node, identically on every request no matter who is holding the phone. It remains
> useful for rejecting nodes owned by a *different* tailnet user (shared machines), so it is worth
> setting; it just cannot tell your own devices apart. The device header does that.

**Is it actually working?** Two controls are doing the work here — the ACL decides *who reaches the
port*, the device gate decides *what a request that got there may do* — and each has to be tested
from a machine that can actually observe it.

**From a tailnet peer** (your phone, a laptop — anything that is neither the ingress node nor the
agent host):

```console
$ curl -s https://collie.example.com/api/snapshot | jq -c .device
{"enforced":true,"device":"my-phone","authorized":true}

$ curl -s --max-time 10 -H 'X-Tailnet-Device: my-phone' http://host.your-tailnet.ts.net:8787/api/snapshot
curl: (28) Connection timed out
```

The first proves the proxy injects the header *and* that the id is allow-listed. The second is the
one people skip: it must **fail to connect**. A reply of any kind means that peer reached the port
directly, and since the header is forgeable there, your forward-auth is decoration for anyone who
bothers.

**On the agent host** (where the port is reachable by definition, so the gate is what's under test):

```console
$ curl -s http://127.0.0.1:8787/api/snapshot | jq -c .device
{"enforced":true,"device":null,"authorized":false}
```

A header-less request must be read-only. **If it says `"authorized":true`, your collie predates
0.15.0** — update before going further.

> ⚠️ **Don't test reachability from the agent host.** A connection to your own tailnet IP is handled
> locally and never crosses the peer packet filter, so `curl http://host.your-tailnet.ts.net:8787`
> succeeds *there* even when the ACL is flawless. It is the most obvious machine to test from, since
> it's the one you're configuring, and it will tell you your ACL is broken when it isn't. Reachability
> is only observable from a second device.

## Variant E — any other mesh or tunnel (NetBird, ZeroTier, Cloudflare Tunnel)

Tailscale is the **default**, not a requirement. Collie's own Tailscale coupling is one header read
and a convenience in the CLI; the bridge itself is a loopback HTTP server that gates on
`Host`, `Origin`, and two optional headers. Anything that can reach `127.0.0.1:$COLLIE_PORT` can
front it.

Collie deliberately **manages** only one front door — the one this project runs and tests. For every
other tunnel you own the ingress and Collie stays out of the way:

```bash
COLLIE_SKIP_SERVE=1                                 # never run tailscale serve
COLLIE_PUBLIC_HOSTS=collie.example.com              # REQUIRED — exact public host; Host validation
                                                    # fails closed and finds no tailnet name here
COLLIE_ALLOWED_ORIGINS=https://collie.example.com   # exact public origin for the same-origin gate
```

Then point your tunnel at `127.0.0.1:$COLLIE_PORT` and start it however you start your other
services. `netbird expose 8787`, a ZeroTier-routed reverse proxy and `cloudflared tunnel` all work
this way. `collie start` will build, launch and supervise Collie and publish nothing;
`unserve` and `uninstall` likewise leave your tunnel alone, exactly as under
[Variant C](#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale).

Three things to get right, none of them Collie-specific:

1. **The [Variant B](#variant-b--identity-aware-proxy--per-device-authorisation) proxy requirements
   apply verbatim.** Loopback upstream, the public `Host` forwarded unchanged (or listed in
   `COLLIE_ALLOWED_ORIGINS`), and — if you use the device gate — the identity header **overridden**
   on every request, never merely added.
2. **`COLLIE_TRUSTED_USER` does nothing here**, for the reason it does nothing behind a reverse proxy
   ([Variant C](#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale)): nothing injects
   `Tailscale-User-Login`, so the check passes every request rather than blocking it, and Collie
   warns about that at startup. If your tunnel authenticates and injects a device identity, use
   `COLLIE_DEVICE_HEADER` + `COLLIE_DEVICE_ALLOWLIST` instead; if it authenticates but injects
   nothing, its own auth *is* the whole gate and anyone who passes it gets full Collie access.
3. **Pin a stable hostname before you install the PWA.** A service-worker cache is per-origin, and
   several tunnels hand out a fresh generated name per session. A name that changes gives you a new
   install each time and makes `COLLIE_PUBLIC_HOSTS` unpinnable.

> ⚠️ **Anything that publishes to the open internet is a `funnel` by another name.** The rule in
> [docs/security.md](./docs/security.md) isn't about Tailscale,
> it's about reachability: this socket is a shell running as you. If your tunnel offers a public URL,
> the auth in front of it is the only thing between a stranger and that shell, so treat a shared PIN
> the way you'd treat a root password — and prefer a tunnel scoped to your own devices over a public
> URL with a gate on it.

## Several Collies on one host

A tailnet name belongs to the **machine**, not to a person on it. So when a team shares one VPS and
each developer wants their own Collie, they are all reaching for the same `https://<host>.<tailnet>.ts.net`
— and `tailscale serve` has exactly one root mount on :443 to give. `COLLIE_SERVE_PORT` hands each
Collie a listener port of its own, and the URL a port suffix to match:

```bash
# ~/.config/herdr/plugins/config/herdr.collie/.env — one per Unix user
COLLIE_PORT=8801                       # this user's loopback bridge port — unique per user
COLLIE_SERVE_PORT=8443                 # this user's tailnet https listener — unique per user
COLLIE_TRUSTED_USER=dev-a@example.com  # only this tailnet login may drive these agents
```

`collie url` then prints `https://<host>.<tailnet>.ts.net:8443`, the next developer gets `:8444`, and
each door is still Collie's one managed front door — same certificate, same identity header, same
teardown rule ([ADR 0001](./.adr/0001-one-managed-front-door.md)). Only the port is yours to pick.

Three things to get right:

1. **One Unix user per developer, each running their own `herdr` and their own Collie.** Collie
   drives whatever panes its herdr can see; two developers sharing one herdr share one set of
   terminals, which is not what anyone means by "my own Collie".
2. **Set `COLLIE_TRUSTED_USER`.** Every developer on the tailnet can reach every port on the host,
   and without it each Collie accepts all of them. It is the only thing making `:8443` yours rather
   than the team's, and Collie warns at startup while it is unset.
3. **The serve step needs privilege the developer may not have.** `tailscale serve` requires root or
   the single Tailscale operator user (`tailscale set --operator=<user>` names exactly one). So an
   admin runs `collie serve` once per user account — the mapping is `--bg` and persists across
   reboots, and each developer's own `collie start`/`restart` then leaves it alone. If a developer
   sees `access denied` from `tailscale serve`, that is this, not a Collie problem.

**`COLLIE_SERVE_PORT` is not `COLLIE_INSTANCE`, and they answer different questions.**
`COLLIE_SERVE_PORT` gives *one* Collie a front-door port of its own — same install, same state dir,
same service unit, only the tailnet listener moves off :443. `COLLIE_INSTANCE` makes a **second,
fully separate Collie** on the host: its own config dir, its own service unit (`collie-<name>`), its
own pidfile and log, and a state dir you give it — sharing nothing with the first. Each developer
above wants the first, because
they already have their own Unix user; one operator running v1 beside their live 0.x wants the second
([docs/upgrading.md → Side by side](./docs/upgrading.md#side-by-side-if-the-herd-is-real)). A named instance still needs
a `COLLIE_SERVE_PORT` of its own if it is to have a front door on the same machine name.

Ports are free-form here: `tailscale serve --https=<port>` takes any port. Only `funnel` — which
Collie never runs — is restricted to 443/8443/10000. An unusable `COLLIE_SERVE_PORT` makes
`collie serve` refuse before it touches anything, rather than quietly falling back to :443.

## The standby door — a pack's failover path

**Packs only, and opt-in.** If you lead a [pack](./PACK_PROTOCOL.md), you can name one peer the
**deputy** and give it a page your phone can reach when the lead is gone. The deputy holds a
lead-signed *warrant*; the page's one button spends it. Why it is a second listener rather than a
route on the existing one, and why the button is gated the way it is, are
[ADR 0028](./.adr/0028-the-standby-door-is-a-second-listener.md) and
[ADR 0027](./.adr/0027-the-deputy-is-named-ahead-of-time.md); the contract is
[`PACK_PROTOCOL.md` §18](./PACK_PROTOCOL.md).

Set on the **deputy** (and on the lead, see the last row):

| Key | Default | What it does |
| --- | --- | --- |
| `COLLIE_STANDBY_PORT` | *(unset)* | The port the standby door binds. **Unset means no door at all** — nothing is bound, nothing is served, and the deputy is a plain peer you can still recover from a keyboard with `collie promote`. Absent means closed. |
| `COLLIE_STANDBY_HOST` | `127.0.0.1` | Where it binds. Loopback is right when the failover proxy is co-located; set the overlay address when it is not. |
| `COLLIE_STANDBY_ARM_MS` | `max(30000, 2.5 × COLLIE_POLL_IDLE_MS)` | How long the lead must be silent before the door arms. The default is a **formula**, so relaxing `COLLIE_POLL_IDLE_MS` moves it with you. A value at or below the idle poll makes an idle pack arm itself nightly; Collie **warns** at boot and does not refuse. |

**Set `COLLIE_STANDBY_PORT` on the lead too, at the same number.** A lead binds that port and answers
only the health check — otherwise a deputy that takes over and later comes back up as the lead leaves
your proxy health-checking a closed port and swinging the phone onto the machine that died.

Collie **binds** this port and publishes nothing: no `tailscale serve`, never `funnel`, no ownership
record. The ingress in front of it is yours, exactly as under
[Variant C](#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale) and
[Variant E](#variant-e--any-other-mesh-or-tunnel-netbird-zerotier-cloudflare-tunnel).

> ⚠️ **Pick a port `tailscale serve` has never served on that machine.** Observed live: a port that
> was once in a serve mapping can stay black-holed for *direct* tailnet dials to that machine even
> after the mapping is removed — tailscaled keeps intercepting it, and a `tailscaled` restart is what
> clears it. Nothing in Collie can see that from the outside, and it looks exactly like a peer that
> is up and unreachable. A port that was never served has none of this history.

### The prerequisite: one hostname, two backends

**The phone must reach the lead and the deputy on the same origin.** The pairing credential and the
installed PWA are both per-origin, so a takeover page on a different hostname is a page your phone
cannot authenticate to. A same-origin failover proxy is therefore an accepted prerequisite of the
phone-first path — Collie does not grow a second credential to work around it, and `collie pack
deputy` says so once when it sees no shared origin configured.

A pack **without** such a proxy still gets everything else: the warrant, the deposition, the
self-heal. Its recovery is `collie promote` at a keyboard
([PACK_PROTOCOL §14.4](./PACK_PROTOCOL.md)), unchanged.

```yaml
# Traefik — generic shape, adapt to your ingress. Hostnames are placeholders.
http:
  routers:
    collie:
      rule: "Host(`collie.example.com`)"
      service: collie-pack
      tls: {}                      # your ingress terminates TLS; both backends speak plain HTTP

  services:
    collie-pack:
      failover:
        service: collie-lead       # primary
        fallback: collie-deputy    # used only while the primary fails its health check

    collie-lead:
      loadBalancer:
        servers:
          - url: "http://lead.internal:8787"
        healthCheck:
          path: /standby/health    # the LEAD answers 200 here while it leads,
          interval: 5s             # and NON-200 once it has been deposed
          timeout: 2s

    collie-deputy:
      loadBalancer:
        servers:
          - url: "http://deputy.internal:8788"   # COLLIE_STANDBY_PORT
        healthCheck:
          path: /standby/health    # 503 while the lead is fresh — so the fallback
          interval: 5s             # only comes up once the deputy has armed
          timeout: 2s
```

`/standby/health` is one question — *should anything route here?* — and three kinds of machine answer
it: a lead `200`, a deposed lead non-`200`, a deputy `503` until it arms and `200` after.

> ⚠️ **The gap is real, and it is one tuning decision rather than two.** The proxy fails the lead over
> after `interval × failures` (seconds here) while the deputy arms after `COLLIE_STANDBY_ARM_MS`
> (30 s by default). In between, both backends are unhealthy and the phone gets a `503`. That is
> honest — the lead really is down and the deputy really is not yet sure — so **tune the health check
> to the arming threshold, not the reverse.**

### Set it up once, while everything is healthy

```bash
# on the lead
collie pair                      # the door needs a credential; an empty registry refuses to arm
collie pack deputy nas           # mints the warrant, restarts this lead, pushes it to every peer,
                                 # then restarts each peer over your own SSH (one prompt, whole batch)
collie pack status               # confirm: deputy named, warrant generation, anchored on N/N peers
```

Then on the deputy, put `COLLIE_STANDBY_PORT=8788` (and `COLLIE_STANDBY_HOST` if the proxy is not
co-located) in its env and restart it.

**The restart of each peer is load-bearing, not tidiness.** A peer's pinned listener cannot adopt the
deputy's certificate while it runs, so a warrant that has landed on disk is inert at the transport
until that peer restarts. `collie pack status` names any peer left in that state
(`warrant stored, anchor INACTIVE`) — fix it *before* the bad day, because a peer that never
restarted cannot be taken over to.

**Visit `https://collie.example.com/standby` once now.** While the lead is healthy the page is a
statement of fact with no action on it, which is how you confirm the door works without spending
anything.

### ⚠️ The deputy must be supervised

A takeover **commits its store and then exits**, deliberately: the operator asked from a phone, and a
machine whose store says `lead` while its process still runs a peer's pinned listener is a machine
nobody can reach. So it commits, says so, and exits about a second later (`performTakeover` in
[`bridge/index.ts`](./bridge/index.ts) — the one place the bridge restarts itself, and the comment
there says why).

**It exits `75`, and the non-zero status is load-bearing.** `75` is `EX_TEMPFAIL` (`sysexits.h`):
*temporary failure, the user is invited to retry* — which is exactly what this is. `Restart=always`
and `Restart=on-failure` both revive a non-zero exit; **`Restart=on-failure` does NOT revive a clean
`0`**, and a live drill found precisely that: a unit with the common `on-failure` policy took over,
exited zero, and systemd correctly treated it as a service that had finished. The store said `lead`,
the service said `inactive`, and the operator holding the phone had no shell. In `journalctl` a
completed takeover therefore reads `status=75/n/a` — that is the takeover, not a crash.

A supervised install — `systemd --user` with `Restart=always` **or** `Restart=on-failure`, or the
Herdr plugin — comes straight back up as the new lead. An unsupervised one is left with a correct
store and a stopped process. Put **both** the lead and the deputy under supervision.

### The bad day — the runbook

1. **The phone's Collie stops answering** — amber at 4 s, red at 15 s.
2. **Pull to refresh, or reopen the app.** The proxy has failed the lead over, so the request lands on
   the deputy.
3. **`/standby` answers** with one sentence: *your lead `desk` has not called this machine for 47
   seconds; this machine (`nas`) is the deputy.*
4. **One button: take over.** No options, no roster editor — a page with choices on it is a page
   nobody can use one-handed at 23:00.
5. **The confirm sends the phone's pairing credential.** The deputy asks the lead first, then asks the
   surviving peers what *they* last heard, and either refuses with the evidence — *peer `attic` says
   the lead called it 2 s ago* — or commits. **A refusal here is the feature working**, not a failure:
   it means you are the one who is cut off. On a two-machine pack there is nobody to ask, and the page
   says so above the button.
6. **The page reloads onto the real app**, now served by the new lead.

**Afterwards, most of the cleanup does itself.** When the old machine comes back it finds the warrant,
**deposes itself and heals to `peer`** on materials both machines already hold — no command, no token,
nothing minted. It stops polling, fails its health check so the proxy stops routing to it, **takes its
own `tailscale serve` mapping down** (only the one it recorded as its own — ADR 0001 is unchanged),
and serves one page saying which state it is in. `collie pack status` on the new lead names what is
genuinely left, and it is two decisions rather than two repairs:

1. **Name a new deputy** — the takeover spent the warrant, so the pack has none.
2. **Re-point the phone**, if you have no failover proxy.

Two things about that comeback are by design and are not bugs:

- **The old lead publishes as lead for about one sweep before it is deposed.** It boots into silence,
  finds nothing to contradict its own store, and comes up leading — until the new lead's warrant
  reaches it and it deposes itself. Measured at ~25 s in a live drill. Fail-open at boot is
  deliberate ([`PACK_PROTOCOL.md` §8.4](./PACK_PROTOCOL.md)): a machine that refused to lead on
  silence alone would strand a pack whose peers are simply offline.
- **A member's address does not follow it into its new role.** The new lead adopts the roster it was
  handed, and the old lead's row in it holds that machine's *front-door URL* — un-dialable now that
  it is a peer with no front door. `collie pack status` says so under that member, and
  `collie pack set-address <member> <host:port>` corrects it.

> ⚠️ **Do not `collie pack rotate` until the old machine is back.** Rotation marks a member that
> missed it `unenrolled`, and a deposed machine that heals into a rotated pack is stranded and needs a
> re-join after all. The rule is not relaxed for this feature; `rotate` warns you by name. Wait for the
> re-entry, *then* rotate.
