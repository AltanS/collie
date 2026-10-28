# Collie on Windows

How to install Collie on Windows 11, open it on your phone, and fix what can go wrong. Read
[Security](security.md) first: Collie gives remote shell access to your machine by design.

`collie start` publishes Collie to your phone for you, with Tailscale Serve, on Windows as on Linux
and macOS. Tailscale is a service that joins your own devices into a private network, called a
tailnet.

Tailscale Serve gives Collie an HTTPS address on your tailnet, and `collie start` runs it for you.
[Reaching it from your phone](#reaching-it-from-your-phone) shows the setup, and the steps by hand
for when `collie start` cannot publish.

> **Experimental.** Experimental means the maintainer owns and tests the Windows code, and the
> parts below are not all proven yet. This is the whole status:
>
> **Tested**
> - A 25-step install, update and rollback rehearsal on a Windows 11 virtual machine, against local
>   copies of the release files.
> - A real install from the public v1.16.0 release on a Windows 11 virtual machine: `install.ps1`
>   found the release, the sha256 matched and `collie.exe` ran. Then `collie start`,
>   `collie status`, `collie doctor` and `collie stop` worked.
> - Phone access through Tailscale Serve over HTTP, on a Headscale tailnet: the Host check,
>   `collie url`, pairing and the write gate.
>
> **Not tested yet**
> - An update between two real releases on Windows.
> - The HTTPS form of Tailscale Serve on Windows, and with it the home screen install, Web Push and
>   the microphone.
> - Publishing from `collie start` on a real tailnet on Windows. Only unit tests and HTTP on the
>   project's Headscale test tailnet have run it.
> - Windows 10, Windows Server, Windows on ARM, and the other items in
>   [What is not tested](#what-is-not-tested).
>
> The release check requires the Windows zip from now on. Only the maintainer can override that, for
> a Linux hotfix ([details](#a-release-without-a-windows-zip)).

## What you get

Collie shows the agents in your terminal on your phone, so you can see which one needs you and
answer it.

The agents run in [Herdr](https://herdr.dev) panes. A pane is one terminal window inside Herdr.
Herdr is a terminal multiplexer, a program that keeps your agents running in panes. On Windows,
Herdr is the only supported multiplexer.

Collie reads agents such as Claude Code, Codex, OpenCode, pi and omp. The agent itself must run on
Windows. Which ones do is the agent's matter, not Collie's.

## Before you start

You need these:

- **Windows 11 on x64.** WSL is not Windows here. Inside WSL, follow the Linux install in
  [Install](install.md).
- **PowerShell.** The Windows PowerShell 5.1 that comes with Windows 11 is enough.
- **Herdr 0.9.3 or newer for Windows.** Step 3 of Zero to phone installs it. The Herdr project makes its
  Windows build, and Collie depends on it.
- **A phone** with a browser, an iPhone or an Android phone.
- **A free Tailscale account.** You create it when you first sign in to the Tailscale app. The PC
  and the phone must sign in to the same one. The phone reaches the PC through it. Steps 1 and 2
  of Zero to phone set it up, and step 6 publishes Collie on it.

Check whether Smart App Control is on, because it can block `collie.exe`. Open Windows Security,
then **App & browser control**, then **Smart App Control settings**. It has three states:

| State | What it means for this install |
| --- | --- |
| Off | It blocks nothing. |
| Evaluation | Windows is still deciding whether to turn it on. It did not block Collie on the test VM. |
| On | It can block `collie.exe`, because the file is not signed, and it has no per-file allow. |

If it is on, read [Unsigned binary](#unsigned-binary-smartscreen-and-smart-app-control) first. It
lists your choices.

## Zero to phone

The step list lives in one place: the [Windows path in the guide](five-minute-install.md#windows).
Follow its steps in order, then pair the phone with
[Put Collie on your phone and pair it](five-minute-install.md#put-collie-on-your-phone-and-pair-it).
To read the installer script before you run it, see [Install](#install).

What you should see after each step of the guide:

1. The Tailscale app on the PC and on the phone shows both devices on one tailnet. Over plain
   HTTP, which a Headscale tailnet uses, the home screen install is not available, and Collie
   stays a browser tab.
2. The admin console shows MagicDNS on and HTTPS enabled.
3. Herdr prints its installer output. `herdr --version` prints 0.9.3 or newer. This page has no
   Herdr command of its own, because the Herdr project owns the installer. If this one fails, open
   [herdr.dev](https://herdr.dev) and follow its Windows steps.
4. The script prints each step. It ends with a line that starts with `OK  Collie` and a list of next
   steps, which begins with `Next steps. This script does not take them for you:`, then
   `1. Open a NEW terminal window.` and `3. Start Collie, then print its address:`. To read the
   script first, see [Install](#install).

   No service starts and nothing stays running. The script runs `collie.exe version` once, to check
   that Windows lets it run, and that is all.
5. Herdr opens and takes over that terminal. A new terminal is needed because Windows gives the new
   PATH only to windows opened after the install.
6. A second terminal is needed because Herdr holds the first one. `collie start` prints the
   **Collie is running** banner and your tailnet address on the `tailnet` line. It runs
   `tailscale serve` for you, and it adopts a mapping that you made by hand with an older version of
   this page. If Tailscale is missing, signed out or without HTTPS, it prints one line
   `setup: <what is missing>` for each problem, each followed by an indented line
   `fix: <what to do>`, and still starts Collie on this PC. After the status banner it ends with
   `Running, but your phone cannot reach it yet. Fix the setup lines above, then run collie start
   again. collie doctor repeats this check.` Start your agent in a Herdr pane, for example
   `claude`. Collie shows it on its dashboard.
7. `collie url` prints the tailnet address. `tailscale serve status` shows the mapping that `start`
   made. If `collie url` prints a loopback address (`127.0.0.1`), an address that only this PC can
   open, `start` could not publish: see
   [Reaching it from your phone](#reaching-it-from-your-phone). You can open that address in a
   browser on this PC to see the dashboard.

After step 7, go on with the guide's phone section. There, `collie qr` prints the address as a QR
code, and `collie pair` prints a code of eight characters, then a line like `single-use · expires
<time> (10 minutes)`. When the phone is paired, the dashboard shows your panes. Panes that wait for
you come first.

## Install

What `install.ps1` does, and what you can change.

```powershell
irm https://colliepwa.dev/install.ps1 | iex
```

To read the script before you run it, save it, open it and run it as a file:

```powershell
Invoke-WebRequest -OutFile install.ps1 https://colliepwa.dev/install.ps1
notepad install.ps1
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` needs no Bun, no Git and no `bash`. It looks at the newest five releases, takes the
first one that has a Windows zip, checks its sha256 and stops on a mismatch. A sha256 is a fingerprint of the
file. The script prints each step, and it never asks for administrator rights. If no release
carries the zip, it stops as [described below](#a-release-without-a-windows-zip).

The default execution policy, `Restricted`, which is the Windows rule for which scripts may run,
refuses a downloaded script file. The last line of the
"read it first" variant sets `Bypass` for that one run. `Unblock-File .\install.ps1` is the other
way. The `irm ... | iex` form runs the script text directly and does not need this.

The script puts a release in `%LOCALAPPDATA%\collie\versions\<version>`, points the `current`
junction at it, and adds `current\bin` to your user PATH. A junction is a Windows folder link, and
`current` always points at the version that runs. The script runs `collie.exe version` once to
check that Windows lets it run. It starts nothing else. A second run changes nothing and points at
`collie update`.

| Variable | Effect |
| --- | --- |
| `COLLIE_DIR` | Where to install. Default `%LOCALAPPDATA%\collie`. Keep it short. |
| `COLLIE_TAG` | Install one exact release, for example `v1.16.0`. |
| `COLLIE_UPDATE_REPO` | The GitHub repository to download from. Default `AltanS/collie`. |
| `COLLIE_NO_PATH_EDIT=1` | Leave your PATH alone. Run `<COLLIE_DIR>\current\bin\collie.exe`. |

The zip is also on each release page on GitHub, beside its `.sha256` file. Use the script, not a
hand install of the zip.

`collie start` registers a Task Scheduler task named `herdr.collie`. Task Scheduler is the Windows
program that runs jobs at set times or events. The task starts Collie at your logon with a limited
token, which means without administrator rights.

The task runs a launcher, a small program that starts the bridge again if the bridge exits with an
error. The bridge is the Collie program that runs on your PC and serves the web page to your phone.

The launcher also restarts a bridge that is still running but has stopped answering. Two minutes
after a start it asks the bridge's health check every 30 seconds, and three misses in a row, about
90 seconds of silence, end the bridge so the launcher starts it again. A crew peer with no standby
door is not asked: its only door is mutual TLS.

## Reaching it from your phone

Step 6 of Zero to phone, in full: set up Tailscale once, and `collie start` publishes Collie on
your tailnet, the same way as on Linux and macOS.

If you already ran `tailscale serve` by hand on Collie's own listener, do nothing. That is tailnet
port 443 in https mode, or Collie's own port (8787 by default) in http mode. The first
`collie start` after the update keeps your mapping and records it as Collie's, and
`collie uninstall` removes it with the rest. `COLLIE_PUBLIC_HOSTS` and `COLLIE_PUBLIC_URL` in
`.env` are harmless and can stay. If your mapping on that port sends traffic somewhere other than
Collie, or uses the other protocol, Collie leaves it alone. `collie start` then prints an error that
says it refuses to overwrite the mapping, and `collie doctor` reports a root mount Collie does not
own.

If your hand-made mapping came from the old Headscale recipe on port 80 (`--http=80`), Collie does
not adopt it, and `collie uninstall` does not remove it. Move it to Collie's own port:

1. Put `COLLIE_SERVE_MODE=http` in the `.env` file (step 1 of the steps by hand below shows where).

2. Remove the port-80 mapping:

   ```powershell
   tailscale serve --http=80 --set-path=/ off
   ```

3. Remove `COLLIE_PUBLIC_URL` from the `.env` file, or change it to `http://<name>:8787`.

4. Start Collie, which publishes on Collie's own port:

   ```powershell
   collie start
   ```

For a new setup, follow these steps:

1. Install Tailscale on the PC and on the phone, and sign in to the same account on both:
   [tailscale.com/download](https://tailscale.com/download).

2. In the Tailscale [admin console](https://login.tailscale.com/admin/dns), open **DNS**, turn on
   MagicDNS, then select **Enable HTTPS**.

3. Start Collie, which publishes it on your tailnet:

   ```powershell
   collie start
   ```

4. Print the address to open on the phone:

   ```powershell
   collie url
   ```

> **Note.** Once `collie start` publishes Collie, every device on your tailnet can reach it, but it
> answers each one `device not paired` until you run `collie pair` and enter the code on the phone.
> Read [Security](security.md) on how to limit who may reach Collie.

Collie listens on this PC only, at a loopback address that only this PC can reach. `collie start`
then runs `tailscale serve --bg --set-path=/ 8787` for you and prints a line like
`tailscale serve (https) → tailnet :443 -> 127.0.0.1:8787`. That is the "managed front door":
Collie publishes the address itself and records the mapping in `tailscale-managed-handler` in its
config folder.

`collie start` also reads this PC's tailnet name from Tailscale and gives it to the Host check, so
the default setup needs no `COLLIE_PUBLIC_HOSTS` and no `COLLIE_PUBLIC_URL`. The Host check refuses
any website name that is not this PC's, which stops a web page from reaching Collie through DNS
rebinding. Open Collie by the full name: the Host check refuses the short name.

Publishing from `collie start` on Windows is new, and the project has tested it with unit tests
only, not yet on a real tailnet. If a step fails, report it ([where](#when-something-breaks)).

Collie removes only the mapping it recorded. `collie stop` leaves it in place, and
`collie uninstall` removes it. `tailscale serve status` shows it. Never use `tailscale funnel`:
Funnel puts Collie on the public internet.

On a tailnet with HTTPS on, Tailscale gives the address a certificate that the phone trusts.
Installing to the home screen, Web Push (notifications to your phone) and the microphone need
HTTPS. Over plain HTTP they stay off ([Voice input and Web Push](voice-and-push.md)).

### If you published by hand before

The first `collie start` after the update takes over your mapping and records it.

Earlier versions of this page told you to run `tailscale serve` by hand. When that mapping sends
`/` to Collie's port on the listener Collie would use, `collie start` prints
`tailscale serve: adopting the existing Collie root mount on :443` and records it. Until then,
`collie doctor` warns on its `front-door` line. The `COLLIE_PUBLIC_HOSTS` and `COLLIE_PUBLIC_URL`
lines in your `.env` keep working, and you may delete them.

### When `collie start` cannot publish

`collie start` prints `note: the tailnet front door did not come up`, and the lines above it say why.
Collie still runs on this PC, so fix the cause and run `collie start` again.

On a Headscale tailnet (a self-hosted Tailscale server) there are no HTTPS certificates, so the
HTTPS form cannot work. Publish over HTTP instead. Add this line to the `.env` file (step 1 of the
steps by hand below shows where it is), then restart and publish:

```text
COLLIE_SERVE_MODE=http
```

```powershell
collie restart
collie serve
```

Collie then publishes on its own port, and the address is `http://<name>:8787`. Plain HTTP is
acceptable here because Tailscale encrypts the traffic between tailnet devices (WireGuard), and the
HTTP hop stays inside the tailnet.

If Collie still cannot publish, or you want to run Tailscale Serve yourself, do it by hand:

1. Open the Collie config folder's `.env` file, and create the folder if it is missing:

   ```powershell
   New-Item -ItemType Directory -Force "$env:APPDATA\herdr\plugins\config\herdr.collie"
   notepad "$env:APPDATA\herdr\plugins\config\herdr.collie\.env"
   ```

2. Publish Collie's local port, 8787 by default, on your tailnet:

   ```powershell
   tailscale serve --bg --set-path=/ 8787
   ```

3. Add these two lines at the end of the `.env` file, with your own name from step 2, and save:

   ```text
   COLLIE_PUBLIC_HOSTS=myhost.tail1234.ts.net
   COLLIE_PUBLIC_URL=https://myhost.tail1234.ts.net
   ```

4. Restart the bridge, then print the address:

   ```powershell
   collie restart
   collie url
   ```

In step 1, Notepad asks whether to create the file if it is not there. Click **Yes**. The folder
is the Herdr plugin config folder for `herdr.collie`, by default
`%APPDATA%\herdr\plugins\config\herdr.collie`. `herdr plugin config-dir herdr.collie` prints it.

In step 2, Tailscale prints a line with an address like `https://myhost.tail1234.ts.net`. The name
is the part after `https://`. On Headscale use `tailscale serve --bg --http=8787 --set-path=/ 8787`,
and put `http://<name>:8787` in `COLLIE_PUBLIC_URL`. That mapping sits on Collie's own listener, so
the next `collie start` adopts it. A mapping on port 80 is not adopted. `--set-path=/` replaces
whatever this PC already serves at `/` on that port.

`COLLIE_PUBLIC_URL` is the address that `collie url` and the QR code of `collie pair` print. A
mapping made by hand that Collie later adopts becomes Collie's to remove; any other one stays
yours, and `tailscale serve reset` clears every Serve mapping on the PC.

If you prefer a reverse proxy, a program that forwards web requests to Collie, or another tunnel,
[Deployment](deployment.md) describes the variants. That is
[Variant C](deployment.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale), with
`COLLIE_SKIP_SERVE=1` and `COLLIE_PUBLIC_HOSTS` set to the name your phone opens. The first
`collie start` raises no firewall prompt, because Collie listens on this machine only.

### Open it on your phone

The steps are the same as on every system:
[Put Collie on your phone and pair it](five-minute-install.md#put-collie-on-your-phone-and-pair-it).
These notes are the Windows part.

- **Over plain HTTP,** the home screen install is not available, because it needs HTTPS. Pair in
  the browser tab instead.
- **With HTTPS,** type the code in the app that you opened from the icon, as the guide says.
- **The phone needs the Tailscale app,** signed in to your tailnet, to reach the address that
  `collie url` prints.
- **The code is good for 10 minutes and works once.** Run `collie pair` again if it ran out.
  Pairing ends the open access in the Note in
  [Reaching it from your phone](#reaching-it-from-your-phone)
  ([Pair a device](security.md#pair-a-device--the-write-credential)).

## Everyday commands

Run these in any terminal. Each works as it does on Linux and macOS, with the Windows notes below.

| Command | What it does on Windows |
| --- | --- |
| `collie start` | Registers the `herdr.collie` task if needed and starts the bridge. |
| `collie stop` | Disables the task, ends a running bridge and its launcher, and prints `bridge stopped`. Collie stays off, also at your next logon, until `collie start`. |
| `collie restart` | Restarts the bridge alone. |
| `collie status` | Names the task and its state, and shows the **Collie is running** banner. |
| `collie doctor` | Checks the install, Herdr, long paths and secret files, and prints a fix for each problem. |
| `collie url` | Prints the address to open on the phone. |
| `collie logs` | Prints the last lines of the log file. |
| `collie update` | Updates to the newest release ([Update](#update)). |
| `collie update --rollback` | Goes back to the previous version ([Update](#update)). |
| `collie uninstall` | Removes the task ([Uninstall](#uninstall)). |

### Update

Update from the terminal or from the phone, the same as on Linux and macOS:

```powershell
collie update
```

The update fetches the release, swaps `collie.exe`, restarts the bridge and checks that it
answers. If it does not answer, Collie rolls back to the version that worked, in about a minute
and a quarter. The phone's Update button runs the same chain.

To go back by hand, run this. It needs no network. It points `current` at the newest older version
that is still on disk and restarts the bridge. If that version does not come up, Collie goes
forward again and changes nothing:

```powershell
collie update --rollback
```

An old version folder can stay in `versions\` until the launcher restarts, because Windows will
not delete a folder a running program holds. The next update removes it.

> **Caution.** A source checkout never updates itself on Windows: `collie update` and the phone
> button say so in one sentence and change nothing. Every Windows install made before the first
> zip is a source checkout. Moving to the zip install is a one-time manual step: run
> `collie uninstall` to remove the old task, then run `install.ps1`. After that, `collie update`
> works.

Collie allows one install per Windows machine, and `collie start` refuses a task that runs
another one, which is why the old task goes first. You can also stay on a source checkout and
update it by hand: fetch the newer tag, run `bun run build`, then `collie restart`. The build
needs Git for Windows' `bash`.

Releases up to and including v1.15.0 cannot swap a running `collie.exe` and fail with `EPERM`.
The fix (PR 309) first shipped in v1.15.1. The later Windows update work, such as the phone's
Update button on Windows, first ships in v1.16.0.

### Uninstall

```powershell
collie uninstall
```

`collie uninstall` stops the bridge and removes the Task Scheduler task. It keeps the install
folder, your `.env` and the user PATH entry, as every install keeps its files. Then it prints two
more lines for PowerShell. The first removes the install folder. The second removes only
`current\bin` from your user PATH, through the registry. Collie prints the two lines on one line
each, with your real folder in them. They look like this, wrapped here to fit:

```powershell
cmd /c rmdir /s /q "<install folder>"
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$k.SetValue('Path', (($k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' |
  Where-Object { $_.TrimEnd('\') -ne '<install folder>\current\bin' }) -join ';'),
  $k.GetValueKind('Path'))
$k.Close()
```

Copy the lines from Collie's own output when you can. Collie removes the `tailscale serve`
mapping it recorded, which includes a hand-made mapping that `collie start` adopted
([Reaching it from your phone](#reaching-it-from-your-phone)). A mapping that it never recorded
stays.

## When something breaks

Run `collie doctor` first, then find your problem below.

`collie doctor` checks the install and prints a fix for each problem it finds. Then read the
section below that matches what you see. If none does, look in the log, described in
[Logs](#logs).

To report a problem, open an issue at
[github.com/AltanS/collie/issues](https://github.com/AltanS/collie/issues). Say that you run
Windows, give the Collie version from `collie version`, and paste the `collie doctor` output and
the last lines of the log. Remove anything private first. The log can hold pane text.

### Unsigned binary: SmartScreen and Smart App Control

`collie.exe` is not signed, so Windows does not know who published it. Read this before you run
the installer.

Two Windows features can stop an unsigned program:

- **SmartScreen** asks before it runs a program that came from the internet. For a file you
  downloaded in a browser, click **More info**, then **Run anyway**.
- **Smart App Control** has no per-file allow. If it is on and it blocks Collie, you cannot allow
  that one file. `install.ps1` shows the block when it runs `collie.exe version`, and prints no
  success line.

If Smart App Control blocks Collie, you have these choices, in this order:

1. Check whether it is on: open Windows Security, then **App & browser control**, then **Smart App
   Control settings**.
2. Build from source ([Build from source](#build-from-source)), which makes `collie.exe` on your
   own machine. This was not tested on a machine where Smart App Control is on.
3. Use a PC where Smart App Control is off, or report the block in an issue.
4. Last, turn Smart App Control off. This is hard to undo: Microsoft's documentation has said that
   turning it on again may need a Windows reset, so read Microsoft's current page first.

The sha256 check in `install.ps1` finds a damaged or swapped download. It does not say who
published the file, because the hash sits beside the zip, and whoever can replace one can replace
the other. Signing the binary is a possible later step, with no date.

### Long paths

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

### Task Scheduler refuses a standard user

**What you see:** `collie start` fails with `error: schtasks /Create /TN herdr.collie failed`,
Windows reports `0x80070569`, and Collie says the account lacks the right "Log on as a batch job".

This affects a standard user account that never had that right. An administrator account usually
has it.

An administrator grants the right:

1. Run `secpol.msc`.
2. Open Local Policies, then User Rights Assignment.
3. Open **Log on as a batch job**, and add the account.
4. Run `collie start` again.

Windows Home does not ship `secpol.msc`.

### Secret files

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

### Logs

The bridge log is `collie.log` in the plugin config folder
(`%APPDATA%\herdr\plugins\config\herdr.collie\collie.log` by default). `collie logs` prints its last
lines. Collie only appends to it and never rotates it, so the file grows for as long as the bridge
runs. To empty it, run `collie stop`, delete the file, then run `collie start`.

### Build from source

The release zip needs no toolchain. A build from source still needs Bun, Git and Git for Windows'
`bash` on your PATH, because `bun run build` calls `bash`. A build without `bash` is planned and
not done.

## What is supported

One host: Windows 11 on x64, with Herdr as the multiplexer.

A **crew** is several machines that each run a Collie, shown behind one URL ([Crews](crew.md)).

| | Supported | Not supported, may work, untested |
| --- | --- | --- |
| Windows | Windows 11, x64 | Windows 10, Windows Server and Windows on ARM |
| Multiplexer | Herdr 0.9.3 or newer for Windows | tmux, zellij and tuios: none has a native Windows build |
| Service | Task Scheduler, one Collie per machine | A Windows service, winget and MSI |
| Crew | Collie on one machine | A Windows machine joining a crew |
| Front door | `collie start` publishes it with `tailscale serve`; the by-hand path is the fallback | A reverse proxy or another tunnel |
| Binary | `collie.exe`, unsigned, with a sha256 | A signed binary |

These limits also hold:

- Collie allows one install per Windows machine. The task name is always `herdr.collie`.
- Collie does not rotate `collie.log` ([Logs](#logs)).
- `herdr plugin install` is not a Windows install path. Use `install.ps1`, then `collie start`.
- Herdr's action buttons do not exist on Windows, because they need `bash`.
- A permission that a hook holds is not on Windows yet. Collie builds no hold socket there, so every permission stays a screen ask.
- The nightly harness lab runs on Linux only. It is not on Windows.
- Herdr's Windows build is made by the Herdr project. Collie depends on it and does not control it.

### Crews

A Windows machine cannot join a crew in this release. `collie crew invite`, `crew join`,
`crew add`, `crew deputy`, `crew approve-promote` and `collie promote` refuse on Windows, say so in
one sentence and change nothing. Collie on one Windows machine works on its own.

## Moving from the community script

What changes if you ran the community script, and what does not carry over.

Before this release, Windows ran under `contrib/windows/collie-ctl.ps1`, a script the community wrote. Collie now runs the task itself, and every verb of the script is a `collie` verb of the same name. After you update, run `collie restart` once. If the script ran the task named `herdr.collie`, Collie takes it over under the same name. Until you restart, `collie status` and `collie doctor` say that the task still runs the old script.

Two things do not carry over:

- **A custom task name.** The script let you set `COLLIE_TASK_NAME`. Collie does not read it, and the task is always `herdr.collie`. A task you registered under another name stays where it is, and Collie does not stop or remove it. Delete it before you run `collie start`, or two supervisors will start the bridge. In PowerShell: `schtasks /Delete /TN "<your task name>" /F`.
- **Crash-log copies.** The script kept a copy of the log when the bridge failed. Collie does not. The old copies stay on disk until you delete them.

## How this is tested, and when experimental ends

Why Collie says experimental, for readers who want the evidence. You do not need it to use Collie.

Two words on this page have a fixed meaning:

- **Supported** means the maintainer owns the Windows code and tests it: a CI run on every push,
  and a rehearsal on a Windows 11 virtual machine before each release tag
  ([ADR 0075](../.adr/0075-windows-is-a-supported-host.md)). CI is the automatic test run on
  GitHub. An ADR is a short decision record kept in the repository.
- **Experimental** means an update between two real releases and the HTTPS phone path are not yet
  proven.

What the support rests on:

- The `windows.yml` workflow, a CI workflow, runs the bridge, cli and scripts tests on
  `windows-latest` for every pull request and every push to `main`. It is not yet a required check.
  The maintainer plans to make it one after about ten green runs in a row.
- Each release builds `collie-<version>-windows-x64.zip` with a `.sha256` file.
- Before each release tag, the maintainer runs a rehearsal, `make win-rehearse`. It installs a
  release on a fresh Windows 11 VM, updates it from the terminal and from the phone's endpoint,
  forces a failed health check and checks the rollback. The update uses a local copy of the release
  files. If the VM is not available, the tag waits.
- Windows 11 is the second truth beside CI, because the CI runner is Windows Server.
- The real install from the public v1.16.0 release ran on a Windows 11 VM. `install.ps1` found the
  release, downloaded the zip, the sha256 matched, and `collie.exe` ran as 1.16.0. `collie start`
  registered the task and started the bridge. `collie status` said running, `collie doctor` exited
  0, and `collie stop` stopped it. The script at `https://colliepwa.dev/install.ps1` is live, and it
  is byte-identical to the script in the v1.16.0 release.
- Phone access ran on a Windows 11 VM on a Headscale tailnet, over HTTP. `tailscale serve --bg
  --http=80 --set-path=/ <port>` published Collie. The two `.env` lines and `collie restart` made
  `collie url` and the `collie start` banner print the tailnet name. From another tailnet machine,
  the page, `/api/health` and `/api/snapshot` answered by the full name, and a request by tailnet IP
  address or by the short name was refused. Pairing in the phone interface worked, and after it a
  write without the credential got 403 "device not paired". A desktop browser at phone size stood
  in for the phone.
- Smart App Control on the test VM is in evaluation mode, and neither Smart App Control nor
  SmartScreen has blocked Collie there. This page describes what Windows documents, not a block
  that was seen.

The word experimental leaves only when all of these are true together:

1. A release carries the Windows zip, `install.ps1` is on colliepwa.dev, and one install and one
   update have run against a real release. The first three are done: v1.16.0 carries the zip, the
   address is live and the install has run. An update between two real releases has not, because it
   needs a second release with the zip.
2. The Windows check is a required check in branch protection. Branch protection is the GitHub
   setting that blocks a merge until the named checks pass.
3. The release gate reads the Windows workflow. The gate is the first step of the release
   workflow, which waits for the tests before it publishes.
4. The tolerance for a missing Windows zip is off. It is off now, as the next section says.

### A release without a Windows zip

The release check requires the Windows zip from now on. Only the maintainer can override that, for
a Linux hotfix. The release job checks this in `scripts/windows-asset.ts`. It looks for an earlier
stable release (not a draft, not a prerelease) that carries the zip, and v1.16.0 is one. From 2026-11-15 the zip is mandatory in any case, and it is
also mandatory when GitHub's release list does not answer. The one exception is a switch that the
maintainer can set for a Linux hotfix while the Windows build is broken, the repository variable
`COLLIE_WINDOWS_ASSET_OVERRIDE`. A release made under that switch carries no Windows zip.

Releases before v1.16.0 have no Windows zip. What you see when the newest release has none:

- `install.ps1` looks at the newest five releases. For each one it prints
  `<tag> has no Windows build. Trying the next older release.` Then it prints
  `collie install: none of the newest 5 releases of AltanS/collie carries a Windows build yet.
  Nothing was installed.` and ends with `Install failed.` and a line that tells you to pin a
  release that has one. It changes nothing on your machine. To pin one, set `COLLIE_TAG`.
- `collie update` on a Windows install says `error: release <version> has no Windows build; try
  again after the next release. Nothing was changed.`

To check, open the release page on GitHub and look for a file named
`collie-<version>-windows-x64.zip`.

### What is not tested

Plain list, so nothing here reads as a promise:

- An update between two real releases on Windows. The rehearsal used a local copy of the release
  files.
- The HTTPS form of Tailscale Serve on Windows (Headscale answered `501 Not Implemented`), and with
  it the home screen install, Web Push and the microphone. Also a real phone, an agent running in a
  Herdr pane, and a reverse proxy, in place of
  [Tailscale Serve](#reaching-it-from-your-phone).
- Publishing from `collie start` on a real tailnet on Windows. It has unit tests, and HTTP ran on
  the project's Headscale test tailnet.
- A manual `collie update --rollback` on Windows. The automatic rollback after a failed update was
  rehearsed.
- Moving from a source checkout to the zip install, and updating a source checkout by hand.
- Installing the zip by hand, without `install.ps1`.
- Windows 10, Windows Server, Windows on ARM, tmux, zellij and tuios on Windows.
- pi and OmO in a Herdr pane on Windows. Collie reads their screens from Linux captures only, and the
  Windows console may lay out their rows differently.
- A real Smart App Control block, and PowerShell 7 for `install.ps1`.
- A build from source on a machine where Smart App Control is on.
- The Task Scheduler fix on Windows Home. The route was checked with a standard user whose name held
  a space and a non-ASCII letter.
- A FAT volume with real hardware. The "not checked" answer is covered by unit tests.
- A second Collie's task being refused, covered by unit tests only.
- Whether Explorer sees the new PATH without a sign-out, and a PATH edit by a standard user.
- The `local-cli` voice provider with a real engine. Its cleanup was tested with a test command:
  Collie ends the command's process tree, but a process started by a helper that has already exited
  can outlive it ([Voice input and Web Push](voice-and-push.md#run-your-own-command-the-local-cli-provider)).
