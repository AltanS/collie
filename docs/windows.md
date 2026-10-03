# Collie on Windows

What Windows support covers, how to install and update Collie there, and what Windows can stop
you on. Read [Security](security.md) first: Collie exposes remote shell access to your machine
by design.

> **Experimental.** Read this first, because it is the truth about today. A release carries the
> Windows zip when its Windows build succeeds. Until the Windows build is a required part of the
> release, a release may ship without it. Then `install.ps1` and `collie update` say so and
> install nothing. The parts below were tested as this page describes them. Phone access needs
> a front door that you set up yourself, and it has not been tested on Windows.

Two words on this page have a fixed meaning:

- **Supported** means the maintainer owns the Windows code and tests it: a CI run on every push,
  and a rehearsal on a Windows 11 virtual machine before each release tag
  ([ADR 0075](../.adr/0075-windows-is-a-supported-host.md)).
- **Experimental** means the install path and the phone path are not yet proven against a real
  release. The word leaves only when all of these are true together: a release carries the Windows
  zip, `install.ps1` is on colliepwa.dev, and one install and one update have run against a real
  release; the Windows check is a required check in branch protection; the release gate reads the
  Windows workflow; and the tolerance for a missing Windows zip is off. That tolerance closes
  itself, as soon as any earlier release carries a Windows zip or on 2026-11-15.

What you see when a release carries no Windows zip:

- `install.ps1` looks at the newest five releases. For each one it prints
  `<tag> has no Windows build. Trying the next older release.` Then it prints
  `collie install: none of the newest 5 releases of AltanS/collie carries a Windows build yet.
  Nothing was installed.` and ends with `Install failed.` and a line that tells you to pin a
  release that has one. It changes nothing on your machine.
- `collie update` on a Windows install says `error: release <version> has no Windows build; try
  again after the next release. Nothing was changed.`

To check, open the release page on GitHub and look for a file named
`collie-<version>-windows-x64.zip`.

## Zero to phone

Five steps. Each links to its section.

1. [Install Herdr for Windows](#what-is-supported), 0.9.3 or newer.
2. [Install Collie](#install) with `install.ps1`. This needs a release that carries the zip.
3. [Open a new terminal, start Herdr, then run `collie start`](#install).
4. To open Collie on your phone you must expose it yourself, for example with a reverse proxy or a
   VPN. This is not tested on Windows. [Reaching it from your phone](#reaching-it-from-your-phone)
   has the details.
5. [Pair your phone](security.md#pair-a-device--the-write-credential) with `collie pair`.

## What is supported

One host: Windows 11 on x64, with Herdr as the multiplexer.

[Herdr](https://herdr.dev) is the terminal multiplexer that Collie mirrors: a program that keeps
your agents running in panes. A **crew** is several machines that each run a Collie, shown behind
one URL ([Crews](crew.md)). A **front door** is the HTTPS address in front of Collie that your
phone opens, because Collie itself listens on the machine it runs on and nowhere else.

| | Supported | Not supported |
| --- | --- | --- |
| Windows | Windows 11, x64 | Windows 10, Windows Server and Windows on ARM are best effort |
| Multiplexer | Herdr 0.9.3 or newer for Windows | tmux, zellij and tuios: none has a native Windows build |
| Service | Task Scheduler, one Collie per machine | A Windows service, winget and MSI |
| Crew | Collie on one machine | A Windows machine joining a crew |
| Front door | You bring your own | Collie does not run `tailscale serve` on Windows |
| Binary | `collie.exe`, unsigned, with a sha256 | A signed binary |

What the support rests on:

- The `windows.yml` workflow runs the bridge, cli and scripts tests on `windows-latest` for every
  pull request and every push to `main`. It is not yet a required check. The maintainer plans to
  make it one after about ten green runs in a row.
- Each release is meant to build `collie-<version>-windows-x64.zip` with a `.sha256` file.
- Before each release tag, `make win-rehearse` installs a release on a fresh Windows 11 VM,
  updates it from the terminal and from the phone's endpoint, forces a failed health check and
  checks the rollback.
- Herdr's Windows build is made by the Herdr project. Collie depends on it and does not control it.

WSL is not Windows here. Inside WSL, follow the Linux install.

## Unsigned binary: SmartScreen and Smart App Control

`collie.exe` is not signed, so Windows does not know who published it. Read this before you run
the installer.

Two Windows features can stop an unsigned program:

- **SmartScreen** asks before it runs a program that came from the internet. For a file you
  downloaded in a browser, click **More info**, then **Run anyway**.
- **Smart App Control** has no per-file allow. If it is on and it blocks Collie, you cannot allow
  that one file. `install.ps1` shows the block when it runs `collie.exe version`, and prints no
  success line. Microsoft's documentation has said that turning Smart App Control off may not be
  undone without resetting Windows, so check Microsoft's current page before you change it. The
  other way out is a [build from source](#build-from-source), which makes `collie.exe` on your own
  machine. That route has not been tested against Smart App Control.

> **Note.** Smart App Control on the test VM is in evaluation mode, and neither feature has
> blocked Collie there. This page describes what Windows documents, not a block that was seen.

The sha256 check in `install.ps1` finds a damaged or swapped download. It does not say who
published the file, because the hash sits beside the zip, and whoever can replace one can replace
the other. Signing the binary is a possible later step, with no date.

## Install

Run `install.ps1`. It needs no Bun, no Git and no `bash`. It downloads the Windows zip of the
newest release that has one, checks its sha256 and stops on a mismatch. Until a release carries
the zip, it stops as [described above](#collie-on-windows).

```powershell
irm https://colliepwa.dev/install.ps1 | iex
```

> **Note.** That address is not live yet. Until it is, download the script from the repository,
> read it, and run it as a file. The script prints each step, and it never asks for administrator
> rights.

```powershell
Invoke-WebRequest -OutFile install.ps1 `
  https://raw.githubusercontent.com/AltanS/collie/main/scripts/install.ps1
notepad install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The default execution policy, `Restricted`, refuses a downloaded script file, so the last line
sets `Bypass` for that one run. `Unblock-File .\install.ps1` is the other way.

The script puts a release in `%LOCALAPPDATA%\collie\versions\<version>`, points the `current`
junction at it, and adds `current\bin` to your user PATH. It runs `collie.exe version` once to
check that Windows lets it run. It starts nothing. A second run changes nothing and points at
`collie update`.

| Variable | Effect |
| --- | --- |
| `COLLIE_DIR` | Where to install. Default `%LOCALAPPDATA%\collie`. Keep it short. |
| `COLLIE_TAG` | Install one exact release, for example `v1.16.0`. |
| `COLLIE_UPDATE_REPO` | The GitHub repository to download from. Default `AltanS/collie`. |
| `COLLIE_NO_PATH_EDIT=1` | Leave your PATH alone. Run `<COLLIE_DIR>\current\bin\collie.exe`. |

The zip is also on each release page on GitHub, beside its `.sha256` file. Installing it by hand
is not a route that has been tested. Use the script.

Then open a new terminal, because Windows gives the new PATH only to windows opened after the
install. Start Herdr and leave it running, then start Collie:

```powershell
herdr
collie start
collie url
```

`collie start` registers a Task Scheduler task named `herdr.collie`. It starts Collie at your
logon, with a limited token, and a launcher relaunches the bridge if it exits with an error.
`collie status` names the task and its state. `collie stop` disables it. `collie restart`
restarts the bridge alone.

## Update

Update from the terminal or from the phone, the same as on Linux and macOS:

```powershell
collie update
```

The update fetches the release, swaps `collie.exe`, restarts the bridge and checks that it
answers. If it does not answer, Collie rolls back to the version that worked, in about a minute
and a quarter. The phone's Update button runs the same chain. Both were rehearsed on a Windows 11
VM against a local copy of the release files, not yet against a real GitHub release.

An old version folder can stay in `versions\` until the launcher restarts, because Windows will
not delete a folder a running program holds. The next update removes it.

> **Caution.** A source checkout never updates itself on Windows: `collie update` and the phone
> button say so in one sentence and change nothing. Every Windows install made before the first
> zip is a source checkout. Moving to the zip install is a one-time manual step: run
> `collie uninstall` to remove the old task, then run `install.ps1`. After that, `collie update`
> works. This route was not rehearsed.

Collie allows one install per Windows machine, and `collie start` refuses a task that runs
another one, which is why the old task goes first. You can also stay on a source checkout and
update it by hand: fetch the newer tag, run `bun run build`, then `collie restart`. The build
needs Git for Windows' `bash`. That route was not rehearsed either.

Releases up to and including v1.15.0 cannot swap a running `collie.exe` and fail with `EPERM`.
The fix (PR 309) first shipped in v1.15.1. The later Windows update work, such as the phone's
Update button on Windows, first ships in v1.16.0.

## Long paths

**What you see:** a pane does not open, and Herdr says `The directory name is invalid (os error
267)`. `collie doctor` warns first: `LongPathsEnabled is 0 on this machine`.

Herdr cannot start a pane in a folder whose path is longer than 260 characters unless Windows
long paths are on. `collie doctor` also warns when the install folder itself is very long.

In a PowerShell run as administrator:

```powershell
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
  -Name LongPathsEnabled -Value 1
```

Windows may need a restart before programs that are already running see it. Keep your work
folders short in any case.

## Task Scheduler refuses a standard user

**What you see:** `collie start` fails with `error: schtasks /Create /TN herdr.collie failed`,
Windows reports `0x80070569`, and Collie says the account lacks the right "Log on as a batch job".

This affects a standard user account that never had that right. An administrator account usually
has it.

An administrator grants the right:

1. Run `secpol.msc`.
2. Open Local Policies, then User Rights Assignment.
3. Open **Log on as a batch job**, and add the account.
4. Run `collie start` again.

Windows Home does not ship `secpol.msc`, and this was not tried there. The route was checked with
a standard user whose name held a space and a non-ASCII letter.

## Secret files

**What you see:** `collie doctor` prints a `secrets-private` line, for example
`can be read by other accounts`, with a fix.

Collie limits who can read its secret files: your account, SYSTEM and Administrators. Windows has
no `0600` mode, so Collie sets the access list (ACL) of its state and config folders.

```powershell
collie doctor
```

The `secrets-private` line has three answers:

| Answer | Meaning |
| --- | --- |
| Private | The folders are private to your account, SYSTEM and Administrators. |
| Loose | Another account can read a folder or a secret. This is an error, and `doctor` prints the fix. |
| Not checked | Collie cannot read the list, so it says `cannot confirm`. This is a warning. |

A folder on a network share or a FAT or exFAT volume is "not checked", because there is no list
to read. Keep the state and config folders on an NTFS drive in this PC.

The bridge repairs a loose folder at start, but only a folder Collie created now, a default
folder in your user profile, or a folder that is empty or holds only Collie's own files. Any other
folder is checked and warned about, with the `icacls` command that fixes it. `collie doctor` and
other commands change nothing.

To undo a repair: before it, the bridge saves the old list in `acl-backups` in the state folder
and prints the undo line. Run it in a terminal run as administrator:

```powershell
icacls <folder> /restore <backup file>
```

`COLLIE_NO_ACL_REPAIR=1` turns every change off. Collie still checks and warns. The full account
of the rules is in [Secret files on Windows](security.md#secret-files-on-windows).

## Reaching it from your phone

To open Collie on your phone you must expose it yourself, for example with a reverse proxy or a
VPN. This is not tested on Windows. On Windows, `collie start` does not run `tailscale serve`, and
Collie listens on this machine only.

[Deployment](deployment.md) describes the variants, for example
[Variant C](deployment.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale), a
reverse proxy, with `COLLIE_PUBLIC_HOSTS` set. Install to the home screen, Web Push and the
microphone need HTTPS with a certificate the phone trusts. Over plain HTTP they stay off
([Voice input and Web Push](voice-and-push.md)). The first `collie start` raises no firewall
prompt, because Collie listens on this machine only.

A front door on Windows that Collie manages is planned and not built.

## Crews

A Windows machine cannot join a crew in this release, and no crew step was rehearsed on Windows.
Collie on one Windows machine works on its own.

## Moving from the community script

Before this release, Windows ran under `contrib/windows/collie-ctl.ps1`, a script the community wrote. Collie now runs the task itself, and every verb of the script is a `collie` verb of the same name. After you update, run `collie restart` once. If the script ran the task named `herdr.collie`, Collie takes it over under the same name. Until you restart, `collie status` and `collie doctor` say that the task still runs the old script.

Two things do not carry over:

- **A custom task name.** The script let you set `COLLIE_TASK_NAME`. Collie does not read it, and the task is always `herdr.collie`. A task you registered under another name stays where it is, and Collie does not stop or remove it. Delete it before you run `collie start`, or two supervisors will start the bridge. In PowerShell: `schtasks /Delete /TN "<your task name>" /F`.
- **Crash-log copies.** The script kept a copy of the log when the bridge failed. Collie does not. The old copies stay on disk until you delete them.

## Logs

The bridge log is `collie.log` in the plugin config folder (`%APPDATA%\herdr\plugins\config\herdr.collie\collie.log` by default). Collie only appends to it and never rotates it, so the file grows for as long as the bridge runs. To empty it, run `collie stop`, delete the file, then run `collie start`.

## Build from source

The release zip needs no toolchain. A build from source still needs Bun, Git and Git for Windows'
`bash` on your PATH, because `bun run build` calls `bash`. A build without `bash` is planned and
not done.

## Uninstall

`collie uninstall` removes the Task Scheduler task. It keeps the install folder and the user PATH
entry, as every install keeps its files, and prints the two PowerShell lines that remove them: a
`rmdir /s` for the folder and a registry edit that drops only `current\bin` from your PATH.

## What is not tested

Plain list, so nothing here reads as a promise:

- Windows 10, Windows Server, Windows on ARM, tmux, zellij and tuios on Windows.
- A real Smart App Control block, and PowerShell 7 for `install.ps1`.
- `install.ps1` against a real release that carries the zip.
- An update from a real GitHub release. The rehearsal used a local copy of the release files.
- A phone reaching a Windows machine through Tailscale or any proxy.
- A FAT volume with real hardware. The "not checked" answer is covered by unit tests.
- A second Collie's task being refused, covered by unit tests only.
- Whether Explorer sees the new PATH without a sign-out, and a PATH edit by a standard user.
- A build from source on a machine where Smart App Control is on.
- The `local-cli` voice provider with a real engine. Its cleanup was tested with a test command:
  Collie ends the command's process tree, but a process started by a helper that has already exited
  can outlive it ([Voice input and Web Push](voice-and-push.md#run-your-own-command-the-local-cli-provider)).
