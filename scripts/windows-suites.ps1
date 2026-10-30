# The Windows test suites, in ONE place. CI (`windows` job in ci.yml) and the Windows VM
# (`make win-test`, guest-test.ps1 in the workspace) both call this file, so they cannot drift.
#
# The caller gets the code, the toolchain and `bun install` ready. This script does none of that.
# It runs `bun test` over bridge, cli and scripts, and prints one line per suite. Exit 0 means: no
# failing test, and no suite with more skipped tests than its own budget allows. Any other result
# exits 1.
#
# Works in Windows PowerShell 5.1 and in PowerShell 7.
#
#   -Out       where the logs go: <suite>.log and <suite>.fails per suite (one failing name per line)
#   -MaxSkipsBridge, -MaxSkipsCli, -MaxSkipsScripts
#              the most skipped tests that still count as green, PER SUITE, so a new skip in one suite
#              cannot hide behind a removed one in another. A test must not be skipped just to get
#              green, so a higher count is a failure. Raise a number only with a reason.
#              Bridge went from 2 to 0 when M43 spec 04 checked the access list instead of the mode.
#              Today, 180 in all, each one named, with its reason:
#              bridge 98. 5 are the POSIX-only and engine cases below, 1 the /etc link scan, 5 are the hold socket tests, 6 the walky ones, 30 are the
#                durable example apps, 10 are the durable-harness adapter test, 36 are the durable socket tests (see "Durable, bridge" below),
#                and 5 are the pane's program reads (see "The pane's program, bridge" below).
#                Of the first 5, four are in bridge/stt/local-cli.test.ts. Windows has no executable bit
#                and no file owner check in this provider:
#                - "commandFileProblem: regular executable passes, symlinks are followed" (the
#                  executable bit; a symlink needs a privilege on Windows)
#                - "status refuses a directory and a non-executable file, and names neither" (the
#                  executable bit)
#                - "only an old directory with the prefix, owned by this user, is removed" (the
#                  owner check by uid)
#                - "loading the provider sweeps its temp root once, in the background" (without a
#                  uid the sweep removes nothing on Windows, so there is nothing to see)
#                The fifth is bridge/stt/whistle.test.ts, "the whistle provider - the real engine, end
#                to end > a 13 s WAV becomes text through a real child of this Collie". It runs only
#                where COLLIE_TEST_WHISTLE_DIR holds the measured model, which is never committed, so
#                no CI job or VM has it (Linux CI skips it too).
#              The /etc link scan, bridge (1). In bridge/claude-commands.test.ts, "discoverClaudeCommands: the bounds
#                a reader of the operator's disk keeps". Windows has no /etc, and a file symlink needs a privilege there:
#                - "real disk: a symlink to /etc, in a project or in the personal folders, yields no row" (POSIX links to /etc)
#              The hold socket, bridge (5). Windows builds no hold socket yet, so every permission there stays a
#                screen ask (CHANGELOG, M56 spec 12). The five tests of the "the hold socket" block in
#                bridge/surface/hook-ask.test.ts are `test.skipIf` on win32:
#                Each name sits on one line, so the pin test can find it:
#                - "owner-only: the folder is 0700, the socket 0600; a second bridge on the same path does not take it" (a POSIX socket file with an owner-only mode)
#                - "a pid the bridge cannot place is dropped with one log line, and the connection closes with no decision" (it dials that socket)
#                - "a placed request reaches the session; the decision travels back as one line" (the same)
#                - "a request from another multiplexer's pane is dropped without a log line, a same-namespace miss is logged" (the same)
#                - "an unparsed line is dropped" (the same)
#              Walky talky, bridge (6). A file mode and a Unix socket are POSIX. In bridge/walky/ the checks of
#                0700 and 0600 sit in their own skipped test, and the behaviour beside them runs on Windows:
#                - "keeps its tokens at 0600 in a 0700 folder" (instances.test.ts, "the instance registry")
#                - "is private: a 0700 folder and a 0600 file" (log.test.ts, "the log")
#                - "keeps its file at 0600 in a 0700 folder" (refusals.test.ts, "the refusal counter")
#                - "keeps an id and target a day, apart from the log, on disk at 0600" (seen.test.ts, "the seen file")
#                - "is 0600, answers one line per connection, and refuses a second bridge on the same path" (socket.test.ts, "the socket"): every part of it is the Unix socket, and Windows builds no walky socket ("Windows has no socket" runs there)
#                - "the server answers an unread line with its reason or `not here`, never the bare word" (socket.test.ts, "the socket"): the answer travels over the Unix socket
#              Durable, bridge (30 + 36). Windows has no socket transport (WIRE.md section 1A), so a test
#                that is about the Unix socket itself cannot run there. The tests about the wire (controls,
#                asks, answers, receipts, events, Chat, starters, the conformance suite) run on Windows
#                against the fake program on 127.0.0.1 (`FakeDurableProgram.startWire`). The 30 are every
#                test of bridge/mux/durable/example.test.ts (12), example-hello.test.ts (6) and
#                example-cloudflare.test.ts (12): the durable example speaks over a Unix socket (or needs
#                `wrangler`), and Windows attaches a program over HTTPS, so none of them runs there. A file's
#                count is its tests plus the skipped placeholder, the beforeAll and the afterAll that Bun
#                counts with them. The VM run of release-1.22 counted bridge 71, nine more than the 62 this
#                budget held before example-hello.test.ts (6) and three more counted in the other two files.
#                The 36 are bridge/mux/durable/client.test.ts: "the privacy check", "the path walk" and "the request"
#                (26; the socket client's owner, mode, link and path rules, and its deadline and size cap on
#                a socket); bridge/mux/durable/adapter.test.ts (6: the factory reading
#                COLLIE_DURABLE_SOCKET, the startup line, socket path rules, a program that asks for a token,
#                a socket that loses its mode, a socket that is not there); events.test.ts (the factory
#                handed a socket path), asks.test.ts (a socket with nothing listening) and
#                http-client.test.ts (the socket client sends no Authorization header), one each; and
#                bridge/durable/log.test.ts (a mode 0755 folder put back to 0700).
#              Durable harness, bridge (10). bridge/mux/durable/example-durable-harness.test.ts returns a skip reason on
#                win32: it starts the examples/durable-harness server with Node 24 and its Bun install, which no
#                Windows job or VM has. The Linux job "durable example" in ci.yml runs it. The 10 are its 7 tests,
#                the skipped placeholder, the beforeAll and the afterAll that Bun counts with them.
#              The pane's program, bridge (5). The version read of 1.24.1 (.adr/0124) runs the pane's own binary.
#                Each name sits on one line, so the pin test can find it:
#                - "boundedRun answers at its cap even when a grandchild holds the pipe" (binary-version.test.ts, win32: a POSIX sh grandchild)
#                - "boundedRun returns what a quick command printed, and its exit code" (binary-version.test.ts, win32: a POSIX sh)
#                - "procProbe sees a live process's executable and folder" (pane-binary.test.ts, off Linux: it reads /proc)
#                - "two copies of one harness" (pane-binary.test.ts, win32: its fake omp copies are POSIX sh scripts), its one test and
#                  the hook Bun counts with it. The Windows path of paneBinaryOf runs on Windows with a fake host ("no /proc" tests).
#              cli 57 in all: 18 in the next paragraph, then 3 of the statusLine wrapper and 36 of walky talky. Of the 18, 12 are every test of the "doctor durable" describe in cli/doctor.test.ts: each reads a
#                real Unix socket. Its Windows rows are tested in cli/durable-findings.test.ts with a fake
#                platform. The other 6:
#                "a per-call override wins over the Exec's own environment (#283) > a child killed by a signal says which one"
#                (Windows has no POSIX signals),
#                "a per-call override wins over the Exec's own environment (#283) > inherit and runIn can point the child's stdout at stderr"
#                (cli/sys.test.ts, added in 1.25.0: its children are POSIX `sh -c` commands),
#                "collie _whistle-transcribe - the real engine, end to end > a child of this checkout's CLI turns 10.4 s of speech into text"
#                (the same missing model as the bridge case), and the 3 tests of
#                "installScript from a shallow lead, run for real" in cli/remote.test.ts: they run the
#                install leg, POSIX sh that a crew member runs over ssh, and a Windows machine cannot be a
#                crew member (WINDOWS_CREW_SENTENCE in cli/crew.ts).
#              The statusLine wrapper, cli (3). The "runShell stops the whole command" block in cli/statusline.test.ts is
#                `describe.skipIf` off Linux: it signals a POSIX process group, and the wrapper is not on Windows by design
#                (the usage row, .adr/0115). Its 3 tests are "a SIGTERM to the wrapper stops a compound command's grandchild"
#                (2, one per group layout) and "passes the command's output and exit code through".
#              Walky talky, cli (36). cli/walky.test.ts runs the verbs against a real bridge socket in a temp state
#                dir, and Windows cannot bind it (the same reason as the hold socket). Each of those tests is
#                `socketTest`, 10 in "send", 22 in "reply, inbox, status, who", 1 in "cancel" and 3 in "on a crew member". The
#                tests that never reach the socket run on Windows: the usage errors, "no bridge at all is
#                UNREACHABLE" and "on Windows it says why and exits STATE".
#              scripts 25: 23 are every test of scripts/install.test.ts ("scripts/install.sh > ..."):
#                install.sh is POSIX sh, and Windows installs with install.ps1, tested beside it.
#                The other 2 are in the harness lab (scripts/harness-canary/lab/):
#                - "POSIX only: the login copy has mode 600" in seed.test.ts (Windows has no file modes)
#                - "a real throwaway server starts, shows its pane, stops, and leaves no socket" in tmux.test.ts
#                  (it needs a tmux binary, and Windows has none)
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxSkipsBridge = 98,
  [int]$MaxSkipsCli = 57,
  [int]$MaxSkipsScripts = 25
)
$skipBudget = @{ bridge = $MaxSkipsBridge; cli = $MaxSkipsCli; scripts = $MaxSkipsScripts }
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

# Always run from the repository root, whatever directory the caller is in.
Set-Location (Split-Path -Parent $PSScriptRoot)
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)

# Some suites shell out to bash. Git for Windows has one, but it is not on PATH by default.
# Put Git's own bash FIRST: Windows can also have `System32\bash.exe`, the WSL launcher, and that one is no use.
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$gitBin = if ($gitCmd) { Join-Path (Split-Path -Parent (Split-Path -Parent $gitCmd.Source)) "bin" } else { "C:\Program Files\Git\bin" }
if (Test-Path (Join-Path $gitBin "bash.exe")) { $env:Path = "$gitBin;" + $env:Path }
Write-Output ("bash     {0}" -f $(if (Get-Command bash -ErrorAction SilentlyContinue) { (Get-Command bash).Source } else { "NOT FOUND" }))

# Hermetic: the suites must not read a config or state dir that a live bridge on this machine uses.
foreach ($v in "HERDR_PLUGIN_CONFIG_DIR", "HERDR_PLUGIN_STATE_DIR", "COLLIE_STATE_DIR", "COLLIE_PORT", "HERDR_SOCKET_PATH") {
  Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $Out, "$Out\cfg", "$Out\state" | Out-Null
$env:HERDR_PLUGIN_CONFIG_DIR = "$Out\cfg"
$env:HERDR_PLUGIN_STATE_DIR = "$Out\state"

function Read-Utf8Lines([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  return [System.IO.File]::ReadAllLines($path)
}

# The count that bun prints on a line like "  12 skip". A missing line means zero.
function Get-BunCount([string[]]$lines, [string]$word) {
  foreach ($l in $lines) { if ($l -match "^\s*(\d+) $word\s*$") { return [int]$Matches[1] } }
  return 0
}

$failed = $false
$allFails = @()
$overBudget = @()
$totalSkips = 0

# One suite = one command line. cmd.exe does the redirect, so PowerShell never wraps or
# re-encodes the output, and the "(fail) name" lines stay whole.
$suites = [ordered]@{
  bridge  = "bun test ./bridge"
  cli     = "bun test ./cli"
  scripts = "bun test ./scripts"
}
foreach ($name in $suites.Keys) {
  $log = "$Out\$name.log"
  cmd /c "$($suites[$name]) > `"$log`" 2>&1"
  $bunExit = $LASTEXITCODE
  $lines = Read-Utf8Lines $log
  $pass = Get-BunCount $lines "pass"
  $fail = Get-BunCount $lines "fail"
  $skip = Get-BunCount $lines "skip"
  $failing = @($lines | Where-Object { $_ -like "(fail) *" } |
    ForEach-Object { ($_ -replace "^\(fail\) ", "") -replace "\s+\[[\d.]+ms\]$", "" } |
    Sort-Object -Unique)
  # Not `Set-Content`: with an empty list it leaves the old file in place, and a green run would
  # keep the failures of an earlier red one.
  [System.IO.File]::WriteAllLines("$Out\$name.fails", [string[]]$failing)
  Write-Output ("{0,-8} {1} pass, {2} fail, {3} skip" -f $name, $pass, $fail, $skip)
  $totalSkips += $skip
  if ($skip -gt $skipBudget[$name]) { $overBudget += ("{0} {1}, allowed {2}" -f $name, $skip, $skipBudget[$name]) }
  $allFails += @($failing | ForEach-Object { "{0}: {1}" -f $name, $_ })
  if ($pass -eq 0) {
    # No summary line, or none passed: a suite that ran nothing must not look green.
    Write-Output ("         {0}: no passing test in {1}" -f $name, $log)
    $failed = $true
  }
  if ($fail -gt 0 -or $failing.Count -gt 0) { $failed = $true }
  elseif ($bunExit -ne 0) {
    # bun failed with no failing test: a crash, a timeout, or a file that did not load.
    Write-Output ("         bun exit {0} with no failing test, last lines of {1}:" -f $bunExit, $log)
    $lines | Select-Object -Last 8 | ForEach-Object { Write-Output "         $_" }
    $failed = $true
  }
}

$allowed = $MaxSkipsBridge + $MaxSkipsCli + $MaxSkipsScripts
Write-Output ("skips    {0} (allowed {1}: bridge {2}, cli {3}, scripts {4})" -f $totalSkips, $allowed, $MaxSkipsBridge, $MaxSkipsCli, $MaxSkipsScripts)
if ($overBudget.Count -gt 0) {
  Write-Output ("         too many skipped tests: {0}." -f ($overBudget -join "; "))
  Write-Output "         Remove the skip. If a test truly cannot run on Windows, raise that suite's -MaxSkips<Suite> in scripts/windows-suites.ps1 and say why in the PR."
  $failed = $true
}
if ($allFails.Count -gt 0) {
  Write-Output "failing tests (first 40):"
  $allFails | Select-Object -First 40 | ForEach-Object { Write-Output "         $_" }
}
Write-Output "logs     $Out"
if ($failed) { exit 1 }
exit 0
