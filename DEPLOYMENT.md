# Deployment variants B–E

The bridge always binds **loopback only**; what changes between deployments is *what sits in front
of it* and *how a request proves who it is*. [Variant A](./README.md#variant-a--tailscale-serve--person-identity-default) —
plain `tailscale serve`, identity by tailnet person — is the default and lives in the README. The
four shapes here are for everything else. Pick one.

- [Variant B — identity-aware proxy + per-device authorisation](#variant-b--identity-aware-proxy--per-device-authorisation)
- [Variant C — reverse proxy as the only front door (no Tailscale)](#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale)
- [Variant D — off-host identity proxy over the tailnet](#variant-d--off-host-identity-proxy-over-the-tailnet)
- [Variant E — any other mesh or tunnel](#variant-e--any-other-mesh-or-tunnel-netbird-zerotier-cloudflare-tunnel)

Not a variant, but it crosses all of them: [Several Collies on one host](#several-collies-on-one-host).

The security rules in [README → Security](./README.md#%EF%B8%8F-security--read-before-you-run-it)
are not relaxed by any of them.

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
# COLLIE_TRUSTED_USER still composes on top if your ingress also injects Tailscale-User-Login
```

Your fronting proxy **must**:

1. **Authenticate the device** by some means it controls — mTLS client certs, an SSO/forward-auth
   layer (oauth2-proxy, Pomerium, Cloudflare Access), Tailscale node identity, etc. How you derive a
   stable per-device id is up to you; Collie treats it as opaque.
2. **Set (override) the device header** on *every* upstream request — never merely add it, so any
   client-supplied copy is discarded. This override is what makes the header trustworthy.
3. **Proxy to the bridge on loopback** (`127.0.0.1:$COLLIE_PORT`). The loopback bind is the trust
   anchor — nothing but the proxy can reach the bridge to set the header.
4. **Satisfy the same-origin gate.** Collie accepts a request when the browser's `Origin` host
   equals the `Host` the bridge receives. So either **forward the public `Host` unchanged**, or — if
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

- **The bridge's own loopback URL becomes read-only.** `http://127.0.0.1:$COLLIE_PORT` bypasses your
  proxy, so the PWA loaded from it sends no device header and shows its read-only state. Drive the
  herd through the proxied URL instead.
- **To drive a pane from the host by hand**, send an allowlisted id yourself, against the loopback
  bridge rather than the public URL (the proxy's mandatory override in requirement 2 above would
  replace your header): `curl -H 'X-Device-Id: my-laptop' http://127.0.0.1:$COLLIE_PORT/api/...`

Revoke a device by dropping its id from `COLLIE_DEVICE_ALLOWLIST` and restarting
(`herdr plugin action invoke restart --plugin herdr.collie`). With the header set but the allowlist
**empty**, every device is read-only (fail-closed), and so is a request that arrives without the
header. In that state nothing can drive a pane, including a hand-made `curl`; recovery is an `.env`
edit plus a restart.

This variant assumes the proxy is **on the same host**, reaching the bridge on loopback. If your
proxy runs on a *different* node and its upstream is the bridge's own `tailscale serve` URL, the
trust story changes — see [Variant D](#variant-d--off-host-identity-proxy-over-the-tailnet).

## Variant C — reverse proxy as the only front door (no Tailscale)

A reverse proxy (Caddy, Nginx, …) is the **sole ingress** — no Tailscale in the path. Choose this
when the host isn't on a tailnet, or when you already run a TLS-terminating proxy with its own access
control (SSO, mTLS, a VPN gateway) and want Collie behind it like any other upstream.

Set `COLLIE_SKIP_SERVE=1` so `collie-ctl.sh start` builds, starts and supervises the bridge but
**never touches `tailscale serve`** — the proxy owns ingress. The bridge still binds loopback only;
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
COLLIE_PUBLIC_HOSTS=collie.example.com              # Host allowlist — blocks DNS rebinding
COLLIE_ALLOWED_ORIGINS=https://collie.example.com   # exact public origin for the same-origin gate
COLLIE_DEVICE_HEADER=X-Device-Id                    # the header your proxy injects…
COLLIE_DEVICE_ALLOWLIST=my-phone,my-laptop          # …and the ids allowed to drive; others → read-only
# COLLIE_PUBLIC_URL=https://collie.example.com      # optional — shown in the collie-ctl.sh status banner
```

> ⚠️ **`COLLIE_TRUSTED_USER` does nothing here.** It gates on `Tailscale-User-Login`, which only
> `tailscale serve` injects — with no Tailscale in the path there is no injector, so the check has
> nothing to compare against and every request passes it. It fails *open*, not closed, and the bridge
> logs a startup warning saying so. **Per-device auth (`COLLIE_DEVICE_HEADER`) is the write gate**,
> and the **proxy must provide TLS and its own access control** — anyone who reaches the proxy gets
> read access to every pane. Give the proxy the same respect you'd give the tailnet.

> ⚠️ **Never blanket-cache, and never refuse the static bundle to a signed-out client.** Both are
> the same fact: a service worker that goes stale or can't be fetched never self-heals. The bridge
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
if your flow lives somewhere you can't move, redirect `/auth/` to it. When the bridge answers there
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

The proxy is on a *different machine*, so it can't reach the bridge on loopback. The agent host
publishes the bridge **tailnet-only** with `tailscale serve --http`, and the proxy's upstream is that
tailnet URL:

```
  phone ──── https ────► ingress node          TLS + forward-auth; SETS the device header
                            │
                            │  http, never leaves the tailnet (WireGuard encrypts it)
                            ▼
                        host.your-tailnet.ts.net:8787     tailscale serve --http, tailnet-only
                            │
                            ▼
                        127.0.0.1:8787                    the bridge
```

Plain HTTP on the middle hop is fine *because it rides the tailnet* — TLS terminates at the proxy.
That is not the same thing as serving Collie over plain HTTP publicly, which is what the
`COLLIE_SERVE_MODE=http` warnings elsewhere are about.

The **four proxy requirements from
[Variant B](#variant-b--identity-aware-proxy--per-device-authorisation) apply**, except (3): proxy to
the host's tailnet URL rather than `127.0.0.1`.

> ⚠️ **A Tailscale ACL is mandatory in this variant.** The bridge's tailnet URL has to stay reachable
> or the proxy couldn't reach it either, so there is a permanent second path to the bridge that skips
> your forward-auth entirely — and **`tailscale serve` forwards a client-supplied device header
> untouched** (verified: it arrives at the bridge unmodified). Your proxy's mandatory *override* only
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
>     dst: ["agent-host:1-8786", "agent-host:8788-65535"]   # everything EXCEPT the bridge
> ```
>
> Per-device auth is still required, and it does real work: since 0.15.0 a request arriving *without*
> the header is read-only, so a stray client, another service or the host's own loopback URL can watch
> but never drive. What it cannot do is stop a caller who deliberately sets the header. The ACL is
> what stops that, and the two together are the posture.

**Host and Origin are different values here** — the one place this trips people up. `tailscale serve`
Host-routes on the host's own MagicDNS name, so the proxy generally must rewrite `Host` to the
upstream (in Traefik, `pass_host_header: false`). The bridge then sees the *tailnet* Host while the
browser's Origin is your *public* name, so the two settings take different values:

```bash
COLLIE_SERVE_MODE=http                                # proxy terminates TLS; this hop is tailnet-internal
COLLIE_HOST=127.0.0.1                                 # keep loopback (default)
COLLIE_DEVICE_HEADER=X-Tailnet-Device                 # header your forward-auth injects — REQUIRED here
COLLIE_DEVICE_ALLOWLIST=my-phone,my-laptop            # ids allowed to drive; others + header-less → read-only
COLLIE_PUBLIC_HOSTS=host:8787,host.your-tailnet.ts.net:8787   # the Host the proxy forwards
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

A header-less request must be read-only. **If it says `"authorized":true`, your bridge predates
0.15.0** — update before going further.

> ⚠️ **Don't test reachability from the agent host.** A connection to your own tailnet IP is handled
> locally and never crosses the peer packet filter, so `curl http://host.your-tailnet.ts.net:8787`
> succeeds *there* even when the ACL is flawless. It is the most obvious machine to test from, since
> it's the one you're configuring, and it will tell you your ACL is broken when it isn't. Reachability
> is only observable from a second device.

## Variant E — any other mesh or tunnel (NetBird, ZeroTier, Cloudflare Tunnel)

Tailscale is the **default**, not a requirement. Collie's own Tailscale coupling is one header read
and a convenience in `collie-ctl.sh`; the bridge itself is a loopback HTTP server that gates on
`Host`, `Origin`, and two optional headers. Anything that can reach `127.0.0.1:$COLLIE_PORT` can
front it.

Collie deliberately **manages** only one front door — the one this project runs and tests. For every
other tunnel you own the ingress and Collie stays out of the way:

```bash
COLLIE_SKIP_SERVE=1                                 # never run tailscale serve
COLLIE_PUBLIC_HOSTS=collie.example.com              # exact public host — blocks DNS rebinding
COLLIE_ALLOWED_ORIGINS=https://collie.example.com   # exact public origin for the same-origin gate
```

Then point your tunnel at `127.0.0.1:$COLLIE_PORT` and start it however you start your other
services. `netbird expose 8787`, a ZeroTier-routed reverse proxy and `cloudflared tunnel` all work
this way. `collie-ctl.sh start` will build, launch and supervise the bridge and publish nothing;
`unserve` and `uninstall` likewise leave your tunnel alone, exactly as under
[Variant C](#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale).

Three things to get right, none of them Collie-specific:

1. **The [Variant B](#variant-b--identity-aware-proxy--per-device-authorisation) proxy requirements
   apply verbatim.** Loopback upstream, the public `Host` forwarded unchanged (or listed in
   `COLLIE_ALLOWED_ORIGINS`), and — if you use the device gate — the identity header **overridden**
   on every request, never merely added.
2. **`COLLIE_TRUSTED_USER` does nothing here**, for the reason it does nothing behind a reverse proxy
   ([Variant C](#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale)): nothing injects
   `Tailscale-User-Login`, so the check passes every request rather than blocking it, and the bridge
   warns about that at startup. If your tunnel authenticates and injects a device identity, use
   `COLLIE_DEVICE_HEADER` + `COLLIE_DEVICE_ALLOWLIST` instead; if it authenticates but injects
   nothing, its own auth *is* the whole gate and anyone who passes it gets full Collie access.
3. **Pin a stable hostname before you install the PWA.** A service-worker cache is per-origin, and
   several tunnels hand out a fresh generated name per session. A name that changes gives you a new
   install each time and makes `COLLIE_PUBLIC_HOSTS` unpinnable.

> ⚠️ **Anything that publishes to the open internet is a `funnel` by another name** — see the rule in
> [README → Security](./README.md#%EF%B8%8F-security--read-before-you-run-it). Prefer a tunnel scoped
> to your own devices over a public URL with a gate on it.

## Several Collies on one host

One shared machine, one Unix user per developer, each running their own Herdr and their own Collie.
The machine has a single tailnet name, so the thing that has to differ per user is the **port at both
ends**: the loopback port the bridge binds, and the tailnet port `tailscale serve` publishes.

Per user, in that user's `.env`:

```bash
COLLIE_PORT=8801                    # loopback port — unique per user
COLLIE_SERVE_PORT=8443              # tailnet https listener — unique per user
COLLIE_TRUSTED_USER=dev-a@example.com   # ONLY this tailnet person may reach this Collie
```

The next developer takes `8802` / `8444`, and so on. Each gets their own URL —
`https://host.your-tailnet.ts.net:8443` — which `collie-ctl.sh url` and `qr` report as usual.

Two things to get right:

- **`COLLIE_TRUSTED_USER` is what keeps the herds apart.** Every developer is on the same tailnet, so
  without it any of them can open any of the others' Collies and drive their agents. `tailscale serve`
  injects the caller's tailnet login and Collie rejects every other identity.
- **Publishing needs root or the Tailscale operator.** `tailscale serve` may be run only by root or by
  the one user named in `tailscale set --operator=`, and there is exactly one such user per machine.
  So either the admin runs the serve step for each developer, or grants them sudo for that one
  command. It is a `--bg` mapping: it is published once and persists across restarts and reboots, so
  this is a setup-time act, not a per-start one. Everything else — `start`, `restart`, `update` —
  the developer runs as themselves.

`COLLIE_SERVE_PORT` applies to the https front door only. Under `COLLIE_SERVE_MODE=http` the tailnet
listener already *is* `COLLIE_PORT`, so setting both is a contradiction and `serve` refuses it rather
than pick a winner.
