# Troubleshooting

Symptoms below, in order — search the page for yours. **`Os { NotFound }` from `herdr plugin`** ·
**`update` says "not currently on a branch"** · **`tailscale serve failed`** · **isn't answering
(service won't start)** · **phone can't open the URL** · **page loads but stays empty (blank page,
403)** · **a password prompt won't take your reply** · **no push notifications** · **gone after a
reboot** · **a pane is stuck narrow** · **Collie refuses to open a tmux window** ·
**`tmux list: output did not parse`** · **`herdr plugin list` shows the old version** ·
**stale UI after a rebuild** · **I saved a machine in Herdr and the phone does not show it** ·
**an update started from the phone stays at staging**.

**`herdr plugin …` fails with `Error: Os { code: 2, kind: NotFound, message: "No such file or
directory" }`** (plugin install fails, action invoke fails)**.** This is *not* a Collie problem — it
means the **Herdr server isn't running**, so its CLI can't reach the control socket
(`~/.config/herdr/herdr.sock`). The tell is the *raw* `Os {…}`
error: a reachable server answers path/manifest problems with structured JSON (e.g.
`plugin_manifest_not_found`), so a bare `Os { NotFound }` is a failed socket connect, before Collie
or your path is ever examined. It hits `link`, `install`, `action invoke` — every subcommand that
talks to the server — while `herdr plugin --help` still works (it never opens the socket). Fix: start
Herdr first (`herdr server &`, or just launch the Herdr TUI — it boots the server), confirm
`ls ~/.config/herdr/herdr.sock` now exists, then retry the install. `herdr plugin list` is a quick
probe: if it throws the same error, the server is down.

**`update` fails with `You are not currently on a branch`.** A GitHub install made before **0.23.1**
([#63](https://github.com/AltanS/collie/issues/63)) — `herdr plugin install` detaches instead of
cloning, so the old `update` had no branch to `git pull` into. The fix ships inside the checkout it
repairs, so it takes one reinstall to land:
[If that fails with *"You are not currently on a branch"*](upgrading.md#if-that-fails-with-you-are-not-currently-on-a-branch)
has the three commands.

**`start` prints `note: tailscale serve failed`.** Collie itself is fine (still up on
`127.0.0.1`) — only the tailnet ingress didn't come up, and tailscale's own error is on the
terminal above the note. Usual causes: your user isn't the Tailscale operator
(`sudo tailscale set --operator=$USER`), the node is logged out (`tailscale up`), or — on
Headscale / `.internal` tailnet domains — HTTPS certs aren't available, which is exactly what
`COLLIE_SERVE_MODE=http` is for: set it in `.env`, then `bin/collie restart`. Verify with
`tailscale serve status`.

**`serve` says `HTTPS certificates are not enabled on this tailnet`.** Nothing was published, and
nothing is waiting. Open the [admin console](https://login.tailscale.com/admin/dns), turn on
"Enable HTTPS", then run `collie serve` again. On Headscale / `.internal` domains there are no
certificates to enable; use `COLLIE_SERVE_MODE=http` instead.

**Banner shows `⚠ Collie isn't answering on :8787 yet`** (service won't start, connection
refused)**.** The service was started but the HTTP server isn't answering the probe. Check the unit
first — `systemctl --user status collie` — then `bin/collie logs` (or
`journalctl --user -u collie -f` to watch live) for why: most commonly the port is already taken
(set `COLLIE_PORT` in `.env`, then `bin/collie restart`, which also re-runs
`tailscale serve` against the new port) or the first build failed (the log says so; fix and run
`bin/collie build`). The unit auto-restarts every 5 s, so once the cause is fixed it usually comes
back on its own.

**Phone can't open the tailnet URL.** Work down the list: (1) the phone runs the Tailscale app and
is *connected* to the same tailnet as the host; (2) you're opening the banner's `tailnet` URL
(`bin/collie url`), not the `local` one — `http://127.0.0.1:8787` only works on the host
itself; (3) MagicDNS is enabled in your tailnet's DNS settings (the URL is a MagicDNS name); (4) the
host is online — check `tailscale status` on the host, or ping the host from the phone's Tailscale
app; (5) **your tailnet policy actually admits a peer to this node** — if it doesn't, the banner now
says so under the `tailnet` line, and nothing else will: the front door is published correctly, the
cert is valid, and `curl` from the host itself returns 200, because loopback never touches the packet
filter. Two things make this one especially misleading — `tailscale ping` **succeeds** (disco pings
bypass ACLs), and blocked traffic is dropped rather than refused, so the phone just hangs and reads
as "server down". Fix it in your ACL policy (<https://login.tailscale.com/admin/acls> on Tailscale;
your policy file on Headscale). The check is best-effort and deliberately unsure of itself: it speaks
up only when this node's filter admits *nothing* — which can equally mean no other device has joined
the tailnet yet — and stays quiet whenever it can't tell.

**Page loads but stays empty** (blank page, white screen); **API calls fail
`403 cross-origin rejected`.** You're reaching Collie through an origin it doesn't expect — a
custom domain, or a proxy that rewrites `Host`. Allow the exact public origin with
`COLLIE_ALLOWED_ORIGINS` (see [Configure](configure.md#configure)), or make the proxy forward `Host` unchanged —
the fourth proxy requirement in
[`docs/deployment.md`](deployment.md#variant-b--identity-aware-proxy--per-device-authorisation).

**A `sudo` (or SSH passphrase, or `gpg`) prompt won't take your reply.** Use **Type** in the
Controls row, not Send. Send *verifies* what it typed by reading it back off the screen before it
presses Enter ([#34](https://github.com/AltanS/collie/issues/34)), and a password prompt turns echo
off, so there is nothing to read back — **Type** sends your keystrokes straight to the pane, Enter
included. Nothing you type in **Type** is stored, echoed into a draft, or restored later, and the
moment Collie recognises a password prompt it drops the stored draft too
([#103](https://github.com/AltanS/collie/issues/103)).

**No push notifications arriving.** Fire one by hand: `bin/collie push-test`. Three
causes, in the order the command distinguishes them:
push says it's disabled (the keys never reached the bridge — run `push-keys` and restart, see
[Web Push](voice-and-push.md#web-push-optional)); it says there are no subscribed devices (this phone never enabled
them in Settings → notifications); or it reports a send and nothing arrives (the phone is on a
plain-HTTP origin, which is not a secure context — Settings flags it `insecure`).

**Collie is gone after a reboot.** On Linux this is almost always lingering, so run
`loginctl enable-linger $USER` ([Surviving reboots](upgrading.md#surviving-reboots)). On macOS the launchd agent starts at
**login**, so check you're actually logged in (not sitting at the login window) and that the agent is
loaded: `launchctl print gui/$(id -u)/herdr.collie`.

**A pane's terminal is stuck narrow, and a full-screen app inside it is squashed** (Copilot CLI,
`top`, any TUI drawn into a strip while the rest of the mirror stays blank)**.** The pane's terminal
is that narrow, and Collie mirrors it faithfully. A Herdr pane's width comes from its rectangle
in the tab's split grid, so a pane sharing a tab gets a share of the columns. Herdr applies
pane geometry **only while a desktop client is attached**
([herdr#1709](https://github.com/herdrdev/herdr/issues/1709)): with nothing attached, closing a split
leaves the survivor stuck at the old narrow width, and `pane.zoom` and `pane.resize` over
the socket do not move it either. Collie cannot fix this from its side; it does not write
pane geometry at all ([ADR 0031](../.adr/0031-freshness-is-a-declared-promise.md): the phone moves
the operator's terminal only on the *Show in terminal* tap). Nothing about it is app-specific:
`top` in a 54-column pane looks identical. To measure it, run `tput cols` in the pane. That is
the real width, and it can disagree with what `herdr pane layout` reports. To fix it, attach a Herdr
client, then zoom or resize the pane there (`herdr pane zoom <pane-id> --on` moves the terminal
once something is attached), or close the pane and open a new one
([#167](https://github.com/AltanS/collie/issues/167)).

**Collie refuses to open a tmux window** (the phone's *new tab* comes back declining, naming
`window-size`)**.** Not a fault in the request: on tmux below 3.7, spawning a window while the
server's `window-size` is `manual` crashes the whole server (tmux #4849, fixed in 3.7), and a crashed
server takes every window with it. Collie declines instead, and names the tmux it saw. The fix is the
line it prints — `tmux set -g window-size latest` on that server — or tmux 3.7. Nothing else is
affected: every other action on those panes keeps working
([Requirements](install.md#requirements) carries the same caveat).

**Collie logs `tmux list: output did not parse` and the dashboard reads empty.** Not a crash: some
tmux versions (3.4, not 3.6b) escape the separator this adapter reads on their way out of a `-F`
listing. Collie reads both shapes now, so a listing that parses to zero rows is reported as a mux
error instead of being stored as an empty herd — the error line names the tmux version and how many
lines it saw. If you still hit this, note the `tmux -V` version and open an issue; the fix belongs in
the adapter, not in your `.env`.

**`herdr plugin list` shows the old version after an `update`.** Expected — Herdr caches the manifest
it read at install or link time. The authority on what's running is the footer build stamp, or
`bin/collie version`. For a linked clone `update` re-links and that self-heals (force it
with `herdr plugin link "$(pwd)"`); on Herdr ≥0.8.0 the manifest is re-read from disk anyway.

**Phone shows a stale UI after a rebuild.** A PWA's service-worker cache is per-origin, so reaching
Collie at two origins (a custom domain *and* the raw `host:8787`) gives you two installs, each
caching its own bundle. The footer **build stamp** (`vX.Y.Z · sha · time`) shows the bundle you're
running; Collie reports what it serves via the `X-Collie-Build` header and `/api/config`. On a
mismatch, the footer offers **"new build — tap to update."** Otherwise reopen the PWA a couple times
(the SW auto-updates) or clear that origin's site data. Best practice: **pick one HTTPS origin and
stick to it.** (Over plain HTTP the SW can't register — always fresh, but no PWA features.)


**I saved a machine in Herdr and the phone does not show it.** Expected. Herdr's saved machines are
its own client's list, and a crew is Collie's own; neither list feeds the other. To reach that
machine from the phone, enrol it: `collie crew add <ssh-host>` on the lead, then `collie restart` on
the lead and `collie crew status` to check the link. Adding or removing a machine in Herdr changes
nothing in the crew ([Herdr machines and the crew](crew.md#herdr-machines-and-the-crew)).

**An update started from the phone stays at staging.** On Collie up to 1.6.0, an update tapped on
the phone could stage the new version and then stop: the runner that performs the swap was never
started, the service kept serving the old version, and the run record sat at `staging` with the lock
held. The tell is three facts together: `collie update --status` reports `staging` (or, past ten
minutes, `interrupted — the updater is gone`), the version directory for the new release exists under
`versions/`, and the runner log at `~/.config/collie/collie.log` is 0 bytes. A `collie update` typed
at a shell on the same machine always worked, which is the same defect seen from the other side. It
is fixed from the next release on: the handoff now waits for the user manager to confirm the runner,
and a handoff that was refused is reported as a failure with the manager's own reason.

To clear a machine that is already stuck, do nothing for ten minutes: a run whose updater is gone
stops blocking a retry ten minutes after its last transition, and the next tap proceeds. To clear it
now, delete the record, the lock and the staging progress file, then check what `--status` says:

```
collie update --status            # note the pid it names
ps -p <pid> -o command=           # empty output: the updater really is gone
rm -f ~/.local/state/collie/update.json ~/.local/state/collie/update.lock
rm -f ~/.local/state/collie/update-staging-*.log
collie update --status            # "no update has run on this install yet"
```

There is no verb that clears a stale run, and these three files are the whole of the state a stalled
staging leaves behind. A suffixed instance keeps them in `~/.local/state/collie-<name>/` instead.
**Never** delete these while an update is actually running, and check the pid first: a live updater
whose lock you removed will flip `current` with nothing guarding it. Leave `versions/` alone. The
half-staged version directory is harmless, the retry builds into it again, and the retention sweep
removes what it no longer needs.

---

[← back to the README](../README.md)
