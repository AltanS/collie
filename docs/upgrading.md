# Manage & update

## Stop or uninstall

Pause Collie without removing anything (a later `start` brings it right back):

```bash
collie stop
```

To tear the service down completely — stop + disable it, remove the service definition (the
`systemd --user` unit, or the launchd agent plist on macOS), and remove
Collie's own `tailscale serve` mapping (port-scoped, so other tailnet mappings on the host survive) —
use `uninstall`. It leaves your `.env` and the checkout untouched:

```bash
collie uninstall
```

That leaves the install itself on disk. Delete the directory to finish the job — for a binary
install, `~/.local/share/collie` (or wherever you pointed `COLLIE_DIR`), plus the `collie` symlink
`collie unlink` takes down.

On a **Herdr-managed install** the same two verbs are also actions —
`herdr plugin action invoke stop --plugin herdr.collie`, and `uninstall` likewise — and the
registration is removed with `herdr plugin uninstall herdr.collie` (or, for a linked clone, by
deleting the directory).

## Update to a new release

One command does the lot, on every install:

```bash
collie update
```

On a binary install it fetches the newest release for your platform, verifies its sha256, swaps the
`current` symlink and restarts — keeping the version you were on, so `collie update --rollback` can
put it back. On a checkout it advances the checkout and rebuilds the UI. Either way it restarts the
bridge, re-execing itself from the new code, so it is safe even when the update rewrites the program
that is running. Confirm via the footer build stamp.

On a **Herdr-managed install** the same verb is the action
`herdr plugin action invoke update --plugin herdr.collie`. Herdr has no `plugin update` of its own —
the checkout is the plugin, so this verb is the refresh. Pinned to a version with `--ref`? Keep
refreshing with `herdr plugin install --ref …`.

**`update` goes to the newest release of the major you are on, and never crosses one.** A major
means you have to change something, so it is never inherited from a routine update: the command says
a new major is out and names the one that takes it —

```bash
collie update --major
```

The flag is the whole consent; there is no prompt, because the same verb has to work where nothing
can answer one — a Herdr action, a systemd unit, a provisioning run. The reasoning is
[ADR 0020](../.adr/0020-a-major-upgrade-is-consented-by-flag.md). On a Herdr-managed install it is
the action `update-major` (`herdr plugin action invoke update-major --plugin herdr.collie`).

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
release newer than it ([below](#testing-the-v1-beta)).

```bash
# newest stable release
git ls-remote --tags --refs https://github.com/AltanS/collie | \
  sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
```

**Do not use `GET /repos/AltanS/collie/releases/latest`.** That endpoint excludes prereleases by
design, so while a prerelease train is running it keeps answering the last stable tag and a consumer
that trusts it silently stalls on an old version. The tags are the contract; the Latest badge is only
a hint for people.

### Testing the v1 beta

The v1 line is a prerelease train — `v1.0.0-beta.N` tags cut off the `v1` branch. **Joining the train
is a deliberate act; staying on it is automatic.** A stable install never lands on a beta: `collie
update` and the in-app banner offer it strict releases and nothing else, so on 0.x `update` stays on
0.x and `update --major` answers *"no release above major 0 exists yet — nothing to cross to."*
Installing a beta is what opts you in, and from then on both the verb and the banner keep you moving
along that major until its release lands (see below). Take it by one of two routes.

**Binary install — take the beta with the install script's opt-in flag:**

```bash
curl -fsSL https://colliepwa.dev/install.sh | sh -s -- --beta
```

`--beta` widens the release search to prerelease tags; without it the script takes the newest stable
release. Once you are on a beta, `collie update` keeps you on the train — that is the paragraph
below. A **stable** binary install is never pulled onto a beta: `update` offers it strict releases
only, and the script refuses to touch an install that is already there. To rehearse the beta beside
it, install a second copy under its own `COLLIE_DIR`; to cross for real once `v1.0.0` is published,
`collie update --major`.

**Herdr-managed — install one beta tag; that is the whole opt-in:**

```bash
# Resolve the newest beta tag, then fetch and detach the checkout onto it, building the UI
# right there (the manifest's [[build]] step, GitHub installs only) — see above.
tag=$(git ls-remote --tags --refs https://github.com/AltanS/collie | \
  sed 's#.*refs/tags/##' | grep -E '^v1\.0\.0-beta\.[0-9]+$' | sort -V | tail -1)
herdr plugin install AltanS/collie --ref "$tag" --yes
herdr plugin action invoke restart --plugin herdr.collie   # reinstall doesn't restart the service

# NEW in v1: every verb now lives at <checkout>/bin/collie. Putting `collie` on your PATH is
# its own act — one symlink, never a copy, never a side effect of install/build/update:
bin/collie link                                            # ~/.local/bin/collie → <checkout>/bin/collie
collie stt setup                                           # …and bare `collie` works from anywhere
```

**A beta install then keeps itself moving.** Because the version on disk carries a prerelease tail,
`update` and the banner both fall back to that major's prereleases — but only while the major has no
strict release newer than you. So `update` walks `beta.46` → `beta.47` → … while `v1.0.0` is
unpublished, and takes `v1.0.0` the moment it exists, skipping any beta above you: the release
supersedes every beta that led to it. From there the install is stable and reads strict releases
only, so a later `v1.1.0-rc.1` is as invisible to it as it is to everyone else. The consent you gave
by installing a beta was to the road *to* its release, not to that major's prereleases forever.
Nothing here is a flag — it is a property of the version you installed, which is why a stable install
can never be pulled onto a beta
([ADR 0020](../.adr/0020-a-major-upgrade-is-consented-by-flag.md), amended 2026-08-30).

So **take the next beta with a plain `bin/collie update`** — not by installing its tag by hand. The
`--ref` above is an entry door, not a pin that holds: `update` reads the version in the checkout's
`herdr-plugin.toml`, not the tag you asked for, and moves you to the newest beta of that major. An
update with nothing to take now stops on its verdict — four lines, no rebuild, no restart — so
running it to check costs you nothing.

**The command above always resolves the current newest beta tag, so there is no literal tag to go
stale.** If you just want the tag name — say, to record it somewhere else — resolve it the same way
as [above](#resolving-the-newest-release-from-a-script), keeping the `-beta` tail this time:

```bash
git ls-remote --tags --refs https://github.com/AltanS/collie | \
  sed 's#.*refs/tags/##' | grep -E '^v1\.0\.0-beta\.[0-9]+$' | sort -V | tail -1
```

`link` is itself a v1 feature worth exercising — [details](commands.md#put-collie-on-your-path),
reasoning in [ADR 0021](../.adr/0021-the-path-name-is-a-pointer-never-a-copy.md). Skip it and every
command below reads `bin/collie …` from the checkout instead.

**Linked clone:**

```bash
git fetch --tags && git checkout v1   # the branch, not a tag — see below
bin/collie build && bin/collie restart
```

Stay on the **branch**. A clone on `v1` keeps its branch and its `--ff-only` pull, so `update` lands
you on the branch tip, which runs ahead of the newest beta tag. Check out a *tag* instead and the
clone is detached, which is the managed shape — `update` then rides the tag train described above.

**To go back**, reinstall with no `--ref`. It lands on the default-branch tip, which is the 0.x stable
line until v1 merges:

```bash
bin/collie unlink                                          # FIRST, if you linked — see below
herdr plugin install AltanS/collie --yes                   # default-branch tip, still detached + shallow
herdr plugin action invoke restart --plugin herdr.collie
```

**Take the link down before you roll back.** 0.x has no `cli/` and no compiled binary — its verbs are
the shim's own — so nothing on that line ever builds or refreshes `<checkout>/bin/collie`, and a
`collie` left on your PATH resolves to a stale v1 binary or to nothing at all. `unlink` removes the
name only while it still points at *this* checkout, so run it before the reinstall, not after.

Nothing you configured moves either way: `.env` and the `tailscale serve` record live in the plugin
config dir, paired devices and `stt.json` in the state dir — all outside the checkout.

What's new to exercise is in the `1.0.0-beta.*` entries of the [CHANGELOG](../CHANGELOG.md). The
newest surface is the beta train itself — run `bin/collie update` when the next beta is cut and tell
us whether it took it. The two biggest v1 surfaces to put weight on are
[voice input](voice-and-push.md#voice-input-optional), off until you run `collie stt setup`, and
[`link`](commands.md#put-collie-on-your-path).

## Upgrading from 0.x to 1.x

1.0 is a major, and a major is never inherited: a routine `update` stays on 0.x and names the command
that crosses. This section is what the crossing changes for *you*. The mechanics of doing it — the one
thing to do first, the side-by-side rehearsal, the way back — are
[Migrating from 0.x](#migrating-from-0x) below.

**The Herdr plugin route still works, and is spelled the same.** `herdr plugin install
AltanS/collie`, `herdr plugin link "$(pwd)"` and every action id in `herdr-plugin.toml` are the
strings they were on 0.x, and the actions still name `scripts/collie-ctl.sh`. Those command strings
are frozen deliberately: a Herdr older than 0.8.0 invokes the action set it cached at install time, so
a path that moved would strand every install made before the move
([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)).

**The CLI is the primary interface now.** On 0.x every verb *was* shell, implemented inside
`collie-ctl.sh`, because there was no `cli/` and no compiled binary. On 1.x every verb is implemented
once in `cli/` and compiled into `<checkout>/bin/collie`, and the script is a bootstrap shim: it finds
Bun, builds the binary when the checkout hasn't got one, and hands it your argv. So the spelling to
learn is `bin/collie <verb>` ([Commands](commands.md)), and `collie link` — new in 1.0 — publishes a
bare `collie` on your PATH as a symlink to that binary
([Put `collie` on your PATH](commands.md#put-collie-on-your-path)). Nothing else ever publishes that
name: not install, not build, not update
([ADR 0021](../.adr/0021-the-path-name-is-a-pointer-never-a-copy.md)).

**Verbs that had nowhere to live on 0.x.** Each is opt-in and absent until you run it, so an install
that ignores the lot behaves exactly as it did:

- **`collie pair` / `collie devices`** — a per-device write credential, on exactly while at least one
  device is paired ([Pair a device](security.md#pair-a-device--the-write-credential)).
- **`collie pack …` / `join` / `promote`** — several machines' Collies behind one URL
  ([Pack commands](pack.md)).
- **`collie doctor`** — one read-only pass over the traps that otherwise fail silently.
- **`collie stt setup`** — the microphone in the composer
  ([Voice input](voice-and-push.md#voice-input-optional)).
- **`collie hooks install claude` / `collie beacon emit`** — how an agent on tmux or zellij says what
  it is ([Agent beacons](multiplexers.md#agent-beacons-optional-linux)).

**`COLLIE_MUX` is a choice you did not have.** 0.x mirrored Herdr and only Herdr. 1.x names its
multiplexer in one key — `herdr` (the default, and the fully supported path), `tmux` or `zellij`, the
last two experimental in 1.0. Leave the key alone and nothing changes; set it and the bridge builds
only that adapter and never dials Herdr's socket, so Herdr need not be installed at all
([tmux and zellij](multiplexers.md)).

**Your configuration does not move, and no key was removed, renamed, or made required.** The `.env`
lives where it lived — the plugin's config dir, `herdr plugin config-dir herdr.collie`, or
`~/.config/collie` without Herdr — along with the `tailscale serve` record, and all of it sits outside
the checkout, so it survives an update, a reinstall and a rollback alike.
`bridge/solo-baseline.test.ts` pins that as a compiled assertion rather than a promise.

**What `update --major` does.** It crosses **one** major, to the newest **strict** release of the next
major that has one — an install two majors behind crosses them one at a time rather than jumping to
the newest. A prerelease is never a target for it, so `--major` cannot land you on a beta of the major
above; joining a prerelease train is a separate act, and it is
[installing one of its tags](#testing-the-v1-beta). The flag is the whole consent — there is no
prompt, because a Herdr action has no terminal to answer one on
([ADR 0020](../.adr/0020-a-major-upgrade-is-consented-by-flag.md)). With no higher major published,
the verb says so and changes nothing.

## Migrating from 0.x

The last 0.x release is the newest `v0.*` tag — read it off the tags with the recipe
[above](#resolving-the-newest-release-from-a-script) rather than trusting a number written here.
Going from there to 1.0 crosses a major, so a routine `update` will not do it. Once `v1.0.0` is
published, `update` says so and names this command instead:

```bash
collie update --major
```

On a Herdr-managed install that is the action `update-major`
(`herdr plugin action invoke update-major --plugin herdr.collie`). Either way: no reinstall, no
re-link, no config edit, no manual `bun install`.

**One thing to do first: if `BUN_INSTALL` lives only in your `.env`, move it to the environment.**
1.0's shim no longer sources `.env` to find Bun. Left in `.env` it fails at the worst possible
moment — the next `update`, invoked as a Herdr action, which gets no login shell. Export it from
your shell profile (or the service environment) before you update.

**A solo install has nothing else to do.** Same routes, same snapshot bytes, same config keys — no
key was removed, renamed, or made required. `bridge/solo-baseline.test.ts` pins that as a compiled
assertion, not a promise.

**Running a pack?** Four things to know, in this order:

- **Update the lead first**, then level the peers from it with `collie pack update <member>…`
  ([above](#updating-the-rest-of-the-pack)). A peer still on the old build is *behind*, never
  `incompatible` — it shows in `collie pack status` as a `warn:`-class version finding naming both
  versions and that remedy
  ([PACK_PROTOCOL §7.1](../PACK_PROTOCOL.md#71-version-skew-inside-a-protocol-version)).
- `collie join` now refuses an `http://` lead without `--insecure`.
- Invite tokens minted before the `<token>.<lead-fingerprint>` format fail closed — reissue with
  `collie pack invite`.
- Member records minted before the portless-callback fix need `collie reconnect`.

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

## When collie will not run

**This section is for a binary install** — `~/.local/share/collie` (or `$COLLIE_DIR`), with a
`versions/x.y.z/` layout and a `current` symlink. If the binary is too broken to run any verb at
all, `collie update`, `collie doctor` and `collie update --rollback` are unreachable — they need a
working binary to run them.

**Run the previous version's binary directly.** List what's on disk:

```bash
ls ~/.local/share/collie/versions/
```

Then invoke the one before the broken one, by its own path:

```bash
~/.local/share/collie/versions/<previous>/bin/collie update --rollback
```

**No good previous version on disk?** Pin forward to a known-good release instead, by re-running
the installer with `COLLIE_TAG` set:

```bash
COLLIE_TAG=v1.0.0 curl -fsSL https://colliepwa.dev/install.sh | sh
```

This lays the pinned version beside the current one and flips the `current` symlink — a rescue
route, not just a pin.

**On a Herdr-managed install or a linked clone (a git checkout), this section doesn't apply.**
There's no `versions/` layout to fall back into. Take a known-good ref directly:
`herdr plugin install AltanS/collie --ref vX.Y.Z --yes`, or on a plain checkout,
`git checkout <tag>`.

## You run a fork

**`collie update` refuses to run in a fork checkout, and says so.** The verb talks to the git remote
named `origin`, and before it fetches anything it checks that `origin` IS the repo updates are
configured to come from (`COLLIE_UPDATE_REPO`, default `AltanS/collie`). On a mismatch it stops,
names both repos, and changes nothing:

```
error: this checkout's origin is github.com/you/collie, but updates are configured to
       come from github.com/AltanS/collie.
       `collie update` would fetch that remote's tags and force-checkout onto them,
       discarding local work — it will not do that.
       If you run a fork on purpose:      set COLLIE_UPDATE_REPO=you/collie
       To take an upstream release by hand: docs/upgrading.md → "You run a fork"
```

That refusal is what the two checkout shapes would otherwise have cost you:

- **A fork clone on a branch** — `update` would fetch `origin` and `git pull --ff-only`, which
  fast-forwards your branch onto your own fork. Nothing from upstream arrives, and the command
  still reports success.
- **A detached fork checkout** — `update` would list `origin`'s tags with `git ls-remote`, pick one,
  and re-detach onto it with `git checkout --detach --force`. With tags of your own it lands you on
  *your* tag, not upstream's — and that forced checkout discards uncommitted work in the tree.

**Setting `COLLIE_UPDATE_REPO` to your fork is consent, not a workaround.** It makes the updater
self-consistent — your fork's tags, your fork's releases, your fork's banner — and it is the right
setting for a fork you genuinely release from. It does not merge anything from upstream; that is the
manual path below.

**The supported path is a manual merge.** Add upstream as a second remote, fetch its tags, and merge
the release tag you decided to take into your branch:

```bash
git remote add upstream https://github.com/AltanS/collie.git
git fetch upstream --tags
git merge v1.0.0                                            # the tag you decided to take
# resolve the conflicts, commit the merge, then rebuild and restart:
sh scripts/collie-ctl.sh build
bin/collie restart                                          # Herdr-managed: invoke the `restart` action
```

**Expect that merge to be real work** wherever you patched a file upstream also moved. Git hands you
the conflict and nothing resolves it for you; that is what carrying your own commits costs, not a
fault in the merge.

**Crossing 0.x to 1.x as a fork is the same merge, with a `v1.*` tag.** `update --major` is not your
route — you merge instead — but everything
[Upgrading from 0.x to 1.x](#upgrading-from-0x-to-1x) says about what the crossing changes for you
applies as written.

**`COLLIE_UPDATE_REPO` is one override for both halves.** It names the repo whose tags the in-app
update notice watches AND the repo `collie update` takes releases from (default `AltanS/collie`) —
on a git checkout as the assertion against `origin` described above, and on a downloaded binary
install as the source of the tags, the manifest and every download URL. `collie doctor` prints it.

## Surviving reboots

A `systemd --user` service only runs while you have a login session. On a host that should serve
Collie unattended, enable lingering once:

```bash
loginctl enable-linger $USER
```

The unit is `enable`d, so with lingering it starts at boot with your user manager; the
`tailscale serve` mapping is persistent (`--bg`) and comes back on its own. Inspect the unit with
`systemctl --user status collie`.

**On macOS there's nothing to enable.** `start` installs a launchd agent
(`~/Library/LaunchAgents/herdr.collie.plist`) with `RunAtLoad`, so Collie comes back when you log
in and launchd restarts it if it exits abnormally. Inspect it with
`launchctl print gui/$(id -u)/herdr.collie`. It's a *LaunchAgent*, not a daemon, so it starts at
**login** rather than at boot — a Mac sitting at the login window is not serving Collie. (Neither
supervisor? A `nohup` process with a pidfile in the config dir instead.)


---

[← back to the README](../README.md)
