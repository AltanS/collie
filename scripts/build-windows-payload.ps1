# Build the Windows release payload (M43 spec 06), the way the `payload` job in release.yml builds
# the Linux and macOS ones. It writes three files into -Out:
#
#   collie-<version>-windows-x64.zip          the payload, one folder of that name at its root
#   collie-<version>-windows-x64.zip.sha256   "<sha256>  <name>", the same line `sha256sum` writes
#   windows-x64.artifact.json                 this payload's entry in the release manifest
#
# The `payload-windows` job in release.yml runs it on windows-latest, and the Windows 11 VM runs it
# by hand. It works in Windows PowerShell 5.1 and in PowerShell 7.
#
# NO NIX HERE. The Linux and macOS rows compile on the upstream Bun archive that flake.nix pins,
# because `bun build --compile` copies the RUNNING bun as the base of the binary, and the Nix copy is
# patched (#184). There is no Nix on Windows: the bun.exe on PATH is the one that compiles, and on
# the runner that is the upstream archive `oven-sh/setup-bun` unpacked. -StrictBun fails the build
# when its version is not the one flake.nix pins; without it a different version is a warning.
#
# The binary is NOT signed (M43 decision, 2026-10-01). Smart App Control is a documented limit.
#
#   -Out        where the three files go (made if missing)
#   -Version    the version in the names; default: the tag being built (vX.Y.Z), else herdr-plugin.toml
#   -Target     Bun's compile target; default the BASELINE build, as for linux-x64: the default
#               target needs AVX2, and the hardware a self-hosted tool lives on may not have it
#   -StrictBun  fail, not warn, when bun.exe is not the version flake.nix pins
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Version = "",
  [string]$Target = "bun-windows-x64-baseline",
  [switch]$StrictBun
)
# Every native command is checked by its exit code. "Stop" would turn a tool's stderr line into a
# terminating error in Windows PowerShell 5.1.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$Platform = "windows-x64"

function Fail([string]$message) {
  [Console]::Error.WriteLine("build-windows-payload: $message")
  exit 1
}

function Need-Exit0([string]$what) {
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)" }
}

# Always from the repository root, whatever directory the caller is in.
Set-Location (Split-Path -Parent $PSScriptRoot)
$repo = (Get-Location).Path
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# --- The version
$tomlLine = Select-String -LiteralPath (Join-Path $repo "herdr-plugin.toml") -Pattern '^\s*version\s*=\s*"([^"]+)"' | Select-Object -First 1
if ($null -eq $tomlLine) { Fail "herdr-plugin.toml names no version" }
if ($Version -eq "") {
  # The tag decides on a release run, as `${GITHUB_REF_NAME#v}` does in the Linux rows.
  if ($env:GITHUB_REF_TYPE -eq "tag" -and $env:GITHUB_REF_NAME -match '^v(.+)$') { $Version = $Matches[1] }
  else { $Version = $tomlLine.Matches[0].Groups[1].Value }
}
$payloadRoot = "collie-$Version-$Platform"
Write-Output "payload  $payloadRoot (target $Target)"

# --- The tools
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($null -eq $bunCmd) { Fail "bun is not on PATH" }
$bun = $bunCmd.Source
$bunVersion = ((& $bun --version) | Out-String).Trim()
$pinLine = Select-String -LiteralPath (Join-Path $repo "flake.nix") -Pattern 'bunVersion\s*=\s*"([^"]+)"' | Select-Object -First 1
$pinned = if ($null -eq $pinLine) { "" } else { $pinLine.Matches[0].Groups[1].Value }
Write-Output "bun      $bunVersion at $bun (flake.nix pins $pinned)"
if ($bunVersion -ne $pinned) {
  if ($StrictBun) { Fail "bun.exe is $bunVersion, and flake.nix pins $pinned; the Windows binary must be built on the pinned Bun" }
  Write-Warning "bun.exe is $bunVersion, and flake.nix pins $pinned. A release build uses -StrictBun."
}

# Git's own bash, never `System32\bash.exe` (the WSL launcher). Only the version gate needs it.
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$gitBin = if ($gitCmd) { Join-Path (Split-Path -Parent (Split-Path -Parent $gitCmd.Source)) "bin" } else { "C:\Program Files\Git\bin" }
$bash = Join-Path $gitBin "bash.exe"
if (-not (Test-Path -LiteralPath $bash)) { Fail "Git for Windows' bash.exe is not at $bash; the version gate needs it" }

# Windows' own tar.exe (bsdtar) writes and reads the zip. A GNU tar from Git can do neither.
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path -LiteralPath $tar)) { Fail "$tar is missing (it ships with Windows 10 and later)" }

# --- The build, in the order the Linux rows run it
# The version gate `collie build` runs, run here too: a release whose four version files disagree
# must not become a downloadable artifact.
& $bash scripts/check-version.sh
Need-Exit0 "the version gate (scripts/check-version.sh)"

& $bun install --frozen-lockfile
Need-Exit0 "bun install"
Push-Location (Join-Path $repo "web")
& $bun install --frozen-lockfile
Need-Exit0 "bun install (web)"
& $bun run build
Need-Exit0 "the web build"
Pop-Location

# NO LINT STEP, as in the Linux rows: CI lints the whole tree in its own workflow.
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$stage = Join-Path $temp $payloadRoot
if (Test-Path -LiteralPath $stage) { Remove-Item -Recurse -Force -LiteralPath $stage }
New-Item -ItemType Directory -Force -Path (Join-Path $stage "bin"), (Join-Path $stage "web"), (Join-Path $stage "scripts") | Out-Null
$exe = Join-Path $stage "bin\collie.exe"
& $bun run scripts/build-cli.ts --bun $bun --target $Target --outfile $exe
Need-Exit0 "compiling bin\collie.exe"

# The same files the Linux payload carries, in the same layout. `herdr-plugin.toml` is the bridge's
# root marker and the canonical version; `package.json` is where the bridge reads its version.
Copy-Item -Recurse -LiteralPath (Join-Path $repo "web\dist") -Destination (Join-Path $stage "web\dist")
foreach ($f in "herdr-plugin.toml", "package.json", ".env.example", "CHANGELOG.md", "LICENSE", "README.md") {
  Copy-Item -LiteralPath (Join-Path $repo $f) -Destination (Join-Path $stage $f)
}
Copy-Item -Recurse -LiteralPath (Join-Path $repo "docs") -Destination (Join-Path $stage "docs")
# The shim the manifest's Herdr actions name. Herdr's actions stay Linux and macOS (they run `bash`),
# and the shim travels anyway, so every payload has one layout.
Copy-Item -LiteralPath (Join-Path $repo "scripts\collie-ctl.sh") -Destination (Join-Path $stage "scripts\collie-ctl.sh")

# --- Check the binary an operator gets, then seal the zip
# The loader check of the Linux rows (scripts/check-payload-links.sh) looks for a Nix store path in
# the binary. No Nix ran here, so there is nothing for it to find.
# The binary finds its own root from its path. A root set by the caller would answer for that root.
Remove-Item Env:COLLIE_PLUGIN_ROOT -ErrorAction SilentlyContinue
$reported = ((& $exe version) | Out-String).Trim()
Need-Exit0 "bin\collie.exe version"
if (-not $reported.StartsWith($Version)) { Fail "the compiled binary reports '$reported', which does not start with '$Version'" }
Write-Output "ok       $payloadRoot\bin\collie.exe reports $reported"

# The embedded manual, proved as the Linux rows prove it: `docs crew` prints a page nothing on
# disk supplied.
$page = @(& $exe docs crew)
Need-Exit0 "bin\collie.exe docs crew"
$first = if ($page.Count -gt 0) { "$($page[0])".TrimEnd() } else { "" }
if ($first -ne "# Crew commands") { Fail "the compiled binary answered 'docs crew' with '$first', not the embedded page" }
Write-Output "ok       $payloadRoot\bin\collie.exe carries the embedded operator docs"

$name = "$payloadRoot.zip"
$zip = Join-Path $Out $name
if (Test-Path -LiteralPath $zip) { Remove-Item -Force -LiteralPath $zip }
# `-a` picks the format from the name: a zip, with `/` between folder names.
& $tar -a -c -f $zip -C $temp $payloadRoot
Need-Exit0 "writing $name"
$listed = @(& $tar -tf $zip)
Need-Exit0 "listing $name"
foreach ($want in "$payloadRoot/bin/collie.exe", "$payloadRoot/web/dist/index.html", "$payloadRoot/herdr-plugin.toml", "$payloadRoot/package.json") {
  if ($listed -notcontains $want) { Fail "$name does not list $want" }
}
Write-Output "ok       $name lists $($listed.Count) entries"

# --- The sidecar and the manifest entry
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
if ($sha.Length -ne 64) { Fail "no usable sha256 for $name" }
$size = (Get-Item -LiteralPath $zip).Length
$utf8 = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText("$zip.sha256", "$sha  $name`n", $utf8)

# One entry of the manifest's `artifacts[]`, in the shape and indent the Linux rows write, so the
# release job merges it with the same loop. `signed: false` says what the macOS row's `codesign`
# field says for its own platform.
$entry = @(
  "{",
  "  `"name`": `"$name`",",
  "  `"platform`": `"$Platform`",",
  "  `"os`": `"windows`",",
  "  `"arch`": `"x64`",",
  "  `"libc`": null,",
  "  `"variant`": $(if ($Target -like '*-baseline') { '"baseline"' } else { 'null' }),",
  "  `"bunTarget`": `"$Target`",",
  "  `"size`": $size,",
  "  `"sha256`": `"$sha`",",
  "  `"payloadRoot`": `"$payloadRoot`",",
  "  `"signed`": false",
  "}"
) -join "`n"
[IO.File]::WriteAllText((Join-Path $Out "$Platform.artifact.json"), "$entry`n", $utf8)

Write-Output "ok       $name  $size bytes  sha256 $sha"
exit 0
