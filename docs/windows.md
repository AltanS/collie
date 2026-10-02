# Collie on Windows

What Windows support covers, how to install and update Collie there, and what Windows can stop
you on. Read [Security](security.md) first: Collie exposes remote shell access to your machine
by design.

> **Experimental.** Windows is a supported host with a small boundary, and the word stays until
> a release carries the Windows zip and `install.ps1` is published on colliepwa.dev. The
> maintainer owns the code and tests it on a Windows 11 virtual machine and on every push
> ([ADR 0075](../.adr/0075-windows-is-a-supported-host.md)).

## What is supported

One host: Windows 11 on x64, with Herdr as the multiplexer.

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
- Each release builds `collie-<version>-windows-x64.zip` with a `.sha256` file.
- Before each release tag, `make win-rehearse` installs a release on a fresh Windows 11 VM,
  updates it from the terminal and from the phone's endpoint, forces a failed health check and
  checks the rollback.

WSL is not Windows here. Inside WSL, follow the Linux install.

## Install

Run `install.ps1`. It needs no Bun, no Git and no `bash`. It downloads the Windows zip of the
newest release, checks its sha256 and stops on a mismatch.

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

## Unsigned binary: SmartScreen and Smart App Control

`collie.exe` is not signed, so Windows does not know who published it. The sha256 check in
`install.ps1` is the only proof that the download is the file the release published.

Two Windows features can stop an unsigned program:

- **SmartScreen** asks before it runs a program that came from the internet. For a file you
  downloaded in a browser, click **More info**, then **Run anyway**.
- **Smart App Control** can block the program with no option to allow it once. If it is on and
  blocks Collie, `install.ps1` shows the block when it runs `collie.exe version`, and prints no
  success line. The setting is in Windows Security, under App and browser control. Turning it off
  changes the whole PC, so that choice is yours.

> **Note.** Smart App Control on the test VM is in evaluation mode, and neither feature has
> blocked Collie there. This page describes what Windows documents, not a block that was seen.

Signing the binary is a possible later step. It is not planned for a date.

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

> **Caution.** Collie 1.15.0 and older cannot update themselves on Windows. The second half of
> `collie update` runs the code of the release it just fetched, and that older code swaps
> `collie.exe` the old way, which fails with `EPERM`. Update by hand once. After that,
> `collie update` works. Neither route below was rehearsed.

- **A source checkout:** fetch the newer tag, check it out, run `bun run build`, then
  `collie restart`. The build needs Git for Windows' `bash`.
- **To move to the binary install:** run `collie uninstall` on the old install first. Collie
  allows one install per Windows machine, and `collie start` refuses a task that runs another
  one. Then run `install.ps1`.

A source checkout cannot update itself on Windows at all. `collie update` and the phone button
say so in one sentence and change nothing.

## Long paths

Herdr cannot start a pane in a folder whose path is longer than 260 characters unless Windows
long paths are on. The error is `os error 267`. `collie doctor` warns when `LongPathsEnabled` is
0, and when the install folder itself is very long.

In a PowerShell run as administrator:

```powershell
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' `
  -Name LongPathsEnabled -Value 1
```

Windows may need a restart before programs that are already running see it. Keep your work
folders short in any case.

## Task Scheduler refuses a standard user

A standard user account may lack the right to run a scheduled task, and `collie start` then
fails. Windows reports `0x80070569`, and Collie prints that the account lacks the right "Log on
as a batch job".

An administrator grants it in Local Security Policy, under Local Policies, User Rights
Assignment, **Log on as a batch job**, by adding the account. Then run `collie start` again.
This was checked with a standard user, whose name held a space and a non-ASCII letter.

## Secret files

Collie keeps its secret files private to your account, SYSTEM and Administrators, by the access
list (ACL) of its state and config folders. Windows has no `0600` mode, so this is the Windows
form of the same rule.

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

Before a repair, the bridge saves the old list in `acl-backups` in the state folder and prints
the undo line. Run it in a terminal run as administrator:

```powershell
icacls <folder> /restore <backup file>
```

`COLLIE_NO_ACL_REPAIR=1` turns every change off. Collie still checks and warns. The full account
of the rules is in [Secret files on Windows](security.md#secret-files-on-windows).

## Reaching it from your phone

Collie listens on this machine only, and on Windows it publishes no front door. `collie start`
does not run `tailscale serve` here. To use Collie from a phone, put your own front door in front
of it, for example a reverse proxy, as in
[Variant C](deployment.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale), and set
`COLLIE_PUBLIC_HOSTS`. The first `collie start` raises no firewall prompt because the bind is
loopback. A managed front door on Windows is planned and not built.

## Crews

A Windows machine cannot join a crew in this release, and no crew step was rehearsed on Windows.
Collie on one Windows machine works on its own.

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
- `install.ps1` against the real GitHub release endpoints, which no release can offer until one
  carries the Windows zip.
- An update from a real GitHub release. The rehearsal used a local copy of the release files.
- A phone reaching a Windows machine through Tailscale or any proxy.
- A FAT volume with real hardware. The "not checked" answer is covered by unit tests.
- A second Collie's task being refused, covered by unit tests only.
- Whether Explorer sees the new PATH without a sign-out, and a PATH edit by a standard user.
