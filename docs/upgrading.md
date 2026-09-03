# Manage & update

| You installed with | You are | Verbs are spelled |
| --- | --- | --- |
| `herdr plugin install` or `herdr plugin link` | **Herdr-managed** (`herdr plugin list` shows `herdr.collie`) | `herdr plugin action invoke <verb> --plugin herdr.collie` |
| Install script or source build | **Standalone** | `bin/collie <verb>` from the install dir |

Herdr installs have no `collie` on PATH; use Herdr action IDs
([Herdr actions](commands.md#herdr-actions)). Standalone installs place the binary in
`~/.local/share/collie/current/bin/collie` or `<checkout>/bin/collie`:

```bash
cd ~/.local/share/collie/current && bin/collie version    # the install script's layout
cd ~/my/collie-checkout        && bin/collie version      # a source build or a linked clone
```

Run `bin/collie link` to symlink the binary into `~/.local/bin`
([Put `collie` on your PATH](commands.md#put-collie-on-your-path)).

Configuration files (`.env`, `tailscale serve` state, paired devices, `stt.json`) sit outside the
checkout and persist across updates (`bridge/solo-baseline.test.ts`).

## Update

**1. Update**

```bash
herdr plugin action invoke update --plugin herdr.collie     # Herdr-managed
bin/collie update                                           # Standalone
```

This fetches the newest release of your current major and stages it. The command then hands the
swap to a separate updater and exits: that updater points `current` at the new version, restarts the
bridge, and waits up to 30 seconds for `GET /api/health` to answer with the version it just
installed. It has to be a separate process, because the restart kills the bridge that asked for the
update.

If the new version does not answer in time, or answers as the old one, the updater flips `current`
back and restarts once more. If that does not come up either, it stops: it records the failure and
the command to run by hand, and nothing restarts again.

Set `COLLIE_UPDATE_HEALTH_TIMEOUT_MS` if 30 seconds is not enough on your machine. A slow cold start
that runs past the budget is read as a failed update and rolled back.

**2. Verify**

```bash
bin/collie update --status          # what the updater did, or is doing (--json for a script)
herdr plugin action invoke version --plugin herdr.collie
bin/collie version
```

Expect the newest tag. A binary install and a linked checkout both swap the `current` symlink and
support `update --rollback`. A Herdr-managed checkout still advances in place and rebuilds
(ADR 0006): there is no staged version beside it, so there is nothing to hand off and nothing to
flip back to. The phone can read the same record while the bridge is down: a deputy's standby door
serves it at `/standby/update`.

If a new beacon hook event is available, `update` prints a notice to re-run `hooks install claude`.

**3. The phone**

The PWA checks for a new build on its own and reloads within about a minute; no action needed. If
you are mid-task, it shows a "tap to update" banner instead and waits for your tap.

### If the version did not move

`collie update` asks GitHub directly on every run, `git ls-remote` for a checkout, the GitHub tags
API for a binary install. It does not cache the release list. A release published seconds ago may
still take a minute to show up, because GitHub itself needs a moment to catch up. Run
`collie doctor` next. If that does not explain it, see
[When collie will not run](#when-collie-will-not-run).

### Cross a major

`update` never crosses a major version automatically.

```bash
herdr plugin action invoke update-major --plugin herdr.collie     # Herdr-managed
bin/collie update --major                                         # Standalone
```

This advances one major version to its newest strict release. It does not target prereleases
([ADR 0020](../.adr/0020-a-major-upgrade-is-consented-by-flag.md)). See also:
[Upgrading from 0.x to 1.0](#upgrading-from-0x-to-10).

### If that fails with *"You are not currently on a branch"*

Installs from GitHub prior to 0.23.1 lack a branch tracking ref
([#63](https://github.com/AltanS/collie/issues/63)). Reinstall to restore update functionality:

```bash
herdr plugin install AltanS/collie --yes          # replaces the checkout, rebuilds the UI
herdr plugin action invoke restart --plugin herdr.collie   # reinstall doesn't restart the service
herdr plugin action invoke version --plugin herdr.collie   # expect 0.23.1 or newer
```

Config in the plugin directory is preserved.

### What `update` actually does to the checkout

Binary installs swap the `current` symlink; checkouts update in place
([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)):

- **Linked clone** (on a branch): runs `git pull --ff-only` and re-links the plugin.
- **`herdr plugin install`** (detached/shallow): fetches default-branch HEAD and checks it out
  detached (`--depth 1` if shallow, `--force`). It does not re-link.

Manual rebuild steps: frontend (`web/`) via `bin/collie build` (no restart needed); backend
(`bridge/`) via `systemctl --user restart collie`. Run `scripts/install-hooks.sh` to install git
hooks.

### Updating the rest of the pack

From the lead node, run `collie pack update <member>…` (or `--all`). It runs as one sequence over
your local SSH: it preflights every machine first, then updates the lead itself if the lead is not
yet running the build it is handing out, then each peer in turn. A peer is pushed the lead's commit,
rebuilt, restarted, and then polled until it answers the new build. The first failure stops the run:
the members after it are left untouched and reported as "not attempted", and the summary names the
one command that clears the failure. Stopping there is safe because the pack tolerates version skew
(PACK_PROTOCOL.md §7.1). See [ADR 0016](../.adr/0016-updates-ride-the-operators-ssh.md).

### Resolving the newest release from a script

Query git tags and sort by semver. Avoid `GET /repos/AltanS/collie/releases/latest`, which excludes
prereleases.

```bash
# newest stable release
git ls-remote --tags --refs https://github.com/AltanS/collie | \
  sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
```

### Prereleases

Stable installs do not receive prereleases. Opting into a prerelease tracks that major's prereleases
until the final release arrives
([ADR 0020](../.adr/0020-a-major-upgrade-is-consented-by-flag.md)):

```bash
# Standalone — the install script's opt-in flag takes the newest prerelease
curl -fsSL https://colliepwa.dev/install.sh | sh -s -- --beta

# Herdr-managed — install the tag; that is the whole opt-in
herdr plugin install AltanS/collie --ref <tag> --yes
herdr plugin action invoke restart --plugin herdr.collie   # a reinstall does not restart the service
```

Resolve `<tag>` using [Resolving the newest release from a script](#resolving-the-newest-release-from-a-script).

To return to stable releases:

```bash
herdr plugin install AltanS/collie --yes
herdr plugin action invoke restart --plugin herdr.collie
```

## Upgrading from 0.x to 1.0

If `BUN_INSTALL` is defined only in `.env`, export it in your shell profile or service environment
instead. Then run:

```bash
# Herdr-managed
herdr plugin action invoke update-major --plugin herdr.collie

# Linked clone
bin/collie update --major
```

Verify with `bin/collie version` or `herdr plugin action invoke version --plugin herdr.collie`.

**For pack setups:** Update the lead first, then run `collie pack update <member>…`
([Updating the rest of the pack](#updating-the-rest-of-the-pack)). Note:
- `join` requires `--insecure` for plain `http://` leads.
- Pre-1.0 invite tokens must be regenerated with `pack invite`.
- Older member records require `reconnect`.
- Unupgraded peers display as `warn:` in `pack status`
  ([PACK_PROTOCOL §7.1](../PACK_PROTOCOL.md#71-version-skew-inside-a-protocol-version)).

### What 1.0 changes for you

Herdr action IDs and `scripts/collie-ctl.sh` routes are unchanged
([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)).

CLI verbs are compiled into `<checkout>/bin/collie` ([Commands](commands.md)). Use
`bin/collie link` to add `collie` to PATH
([Put `collie` on your PATH](commands.md#put-collie-on-your-path),
[ADR 0021](../.adr/0021-the-path-name-is-a-pointer-never-a-copy.md)).

New features:
- **`pair` / `devices`**: Per-device write credentials
  ([Pair a device](security.md#pair-a-device--the-write-credential)).
- **`pack …` / `join` / `promote`**: Multi-host clustering ([Pack commands](pack.md)).
- **`doctor`**: Configuration diagnostics.
- **`stt setup`**: Voice composer configuration
  ([Voice input](voice-and-push.md#voice-input-optional)).
- **`hooks install claude` / `beacon emit`**: Agent activity beacons
  ([Agent beacons](multiplexers.md#agent-beacons-optional-linux)).
- **`COLLIE_MUX`**: Select `herdr` (default), `tmux`, or `zellij`
  ([tmux and zellij](multiplexers.md)).

### Side by side, if the herd is real

Secondary instance configuration is documented in
[Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host).

### Rolling back

Check out the last 0.x tag and rebuild:

```bash
last0x=$(git ls-remote --tags --refs origin | sed 's#.*refs/tags/##' | \
  grep -E '^v0\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
git fetch --depth 1 origin tag "$last0x"
git checkout --detach --force "$last0x"
rm -f bin/collie    # 1.0's binary otherwise survives the rollback
```

Rebuild with `bash scripts/collie-ctl.sh build` and invoke Herdr's `restart` action. State files
(`pack-trust.json`, `pack-runtime.json`, `paired-devices.json`, `pairing-pending.json`) can remain.
Rollback removes device pairing enforcement; configure `COLLIE_DEVICE_HEADER` if write protection
is required.

### Verify it worked

Check that `version` reports `1.0.0` or higher. An upgraded install pairs no devices automatically:
run `pair` to issue a phone its write credential, and `devices revoke` if that phone is lost
([Pair a device](security.md#pair-a-device--the-write-credential)).

## Stop or uninstall

Pause the service:

```bash
herdr plugin action invoke stop --plugin herdr.collie     # Herdr-managed
bin/collie stop                                           # standalone
```

Remove the service definition and port mappings (`.env` and checkouts are preserved):

```bash
herdr plugin action invoke uninstall --plugin herdr.collie   # Herdr-managed
bin/collie uninstall                                         # standalone
```

To delete remaining files: run `herdr plugin uninstall herdr.collie` (Herdr-managed), or run
`bin/collie unlink` and delete `~/.local/share/collie` / `$COLLIE_DIR` (standalone).

## When collie will not run

For binary installs (`~/.local/share/collie` or `$COLLIE_DIR`), execute an older binary directly:

```bash
ls ~/.local/share/collie/versions/
~/.local/share/collie/versions/<previous>/bin/collie update --rollback
```

To install a specific version directly:

```bash
COLLIE_TAG=v1.0.0 curl -fsSL https://colliepwa.dev/install.sh | sh
```

For checkouts or Herdr installs, run `git checkout <tag>` or
`herdr plugin install AltanS/collie --ref vX.Y.Z --yes`.

## You run a fork

`collie update` checks `origin` against `COLLIE_UPDATE_REPO` (default `AltanS/collie`) and aborts if
they differ. Set `COLLIE_UPDATE_REPO=you/collie` if your fork releases its own tags.

To merge upstream updates into your fork manually:

```bash
git remote add upstream https://github.com/AltanS/collie.git
git fetch upstream --tags
git merge v1.0.0                                            # the tag you decided to take
# resolve the conflicts, commit the merge, then rebuild and restart:
bash scripts/collie-ctl.sh build
bin/collie restart                                          # Herdr-managed: invoke the `restart` action
```

Do not use `update --major` on a fork; merge the `v1.*` tag manually. Run `collie doctor` to check
the active `COLLIE_UPDATE_REPO`.

## Surviving reboots

On Linux, enable lingering for unattended user services:

```bash
loginctl enable-linger $USER
```

Verify status with `systemctl --user status collie`.

On macOS, `start` manages `~/Library/LaunchAgents/herdr.collie.plist` automatically. It runs at user
login. Check status with `launchctl print gui/$(id -u)/herdr.collie`.

---

[← back to the README](../README.md)