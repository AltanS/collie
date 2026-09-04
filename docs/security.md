# Security — read before you run it

**Collie provides remote shell access to your machine by design.** A single Collie API call sends
arbitrary keystrokes directly to a live terminal pane. Anyone with network access to the URL can
read every pane (source code, secrets, environment variables, agent output) and execute commands as
your user.

There is no sandbox and no command allow-list, as filtering commands would defeat the purpose of
the tool. Treat the URL as a root login.

## Risk model

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
  multiplexer session discovered under Herdr's configuration root, including sandbox sessions
  ([Multi-session](configure.md#multi-session)).
- **Writes are recorded to `<state-dir>/audit.log`**, which is `~/.local/state/collie/audit.log`
  unless `COLLIE_STATE_DIR` moves it. The server logs all incoming keystrokes,
  replies, file uploads, and pane/tab lifecycle events. Note that an audit log provides visibility
  after the fact rather than access control
  ([ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)).
- **Default defensive controls.** Collie binds strictly to loopback interfaces, routes traffic
  solely through `tailscale serve` or an equivalent reverse proxy, and applies strict CSP rules,
  same-origin checks, and host-header validation. Pane output renders as React text nodes instead of
  `innerHTML`. Never use `tailscale funnel` or expose a raw port. To authorize specific hardware, use
  [pairing](#pair-a-device--the-write-credential) directly, or, if your proxy injects device IDs, the
  two `COLLIE_DEVICE_*` variables below.

| variable | what it does |
| --- | --- |
| `COLLIE_ALLOW_NON_LOOPBACK_BIND=1` | Opts out of the loopback-only bind; unset, the bridge refuses to bind to `0.0.0.0`. |
| `COLLIE_ALLOW_ANY_HOST=1` | Disables host-header validation, which is otherwise on by default and fails closed. |
| `COLLIE_TRUSTED_USER` | Rejects a request whose `Tailscale-User-Login` header is missing or does not match. |
| `COLLIE_TRUSTED_USER_OPTIONAL=1` | Permits a missing `Tailscale-User-Login` header (tagged nodes never send one). |
| `COLLIE_DEVICE_HEADER` | Name of the header your proxy injects with a device id. |
| `COLLIE_DEVICE_ALLOWLIST` | Comma-separated device ids allowed to write; every other device stays read-only ([`docs/deployment.md`](deployment.md)). |

> 🚫 **Never use `tailscale funnel` with Collie.** Funnel routes traffic to the public internet,
> whereas `tailscale serve` restricts access to your private tailnet. There is no supported use case
> for running Collie over Funnel.

Restrict access further with Tailscale ACLs and `COLLIE_TRUSTED_USER`. Provided as-is, without
warranty.

## What leaves your machine

Nothing, by default and by policy. Collie sends no install events, no usage statistics, no crash
reports and no analytics. There is no flag that enables them.

The one unprompted outbound call is the update check: an anonymous HTTPS `GET` to GitHub's public
tags API (`bridge/update.ts`) that compares your version to the newest tag. It carries no data about
you or your machine, only the static user-agent `collie-update-check`.

If collection is ever added, explicit opt-in is the ceiling — off by default, asked as a visible
question, never carried by a flag or a default. Removing that promise would be a breaking change
([ADR 0034](../.adr/0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md)).

## Pair a device — the write credential

```bash
bin/collie pair          # on the host — prints an 8-character code, good for 10 minutes
```

Open Collie on the phone, go to **Settings** → **Paired devices**, and enter the code with a label
for the device. The phone stores the returned token. Collie keeps only the hash, and the token is
displayed once. You do not need to restart the process; the running daemon applies pairings and
revocations on the next request.

The two device gates answer different questions, and you can run either, both, or neither:

| | asks | trusts | revoke by |
| --- | --- | --- | --- |
| `COLLIE_DEVICE_HEADER` | *is this device on the operator's list?* | your proxy, to inject a name it sanitised | editing `COLLIE_DEVICE_ALLOWLIST`, then restarting |
| **pairing** | *does this device hold a credential I issued?* | nothing on the network | `collie devices revoke <label>` — live |

Pairing requires no extra infrastructure. It fits a direct `tailscale serve` setup where no proxy
exists to inject headers.

Both options gate write access only. Read requests remain open to anything that passes the
same-origin check.

```bash
bin/collie devices list             # what holds a credential, and when each was last seen
bin/collie devices revoke old-phone # effective immediately, no restart
```

The write gate is active only while at least one device is paired. No device is paired until you
run `collie pair`, so until then read and write operations function as before. Pair your current
phone first. Revoking the final device disables the gate again to prevent lockouts.

Five failed code attempts invalidate the code, which requires running `collie pair` again.

On a host running multiple instances, prefix commands with `COLLIE_INSTANCE=<name>` and open that
specific instance URL on the phone
([Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host)).


---

[← back to the README](../README.md)
