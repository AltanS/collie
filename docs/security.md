# Security — read before you run it

**Collie provides remote shell access to your machine by design.** A single Collie API call sends
arbitrary keystrokes directly to a live terminal pane. Any device you paired can read every pane
(source code, secrets, environment variables, agent output) and execute commands as your user.
Since 1.18.0 every API request needs a paired device's token, reads included, so the door is
pairing itself: anyone who can reach the URL and holds a valid pairing code gets the same access.
Before 1.18.0, anyone who could reach the URL could read every pane.

There is no sandbox and no command allow-list, as filtering commands would defeat the purpose of
the tool. Treat every paired device as a root login, and a pairing code as a password. Revoke a
lost device at once with `collie devices revoke <label>`. Pairing lowers the risk but does not
remove it, so keep the URL on a private network such as a tailnet, never on the public internet.

## Pair a device — the write credential

Since 1.18.0 this is the credential for every request, reads included, not for writes alone.

```bash
# on the host — prints an 8-character code and a QR code, good for 10 minutes
bin/collie pair
```

Pairing is always on, and reads need the pairing token as well as writes. Until a device is
paired, Collie answers every phone and browser with `403 device not paired`. Open Collie on the
phone first, in the home screen app, because that app keeps its own storage, separate from Safari.
Then run `collie pair` on the host. The steps are in
[Put Collie on your phone and pair it](five-minute-install.md#put-collie-on-your-phone-and-pair-it).

In Collie, go to **Settings** → **System** → **Paired devices**, and enter the code with a label
for the device. On a desktop, you can instead scan or open the QR code printed by the command,
which opens that screen in a browser tab with the code already filled in. On a phone, type the
code in the home screen app, because the camera opens the QR code in a browser tab.

The phone stores the returned token. Collie keeps only the hash, and the token is displayed once.
You do not need to restart the process; the running daemon applies pairings and revocations on
the next request.

The two device gates answer different questions, and you can run either, both, or neither:

| | asks | trusts | revoke by |
| --- | --- | --- | --- |
| `COLLIE_DEVICE_HEADER` | *is this device on the operator's list?* | your proxy, to inject a name it sanitised | editing `COLLIE_DEVICE_ALLOWLIST`, then restarting |
| **pairing** | *does this device hold a credential I issued?* | nothing on the network | `collie devices revoke <label>` — live |

Pairing requires no extra infrastructure. It fits a direct `tailscale serve` setup where no proxy
exists to inject headers.

Pairing gates every `/api` route, reads included. Only three routes stay open: `/api/health`, which
a monitor or a load balancer asks, `/api/pair`, which a device needs before it holds a token, and
`/api/pair/request`, which a device uses to [pair with a phone](#pair-with-a-phone).
`/api/health` answers the build, the crew mode and three counts of the last seven days (how often the
input box read as free, how often it could not be read, and how often a person sent by hand past a
screen Collie could not read). The counts name no pane, no text and no person.

The device header gates writes and two reads: the [Files view](changes.md#files), which can show
every file under a workspace's folder, and the New page's
[Browse](configure.md#favourite-and-recent-folders), which lists folder names under home
([ADR 0086](../.adr/0086-reads-need-the-pairing-token.md)).

```bash
bin/collie devices list             # what holds a credential, and when each was last seen
bin/collie devices revoke old-phone # effective immediately, no restart
```

A fresh install has no paired device, so Collie answers no phone until you run `collie pair`.
Revoking the final device does not open Collie again: every device then gets
`device not paired`. To recover, run `collie pair` on the host and pair the phone again.
`collie doctor` warns while no device is paired.

> **Note.** The crew link and the standby door keep their own credentials. A lead forwards a read
> to a member over pinned mutual TLS and the crew secret, so a member needs no paired device of its
> own ([crew](crew.md)).

Five failed code attempts invalidate the code, which requires running `collie pair` again. On top of
that, the bridge refuses more than ten pairing attempts per source address per minute with `429` and
`Retry-After: 60`. Behind a front door on the same machine, the source address is the last
`X-Forwarded-For` entry, the one the front door adds. From any other peer, that header is ignored. The
counters live in memory and reset when the bridge restarts.

### An agent does not pair a device

`collie pair` refuses in a pane where an agent works. A paired device can read and drive every
session, approve a trick and answer a Decision. An agent that pairs one for itself skips every tap
Collie asks of you. So the command asks the running bridge whether its pane runs an agent, the same
check `collie trick on` makes, and refuses there. `collie pair --json` refuses too. Run it in a
shell pane or a terminal of your own. With no bridge running, or a bridge that does not know the
pane, it does not refuse. The check is a speed bump, not a wall
([What a program running as you can still do](#what-a-program-running-as-you-can-still-do)).

Each pairing writes one `pair` line to the audit log. The line names the device's label, the route
the claim came by, and the pane that made the code. The route is an address class: `loopback`,
`tailnet`, `lan` or `internet`, never the address. Behind a front door on the same machine, such as
`tailscale serve`, `forwardedFrom` gives the class of the address that door passed on. A local
program can write that header itself, so `route` is the fact and `forwardedFrom` is a claim. The
pane is `mintSession` and `mintPane`, or `not placed` when `collie pair` ran outside a pane or no
bridge placed it. The label is the device's only id: `collie devices revoke` takes it. A refused
`collie pair` writes a `pair-refused` line with the reason `agent-pane`. The log never holds the
code or the token.

```json
{"ts":"2026-11-11T09:30:00.000Z","action":"pair","device":"pixel","detail":{"label":"pixel","route":"loopback","forwardedFrom":"tailnet","mintSession":"main","mintPane":"w1:p3"}}
```

### Pair with a phone

A browser that is not paired can also ask a paired phone to let it in, with no terminal. In the
browser, tap **Pair with your phone**. It shows a QR code, a 6-character code and a countdown of two
minutes. Scan the QR code with the paired phone. The phone opens **Pair a device** in Collie, which
shows the browser and system that ask (for example `Chrome on Linux`) and the network they ask from.
Then it shows three codes. Tap the one the other screen shows. The phone also names the new device;
the name follows the rules of `collie pair`, and a name in use gets a number.

There is no plain Yes. A link alone can come from anyone who can reach Collie, so the right code is
the proof that you see the other screen. A wrong tap ends the request for good, and so does **Not my
device**. On the right tap, Collie pairs the browser with no expiry, as `collie pair` does without
`--expires`, and hands the browser its token once. The browser stores it as the code form does and
reloads.

The rules the bridge keeps:

- Only a paired device with full access can answer: its own token, and when `COLLIE_DEVICE_HEADER`
  is set, a name on the allowlist too. The CLI's [local read credential](#the-clis-own-reads), a
  browser that is not paired and a crew forward are refused.
- With no paired device, the request is refused, and the browser says to run `collie pair`.
- At most three requests are open at once, and one source address can ask six times in ten minutes.
  Past that, the answer is `429` with `Retry-After`.
- The browser polls with a secret that only it holds, sent in a header. A wrong secret reads the
  same as an unknown request.
- Requests live in memory. A bridge restart drops them, and the browser shows a new code. A token
  the browser did not collect in time is revoked.
- A crew member serves no browser door, so it answers `404`.

Each step writes one line to the audit log: `pair-request` with the route, `pair-approve` with the
approving device, the new label and both routes, and `pair-request-refused` with the reason
`wrong-code`, `refused`, `expired` or `rate`. The log never holds a code, a request id, the secret or
the token.

### The CLI's own reads

At each start the bridge writes a new random secret to `local-secret` in its state folder.
`collie doctor` and `collie crew update` send it to read their own bridge on the same machine.
The file is owner-only, so only your account can read it, and a clean stop deletes it. The
bridge takes it for reads only, never for a write or the Files view, and never from another machine.
It accepts the secret from loopback only, and never on a request that carries a proxy's header such
as `X-Forwarded-For`. A crew member that binds `COLLIE_HOST` to its tailnet address has nothing on
loopback, so there the bridge also accepts it from this machine's own addresses. A plain TCP relay
on the same machine, such as `socat` or `ssh -L`, can still pass the secret on. The file is what
keeps the secret yours, so keep the state folder owner-only.

### Give a device an expiry

A paired device keeps its token until you revoke it. To limit that, pass a lifetime when you pair:

```bash
bin/collie pair --expires 30d             # also 12h, 2w; at most 3650d
bin/collie devices set-expiry pixel 90d   # a new lifetime, counted from now
bin/collie devices clear-expiry pixel     # no expiry again
```

The lifetime counts from the moment the phone claims the code. Without `--expires`, a token never
expires, exactly as before, and no existing token changes. After the expiry, the bridge refuses the
token with `device expired` instead of `device not paired`. The phone then
[clears what the pairing left](#what-unpair-clears-on-the-phone) and shows **Pair again** in
Settings, so run `collie pair` for a new code. `collie devices list` and the Settings screen show
each device's expiry. An expired device stays in the list until you revoke it or give it a new
expiry with `set-expiry`. To pair it again, you can use the same name: the new pairing replaces
the expired entry and revokes its old token, and the audit log records the revoke. A name that a
device still uses, with a token that has not expired, is refused. A crew deputy's standby door
refuses an expired token too.

On a host running multiple instances, prefix commands with `COLLIE_INSTANCE=<name>` and open that
specific instance URL on the phone
([Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host)).

### What unpair clears on the phone

When a pairing ends, the phone deletes what Collie stored under it. This happens when you unpair the
phone from Settings, and when the bridge refuses its token with `device not paired` or `device expired`.

The phone deletes the token, every unsent draft, the saved pane text and herd, the push subscription,
the "No prompts" confirms, and Collie's caches except the app shell. Your settings stay: theme, language, pins and other
preferences hold no session text. Settings asks you to confirm before it revokes any device.

The phone's own wipe is the only one. The bridge sends no `Clear-Site-Data` header, because that
header would also clear your settings and the offline app, and on a shared host name it would
reach the other apps there too.

If the bridge cannot read its list of paired devices, for example a half-written file, it answers
`503 pairing unavailable` instead. The phone then keeps its token and everything it stored, and
tries again.

### What the phone keeps

The phone keeps a small, bounded copy of what it last saw, so a cold open can show it while the
bridge is out of reach. Every item below has a size bound and a lifetime.

| What | Where | How long | At unpair |
| --- | --- | --- | --- |
| Pairing token | localStorage | until unpair, revoke or expiry | deleted |
| Settings: theme, language, pins | localStorage | until you change them | kept |
| Unsent drafts | localStorage | 48 hours | deleted |
| A theme you are trying | sessionStorage | until Keep, Back or the tab closes | kept |
| Push endpoint | localStorage | until it changes | deleted |
| App shell | Cache Storage | until the next build | kept |
| Fonts and push titles | Cache Storage | until replaced | deleted |
| Whistle speech model and engine files (only if you chose to copy them) | Cache Storage | until you remove them | deleted |
| Math engine files this device used (only with an engine chosen) | Cache Storage | until the next build | deleted |
| Herd and pane text, as last seen | IndexedDB `collie-store` | 24 hours | deleted |
| Newest Chat turns of each pane | IndexedDB `collie-store` | 1 day, or the "Keep chat on this phone" setting | deleted |

The last two rows are the on-device store. It holds only text the bridge already
[masked](#what-leaves-the-machine-is-masked), at most 256 KiB per pane and 10 MiB in all, and it
drops the oldest entries first. The pane text and the Chat turns each get half of a pane's 256 KiB,
so one never pushes the other out. The Chat turns are kept whole, as Chat drew them, never as the
raw terminal screen. "Keep chat on this phone" set to Off keeps none and deletes the ones kept.
When a pane asks for a password, the phone drops that pane's entries. Nothing in the store can send a key or a reply. The deletions at unpair are the ones in
[What unpair clears on the phone](#what-unpair-clears-on-the-phone).

The phone's app switcher can also show a pane. When you leave Collie, the phone keeps a picture of
the screen for its list of recent apps, and that picture can show pane text. A web app cannot stop
this: Android took its picture before the page heard that it went to the background (tested on a
Pixel, 2026-10-08), and iOS gives no promise either. If that matters to you, lock the phone or close
Collie before you hand it to someone.

## Risk model

Key security boundaries and risks:

- **It runs with your user permissions.** Collie inherits your full access rights, including
  `~/.ssh`, `git push --force`, `rm -rf`, and `sudo`.
- **Authentication identifies devices, not humans.** Tailscale verifies the hardware endpoint rather
  than the user holding it. There are no passwords or user sessions; an unlocked or stolen phone
  provides an open shell. Pairing ties access to a credential on the device
  ([above](#pair-a-device--the-write-credential)), so revoke a lost phone at once. The built-in
  idle lock merely blanks an unattended screen and provides no actual security boundary
  ([ADR 0007](../.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md)).
- **All local system users can reach the port.** Standard terminal multiplexer sockets (`tmux`,
  `zellij`, `herdr`) use filesystem permissions to restrict access to other local users. Collie
  listens on a local TCP port, which exposes it to every local UID. Reads need the pairing token,
  so another local user who holds no token reads nothing but `/api/health`. The token is the
  boundary: a local user who can read your browser profile can read the token too
  ([ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)).
- **A held permission waits for a person's tap.** With `collie hooks install claude
  --hold-permissions`, Claude's permission hook asks the bridge through a socket file. Only your
  user can open it (mode 0600 in a 0700 folder). The hook checks the socket owner, the folder and
  the state dir above it before it connects. The bridge answers only for a process it places on a
  pane. It never answers alone. A tap must carry the hash of what the card showed. A screen card
  never answers a request whose dialog is not on the screen
  ([Permissions held for the phone](multiplexers.md#permissions-held-for-the-phone)).
- **The Files view reads files off your disk.** It shows any file under a workspace's folder, except
  a `.git` folder, Collie's own state and config folders, and files named like a Collie state
  secret. So it asks for an authorised device, like a write
  ([ADR 0083](../.adr/0083-the-files-view-reads-the-changes-root.md)).
- **The New page's Browse lists folder names under your home.** Names only, with the Files view's
  limits: no dot-folders unless typed, no `.git`, no Collie state or config folder, no link out of
  home, at most 200 rows. It needs an authorised device too
  ([Favourite and recent folders](configure.md#favourite-and-recent-folders)).
- **Every paired device can read files under the workspace's folder.** That includes `.env`
  files. Pair only the devices you trust with the shell itself.
- **Credential files under a workspace's folder are readable.** A workspace opened in `~/.claude`,
  `~/.codex`, `~/.config/gh` or `~/.ssh` shows what is there. So does the `.env` of a second Collie
  whose config folder sits under the workspace. A hard link inside the folder to a file outside it is
  not caught either.
- **A paired device can add launchers.** With the default `[phone] adds = true` on the lead, a phone
  may add a row built from a recipe: an agent plus option chips whose flags the bridge picks from its own
  table. A line typed by hand needs `free_text = true`, which is off by default. A recipe can still
  skip permission prompts. Such a row carries a "No prompts" badge, and each device confirms it once.
  Revoking a device removes the rows it added. Set `adds = false` to turn off every phone-added row.
  The allowlist stays on the phone door: a phone names a row and never sends a line. A member
  accepts a row definition only from its lead, over the pinned crew link, and refuses one that a phone
  sends to it directly. The lead already holds the pairing, so this adds no power over what a paired
  phone can do in a shell
  ([Your own launchers](configure.md#launchers-added-from-a-phone),
  [ADR 0094](../.adr/0094-launchers-added-from-a-phone.md)).
- **A paired device can run a one-off command.** With the default `[phone] run = true`, a phone may
  type a line it wrote into a fresh shell on a machine. This adds no power, because a paired phone can
  already open a shell and type into it. The line follows the free-line character rule, and the bridge
  refuses it with no paired device. Each command that started is kept, up to 12, in
  `commands-recent.json` in the state folder (mode 0600). A line that seems to carry a secret (an
  assignment such as `TOKEN=…`, a URL with a password, or a word such as `token` or `password`) runs
  but is not kept. The check is a guess, so a secret can still slip into the list; the audit log
  records only a line's first word and its length. Unpairing or revoking a device leaves the
  list as it is, because running a line again needs a paired device. Set `run = false` to remove the
  shortcut
  ([One-off commands](configure.md#one-off-commands-and-their-history),
  [ADR 0095](../.adr/0095-one-off-commands-and-their-history.md)).
- **Each machine keeps the shell lines you send through Collie.** Sent keeps a line you send to a
  shell pane, and each one-off command, in `sent.jsonl` in the state folder (mode 0600). A paired
  device can read it, as it can read the panes. Some secrets are still kept
  ([Sent: the shell lines you sent](#sent-the-shell-lines-you-sent)).
- **A single instance exposes all Herdr sessions.** By default, one Collie process fronts every
  Herdr session discovered under Herdr's configuration root, including sandbox sessions
  ([Multi-session](configure.md#multi-session)).
- **Writes are recorded to `<state-dir>/audit.log`**, which is `~/.local/state/collie/audit.log`
  unless `COLLIE_STATE_DIR` moves it. The server logs all incoming keystrokes,
  replies, file uploads, and pane/tab lifecycle events. Note that an audit log provides visibility
  after the fact rather than access control. Characters sent in Type mode are never written to the
  log: `COLLIE_AUDIT_CONTENT=none` redacts each one, and the default preview records only a count of
  `•` marks. Named keys such as Enter and Ctrl+C stay readable
  ([ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)). A durable agent's answers, sends, stops,
  button taps, starts, reopens and renames are recorded too
  ([What is logged](durable-agents-security.md#what-is-logged)).
- **Response headers.** Every response carries `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and `Permissions-Policy: camera=(), geolocation=(),
  microphone=(self), payment=(), usb=()`. The microphone stays allowed for the hands-free speech
  setting. The Content-Security-Policy on the app shell includes `object-src 'none'`,
  `form-action 'self'` and `frame-ancestors 'none'`. `Strict-Transport-Security` is sent only when a
  request arrived over HTTPS, either on a TLS listener or with `X-Forwarded-Proto: https` from your
  proxy. It covers the host name that answered and not its subdomains, because Collie often shares
  a parent domain with other services. The bridge itself speaks plain HTTP behind
  `tailscale serve`, and a browser ignores the header there. Images served from `/api/blobs/` are
  session content, so they carry `Cache-Control: private, no-store` and no cache keeps them, not
  even the phone's own.
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
| `COLLIE_REDACT=off` | Turns off the secret mask on pane text, diffs and file text ([below](#what-leaves-the-machine-is-masked)). On by default. |
| `COLLIE_SENT=off` | Keeps no record of the shell lines you send ([below](#sent-the-shell-lines-you-sent)). On by default. |

> 🚫 **Never use `tailscale funnel` with Collie.** Funnel routes traffic to the public internet,
> whereas `tailscale serve` restricts access to your private tailnet. There is no supported use case
> for running Collie over Funnel.

Restrict access further with Tailscale ACLs and `COLLIE_TRUSTED_USER`. Provided as-is, without
warranty.

## What a program running as you can still do

A person's tap guards pairing, a trick's switch and a Decision's answer. A program that runs under
your own user account can still get a write credential, or skip the tap. The list below states
facts. It is not a list of fixes. The state folder is `~/.local/state/collie` unless
`COLLIE_STATE_DIR` moves it, and the config folder holds the instance's `.env`.

| File or door | What it gives a program that runs as you |
| --- | --- |
| `paired-devices.json` in the state folder | It holds hashes, not tokens, so a read gives nothing to spend. A program that adds its own entry, with the hash of a token it made up, has a paired device. The bridge reads the file on each request, so no restart is needed. |
| `pairing-pending.json` in the state folder | A program that writes the hash of a code it chose can claim that code at `POST /api/pair`. It never runs `collie pair`, so the agent check never runs, and the audit line names whatever pane the file names, or `not placed`. |
| A pairing code on screen | `collie pair` prints its code in a pane. A program that reads that pane through the multiplexer can claim the code before your phone does. The phone then hears that no code waits, and the audit log shows a pairing you did not make. |
| `POST /api/pair` on loopback | It needs a live code. Its `Origin` rule stops a web page, not a local program: a local program writes its own `Origin` and `Host` headers, and a request with no `Origin` is taken from a loopback host name. |
| `local-secret` in the state folder | The CLI's read credential. It reads every session through the bridge on the same machine. It never writes, and never opens the Files view. |
| The profile of a paired browser | The browser keeps its token in local storage. A program that reads the profile files gets a full device token. A program that drives the browser, for example through a debugging port, taps as you. |
| `tricks/switches.json` in the state folder, and `tricks/.collie-approved/` in the config folder | A program that writes an approved copy and its hash into the switch file switches a trick on, with take changes without asking too. No tap is asked. |
| `.collie-origin.json` in a trick folder | It is outside the code hash. A program that edits it changes where Settings says the trick came from. |
| `.env` and `config.toml` in the config folder | A program can loosen a setting, such as `COLLIE_ALLOW_ANY_HOST=1` or `free_text = true` for the launchers a phone adds, then restart the user service. |
| `standby-devices.json` on a crew deputy | A program on the deputy can add the hash of its own token. While the standby door is armed, that token can confirm a takeover, and the takeover adds it to the deputy's own paired devices. |
| `crew-trust.json` in the state folder | It holds this machine's crew key and the crew secret. A program that reads it can speak to the crew as this machine. |
| The multiplexer's socket | A program can type into any pane without Collie at all, a yes on an agent's permission prompt included. |
| `audit.log` in the state folder | A program can change or delete lines. The log tells the truth only while nobody has changed it. |
| Collie's own files: the binary, the checkout and the user service unit | A program that changes them changes what runs as Collie. |

Collie's taps protect against a remote party and against an agent that follows the rules. They do
not sandbox a program that runs as you.

## Durable agents

A durable agent you attach is code you run or deploy, and Collie treats its text as untrusted. A private socket
keeps other users out but not a process of your own user, and a token is the only gate over https.
The trust rules per transport, what Collie does to a durable agent's text and what the audit log keeps are in
[Security of a durable agent](durable-agents-security.md).

## The speech engine (Whistle)

Whistle runs third-party code: a WebAssembly engine from Cactus Compute. It runs on the phone, or on
the host as the bridge's user. Collie bounds what that code can reach. It cannot remove the reach
entirely.

- **Vendored and pinned.** The engine is two files, `needle.js` and `needle.wasm`, kept byte for byte
  as upstream published them, with upstream's licence and a provenance note
  (`web/public/stt/needle-3-93e88ede/`). A test pins the sha256 of both files and the list of the
  sixteen functions the wasm may ask its host for. A new import is a reason to stop. Only a person
  updates the pin, and reads the diff first. The model has its own pinned hash, and Collie keeps a
  downloaded copy only when it matches.
- **On the phone, a worker with its own policy.** The wasm runs in a dedicated worker. The bridge
  serves every script under `stt/` with this policy, and no other page gets it:

  ```
  Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; base-uri 'none'
  ```

  The worker has no network, no DOM and no way to load code from elsewhere. It cannot read the
  pairing token, which sits in `localStorage`, and workers have no `localStorage`. Before it does
  anything else, it compiles a tiny wasm module. A browser that does not give the worker its own
  policy refuses that, and *This phone* shows as unavailable there.
- **The page's policy does not change.** The document policy never gains `'wasm-unsafe-eval'`, and
  it keeps `connect-src 'self'`.
- **What the worker can still reach.** It can read and write this origin's IndexedDB and Cache
  Storage, which no policy directive closes. `collie-store` holds recent pane and Chat text
  ([What the phone keeps](#what-the-phone-keeps)). That text was already masked, but it is readable.
  This reach is accepted, and named in the ADR. If it starts to matter, the next step is a sandboxed
  frame around the worker.
- **On the host, a child of Collie's own binary.** One short-lived child per dictation runs
  `_whistle-transcribe` with a fixed argument list that Collie wrote. It checks the engine, the wasm
  and the model against their pins before it compiles anything. It has a 60-second deadline, killed
  with SIGKILL, a 256 KiB output cap and at most two at once. It gets none of the bridge's `COLLIE_*`
  variables. The bridge sets only two, the state folder and the install folder, to paths it resolved
  itself. Nothing from the request reaches the argument list but the recording.
- **A second outbound call, by a person's tap.** The update check is the first. The model download is
  the second: one file, from one pinned Hugging Face address, written only after its hash matched.
  A phone never calls Hugging Face. It copies the model from the host, with the pairing token. The
  routes need a write device, run on the lead only, allow one download at a time and are audited.
- **Setup from Settings is an exception to "setup is a CLI act".** Providers that store a credential
  or name a command stay in the terminal. Whistle does none of these. A stolen write token can
  already type into terminals and start an update, so the setup tap gives it nothing new.
- **Switching to Codex from Settings is the other exception.** A write device may switch the host
  between Whistle, Codex and Off, and nothing else. Codex needs the full consent, the same words
  `collie stt setup` prints, and a tap on **I accept**; the bridge then runs the CLI's own probe. A
  stolen write token could point the host's speech at the operator's signed-in ChatGPT account. It
  cannot add a key or a command, or replace one. The token can already type `codex` into a
  terminal. [ADR 0097](../.adr/0097-codex-speech-can-be-chosen-from-settings.md) weighs this.
  A switch from Settings also writes the paired device's name, as given at pairing, and the time into
  `stt.json`, so **Host speech** can say who changed it last. No token and no address is written.
  A run of `collie stt setup` drops that line.
- **Paired devices can read what the host's speech settings name, by name only.** That is the
  command's name, a model file's name and a speech service's host name, never a path, an argument,
  a key or a URL path.

Why it is built this way: [ADR 0096](../.adr/0096-speech-can-stay-on-the-phone.md). The setup steps
are in [Voice input and Web Push](voice-and-push.md#whistle-speech-to-text-on-your-phone-or-your-host).

## WalkyTalky

WalkyTalky carries messages between agent sessions, so this section says what a message proves and
what it does not. The commands are in [WalkyTalky](walky-talky.md).

```sh
# in .env, then run `collie restart`
COLLIE_WALKY=off
```

That line makes this machine refuse every message for its panes. The CLI on the machine can still send.

- **A crew key signs a message across machines.** A member signs a message with its crew key. The
  lead checks the signature against the key it pinned for that member, then adds its own signature
  for the machine that receives it. A solo install has no crew key. It signs nothing and sends nothing
  off the machine.
- **The receiver checks the sender, through the lead's word.** A member pins only its lead. So the
  lead sends the sender's certificate with the message, and signs a short statement that this
  certificate belongs to that member of the crew. The receiving machine checks that statement, then
  checks the sender's signature against the certificate. If any check fails, it refuses the message.
  It still trusts the lead about who is in the crew.
- **Only the lead can write an outcome back.** The lead sends a member the outcomes of that member's
  own messages. The member takes them only from its pinned lead, and only for a message it sent and
  still logs. Outcomes and the record of what the lead got stay in memory, and go after 10 minutes.
- **The phone's card needs the log.** The phone draws a message card only when the bridge's own log
  holds that message id. A header that an agent only prints on the screen stays plain text, with the
  mark "no log record on this machine".
- **A pane token is no secret.** The token in an address, such as `#k3f9`, keeps a message from
  reaching a new session that took a closed pane's id. `collie walky who` prints it to every agent,
  and `<stateDir>/walky/instances.json` is readable by your user. It proves nothing about who sends.
- **Every machine a message crosses keeps it.** The sender's machine, the lead and the receiving
  machine each log the message in `<stateDir>/walky/`. The log keeps 7 days and at most 2,000 lines.
  Never put a secret in a message.
- **An agent's message is a peer's words.** The pane gets one line with the sender's header and no
  body. The agent reads the body as the output of `collie walky inbox <id>`, which a harness treats
  as data and not as your instruction. The installed skill tells the agent to weigh it and never to
  run a destructive command because a peer asked.

> **Note.** An agent runs as your user, so it can read the crew key and open the local socket. It
> could sign a message or claim a pane that is not its own. The signature protects a message on its
> way between machines and tells the receiver which machine sent it. It does not protect you from a
> program on the same machine that lies about itself.

The community theme list is another outbound call, and it also happens only on a tap: **Refresh** in
the **Browse community themes** sheet of the **Theme** card. The bridge makes one anonymous HTTPS
`GET`, with the user-agent `Collie/<version>` and nothing about you:

```text
https://colliepwa.dev/themes/registry.json
```

The address is fixed in the bridge. The one exception is `COLLIE_THEME_REGISTRY_URL`, for a test
against a staged copy of the site ([Configure](configure.md#the-community-theme-list)). The bridge
follows a redirect only on the address's own site, refuses a file that is not typed as JSON, over 1 MB or with more than 500 themes,
and keeps a theme only when Collie's own theme parser accepts it. It keeps the list in the `themes` folder of its state folder.
The phone checks every theme again before it draws one, and the page itself never calls colliepwa.dev.
The refresh needs a write device, runs on the lead only, allows one fetch at a time and is audited.
A refresh within a minute of a good fetch answers that copy and fetches nothing. A copy older than a
week is not listed, so the next tap fetches again.

WalkyTalky adds no outbound call. A message to another machine rides the crew link that already
exists, and no model, cloud service or third party sees it.

## What leaves the machine is masked

Collie masks known secret shapes in pane text and file content before it reaches a phone.

```bash
# in your .env, only to turn the mask off; it is on by default
COLLIE_REDACT=off
```

The mask runs on the bridge, on five paths: the terminal mirror, the Chat and History views, every
push notification, the diffs in the Changes view, and the file text in the Files view. What it hides
becomes `•` marks of the same width, so columns and line counts hold. A vendor prefix stays
readable, so `sk-o••••` still tells you what was hidden.

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

The switch lives on the bridge only, as `COLLIE_REDACT`. Settings → System shows it read-only, as
"Secret masking". The phone has no switch on purpose: a switch on the phone would let any paired
phone, or a stolen one, turn the mask off. To read a masked value, read it on the machine. The first
time a pane shows masked text, a short line on the phone says so, once per device. If you paste
masked text into a reply, a caution under the box says the pane gets the dots, not the secret.

In a crew, each member masks its own text, and the lead masks it again before your phone gets it.
The lead masks a member's mirror, Chat, History, diffs, file text and pane titles with the same mask
it uses for its own, so a member that still runs 1.17.x cannot send a key to your phone in clear.
Masked text stays as it is when it is masked again. Text reaches the phone unmasked only when
`COLLIE_REDACT=off` is set on both the lead and the member. One edge: a member on 1.17.x masks
nothing itself, so when a secret sits in the lines a reply is checked against, the phone may refuse
that reply with "The screen changed before that could be sent". The reply then waits until the
member runs 1.18.0.

If the lead cannot read a member's answer to mask it, it does not pass the answer on. The phone then
shows that read as failed, as it does for a member it cannot reach.

A push notification also names a pane only by the name you gave it: the pane's label, Claude's
`/rename` name, or a one-pane tab's name. It never uses the title a program in the pane set, because
any program can set that title, and a title can hold a path, a command or a secret. A pane with no
such name is called by its harness, for example `claude`.

## Sent: the shell lines you sent

Each machine keeps a record of the shell lines you send through Collie, so you can find and send one again.

```bash
# in your .env, to keep no record on this machine
COLLIE_SENT=off
```

| question | answer |
| --- | --- |
| What is kept | A line you send to a shell pane, and each one-off command from the New page. For each line: the text, its folder, the time, and which of the two it was. |
| What is never kept | Prompts to an agent, text for a program, keys from the Keys board, and Type mode. |
| Where | `sent.jsonl` in the state folder, `~/.local/state/collie/` unless `COLLIE_STATE_DIR` moves it. The file is mode 0600, in a folder at 0700. |
| How long | At most 5000 lines on each machine, and none older than 365 days. |
| Who can read it | A paired device, as it can read the panes the lines went to. |
| In a crew | Each machine keeps its own file. The lead asks its members when your phone asks, and keeps no copy. |

Collie sends every line you tap, and then decides whether to keep it. It keeps nothing about a line
that:

- starts with a space or a tab,
- sets a variable, such as `TOKEN=abc deploy` or `export AWS_SECRET_ACCESS_KEY=…`,
- holds a URL with a password, such as `https://user:pass@host`,
- holds a word such as `password`, `secret`, `token`, `bearer` or `authorization`,
- holds a shape the secret mask knows, such as a `ghp_…` or `sk-…` key,
- is longer than 4096 characters.

Such a line leaves no row, no count and no log line with its text.

To keep one line out, start it with a space. The shell runs it as usual, and Collie keeps nothing.

> **Caution.** The check is a guess. It keeps a password you pass as a plain argument, such as
> `mysql -pPASS`, and any secret with a shape it does not know. Start such a line with a space.

To forget one line, use Forget on its row in the Sent sheet. To forget a whole machine, use Clear
Sent. Both work while `COLLIE_SENT=off` is set. The audit log records each forget with a count, never
the line. Every line goes through the secret mask before it leaves the machine.

Why it is built this way: [ADR 0107](../.adr/0107-sent-keeps-shell-lines-per-machine.md).

## Pinned messages

A pin is a copy of the message text. The machine that owns the pane keeps it in `<stateDir>/pins/`,
one file for each session, mode 0600 in a folder at 0700. The file holds the whole text, tool results
included, and every paired device can read it. `COLLIE_REDACT` masks the text that leaves the machine,
not the file: the file keeps the copy as it was. Unpin a message to delete its copy.

A rollback to an older build leaves `pins/` and `math/` in the state folder. An older build does not
read them, so they do no harm, and you can delete both folders by hand.

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

From 1.27.0 each Collie bridge sends one small anonymous ping a day to our own analytics. It carries
the Collie version, the operating system, how Collie was installed, and whether the bridge runs
alone or in a crew, under a random ID made on your machine. No IP address is stored with the ping.
Nothing else is sent: no host name, no folder, nothing you type or read. We need these numbers to
spot regressions and slow degradations after a release, and to steer what gets built next. Up to
1.26.x Collie sent nothing ([ADR 0129](../.adr/0129-an-anonymous-install-count-on-by-default.md)).

When Collie shows one of its two trouble cards, the next ping also carries how often, in six fields:
which card, the name and version of the agent program, the multiplexer it ran on, a count and, from
1.27.4, a screen field on a dialog card. The screen field is a short hash of the dialog's key-hint
row only, never a row with your text, never the screen or what you typed. It is absent unless that
row is a short list of key hints, such as `enter select · esc back`.

Turning it off is one switch: Settings, System, **Telemetry**. `COLLIE_TELEMETRY=0`,
`telemetry = false` in `config.toml` or `DO_NOT_TRACK=1` do the same, and so does blocking the one
host it goes to, `ping.colliepwa.dev`, in your firewall. The first ping waits a day after the first
start of a build that has it. The exact message is written down in the contract in the repository,
[`telemetry/README.md`](https://github.com/AltanS/collie/blob/main/telemetry/README.md).

### What did not change

Besides the daily ping, the one unprompted outbound call is the update check: an anonymous HTTPS `GET` to GitHub's public
tags API (`bridge/update.ts`) that compares your version to the newest tag. It carries no data about
you or your machine, only the static user-agent `collie-update-check`.

The Whistle model download is another outbound call. It happens only when a person taps **Download
to host** or runs `collie stt whistle`, and it sends no data about you ([The speech engine
(Whistle)](#the-speech-engine-whistle)).

The math engines download is another outbound call, and it also happens only on a tap: **Download
the math engines**, or picking an engine in **Settings → Appearance → Math** while the host has
none. The bridge makes two anonymous HTTPS `GET`s to GitHub, with the user-agent `Collie/<version>`
and nothing about you:

```text
https://github.com/<repo>/releases/download/v<version>/collie-<version>.manifest.json
https://github.com/<repo>/releases/download/v<version>/collie-math-<version>.tar.gz
```

`<version>` is the version the bridge runs. `<repo>` is `AltanS/collie`, or `COLLIE_UPDATE_REPO` when you set it. The
bridge takes the pack's size and sha256 from that release's manifest, refuses a file over 64 MiB or
with another hash, and unpacks it itself, with no child process. It keeps the engines in the `math`
folder of its state folder until you remove them on the same card. The routes need a write device,
run on the lead only, allow one download at a time and are audited. A development build never
makes the call ([ADR 0132](../.adr/0132-the-math-engines-are-a-pack-the-host-downloads.md)).

WalkyTalky adds no outbound call. A message to another machine rides the crew link and goes
nowhere else ([WalkyTalky](#walkytalky)).

Report a problem adds no outbound call. After failed sends the phone can open GitHub's new-issue
form, filled in, as a link in your own browser. You read the whole text first and submit it yourself
under your own account. Collie holds no GitHub token and the phone never calls GitHub
([ADR 0123](../.adr/0123-report-a-problem-three-failed-sends-offer-a-prefilled-issue.md)).

If you set `COLLIE_ACCESS_TEAM`, Collie also fetches that Cloudflare Access team's public keys, at
start and once an hour. That call is yours to turn on, and it sends nothing about you either.

If you attach a durable agent by URL, Collie calls that URL on every poll with the durable agent's bearer token in
the `Authorization` header. That call is yours to turn on too, and nothing is sent until you attach
one ([Security of a durable agent](durable-agents-security.md#the-token-transport)).

---

[← back to the README](../README.md)
