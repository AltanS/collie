# Security — read before you run it

**Collie provides remote shell access to your machine by design.** A single Collie API call sends
arbitrary keystrokes directly to a live terminal pane. Anyone with network access to the URL can
read every pane (source code, secrets, environment variables, agent output) and execute commands as
your user.

There is no sandbox and no command allow-list, as filtering commands would defeat the purpose of
the tool. Treat the URL as a root login.

## Pair a device — the write credential

```bash
# on the host — prints an 8-character code and a QR code, good for 10 minutes
bin/collie pair
```

This closes only the write path; the [risk model](#risk-model) below covers what it leaves open.

Open Collie on the phone, go to **Settings** → **Paired devices**, and enter the code with a label
for the device, or scan the QR code printed by the command to open directly to that screen with
the code already filled in. The phone stores the returned token. Collie keeps only the hash, and
the token is displayed once. You do not need to restart the process; the running daemon applies
pairings and revocations on the next request.

The two device gates answer different questions, and you can run either, both, or neither:

| | asks | trusts | revoke by |
| --- | --- | --- | --- |
| `COLLIE_DEVICE_HEADER` | *is this device on the operator's list?* | your proxy, to inject a name it sanitised | editing `COLLIE_DEVICE_ALLOWLIST`, then restarting |
| **pairing** | *does this device hold a credential I issued?* | nothing on the network | `collie devices revoke <label>` — live |

Pairing requires no extra infrastructure. It fits a direct `tailscale serve` setup where no proxy
exists to inject headers.

Both options gate write access, and one read: the [Files view](changes.md#files), which can show
every file under a workspace's folder. Every other read remains open to anything that passes the
same-origin check.

```bash
bin/collie devices list             # what holds a credential, and when each was last seen
bin/collie devices revoke old-phone # effective immediately, no restart
```

The write gate is active only while at least one device is paired. No device is paired until you
run `collie pair`, so until then read and write operations function as before. Pair your current
phone first. Revoking the final device disables the gate again to prevent lockouts.

Five failed code attempts invalidate the code, which requires running `collie pair` again.

### Give a device an expiry

A paired device keeps its token until you revoke it. To limit that, pass a lifetime when you pair:

```bash
bin/collie pair --expires 30d             # also 12h, 2w; at most 3650d
bin/collie devices set-expiry pixel 90d   # a new lifetime, counted from now
bin/collie devices clear-expiry pixel     # no expiry again
```

The lifetime counts from the moment the phone claims the code. Without `--expires`, a token never
expires, exactly as before, and no existing token changes. After the expiry, the bridge refuses the
token with `device expired` instead of `device not paired`. The phone then drops the token and shows
**Pair again** in Settings, so run `collie pair` for a new code. `collie devices list` and the
Settings screen show each device's expiry. An expired device stays in the list, and it still keeps
pairing on, until you revoke it or give it a new expiry with `set-expiry`. A crew deputy's standby
door refuses an expired token too.

On a host running multiple instances, prefix commands with `COLLIE_INSTANCE=<name>` and open that
specific instance URL on the phone
([Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host)).

## Risk model

Key security boundaries and risks:

- **It runs with your user permissions.** Collie inherits your full access rights, including
  `~/.ssh`, `git push --force`, `rm -rf`, and `sudo`.
- **Authentication identifies devices, not humans.** Tailscale verifies the hardware endpoint rather
  than the user holding it. There are no passwords or user sessions; an unlocked or stolen phone
  provides an open shell. You can mitigate this by pairing the device
  ([above](#pair-a-device--the-write-credential)). The built-in idle lock merely blanks an
  unattended screen and provides no actual security boundary
  ([ADR 0007](../.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md)).
- **All local system users can reach the port.** Standard terminal multiplexer sockets (`tmux`,
  `zellij`, `herdr`) use filesystem permissions to restrict access to other local users. Collie
  listens on a local TCP port, which exposes it to every local UID. Pairing or the per-device gate
  restricts write access, but read operations remain accessible to all local users. This limits
  execution risks but does not prevent data disclosure
  ([ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)).
- **The Files view reads files off your disk.** It shows any file under a workspace's folder, except
  a `.git` folder, Collie's own state and config folders, and files named like a Collie state
  secret. So it asks for an authorised device, like a write
  ([ADR 0083](../.adr/0083-the-files-view-reads-the-changes-root.md)).
- **Files is gated only when a device is paired or `COLLIE_DEVICE_HEADER` is set.** Until then,
  every device that can read panes can browse and read files under the workspace's folder, `.env`
  files included. Pair your phone to close it.
- **Credential files under a workspace's folder are readable.** A workspace opened in `~/.claude`,
  `~/.codex`, `~/.config/gh` or `~/.ssh` shows what is there. So does the `.env` of a second Collie
  whose config folder sits under the workspace. A hard link inside the folder to a file outside it is
  not caught either.
- **A single instance exposes all sessions.** By default, one Collie process fronts every
  multiplexer session discovered under Herdr's configuration root, including sandbox sessions
  ([Multi-session](configure.md#multi-session)).
- **Writes are recorded to `<state-dir>/audit.log`**, which is `~/.local/state/collie/audit.log`
  unless `COLLIE_STATE_DIR` moves it. The server logs all incoming keystrokes,
  replies, file uploads, and pane/tab lifecycle events. Note that an audit log provides visibility
  after the fact rather than access control. Characters sent in Type mode are never written to the
  log: `COLLIE_AUDIT_CONTENT=none` redacts each one, and the default preview records only a count of
  `•` marks. Named keys such as Enter and Ctrl+C stay readable.
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
| `COLLIE_ACCESS_TEAM` + `COLLIE_ACCESS_AUD` | Cloudflare Tunnel only. Rejects every remote request unless its `Cf-Access-Jwt-Assertion` verifies for this Access app. Only a local process on loopback, `/api/health` and the crew links skip it, and pairing still applies. Other front doors, such as `tailscale serve`, are refused too ([Cloudflare Tunnel](deployment.md#cloudflare-tunnel)). |
| `COLLIE_DEVICE_HEADER` | Name of the header your proxy injects with a device id. |
| `COLLIE_DEVICE_ALLOWLIST` | Comma-separated device ids allowed to write; every other device stays read-only ([`docs/deployment.md`](deployment.md)). |
| `COLLIE_REDACT=off` | Turns off the secret mask on pane text ([below](#what-leaves-the-machine-is-masked)). On by default. |

> 🚫 **Never use `tailscale funnel` with Collie.** Funnel routes traffic to the public internet,
> whereas `tailscale serve` restricts access to your private tailnet. There is no supported use case
> for running Collie over Funnel.

Restrict access further with Tailscale ACLs and `COLLIE_TRUSTED_USER`. Provided as-is, without
warranty.

## What leaves the machine is masked

Collie masks known secret shapes in pane text before that text reaches a phone.

```bash
# in your .env, only to turn the mask off; it is on by default
COLLIE_REDACT=off
```

The mask runs on the bridge, on three paths: the terminal mirror, the Chat and History views, and
every push notification. What it hides becomes `•` marks of the same width, so the mirror's columns
and line count hold. A vendor prefix stays readable, so `sk-o••••` still tells you what was hidden.

It matches high-confidence shapes only:

| shape | example of what is masked |
| --- | --- |
| prefixed API keys | `sk-…`, `sk-ant-…`, `sk-or-v1-…`, `ghp_…`, `github_pat_…`, `xoxb-…`, `AKIA…`, `AIza…`, `glpat-…`, `npm_…` |
| JWTs | three base64url parts, the first starting `eyJ` |
| PEM private keys | every line between `BEGIN … PRIVATE KEY` and its `END` line |
| bearer tokens | the token after `Bearer `, 20 characters or more |
| named values | the value after `password=`, `secret:`, `token=`, `api_key:` and similar, 8 characters or more |

> **Caution.** This is a mitigation, not a guarantee. A plain password on its own, a bare hex or
> base64 value, and a key with a prefix not in the list are missed on purpose. A pattern for them
> would mask ordinary text and code on every screen.

Some ordinary text is masked too, for example a line of prose or YAML that reads `token: something`.
What you type and send is never masked, and the audit trail keeps its own rules
(`COLLIE_AUDIT_CONTENT`).

A push notification also names a pane only by the name you gave it: the pane's label, Claude's
`/rename` name, or a one-pane tab's name. It never uses the title a program in the pane set, because
any program can set that title, and a title can hold a path, a command or a secret. A pane with no
such name is called by its harness, for example `claude`.

## Secret files on Windows

On Windows (experimental), Collie keeps its secret files private to your account, SYSTEM and
Administrators. "Your account" is the Windows account that runs Collie.

NTFS has no `0600` mode, so Collie uses the access control list (ACL) of its state folder and its
config folder. Each file that Collie writes there gets the same list. The default folders in your
user profile are already closed to other standard users. The check matters most when you move a
folder with `COLLIE_STATE_DIR` or another setting.

At start, the bridge checks both folders and their secret files. If other accounts can read one,
the bridge repairs it, but only in Collie's own folders. It saves the old list first, in
`acl-backups` in the state folder, and prints the `icacls /restore` command that puts it back.
Run that command in a terminal run as administrator. A
folder that also holds other files is checked, not changed: Collie prints the `icacls` command
for you to run. Other commands, such as `collie version`, only check and warn.

`collie doctor` shows the result as `secrets-private`. A folder that other accounts can read is an
error, with the fix. A folder that Collie cannot check is a warning: `cannot confirm`.

| Case | What happens |
| --- | --- |
| You copy, restore or sync the folder (zip, `robocopy` without `/SEC`, OneDrive, File History, a USB drive) | The copy can lose the list. Collie checks again at the next start. |
| Antivirus or Controlled folder access blocks the change | Collie says that it could not make the folder private, and gives the fix. |
| The folder is on FAT, exFAT or a network share | There is no list that Collie can use. Collie says `cannot confirm`. Move the state folder to an NTFS drive on this PC. |
| `COLLIE_NO_ACL_REPAIR=1` | Collie changes no list. It still checks and warns, and `doctor` still reports. |

> **Note.** This is not protection from an administrator. Administrators can still read the files.
> It also does not cover other programs that run as your account, hard links inside the folder,
> agent backups in `~/.claude`, or a state folder inside OneDrive or Documents.

## What leaves your machine

Nothing, by default and by policy. Collie sends no install events, no usage statistics, no crash
reports and no analytics. There is no flag that enables them.

The one unprompted outbound call is the update check: an anonymous HTTPS `GET` to GitHub's public
tags API (`bridge/update.ts`) that compares your version to the newest tag. It carries no data about
you or your machine, only the static user-agent `collie-update-check`.

If you set `COLLIE_ACCESS_TEAM`, Collie also fetches that Cloudflare Access team's public keys, at
start and once an hour. That call is yours to turn on, and it sends nothing about you either.

If collection is ever added, explicit opt-in is the ceiling — off by default, asked as a visible
question, never carried by a flag or a default. Removing that promise would be a breaking change
([ADR 0034](../.adr/0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md)).

---

[← back to the README](../README.md)
