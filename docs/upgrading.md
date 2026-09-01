# Manage & update

**Two shapes, two spellings.** Which one is yours was decided when you installed. Every command on
this page comes in both, and **neither assumes a bare `collie` on your PATH**:

| You installed with | You are | Verbs are spelled |
| --- | --- | --- |
| `herdr plugin install` or `herdr plugin link` | **Herdr-managed** — `herdr plugin list` shows `herdr.collie` | `herdr plugin action invoke <verb> --plugin herdr.collie` |
| the install script, or a build from source | **Standalone** | `bin/collie <verb>`, from the install directory |

**Herdr-managed installs have no `collie` on your PATH, and nothing puts one there.** Herdr owns the
checkout — a GitHub install lands under a hashed path you are not meant to type — so the action ids
in `herdr-plugin.toml` are the interface ([Herdr actions](commands.md#herdr-actions)).

**Standalone installs have the binary at a path you know.** The install script puts it in
`~/.local/share/collie/current/bin/collie`; a source build puts it at `bin/collie` inside your
checkout. It is executable as it lands — nothing to `chmod` — so the full path is always a working
command:

```bash
cd ~/.local/share/collie/current && bin/collie version    # the install script's layout
cd ~/my/collie-checkout        && bin/collie version      # a source build or a linked clone
```

The install script also runs `collie link` for you, which publishes a bare `collie` as a symlink to
that binary. If `~/.local/bin` is on your PATH, `collie <verb>` works from anywhere and is the same
program; if it is not, the script says so and the paths above stay correct
([Put `collie` on your PATH](commands.md#put-collie-on-your-path)).

**Deeper down this page, reference sections spell verbs as `collie <verb>`** — the standalone
name. Read those as `bin/collie <verb>` if you have not linked it, or as the matching action id
if you are Herdr-managed.

Nothing you configured lives in the checkout. The `.env`, the `tailscale serve` record, paired
devices and `stt.json` all sit outside it, so nothing on this page moves your configuration —
`bridge/solo-baseline.test.ts` pins that as a compiled assertion rather than a promise.

## Update

**Herdr-managed:**

```bash
herdr plugin action invoke update --plugin herdr.collie
```

**Standalone:**

```bash
bin/collie update
```

That is the whole update. It takes the newest release of the major you are on and restarts the
bridge, re-execing itself from the new code — so it is safe even when the update rewrites the
program that is running. Confirm it on the footer build stamp, or with `version`.

Underneath, the shape decides the mechanics. A binary install fetches the release for your platform,
verifies its sha256 and swaps the `current` symlink, keeping the version it replaced so
`update --rollback` can put it back. A checkout — Herdr-managed, or a linked clone — advances the
checkout and rebuilds the UI ([what that means exactly](#what-update-actually-does-to-the-checkout)).

Herdr has no `plugin update` of its own: the checkout *is* the plugin, so the action above is the
refresh. Pinned to a version with `--ref`? Keep refreshing with `herdr plugin install --ref …`.

**A release can add a beacon hook event, and `update` tells you when one is missing.** Your
`~/.claude/settings.json` keeps the set the old build wrote, so a newly registered event never fires
until you re-run `hooks install claude`; a successful update prints one line when that is the case,
and stays quiet when you have no beacon hooks installed or the set is already complete.

### Cross a major

**`update` never crosses a major on its own.** A major means something changed that you have to know
about, so it is never inherited from a routine update: the command says a new major is out and names
the one that takes it.

**Herdr-managed:**

```bash
herdr plugin action invoke update-major --plugin herdr.collie
```

**Standalone:**

```bash
bin/collie update --major
```

It crosses **one** major, to the newest **strict** release of the next one — an install two majors
behind crosses them one at a time rather than jumping to the newest — and a prerelease is never a
target for it. With no higher major published, the verb says so and changes nothing. The flag is the
whole consent; there is no prompt, because the same verb has to work where nothing can answer one —
a Herdr action, a systemd unit, a provisioning run
([ADR 0020](../.adr/0020-a-major-upgrade-is-consented-by-flag.md)).

**Still on 0.x?** That is the crossing to 1.0. It is the same one command, with one thing to check
first: [Upgrading from 0.x to 1.0](#upgrading-from-0x-to-10).

### If that fails with *"You are not currently on a branch"*

You installed from GitHub before **0.23.1**, when `update` assumed every checkout was a clone
([#63](https://github.com/AltanS/collie/issues/63)). `herdr plugin install` doesn't clone — it fetches
one commit and detaches onto it — so `git pull` had nothing to pull into, and no version installed
that way could ever self-update. The fix ships *inside* the checkout it repairs, so take it with one
reinstall; `update` works normally from then on:

```bash
herdr plugin install AltanS/collie --yes          # replaces the checkout, rebuilds the UI
herdr plugin action invoke restart --plugin herdr.collie   # reinstall doesn't restart the service
herdr plugin action invoke version --plugin herdr.collie   # expect 0.23.1 or newer
```

Your `.env` and `tailscale serve` state live in the plugin config dir, outside the checkout, so they
survive.

### What `update` actually does to the checkout

**This part is about the two checkout-shaped installs — a Herdr-managed one and a linked clone.** A
binary install has no checkout at all: `update` fetches a built release, verifies it, and swaps the
`current` symlink, which is why `--rollback` exists there and nowhere else.

The two checkout routes differ in *when* the UI builds — a GitHub install at install time, via the
manifest's `[[build]]` step; a linked clone on first `start`.

They also leave two different shapes on disk, which is what `update` has to cope with.
`herdr plugin install` doesn't clone: it fetches one commit and detaches onto it, so the checkout has
no branch. A linked clone sits on one, the way you'd expect.

One command handles both ([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)):

- **Linked clone** (on a branch) — `git pull --ff-only`, then **re-links the plugin** so Herdr picks
  up any new actions and the new version.
- **`herdr plugin install`** (detached, shallow) — fetches the default-branch tip and re-detaches onto
  it. `--depth 1` only if it's already shallow, so a full history is never truncated; `--force` so a
  lockfile the build rewrote can't wedge the *next* update. It deliberately does **not** re-link:
  linking re-registers the plugin as a local path, after which Herdr refuses `herdr plugin install` —
  the reinstall above, which is your recovery path if this checkout ever breaks again.

By hand: frontend (`web/`) → `bin/collie build` (live, no restart — served from disk); backend
(`bridge/`) → `systemctl --user restart collie`. Run `scripts/install-hooks.sh` once to enable the
repo's pre-commit / pre-push checks.

### Updating the rest of the pack

`collie update` advances *this* machine. If you lead a pack, level its peers to the build you just
landed with **`collie pack update <member>… `** (or `--all`), run on the lead. It probes each member
read-only, shows you what it is about to do, asks **once**, and then per member pushes this lead's
commit over **your own ssh**, rebuilds there, restarts that machine's bridge and confirms over the
pack link that it now answers with the new version. A member that is already current is listed and
left alone; one it has never `collie pack add`-ed from here is skipped with the command that would
teach it; a failure stops that member and not the run. Nothing about an update crosses the pack link
itself — that is deliberate, and the reasoning is
[ADR 0016](../.adr/0016-updates-ride-the-operators-ssh.md).

### Resolving the newest release from a script

If something outside Collie has to answer *"which release is current?"* — a packager, a CI job, the
demo site that pins a release bundle — **read the repo's git tags and sort them by semver**. Include
or exclude the `-beta` / `-rc` tails according to what you want; Collie's own update banner and
`collie update` both do exactly this (`bridge/update.ts`, `cli/update.ts`), and which tails they keep
depends on the version the checkout is already running — a stable install reads strict tags only, and
a prerelease install falls back to its own major's prereleases only while that major has no strict
release newer than it ([below](#prereleases)).

```bash
# newest stable release
git ls-remote --tags --refs https://github.com/AltanS/collie | \
  sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
```

**Do not use `GET /repos/AltanS/collie/releases/latest`.** That endpoint excludes prereleases by
design, so while a prerelease train is running it keeps answering the last stable tag and a consumer
that trusts it silently stalls on an old version. The tags are the contract; the Latest badge is only
a hint for people.

### Prereleases

**A stable install never lands on a prerelease.** `update` and the in-app banner offer it strict
releases and nothing else, so no `-beta` or `-rc` tag can reach you by accident. Installing one is
what opts you in, and from then on both keep you moving along that major — until its release lands,
which supersedes every prerelease that led to it and returns you to strict releases only. The
consent is a property of the version on disk, not a flag you carry
([ADR 0020](../.adr/0020-a-major-upgrade-is-consented-by-flag.md), amended 2026-08-30).

Take one deliberately:

```bash
# Standalone — the install script's opt-in flag takes the newest prerelease
curl -fsSL https://colliepwa.dev/install.sh | sh -s -- --beta

# Herdr-managed — install the tag; that is the whole opt-in
herdr plugin install AltanS/collie --ref <tag> --yes
herdr plugin action invoke restart --plugin herdr.collie   # a reinstall does not restart the service
```

Resolve `<tag>` the way [Resolving the newest release from a script](#resolving-the-newest-release-from-a-script)
does, keeping the prerelease tail rather than filtering it out.

`--ref` is an entry door, not a pin that holds. From there a plain `update` reads the version in the
checkout's `herdr-plugin.toml` — not the tag you asked for — and moves you to the next prerelease of
that major by itself, so there is nothing to install by hand again.

**To leave the train**, reinstall with no `--ref`. It lands on the default-branch tip:

```bash
herdr plugin install AltanS/collie --yes
herdr plugin action invoke restart --plugin herdr.collie
```

## Upgrading from 0.x to 1.0

**0.x is Herdr-managed or a linked clone** — that line had no compiled binary and no install script —
so this is the crossing for everyone still on it, and it is one command.

**First, one check.** If `BUN_INSTALL` lives only in your `.env`, move it into your environment:
export it from your shell profile, or from the service environment. 1.0's shim no longer sources
`.env` to find Bun, and left there it fails at the worst possible moment — the update itself,
invoked as a Herdr action, which gets no login shell.

**Then cross:**

```bash
# Herdr-managed
herdr plugin action invoke update-major --plugin herdr.collie

# Linked clone
bin/collie update --major
```

No reinstall, no re-link, no config edit, no manual `bun install`. It worked when
`herdr plugin action invoke version --plugin herdr.collie` — or `bin/collie version` — reads `1.0.0`
or newer, and the footer build stamp agrees.

**A solo install has nothing else to do.** Same routes, same snapshot bytes, same config keys: no key
was removed, renamed, or made required, and your `.env` and `tailscale serve` record never move.

**Running a pack? Update the lead first**, then level its peers from it with
`collie pack update <member>…` ([above](#updating-the-rest-of-the-pack)). Three things changed under
you there:

- `join` now refuses an `http://` lead without `--insecure`.
- Invite tokens minted before the `<token>.<lead-fingerprint>` format fail closed — reissue with
  `pack invite`.
- Member records minted before the portless-callback fix need `reconnect`.

A peer still on the old build is *behind*, never `incompatible`: it shows in `pack status` as a
`warn:`-class version finding naming both versions and that remedy
([PACK_PROTOCOL §7.1](../PACK_PROTOCOL.md#71-version-skew-inside-a-protocol-version)).

### What 1.0 changes for you

**Your Herdr routes are spelled exactly as they were.** `herdr plugin install AltanS/collie`,
`herdr plugin link "$(pwd)"` and every action id in `herdr-plugin.toml` are the strings they were on
0.x, and the actions still name `scripts/collie-ctl.sh`. Those are frozen deliberately: a Herdr older
than 0.8.0 invokes the action set it cached at install time, so a path that moved would strand every
install made before the move
([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)).

**The CLI is the primary interface now.** On 0.x every verb *was* shell, implemented inside
`collie-ctl.sh`. On 1.x every verb is implemented once in `cli/` and compiled into
`<checkout>/bin/collie`, and the script is a bootstrap shim: it finds Bun, builds the binary when the
checkout hasn't got one, and hands it your argv. So the spelling to learn is `bin/collie <verb>`
([Commands](commands.md)), and on a checkout you can reach — a linked clone, not a Herdr GitHub
install, whose checkout lives under a hashed path — `bin/collie link` publishes a bare `collie` on
your PATH as a symlink to that binary
([Put `collie` on your PATH](commands.md#put-collie-on-your-path)). Nothing else ever publishes that
name: not install, not build, not update
([ADR 0021](../.adr/0021-the-path-name-is-a-pointer-never-a-copy.md)).

**Verbs that had nowhere to live on 0.x.** Each is opt-in and absent until you run it, so an install
that ignores the lot behaves exactly as it did:

- **`pair` / `devices`** — per-device write credentials. The gate is active only while at least one
  device is paired; pair none and nothing changes. Once a device is paired, every write requires that
  device's token, while reads stay open
  ([Pair a device](security.md#pair-a-device--the-write-credential)).
- **`pack …` / `join` / `promote`** — several machines' Collies behind one URL
  ([Pack commands](pack.md)).
- **`doctor`** — one read-only pass over the traps that otherwise fail silently.
- **`stt setup`** — the microphone in the composer
  ([Voice input](voice-and-push.md#voice-input-optional)).
- **`hooks install claude` / `beacon emit`** — how an agent on tmux or zellij says what it is
  ([Agent beacons](multiplexers.md#agent-beacons-optional-linux)).

**`COLLIE_MUX` is a choice you did not have.** 0.x mirrored Herdr and only Herdr. 1.x names its
multiplexer in one key — `herdr` (the default, and the fully supported path), `tmux` or `zellij`, the
last two experimental in 1.0. Leave the key alone and nothing changes; set it and the bridge builds
only that adapter and never dials Herdr's socket, so Herdr need not be installed at all
([tmux and zellij](multiplexers.md)).

### Side by side, if the herd is real

If you lead a pack you depend on, run 1.0 as a **second instance** and cut over when you're happy;
everyone else should just update in place. A second instance is its own config dir at
`~/.config/herdr/plugins/config/herdr.collie-<name>/.env`, containing at minimum:

```bash
COLLIE_INSTANCE=<name>        # required — [a-z0-9-], max 16 chars
COLLIE_PORT=8788              # required for a named instance; no default is inferred
COLLIE_STATE_DIR=/home/you/.local/state/collie-<name>   # the state dir is NOT instance-suffixed
```

plus its own front door. A named instance reads *only* that file: if it's missing, the instance
**refuses to run** rather than falling back to another instance's config. That refusal is the
feature — a named instance that silently resolved the default config would mint a fresh identity
into your live install's state.

### Rolling back

Check out the last 0.x tag in the same checkout and rebuild. A Herdr-managed checkout is shallow
*and* tagless, so fetch the tag first:

```bash
last0x=$(git ls-remote --tags --refs origin | sed 's#.*refs/tags/##' | \
  grep -E '^v0\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
git fetch --depth 1 origin tag "$last0x"
git checkout --detach --force "$last0x"
rm -f bin/collie    # 1.0's binary otherwise survives the rollback
```

Then rebuild in the checkout with `bash scripts/collie-ctl.sh build` — after that checkout it is 0.x's
own script again — and restart with the Herdr `restart` action. A routine `update` while rolled back
is safe: 0.x's own shim is major-gated too, so it targets the newest `v0.*` release and can never
cross to 1.x by itself. **What crosses is `update --major` / the `update-major` action** — don't
invoke that one until you mean to come back. Leave the four 1.0 state files
alone — `pack-trust.json`, `pack-runtime.json`, `paired-devices.json` and `pairing-pending.json` are
inert to 0.x, which never opens them.

> **Rollback drops the pairing gate.** 0.x has no bearer path at all, so a paired phone's credential
> is simply ignored and writes fall back to the 0.x gates. If `COLLIE_DEVICE_HEADER` isn't
> configured, that is **full write access for any same-origin request**. If you paired devices
> *instead of* configuring the header gate, configure it before you roll back — or accept that
> consequence knowingly.

### Verify it worked

The footer build stamp — or `bin/collie version` — reads `1.0.0…`. Here's the tail of a real
Herdr-managed upgrade; the interesting part is the hand-off, where 0.x's shell `exec`s the path it
froze and lands on the 1.0 shim, which builds its own binary on the way through:

```
updating Collie (Herdr-managed checkout: fetch + detach onto origin HEAD)…
→ now at b0949b4 fix(pack): a leg's progress line belongs under that leg, not under all three
first run — building the collie binary…
…
note: Herdr-managed install — registry left alone (re-linking would block `herdr plugin install`)
✓ update complete
```

**Next step: pair your phone.** Pairing is optional, and an upgraded installation pairs no devices
automatically. Pairing issues that phone a write credential. Revoke this credential with
`collie devices revoke` if a device is lost
([Pair a device](security.md#pair-a-device--the-write-credential)).

## Stop or uninstall

Pause Collie without removing anything — a later `start` resumes it:

```bash
herdr plugin action invoke stop --plugin herdr.collie     # Herdr-managed
bin/collie stop                                           # standalone
```

`uninstall` tears the service down: it stops and disables it, removes the service definition (the
`systemd --user` unit or the macOS launchd agent plist), and clears Collie's port-scoped
`tailscale serve` mapping without touching other tailnet mappings on the host. Your `.env` and your
checkout are left alone:

```bash
herdr plugin action invoke uninstall --plugin herdr.collie   # Herdr-managed
bin/collie uninstall                                         # standalone
```

To remove the files as well: on a Herdr-managed install, drop the registration with
`herdr plugin uninstall herdr.collie` (or delete the directory, for a linked clone). On a standalone
install, run `bin/collie unlink` to take the name off your PATH if you linked it, then delete the install directory —
`~/.local/share/collie`, or your own `COLLIE_DIR`.

## When collie will not run

**This section applies to standard binary installs** in `~/.local/share/collie` (or `$COLLIE_DIR`),
which use a `versions/x.y.z/` layout and a `current` symlink. If the active binary cannot execute
commands, `collie update`, `collie doctor`, and `collie update --rollback` will not run.

**Execute the previous binary directly.** Inspect the installed versions:

```bash
ls ~/.local/share/collie/versions/
```

Run rollback using the direct path to the previous working binary:

```bash
~/.local/share/collie/versions/<previous>/bin/collie update --rollback
```

**If no previous working version exists on disk**, install a specific release by setting
`COLLIE_TAG`:

```bash
COLLIE_TAG=v1.0.0 curl -fsSL https://colliepwa.dev/install.sh | sh
```

This writes the specified version to the versions directory and updates the `current` symlink.

**This does not apply to Herdr-managed installs or git checkouts.** Those setups do not use the
`versions/` directory layout. Switch to a known-good release using
`herdr plugin install AltanS/collie --ref vX.Y.Z --yes`, or run `git checkout <tag>` inside a
repository clone.

## You run a fork

**`collie update` refuses to run in a fork checkout.** The command inspects the git remote named
`origin`. Before fetching, it confirms that `origin` matches the configured update repository
(`COLLIE_UPDATE_REPO`, which defaults to `AltanS/collie`). On a mismatch, it exits with an error,
prints both repository paths, and leaves the working tree untouched:

```
error: this checkout's origin is github.com/you/collie, but updates are configured to
       come from github.com/AltanS/collie.
       `collie update` would fetch that remote's tags and force-checkout onto them,
       discarding local work — it will not do that.
       If you run a fork on purpose:      set COLLIE_UPDATE_REPO=you/collie
       To take an upstream release by hand: docs/upgrading.md → "You run a fork"
```

Without this check, the updater would fail in one of two ways depending on your checkout state:

- **A fork clone on a branch:** `update` would fetch from `origin` and run `git pull --ff-only`.
  This fast-forwards your branch against your own fork, pulls nothing from upstream, and exits
  cleanly.
- **A detached fork checkout:** `update` would query `origin` for tags using `git ls-remote`, select
  one, and execute `git checkout --detach --force`. If your fork defines tags, this checks out your
  tag instead of upstream and overwrites uncommitted local changes.

**Set `COLLIE_UPDATE_REPO` to your fork only if you release from it directly.** This aligns the
update checks, release tags, and UI notices with your repository. It does not pull or merge changes
from upstream.

**To pull upstream releases, merge them manually.** Add upstream as a remote, fetch its tags, and
merge the target release tag into your branch:

```bash
git remote add upstream https://github.com/AltanS/collie.git
git fetch upstream --tags
git merge v1.0.0                                            # the tag you decided to take
# resolve the conflicts, commit the merge, then rebuild and restart:
sh scripts/collie-ctl.sh build
bin/collie restart                                          # Herdr-managed: invoke the `restart` action
```

**Resolve merge conflicts manually.** Files modified in your fork that also changed upstream will
conflict during the merge. You must resolve these directly.

**Upgrading from 0.x to 1.x uses the same manual merge with a `v1.*` tag.** Do not run
`update --major`. Merge the tag manually, then review the operational notes in
[Upgrading from 0.x to 1.0](#upgrading-from-0x-to-10).

**`COLLIE_UPDATE_REPO` controls both update discovery and downloads.** It sets the repository used
for in-app version notices and the source repository for `collie update` (defaulting to
`AltanS/collie`). In git checkouts, it validates the `origin` remote. In binary installations, it
defines the source for tags, manifests, and release assets. Run `collie doctor` to inspect its
current value.

## Surviving reboots

A `systemd --user` service runs only during an active login session. On a host that serves Collie
unattended, enable lingering:

```bash
loginctl enable-linger $USER
```

Because the unit is enabled, lingering allows it to start at boot with the user manager. The
`tailscale serve` mapping is persistent (`--bg`) and restores itself automatically. Check the unit
with `systemctl --user status collie`.

**On macOS, configuration is automatic.** The `start` command installs a launchd agent
(`~/Library/LaunchAgents/herdr.collie.plist`) with `RunAtLoad`. Collie starts at login, and launchd
restarts it if the process crashes. Check the state with
`launchctl print gui/$(id -u)/herdr.collie`. Because this is a LaunchAgent rather than a daemon, it
runs at **login** instead of system boot; a Mac at the login window will not serve Collie. If
neither supervisor is present, Collie runs as a `nohup` process with a pidfile in the config
directory.


---

[← back to the README](../README.md)
