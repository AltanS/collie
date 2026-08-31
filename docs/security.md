# Security — read before you run it

**Collie is remote shell access to your machine, by design.** One Collie API call types arbitrary
keystrokes into a live terminal pane, so anyone who can reach the URL can read every pane (source,
secrets, env, agent output) and run any command as your user. No sandbox, no command allow-list
(that would defeat the purpose). Treat the URL like a root login.

The sharp edges:

- **It acts as _you_**, with your full privileges — `~/.ssh`, `git push --force`, `rm -rf`, `sudo`.
- **Access is device-level, not person-level.** Tailscale proves the device, not who's holding it —
  no password, no session, so an unlocked or stolen phone is an open shell. Pairing a device is the
  answer to that ([below](#pair-a-device--the-write-credential)); the idle lock is not — it pauses an
  unattended screen and gates nothing (details:
  [ADR 0007](../.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md)).
- **Every uid on the host can reach it.** Herdr's socket is a file, so its permissions keep other
  local users out; Collie's port is TCP, so they're all in. Pairing or the per-device gate closes the
  write half of that; reads stay open, so it bounds damage, not disclosure (details:
  [ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)).
- **One collie fronts _every_ session** under your config root by default, sandbox ones included
  (details: [Multi-session](configure.md#multi-session)).
- **Every write is appended to `<state-dir>/audit.log`** — replies, keys, uploads, pane and tab
  create/close. A trail is not a gate (details:
  [ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)).
- **The defenses:** loopback bind only, never `0.0.0.0` (the bridge refuses to start on a wide bind
  unless you set `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`); exactly one hardened front door —
  `tailscale serve` or a conforming reverse proxy, never `funnel` and never a bare port; a
  same-origin gate and a strict CSP, with pane output rendered as React text nodes rather than
  `innerHTML`. Host-header validation is on by default and fails closed (`COLLIE_ALLOW_ANY_HOST=1`
  turns it off), and a non-loopback bind refuses to start. `COLLIE_TRUSTED_USER` is yours to set, and
  you should: it rejects a mismatching *or missing* `Tailscale-User-Login` (tagged nodes get no
  header; `COLLIE_TRUSTED_USER_OPTIONAL=1` restores the old missing-header pass). Authorising
  individual *devices* is [pairing](#pair-a-device--the-write-credential) — no proxy required — or,
  if a proxy already injects a device identity, `COLLIE_DEVICE_HEADER` + `COLLIE_DEVICE_ALLOWLIST`, see
  [`DEPLOYMENT.md`](../DEPLOYMENT.md).

> 🚫 **Never `tailscale funnel` this** — funnel exposes it to the public internet; `serve` keeps it
> tailnet-only. There is no scenario where funneling Collie is correct.

Narrow the blast radius with Tailscale ACLs and `COLLIE_TRUSTED_USER`. Provided as-is, no warranty.

## Pair a device — the write credential

The two device gates answer different questions, and you can run either, both, or neither:

| | asks | trusts | revoke by |
| --- | --- | --- | --- |
| `COLLIE_DEVICE_HEADER` | *is this device on the operator's list?* | your proxy, to inject a name it sanitised | editing `COLLIE_DEVICE_ALLOWLIST`, then restarting |
| **pairing** | *does this device hold a credential I issued?* | nothing on the network | `collie devices revoke <label>` — live |

Pairing costs no infrastructure, so it is the one to reach for on a plain `tailscale serve` setup,
where there is no proxy to inject a header in the first place. Both are **write** gates: reads stay
open to anything that clears the same-origin gate either way.

```bash
bin/collie pair          # on the host — prints an 8-character code, good for 10 minutes
```

Open Collie on the phone → **Settings** → **Paired devices** → enter the code and a name for the
device. The phone stores the token it gets back; Collie stores only its hash, and the token is
shown exactly once. Nothing needs restarting — the running service picks up a pairing (and a
revocation) on the next request.

```bash
bin/collie devices list             # what holds a credential, and when each was last seen
bin/collie devices revoke old-phone # effective immediately, no restart
```

**Pairing the first device turns the requirement on for every device**, so pair the phone you are
holding first. Revoking the last one turns it back off — there is no state in which you are locked
out of your own collie. A wrong code is worth five attempts before the code is destroyed and you have
to run `collie pair` again.


---

[← back to the README](../README.md)
