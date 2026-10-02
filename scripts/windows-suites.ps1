# The Windows test suites, in ONE place. CI (`windows` job in ci.yml) and the Windows VM
# (`make win-test`, guest-test.ps1 in the workspace) both call this file, so they cannot drift.
#
# The caller gets the code, the toolchain and `bun install` ready. This script does none of that.
# It runs `bun test` over bridge, cli and scripts, and prints one line per suite. Exit 0 means: no
# failing test, and no more skipped tests than -MaxSkips allows. Any other result exits 1.
#
# Works in Windows PowerShell 5.1 and in PowerShell 7.
#
#   -Out       where the logs go: <suite>.log and <suite>.fails per suite (one failing name per line)
#   -MaxSkips  the most skipped tests that still count as green. A test must not be skipped just to
#              get green, so a higher count is a failure. Raise this number only with a reason.
#              Measured 2026-10-02 on the Windows 11 VM: bridge 2, cli 1, scripts 23 (26 in all).
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxSkips = 26
)
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
$skipped = @()
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
  if ($skip -gt 0) { $skipped += ("{0} {1}" -f $name, $skip) }
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

Write-Output ("skips    {0} (allowed {1})" -f $totalSkips, $MaxSkips)
if ($totalSkips -gt $MaxSkips) {
  Write-Output ("         too many skipped tests: {0}, allowed {1}. From: {2}." -f $totalSkips, $MaxSkips, ($skipped -join ", "))
  Write-Output "         Remove the skip. If a test truly cannot run on Windows, raise -MaxSkips in scripts/windows-suites.ps1 and say why in the PR."
  $failed = $true
}
if ($allFails.Count -gt 0) {
  Write-Output "failing tests (first 40):"
  $allFails | Select-Object -First 40 | ForEach-Object { Write-Output "         $_" }
}
Write-Output "logs     $Out"
if ($failed) { exit 1 }
exit 0
