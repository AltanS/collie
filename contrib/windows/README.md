# Collie on Windows — community-maintained lifecycle

The Collie **bridge** has run on Windows since 0.15.0: Herdr exposes its control socket there as a
*named pipe*, and Collie dials it through `node:net` — see [`bridge/dial.ts`](../../bridge/dial.ts)
and [Windows](../../README.md#windows-experimental) in the main README. What was missing is the
**lifecycle** around it: a supervisor, and the start/stop/update commands. That's what lives here —
a PowerShell control script that mirrors [`scripts/collie-ctl.sh`](../../scripts/collie-ctl.sh)
against **Task Scheduler** instead of `systemd --user`.

If your whole herd can live in WSL, the standard Linux setup applies and none of this is needed.

## What's in here

| File | What it is |
| --- | --- |
| `collie-ctl.ps1` | The control script — `build`, `start`, `stop`, `restart`, `status`, `url`, `version`, `logs`, `uninstall`, `update` |
| `collie-action.cs` | A tiny launcher compiled to `build/collie-action-v1.exe`, so a Herdr action can be a native command instead of shelling out to `bash` |
| `collie-ctl.test.ps1` | Its tests — dot-sources the control script and stubs the Task Scheduler cmdlets, so it runs without registering anything |

## Setup

Prerequisites: **Bun**, **git**, Herdr's Windows build, and Tailscale (or your own ingress).

```powershell
git clone https://github.com/AltanS/collie.git
cd collie
powershell.exe -NoProfile -ExecutionPolicy Bypass -File contrib\windows\collie-ctl.ps1 build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File contrib\windows\collie-ctl.ps1 start
```

`start` registers a Task Scheduler job (`herdr.collie`, override with `COLLIE_TASK_NAME`) that runs
at logon, restarts after failures, and outlives Herdr. `status` prints the same readiness banner the
POSIX script does; `logs` tails the bridge's stdout/stderr, including the pair preserved from the
last crash. Config is the usual `.env` in the plugin config dir
([`.env.example`](../../.env.example) documents every key).

**Herdr's action buttons stay POSIX.** [`herdr-plugin.toml`](../../herdr-plugin.toml) declares
`linux`/`macos` only and its actions shell out to `bash`, and this directory deliberately doesn't
change that. Drive the lifecycle from PowerShell as above, or — if you want the buttons — point a
local edit of the manifest's `[[actions]]` at `build\collie-action-v1.exe` (which `build` produces
for exactly that purpose) and add `windows` to `platforms`. That edit is yours to carry.

**The version gate is skipped on this path.** `scripts/check-version.sh` is a maintainer release
gate and needs bash; operators never need it. Run it from WSL or Git Bash if you're cutting a
release from Windows.

## Security defaults

The posture is the one in [§Security](../../README.md#%EF%B8%8F-security--read-before-you-run-it) —
nothing is relaxed here.

- **The scheduled task runs at limited privilege.** `COLLIE_TASK_RUN_LEVEL=highest` is an explicit
  opt-in for hosts where Herdr itself intentionally runs as Administrator, it refuses to register
  unless you're in an Administrator PowerShell — and every action you take from your phone then
  inherits Administrator. Prefer running Herdr normally.
- **Ingress stays operator-owned. Collie publishes nothing on Windows.** The control script never
  touches Tailscale Serve state — not on `start`, not on `uninstall`. Create the mapping yourself,
  once, in an Administrator PowerShell (`tailscale serve --bg 8787`), or run
  `COLLIE_SKIP_SERVE=1` behind your own reverse proxy per
  [Variant C](../../README.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale). This
  is the [one managed front door](../../.adr/0001-one-managed-front-door.md) rule holding: Collie
  manages exactly one, and it isn't this one.

## Support

**Community-maintained by [Pimpmuckl](https://github.com/Pimpmuckl) (Jonathan Liebig)**, extracted
from [#71](https://github.com/AltanS/collie/pull/71). Verified against **0.27.x** at extraction
time. It is **not covered by CI, not exercised by the release process, and not part of the
supported tree** — the maintainer does not run Windows. Fixes arrive as pull requests, not as bug
reports; if it breaks against a newer Collie, send the patch.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File contrib\windows\collie-ctl.test.ps1
```
