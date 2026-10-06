# Collie's installer for Windows. It downloads the Windows release, checks its sha256, lays it down,
# and puts `collie` on your user PATH. It is the Windows twin of install.sh.
#
# Run it like this, in PowerShell:
#
#   irm https://colliepwa.dev/install.ps1 | iex
#
# You can also download this file, read it, and run it by hand:
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Windows marks a file that a browser downloaded (the Mark of the Web), and a RemoteSigned policy then
# refuses it as "not digitally signed". After you have read it, clear the mark with:
#
#   Unblock-File .\install.ps1
#
# This file is one page with no helpers to fetch, so you can read all of it before you run it.
# What it will never do:
#   - It never asks for admin rights.
#   - It never writes outside COLLIE_DIR, except one entry in your user PATH.
#   - It never starts a service or a task. It runs one program once: the new collie.exe, as
#     `collie.exe version`, to check that Windows lets it run.
#   - It never sends anything anywhere. It only downloads the release files.
#   - It never installs a download whose sha256 does not match. There is no flag to skip the check.
# It ends by PRINTING the next steps. It never takes them for you.
#
# It needs no toolchain: no Bun, no Git, no bash. It needs Windows 10 build 19041 or newer on x64,
# and Windows PowerShell 5.1 or PowerShell 7. Collie on Windows is experimental, and collie.exe is
# not signed. The sha256 check is the only check that the download is the one the release published.
#
# Three environment variables steer what it installs:
#   COLLIE_DIR          where to install. Default: %LOCALAPPDATA%\collie
#   COLLIE_UPDATE_REPO  which GitHub repository to download from. Default: AltanS/collie
#   COLLIE_TAG          install one exact release tag, for example v1.16.0. A pin skips the tag
#                       lookup, so the script makes no call to api.github.com.
# A GitHub token in COLLIE_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN goes only to api.github.com, with
# the one call that lists the tags. It never goes with a download and never to a mirror.
# Two more exist on Windows only, and neither is in install.sh:
#   COLLIE_NO_PATH_EDIT=1     do not change the user PATH. Run <COLLIE_DIR>\current\bin\collie.exe.
#   COLLIE_INSTALL_MIRROR     A TEST SEAM for tests and rehearsals, not a way to install. A base URL
#                             that replaces https://api.github.com and https://github.com. Only a
#                             file:/// URL or http://127.0.0.1 or http://localhost (with a port) is
#                             accepted, and a loud line says it is set. The script asks it for
#                             /repos/<repo>/tags and /<repo>/releases/download/<tag>/<file>.
#
# The layout is the one `collie update` reads: <COLLIE_DIR>\versions\<X.Y.Z> holds one release, and
# <COLLIE_DIR>\current is a directory junction to one of them. A standard user can make a junction.
# A symbolic link needs Developer Mode, so this uses none.
#
# Everything is inside functions, and the last line calls them. If the download of this file stops
# half way, `iex` gets no last line, and nothing runs. A failed run ends with a line that starts
# "Install failed." and names one fix, and sets $LASTEXITCODE: 0 when it installed, 1 when it failed.
# Run as a file (`powershell -File install.ps1`), a failure also ends with `exit 1`, which ends only
# that PowerShell. Under `irm | iex` it never calls `exit`, because that would close your window.

# Stop the install. What happened, then the one thing to do about it. The entry function prints both,
# with "Install failed." in front of the fix, as the last line.
function Stop-CollieInstall([string]$What, [string]$Fix = "Fix the problem above, then run the installer again.") {
  $failure = New-Object System.Exception $What
  $failure.Data["CollieFix"] = $Fix
  throw $failure
}

function Write-CollieLine([string]$Text) {
  Write-Host $Text
}

# Is this machine one Collie publishes a binary for? Returns the reason it is not, or $null.
function Get-CollieHostProblem([string]$Arch, [int]$Build) {
  if ($Arch -ne "AMD64" -and $Arch -ne "X64") {
    return "Collie publishes no Windows binary for $Arch. Only x64 (AMD64) is published."
  }
  if ($Build -lt 19041) {
    return "this Windows is build $Build. Collie needs Windows 10 build 19041 or newer, and is tested on Windows 11."
  }
  return $null
}

# The processor of the machine, not of this PowerShell. A 32-bit PowerShell on 64-bit Windows says x86.
function Get-CollieArch {
  try {
    $os = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    if ($null -ne $os) { return $os.ToString() }
  } catch { }
  if ($env:PROCESSOR_ARCHITEW6432) { return $env:PROCESSOR_ARCHITEW6432 }
  return $env:PROCESSOR_ARCHITECTURE
}

# Every value that becomes part of a URL or a path is checked here first, case-sensitively and
# anchored at both ends (\A and \z: `$` would let a trailing newline through). A tag the API or a
# mirror returns is checked the same way as one you typed, so a hostile answer such as
# `v1.0.0\..\..\x` never reaches a path.
function Test-CollieTag([string]$Tag, [switch]$AllowPrerelease) {
  if ($AllowPrerelease) { return $Tag -cmatch '\Av[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?\z' }
  return $Tag -cmatch '\Av[0-9]+\.[0-9]+\.[0-9]+\z'
}

# owner/name, each part from [A-Za-z0-9._-] and not made of dots alone.
function Test-CollieRepo([string]$Repo) {
  if ($Repo -cnotmatch '\A([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)\z') { return $false }
  return ($Matches[1] -cnotmatch '\A\.+\z') -and ($Matches[2] -cnotmatch '\A\.+\z')
}

# Why Path cannot be the install folder, or $null. It must be a full path on a drive, not a share and
# not the drive itself, and hold no `;` or `%`: the folder goes into your PATH, where `;` splits an
# entry and `%` starts a variable. A space, `&` or a non-ASCII letter is fine.
function Get-CollieDirProblem([string]$Path) {
  if ($Path -cnotmatch '\A[A-Za-z]:[\\/]') { return "COLLIE_DIR='$Path' is not a full path on a drive, such as C:\Users\you\collie" }
  if ($Path.Contains(';') -or $Path.Contains('%')) { return "COLLIE_DIR='$Path' holds a ';' or a '%', which would break your PATH" }
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full -cmatch '\A[A-Za-z]:\z') { return "COLLIE_DIR='$Path' is the root of a drive" }
  return $null
}

# The strict release tags (vX.Y.Z), newest first, compared as numbers (v1.15.0 is newer than v1.9.0).
# A prerelease is never picked: pin it.
function Sort-CollieTags([string[]]$Names) {
  return @($Names | Where-Object { Test-CollieTag $_ } | Sort-Object { [version]$_.Substring(1) } -Descending)
}

# Check a downloaded file against its sidecar line "<sha256>  <name>" (the name may be left out).
# Returns the problem, or $null.
function Get-CollieDigestProblem([string]$Sidecar, [string]$Name, [string]$Actual) {
  $words = @("$Sidecar".Trim() -split '\s+')
  if ($words.Count -gt 2 -or $words[0] -cnotmatch '\A[0-9a-fA-F]{64}\z') {
    return "$Name.sha256 is not one '<sha256>  <name>' line"
  }
  if ($words.Count -eq 2 -and $words[1].TrimStart('*') -cne $Name) { return "$Name.sha256 names $($words[1]), not $Name" }
  if (-not [string]::Equals($words[0], $Actual, [StringComparison]::OrdinalIgnoreCase)) {
    return "CHECKSUM MISMATCH for $Name"
  }
  return $null
}

# The user PATH with Entry added at the end, or $null when it is there already. Pure, so it is tested
# with strings. The value keeps every byte it had: no entry is reordered, expanded or dropped.
function Add-CollieUserPathEntry([string]$PathValue, [string]$Entry) {
  $want = $Entry.TrimEnd('\')
  foreach ($part in ("$PathValue" -split ';')) {
    if ($part -eq '') { continue }
    $expanded = [Environment]::ExpandEnvironmentVariables($part).TrimEnd('\')
    if ($part.TrimEnd('\') -eq $want -or $expanded -eq $want) { return $null }
  }
  if ("$PathValue" -eq '') { return $Entry }
  # A value that ends in ';' keeps ending in ';', so removing the entry again (the line `collie
  # uninstall` prints) gives back the exact value it had before.
  if ("$PathValue".EndsWith(';')) { return "$PathValue$Entry;" }
  return "$PathValue;$Entry"
}

# Add Entry to HKCU\Environment\Path. No admin is needed. Returns $true when it changed the value.
function Set-CollieUserPath([string]$Entry) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
  try {
    $raw = $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($null -ne $key.GetValue("Path")) { $kind = $key.GetValueKind("Path") }
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
      Stop-CollieInstall "your user PATH is stored as $kind, which this script does not edit." "Add $Entry to your user PATH by hand, or set COLLIE_NO_PATH_EDIT=1 and run the installer again."
    }
    $new = Add-CollieUserPathEntry $raw $Entry
    if ($null -eq $new) { return $false }
    $key.SetValue("Path", $new, $kind)
  } finally {
    $key.Close()
  }
  # Tell open programs that the environment changed, so a terminal started from the Start menu sees
  # the new PATH. .NET sends that message after any user variable change. Removing a variable that
  # does not exist changes nothing in the registry, and still sends the message.
  [Environment]::SetEnvironmentVariable("COLLIE_INSTALL_NOT_A_VARIABLE", $null, "User")
  return $true
}

# The HTTP status of a failed web call, or 0 when no server answered.
function Get-CollieHttpCode($ErrorRecord) {
  $response = $ErrorRecord.Exception.Response
  if ($null -eq $response) { return 0 }
  try { return [int]$response.StatusCode } catch { return 0 }
}

# Is Url a mirror this script accepts? Only a local folder or this machine's loopback address.
function Test-CollieMirror([string]$Url) {
  return $Url -cmatch '\A(file:///[A-Za-z]:/[A-Za-z0-9._~/ -]*|http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?)\z'
}

# Download Url to OutFile. Returns 200, the HTTP status of a failure, or 0 when no server answered.
# A file:/// URL (a mirror folder) is copied, and a missing file answers 404.
function Get-CollieFile([string]$Url, [string]$OutFile) {
  if ($Url.StartsWith("file:///")) {
    $local = ([Uri]$Url).LocalPath
    if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { return 404 }
    Copy-Item -LiteralPath $local -Destination $OutFile
    return 200
  }
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -ErrorAction Stop
    return 200
  } catch {
    Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
    return (Get-CollieHttpCode $_)
  }
}

# Why a zip entry may not be unpacked, or $null. Every entry must sit under Root/, with no drive, no
# stream (':'), no leading slash and no '..' part. This is what stops a zip that writes outside the
# folder it is unpacked into.
function Get-CollieEntryProblem([string]$Name, [string]$Root) {
  if ($Name -ceq '') { return "an entry with no name" }
  if ($Name.Contains(':')) { return "'$Name' names a drive or a stream" }
  if ($Name.StartsWith('/') -or $Name.StartsWith('\')) { return "'$Name' starts at the root" }
  if (@($Name -split '[\\/]' | Where-Object { $_ -ceq '..' }).Count -gt 0) { return "'$Name' climbs out with '..'" }
  if (-not $Name.StartsWith("$Root/", [StringComparison]::Ordinal)) { return "'$Name' is not under $Root/" }
  return $null
}

# Unpack Zip into Destination, one entry at a time, after EVERY entry has been checked: by name, and
# by its full path, which must start with Destination\. Nothing is written when one entry fails.
# System.IO.Compression is part of Windows; nothing is compiled.
function Expand-CollieZip([string]$Zip, [string]$Destination, [string]$Root) {
  try { Add-Type -AssemblyName System.IO.Compression.FileSystem } catch { }
  $dest = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    $plan = New-Object System.Collections.ArrayList
    foreach ($entry in $archive.Entries) {
      $problem = Get-CollieEntryProblem $entry.FullName $Root
      if ($null -eq $problem) {
        $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($dest, $entry.FullName.Replace('/', '\')))
        if (-not $target.StartsWith($dest, [StringComparison]::OrdinalIgnoreCase)) { $problem = "'$($entry.FullName)' resolves outside the folder" }
      }
      if ($null -ne $problem) { Stop-CollieInstall "the zip is not safe to unpack: $problem. Nothing was installed." "Report it at https://github.com/AltanS/collie/issues" }
      [void]$plan.Add(@($entry, $target))
    }
    foreach ($item in $plan) {
      $entry = $item[0]; $target = $item[1]
      if ($entry.FullName.EndsWith('/')) { [void][System.IO.Directory]::CreateDirectory($target); continue }
      [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target))
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
  } finally {
    $archive.Dispose()
  }
}

# A rename that tries again while the folder is busy. Defender often holds a new folder for a moment.
function Move-CollieItem([string]$From, [string]$To) {
  for ($try = 1; ; $try++) {
    try {
      [System.IO.Directory]::Move($From, $To)
      return
    } catch {
      if ($try -ge 5) { throw }
      Start-Sleep -Milliseconds (500 * $try)
    }
  }
}

# "absent", "link" (a junction or a symbolic link) or "other". It never follows the link.
function Get-CollieLinkState([string]$Path) {
  try {
    $attributes = [System.IO.File]::GetAttributes($Path)
  } catch {
    return "absent"
  }
  if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { return "link" }
  return "other"
}

function Get-CollieLinkTarget([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  $target = @($item.Target)
  if ($target.Count -eq 0 -or "$($target[0])" -eq '') { return $null }
  return "$($target[0])"
}

function New-CollieJunction([string]$Path, [string]$Target) {
  New-Item -ItemType Junction -Path $Path -Value $Target -ErrorAction Stop | Out-Null
}

# Remove a junction ITSELF. A non-recursive delete never touches the folder the junction names.
function Remove-CollieLink([string]$Path) {
  if ([System.IO.File]::GetAttributes($Path) -band [System.IO.FileAttributes]::Directory) { [System.IO.Directory]::Delete($Path, $false) }
  else { [System.IO.File]::Delete($Path) }
}

# Delete a folder this script made, and everything in it. It never follows a junction or a link: one
# found anywhere in the tree is removed by itself, so the folder it names keeps every file. That is
# why this script has no `Remove-Item -Recurse`, which in Windows PowerShell 5.1 walks into one.
function Remove-CollieTree([string]$Path) {
  $state = Get-CollieLinkState $Path
  if ($state -eq "absent") { return }
  if ($state -eq "link") { Remove-CollieLink $Path; return }
  if (-not ([System.IO.File]::GetAttributes($Path) -band [System.IO.FileAttributes]::Directory)) {
    [System.IO.File]::SetAttributes($Path, [System.IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($Path)
    return
  }
  foreach ($child in [System.IO.Directory]::GetFileSystemEntries($Path)) { Remove-CollieTree $child }
  [System.IO.Directory]::Delete($Path, $false)
}

# Delete Path only when it is an EMPTY real folder.
function Remove-CollieEmptyFolder([string]$Path) {
  if ((Get-CollieLinkState $Path) -ne "other") { return }
  if (@([System.IO.Directory]::GetFileSystemEntries($Path)).Count -gt 0) { return }
  [System.IO.Directory]::Delete($Path, $false)
}

# Point <Dir>\current at Target. A new junction is made beside it first, which proves the folder can
# be named before anything moves. Then the old junction goes and the new one takes its name. When
# that fails, the old junction is put back, or the exact command to put it back is printed.
function Set-CollieCurrent([string]$Dir, [string]$Target) {
  $current = Join-Path $Dir "current"
  $staged = Join-Path $Dir ".current.new"
  $state = Get-CollieLinkState $current
  if ($state -eq "absent") {
    New-CollieJunction $current $Target
    return
  }
  if ($state -eq "other") {
    Stop-CollieInstall "$current is a real folder or file, not a junction, so it is not Collie's to remove." "Move $current aside, then run the installer again."
  }
  $old = Get-CollieLinkTarget $current
  switch (Get-CollieLinkState $staged) {
    "link" { Remove-CollieLink $staged }
    "other" { Stop-CollieInstall "$staged is in the way and is not a junction." "Move $staged aside, then run the installer again." }
  }
  New-CollieJunction $staged $Target
  try {
    Remove-CollieLink $current
    Move-CollieItem $staged $current
    return
  } catch {
    $why = $_.Exception.Message
  }
  if ((Get-CollieLinkState $staged) -eq "link") { try { Remove-CollieLink $staged } catch { } }
  if ($null -ne $old -and (Get-CollieLinkState $current) -eq "absent") {
    try {
      New-CollieJunction $current $old
    } catch {
      Stop-CollieInstall "could not point $current at $Target ($why). $current is missing now, and putting it back failed too." "Make it again by hand:  cmd /c mklink /J `"$current`" `"$old`""
    }
  }
  Stop-CollieInstall "could not point $current at $Target ($why). $current still names $old. Nothing was changed." "Close every program that runs Collie from $Dir, then run the installer again."
}

# Stop a process and every process below it, children first, so none is left without a parent to
# be found by. Windows PowerShell 5.1 has no Kill(entireProcessTree), and taskkill would be a second
# program this script runs.
function Stop-CollieTree([int]$Id) {
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $Id" -ErrorAction SilentlyContinue)) {
    Stop-CollieTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
}

# Run Exe once, as `Exe version`, and wait up to 30 seconds. Returns $null when it ran and exited 0,
# or what went wrong. cmd.exe writes its output to Log, a file: nothing is read through a pipe, which
# a program left running could hold open. Its input is NUL, so nothing waits for a key. On the
# timeout the whole tree goes (Stop-CollieTree): killing cmd.exe alone left a hung collie.exe
# running, and it held the version folder open.
function Test-CollieRuns([string]$Exe, [string]$Log) {
  if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return "$Exe is missing" }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path ([Environment]::SystemDirectory) "cmd.exe"
  $start.Arguments = "/d /s /c `"`"$Exe`" version < NUL > `"$Log`" 2>&1`""
  $start.UseShellExecute = $false
  $run = [System.Diagnostics.Process]::Start($start)
  if (-not $run.WaitForExit(30000)) {
    Stop-CollieTree $run.Id
    [void]$run.WaitForExit(5000)
    return "collie.exe version did not finish in 30 seconds"
  }
  if ($run.ExitCode -eq 0) { return $null }
  $said = ""
  if (Test-Path -LiteralPath $Log) { $said = "$(@([System.IO.File]::ReadAllLines($Log) | Where-Object { $_.Trim() -ne '' })[0])".Trim() }
  return "collie.exe version stopped with exit code $($run.ExitCode): $said"
}

# The one message for a collie.exe that Windows did not let run. The files stay where they are.
function Stop-CollieBlocked([string]$Dir, [string]$Exe, [string]$Why) {
  Stop-CollieInstall ("Collie was installed in $Dir, but Windows did not let collie.exe run ($Why). " +
    "The usual causes are Smart App Control, Microsoft Defender (it may have quarantined the file), or a policy set by whoever manages this computer. " +
    "The install is safe to leave in place. Smart App Control cannot be overridden for one program, and turning it off is permanent, so decide that first. " +
    "If you saw 'Windows protected your PC' (SmartScreen), choose More info, then Run anyway.") "Fix the cause, then run  `"$Exe`" version  to check. If you are stuck, report it at https://github.com/AltanS/collie/issues"
}

# Add the PATH entry, unless COLLIE_NO_PATH_EDIT says no. Returns one line that says what happened.
function Publish-CollieName([string]$Dir) {
  $bin = Join-Path $Dir "current\bin"
  if ($env:COLLIE_NO_PATH_EDIT -eq "1") {
    return "COLLIE_NO_PATH_EDIT=1 is set, so your PATH was not changed. Run Collie as $bin\collie.exe."
  }
  $added = Set-CollieUserPath $bin
  # This window too, so the steps below work here without a new terminal. Appended, like the user PATH.
  $here = Add-CollieUserPathEntry $env:Path $bin
  if ($null -ne $here) { $env:Path = $here }
  if ($added) { return "Added $bin to your user PATH." }
  return "$bin is on your user PATH already."
}

# How to spell Collie in the printed steps: `collie` when that name finds THIS install's collie.exe,
# else the full path (no PATH edit, or another `collie` comes first on PATH).
function Get-CollieCommandName([string]$Exe) {
  $found = Get-Command collie -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $found -and [string]::Equals($found.Source, $Exe, [StringComparison]::OrdinalIgnoreCase)) { return "collie" }
  return $Exe
}

function Invoke-CollieInstall {
  $repo = "$env:COLLIE_UPDATE_REPO".Trim()
  if ($repo -eq '') { $repo = "AltanS/collie" }
  if (-not (Test-CollieRepo $repo)) {
    Stop-CollieInstall "COLLIE_UPDATE_REPO='$repo' is not a GitHub repository name like AltanS/collie." "Set COLLIE_UPDATE_REPO to owner/name, or remove it to take Collie's own releases."
  }
  if ($repo -cne "AltanS/collie") {
    Write-CollieLine "WARNING: COLLIE_UPDATE_REPO is set. This installs Collie from github.com/$repo, not from AltanS/collie."
  }
  $dir = "$env:COLLIE_DIR".Trim()
  if ($dir -eq '') {
    if ("$env:LOCALAPPDATA" -eq '') { Stop-CollieInstall "LOCALAPPDATA is not set." "Set COLLIE_DIR to the folder to install into, then run the installer again." }
    $dir = Join-Path $env:LOCALAPPDATA "collie"
  }
  $problem = Get-CollieDirProblem $dir
  if ($null -ne $problem) { Stop-CollieInstall "$problem." "Set COLLIE_DIR to a full folder path such as C:\Users\you\collie, then run the installer again." }
  $dir = [System.IO.Path]::GetFullPath($dir).TrimEnd('\')
  $mirror = "$env:COLLIE_INSTALL_MIRROR".Trim().TrimEnd('/')
  if ($mirror -ne '') {
    if (-not (Test-CollieMirror $mirror)) {
      Stop-CollieInstall "COLLIE_INSTALL_MIRROR='$mirror' is not a file:/// URL or an http://127.0.0.1 or http://localhost URL. It is a test seam, never a download source." "Remove COLLIE_INSTALL_MIRROR to install from GitHub."
    }
    Write-CollieLine "WARNING: COLLIE_INSTALL_MIRROR is set. This is a test seam: everything comes from $mirror, not from GitHub."
  }

  # A pinned tag is checked before anything is fetched or touched.
  $pin = "$env:COLLIE_TAG".Trim()
  if ($pin -ne '' -and -not (Test-CollieTag $pin -AllowPrerelease)) {
    Stop-CollieInstall "COLLIE_TAG='$pin' is not a release tag." "Set COLLIE_TAG to a tag like v1.16.0 (or v1.16.0-rc.1), or remove it to take the newest release."
  }

  $problem = Get-CollieHostProblem (Get-CollieArch) ([Environment]::OSVersion.Version.Build)
  if ($null -ne $problem) { Stop-CollieInstall $problem "Install Collie on an x64 machine with Windows 10 build 19041 or newer." }

  # Leave an existing install alone, unless a tag was pinned. A pin lays that version down BESIDE
  # what is there and points `current` at it. That is the way back when the installed version is
  # the broken one.
  $rescue = $false
  if (Test-Path -LiteralPath $dir) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Stop-CollieInstall "$dir is a file." "Move $dir aside, or set COLLIE_DIR to another folder." }
    $isGit = Test-Path -LiteralPath (Join-Path $dir ".git")
    $hasVersions = Test-Path -LiteralPath (Join-Path $dir "versions") -PathType Container
    if ($isGit -and $pin -ne '') {
      Stop-CollieInstall "$dir is a git checkout, and COLLIE_TAG only pins a binary install." "Pin it with git instead:  git -C $dir checkout $pin"
    }
    if ($hasVersions -and -not $isGit -and $pin -ne '') {
      $rescue = $true
    } elseif ($isGit -or $hasVersions) {
      # A rerun is not an update: `collie update` owns that, so a working `current` is never moved
      # from here without a pin, and nothing is changed or downloaded.
      $installed = "Collie"
      if ($isGit) { $installed = "Collie (a git checkout)" }
      else {
        $target = Get-CollieLinkTarget (Join-Path $dir "current")
        if ($null -ne $target) { $installed = "Collie " + [System.IO.Path]::GetFileName($target.TrimEnd('\')) }
      }
      Write-CollieLine "$installed is already installed in $dir. To update, run: collie update"
      Write-CollieLine "To lay one exact version beside it instead, set COLLIE_TAG (for example `$env:COLLIE_TAG = 'v1.16.0') and run the installer again."
      return
    } else {
      $other = @(Get-ChildItem -LiteralPath $dir -Force | Where-Object { $_.Name -ne ".staging" })
      if ($other.Count -gt 0) { Stop-CollieInstall "$dir already exists and is not a Collie install." "Move $dir aside, or set COLLIE_DIR to another folder." }
    }
  }

  # Which release. The tags are the list `collie update` reads too, never `releases/latest`. A
  # GitHub token, if you have one, goes with this ONE call to api.github.com: never with a download
  # (Windows PowerShell 5.1 can carry the header across the redirect to the file host) and never to
  # a mirror. Without a pin, the newest strict tag is tried first, then up to four older ones,
  # because a release made before Collie shipped a Windows zip has none.
  $platform = "windows-x64"
  $releases = "https://github.com/$repo/releases"
  $candidates = @($pin)
  if ($pin -eq '') {
    $api = if ($mirror -ne '') { $mirror } else { "https://api.github.com" }
    $headers = @{ Accept = "application/vnd.github+json" }
    $tokenFrom = ''
    foreach ($name in "COLLIE_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN") {
      $value = [Environment]::GetEnvironmentVariable($name)
      if ("$value" -ne '') { $tokenFrom = $name; break }
    }
    if ($tokenFrom -ne '' -and $mirror -eq '') { $headers.Authorization = "Bearer " + [Environment]::GetEnvironmentVariable($tokenFrom) }
    $pinFix = "Name the version and skip this call:  `$env:COLLIE_TAG = 'vX.Y.Z'  (the tags are at $releases)"
    try {
      if ($api.StartsWith("file:///")) {
        $tagsFile = ([Uri]"$api/repos/$repo/tags").LocalPath
        if (-not (Test-Path -LiteralPath $tagsFile -PathType Leaf)) { Stop-CollieInstall "the mirror has no $tagsFile." "Put the tags list there, or remove COLLIE_INSTALL_MIRROR." }
        $rows = @([System.IO.File]::ReadAllText($tagsFile) | ConvertFrom-Json | ForEach-Object { $_ })
      } else {
        # Every page: GitHub serves 100 tags a page, and a newer tag can sit on a later one. A page
        # shorter than 100 is the last; ten pages is the bound, as in `collie update`.
        $rows = @()
        for ($page = 1; $page -le 10; $page++) {
          $uri = "$api/repos/$repo/tags?per_page=100"
          if ($page -gt 1) { $uri = "$uri&page=$page" }
          $answer = Invoke-WebRequest -UseBasicParsing -Uri $uri -Headers $headers -ErrorAction Stop
          $onePage = @($answer.Content | ConvertFrom-Json | ForEach-Object { $_ })
          $rows += $onePage
          if ($onePage.Count -lt 100) { break }
        }
      }
    } catch {
      if ($null -ne $_.Exception.Data["CollieFix"]) { throw }
      $code = Get-CollieHttpCode $_
      if ($code -eq 0) { Stop-CollieInstall "could not reach $api to list the releases." "Check your network, or $pinFix" }
      if ($code -eq 401 -and $headers.ContainsKey("Authorization")) { Stop-CollieInstall "GitHub refused the token in $tokenFrom (HTTP 401)." "Fix or remove $tokenFrom, then run the installer again." }
      if ($code -eq 403 -or $code -eq 429) {
        Stop-CollieInstall "GitHub's API rate limit says no (HTTP $code). Without a token GitHub allows 60 calls an hour per network address." "Wait an hour, set GH_TOKEN to a GitHub token with no scopes, or $pinFix"
      }
      Stop-CollieInstall "$api answered HTTP $code when asked for the tags of $repo." "Try again later, or $pinFix"
    }
    $names = @($rows | ForEach-Object { "$($_.name)" })
    $candidates = @(Sort-CollieTags $names | Select-Object -First 5)
    if ($candidates.Count -eq 0) { Stop-CollieInstall "no release tag found for $repo." "Pin a version with COLLIE_TAG, or report this at https://github.com/AltanS/collie/issues" }
  }
  $current = Join-Path $dir "current"

  # The pinned version may be on disk already: then the rescue is a junction flip and nothing more.
  if ($rescue) {
    $tag = $pin
    $versionDir = Join-Path $dir "versions\$($tag.Substring(1))"
  }
  if ($rescue) {
    foreach ($folder in (Join-Path $dir "versions"), $versionDir) {
      if ((Get-CollieLinkState $folder) -eq "link") {
        Stop-CollieInstall "$folder is a junction or a link, not a folder this installer made." "Move $folder aside, then run the installer again."
      }
    }
    if ((Get-CollieLinkState $current) -eq "other") {
      Stop-CollieInstall "$current is a real folder or file, not a junction, so it is not Collie's to remove." "Move $current aside, then run the installer again."
    }
  }
  if ($rescue -and (Test-Path -LiteralPath $versionDir)) {
    # A folder from a move that stopped half way is not an install: it must hold bin\collie.exe.
    if (-not (Test-Path -LiteralPath (Join-Path $versionDir "bin\collie.exe"))) {
      Stop-CollieInstall "$versionDir is there but holds no bin\collie.exe." "Move $versionDir aside, then run the installer again."
    }
    $now = Get-CollieLinkTarget $current
    if ($null -ne $now -and $now.TrimEnd('\') -eq $versionDir) {
      Write-CollieLine (Publish-CollieName $dir)
      Write-CollieLine "OK  Collie $tag is installed at $dir and current names it already. Nothing was changed, and nothing was downloaded."
      return
    }
    Set-CollieCurrent $dir $versionDir
    Write-CollieLine (Publish-CollieName $dir)
    $blocked = Test-CollieRuns (Join-Path $current "bin\collie.exe") (Join-Path $dir ".collie-version-check.txt")
    Remove-Item -LiteralPath (Join-Path $dir ".collie-version-check.txt") -Force -ErrorAction SilentlyContinue
    if ($null -ne $blocked) { Stop-CollieBlocked $dir (Join-Path $current "bin\collie.exe") $blocked }
    Write-CollieLine "OK  Collie $tag was already at $versionDir. current now names it, and nothing was downloaded."
    Write-CollieLine "If Collie is running, run  collie restart  to start this version."
    return
  }

  # Download, and verify before anything is unpacked. The scratch folder is inside COLLIE_DIR, and
  # it is removed on every way out.
  if ($rescue) { Write-CollieLine "Collie is already installed in $dir. Laying $pin down beside it, and pointing current at it." }
  $createdDir = -not (Test-Path -LiteralPath $dir)
  $staging = Join-Path $dir ".staging"
  $work = Join-Path $staging "install-$PID"
  try {
    # A `.staging` left by a run that was stopped is emptied. One that is a junction is removed by
    # itself (the folder it names is not touched), and a real folder takes its place.
    switch (Get-CollieLinkState $staging) {
      "link" { Remove-CollieLink $staging }
      "other" { foreach ($leftover in [System.IO.Directory]::GetFileSystemEntries($staging)) { Remove-CollieTree $leftover } }
    }
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    # The checksum file first: it is small, and a release with no Windows build has none.
    $tag = $null
    foreach ($candidate in $candidates) {
      $zipName = "collie-$($candidate.Substring(1))-$platform.zip"
      $base = if ($mirror -ne '') { "$mirror/$repo/releases/download/$candidate" } else { "$releases/download/$candidate" }
      $code = Get-CollieFile "$base/$zipName.sha256" (Join-Path $work "$zipName.sha256")
      if ($code -eq 0) { Stop-CollieInstall "could not reach the download for $candidate." "Check your network, then run the installer again." }
      if ($code -eq 200) { $tag = $candidate; break }
      if ($pin -ne '') {
        Stop-CollieInstall "release $pin has no $zipName.sha256 (HTTP $code), so a download could not be checked. Either that release has no Windows build, or its checksum file is missing. Nothing was installed." "Check the tag against $releases, or pin another one with COLLIE_TAG."
      }
      Write-CollieLine "$candidate has no Windows build. Trying the next older release."
    }
    if ($null -eq $tag) {
      Stop-CollieInstall "none of the newest $($candidates.Count) releases of $repo carries a Windows build yet. Nothing was installed." "Pin a release that has one:  `$env:COLLIE_TAG = 'vX.Y.Z'  (see $releases)"
    }
    $version = $tag.Substring(1)
    $versionDir = Join-Path $dir "versions\$version"
    $zip = Join-Path $work $zipName
    if ($mirror -ne '') { Write-CollieLine "Downloading Collie $tag for $platform from the mirror $mirror ..." }
    else { Write-CollieLine "Downloading Collie $tag for $platform ..." }
    $code = Get-CollieFile "$base/$zipName" $zip
    if ($code -eq 0) { Stop-CollieInstall "could not reach the download for $zipName." "Check your network, then run the installer again." }
    if ($code -ne 200) {
      Stop-CollieInstall "release $tag has a checksum file but no $zipName (HTTP $code). Nothing was installed." "Try again later. If it happens again, report it at https://github.com/AltanS/collie/issues"
    }
    $manifestPath = Join-Path $work "manifest.json"
    if ((Get-CollieFile "$base/collie-$version.manifest.json" $manifestPath) -ne 200) {
      Stop-CollieInstall "could not download the release manifest for $version. Nothing was installed." "Try again later. If it happens again, report it at https://github.com/AltanS/collie/issues"
    }
    $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1) {
      Stop-CollieInstall "release $version uses a manifest this installer does not understand." "Report it at https://github.com/AltanS/collie/issues"
    }
    $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    $problem = Get-CollieDigestProblem ([System.IO.File]::ReadAllText("$zip.sha256")) $zipName $digest
    if ($null -ne $problem) {
      Stop-CollieInstall "$problem. The download was discarded and nothing was installed." "Run the installer again. If it happens again, report it at https://github.com/AltanS/collie/issues"
    }
    # The manifest's own Windows entry, matched by platform, and its digest compared as a whole value.
    $entries = @($manifest.artifacts | Where-Object { "$($_.platform)" -ceq $platform })
    $named = ($entries.Count -eq 1) -and ("$($entries[0].name)" -ceq $zipName) -and [string]::Equals("$($entries[0].sha256)", $digest, [StringComparison]::OrdinalIgnoreCase)
    if (-not $named) { Stop-CollieInstall "the digest of $zipName is not the one release $version's manifest names. Nothing was installed." "Report it at https://github.com/AltanS/collie/issues" }

    # Lay it down: one complete payload per version, and `current` names one of them.
    $unpacked = Join-Path $work "unpacked"
    Expand-CollieZip $zip $unpacked "collie-$version-$platform"
    $payload = Join-Path $unpacked "collie-$version-$platform"
    if (-not (Test-Path -LiteralPath (Join-Path $payload "bin\collie.exe"))) {
      Stop-CollieInstall "$zipName does not contain bin\collie.exe. Refusing to install it." "Report it at https://github.com/AltanS/collie/issues"
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $dir "versions") | Out-Null
    if ((Get-CollieLinkState (Join-Path $dir "versions")) -ne "other") { Stop-CollieInstall "$dir\versions is a junction or a link, not a folder this installer made." "Move $dir\versions aside, then run the installer again." }
    if ((Get-CollieLinkState $versionDir) -ne "absent") { Stop-CollieInstall "$versionDir exists already." "Move $versionDir aside, then run the installer again." }
    try { Move-CollieItem $payload $versionDir }
    catch { Stop-CollieInstall "could not move the payload into $versionDir ($($_.Exception.Message))." "Close programs that may hold files in $dir (an antivirus scan can), then run the installer again." }
    Set-CollieCurrent $dir $versionDir
  } finally {
    try { Remove-CollieTree $work } catch { }
    try { Remove-CollieEmptyFolder $staging } catch { }
    if ($createdDir) { try { Remove-CollieEmptyFolder $dir } catch { } }
  }

  $published = Publish-CollieName $dir
  $exe = Join-Path $current "bin\collie.exe"
  # The check file sits in COLLIE_DIR, like everything else this script writes.
  $check = Join-Path $dir ".collie-version-check.txt"
  $blocked = Test-CollieRuns $exe $check
  Remove-Item -LiteralPath $check -Force -ErrorAction SilentlyContinue
  if ($null -ne $blocked) {
    Write-CollieLine $published
    Stop-CollieBlocked $dir $exe $blocked
  }
  $collie = Get-CollieCommandName $exe
  $herdr = Get-Command herdr -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

  # A pinned run over an install: Collie may be running already, so the next step is a restart,
  # as for a rescue that found the version on disk, never a first start.
  if ($rescue) {
    Write-CollieLine ""
    Write-CollieLine "OK  Collie $version is installed in $dir, and current names it."
    Write-CollieLine "    The download matches the checksum published with the release, and collie.exe runs."
    Write-CollieLine $published
    Write-CollieLine "If Collie is running, run  $collie restart  to start this version."
    return
  }

  # What is left is yours.
  Write-CollieLine ""
  Write-CollieLine "OK  Collie $version is installed in $dir. Nothing is running yet."
  Write-CollieLine "    The download matches the checksum published with the release, and collie.exe runs."
  Write-CollieLine $published
  if ($null -eq $herdr) { Write-CollieLine "Herdr not found on your PATH. Collie on Windows needs it (step 2)." }
  else { Write-CollieLine "Herdr found: $($herdr.Source)" }
  Write-CollieLine ""
  Write-CollieLine "Next steps. This script does not take them for you:"
  Write-CollieLine ""
  if ($env:COLLIE_NO_PATH_EDIT -eq "1") { Write-CollieLine "  1. Open a NEW terminal window." }
  else { Write-CollieLine "  1. Open a NEW terminal window. Windows gives the new PATH only to windows opened after this install." }
  Write-CollieLine ""
  Write-CollieLine "  2. Start Herdr in another terminal window, and leave it running. Collie needs it before it starts."
  Write-CollieLine "     Get Herdr at https://herdr.dev (its installer: irm https://herdr.dev/install.ps1 | iex). Then run:"
  Write-CollieLine "       herdr"
  Write-CollieLine ""
  Write-CollieLine "  3. Start Collie, then print its address:"
  Write-CollieLine "       $collie start"
  Write-CollieLine "       $collie url"
  Write-CollieLine "     On Windows, Collie listens on this machine only. To open it on your phone, reach it through"
  Write-CollieLine "     your Tailscale network: $current\docs\deployment.md"
  Write-CollieLine ""
  Write-CollieLine "  4. Pair your phone. Collie answers no device until one is paired:"
  Write-CollieLine "       $collie pair"
  Write-CollieLine ""
  Write-CollieLine "Linking several machines (crew) does not work on Windows yet. Collie on one machine works fine."
  Write-CollieLine "collie.exe is unsigned: Windows does not know the publisher of this file. If Windows blocks it later, run  `"$exe`" version  to see why."
  Write-CollieLine "Read $current\docs\security.md before you open Collie on a phone. Collie gives remote shell access to this machine, by design."
}

# Print a failure: what happened, then "Install failed." and the one fix, as the last line.
function Write-CollieFailure([string]$What, [string]$Fix) {
  Write-Host "collie install: $What" -ForegroundColor Red
  Write-Host "Install failed. $Fix" -ForegroundColor Red
}

# The install and its outcome. It sets $LASTEXITCODE (0 on success, 1 on a failure, 2 on an option)
# and puts back the one process-wide setting it changes (the TLS protocols), so nothing it did stays
# in your session.
function Invoke-CollieEntry([object[]]$Arguments) {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  if ($ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
    Write-CollieFailure "this PowerShell runs in $($ExecutionContext.SessionState.LanguageMode) mode, and the installer needs FullLanguage (a device policy sets this)." "Ask whoever manages this machine, or install by hand: https://github.com/AltanS/collie/blob/main/docs/install.md"
    $global:LASTEXITCODE = 1
    return
  }
  if (@($Arguments).Count -gt 0) {
    Write-CollieFailure "install.ps1 takes no options, and got '$(@($Arguments)[0])'." "Run it with no options. Steer it with COLLIE_DIR, COLLIE_UPDATE_REPO and COLLIE_TAG."
    $global:LASTEXITCODE = 2
    return
  }
  $tls = [Net.ServicePointManager]::SecurityProtocol
  try {
    [Net.ServicePointManager]::SecurityProtocol = $tls -bor [Net.SecurityProtocolType]::Tls12
    Invoke-CollieInstall
    $global:LASTEXITCODE = 0
  } catch {
    $fix = $_.Exception.Data["CollieFix"]
    if ($null -eq $fix) { $fix = "Report it at https://github.com/AltanS/collie/issues with the lines above." }
    Write-CollieFailure $_.Exception.Message $fix
    $global:LASTEXITCODE = 1
  } finally {
    [Net.ServicePointManager]::SecurityProtocol = $tls
  }
}

# The entry. $PSCommandPath names the script file when it runs as one; under `irm | iex` it is empty.
# Only a file run ends a failure with `exit`: there it ends just that PowerShell and gives the caller
# the exit code. Under `iex` an `exit` would close your window, so the function returns instead.
function Install-Collie([object[]]$Arguments) {
  Invoke-CollieEntry $Arguments
  if ($global:LASTEXITCODE -ne 0 -and "$PSCommandPath" -ne '') { exit $global:LASTEXITCODE }
}

Install-Collie $args
