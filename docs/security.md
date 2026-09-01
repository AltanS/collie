# Security — read before you run it

**Collie provides remote shell access to your machine by design.** A single Collie API call sends
arbitrary keystrokes directly to a live terminal pane. Anyone with network access to the URL can
read every pane (source code, secrets, environment variables, agent output) and execute commands as
your user. There is no sandbox and no command allow-list, as filtering commands would defeat the
purpose of the tool. Treat the URL as a root login.

Key security boundaries and risks:

- **It runs with your user permissions.** Collie inherits your full access rights, including
  `~/.ssh`, `git push --force`, `rm -rf`, and `sudo`.
- **Authentication identifies devices, not humans.** Tailscale verifies the hardware endpoint rather
  than the user holding it. There are no passwords or user sessions; an unlocked or stolen phone
  provides an open shell. You can mitigate this by pairing the device
  ([below](#pair-a-device--the-write-credential)). The built-in idle lock merely blanks an
  unattended screen and provides no actual security boundary
  ([ADR 0007](../.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md)).
- **All local system users can reach the port.** Standard terminal multiplexer sockets (`tmux`,
  `zellij`, `herdr`) use filesystem permissions to restrict access to other local users. Collie
  listens on a local TCP port, which exposes it to every local UID. Pairing or the per-device gate
  restricts write access, but read operations remain accessible to all local users. This limits
  execution risks but does not prevent data disclosure
  ([ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)).
- **A single instance exposes all sessions.** By default, one Collie process fronts every
  multiplexer session discovered under your configuration root, including sandbox sessions
  ([Multi-session](configure.md#multi-session)).
- **Writes are recorded to `<state-dir>/audit.log`.** The server logs all incoming keystrokes,
  replies, file uploads, and pane/tab lifecycle events. Note that an audit log provides visibility
  after the fact rather than access control
  ([ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)).
- **Default defensive controls.** Collie binds strictly to loopback interfaces. The bridge refuses
  to bind to `0.0.0.0` unless you set `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`. Route traffic solely
  through `tailscale serve` or an equivalent reverse proxy; do not use `tailscale funnel` or expose
  raw ports. The web interface applies strict CSP rules, enforces same-origin checks, and renders
  pane outputs as React text nodes instead of `innerHTML`. Host-header validation is enabled by
  default and fails closed; set `COLLIE_ALLOW_ANY_HOST=1` to disable it. Set `COLLIE_TRUSTED_USER`
  to reject requests where the `Tailscale-User-Login` header is missing or does not match (tagged
  nodes do not send this header; use `COLLIE_TRUSTED_USER_OPTIONAL=1` to permit missing headers). To
  authorize specific hardware, use [pairing](#pair-a-device--the-write-credential) directly, or
  configure `COLLIE_DEVICE_HEADER` and `COLLIE_DEVICE_ALLOWLIST` if your proxy injects device IDs
  ([`DEPLOYMENT.md`](../DEPLOYMENT.md)).

> 🚫 **Never use `tailscale funnel` with Collie.** Funnel routes traffic to the public internet,
> whereas `tailscale serve` restricts access to your private tailnet. There is no supported use case
> for running Collie over Funnel.

Restrict access using Tailscale ACLs and `COLLIE_TRUSTED_USER`. Provided as-is, without warranty.

## Pair a device — the write credential

The two device gates answer different questions, and you can run either, both, or neither:

| | asks | trusts | revoke by |
| --- | --- | --- | --- |
| `COLLIE_DEVICE_HEADER` | *is this device on the operator's list?* | your proxy, to inject a name it sanitised | editing `COLLIE_DEVICE_ALLOWLIST`, then restarting |
| **pairing** | *does this device hold a credential I issued?* | nothing on the network | `collie devices revoke <label>` — live |

Pairing requires no extra infrastructure. It fits a direct `tailscale serve` setup where no proxy
exists to inject headers. Both options gate write access only. Read requests remain open to anything
that passes the same-origin check.

```bash
bin/collie pair          # on the host — prints an 8-character code, good for 10 minutes
```

Open Collie on the phone, go to **Settings** → **Paired devices**, and enter the code with a label
for the device. The phone stores the returned token. Collie keeps only the hash, and the token is
displayed once. You do not need to restart the process; the running daemon applies pairings and
revocations on the next request.

```bash
bin/collie devices list             # what holds a credential, and when each was last seen
bin/collie devices revoke old-phone # effective immediately, no restart
```

Pairing the first device enables the write gate globally. Pair your current phone first. Revoking
the final device disables the gate again, preventing lockouts. Five failed code attempts invalidate
the code, requiring a new run of `collie pair`.


---

[← back to the README](../README.md)
