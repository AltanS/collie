# Collie's installer for Windows. It downloads the Windows release, checks its sha256, lays it down,
# and puts `collie` on your user PATH. It is the Windows twin of install.sh.
#
# Run it like this, in PowerShell:
#
#   irm https://colliepwa.dev/install.ps1 | iex
#
# You can also download this file, read it, and run it:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# This file is one page with no helpers to fetch, so you can read all of it before you run it.
# What it will never do:
#   - It never asks for admin rights.
#   - It never writes outside COLLIE_DIR, except one entry in your user PATH.
#   - It never starts a service, a task or a program.
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
# Two more are for tests and rehearsals:
#   COLLIE_NO_PATH_EDIT=1     do not change the user PATH. Run <COLLIE_DIR>\current\bin\collie.exe.
#   COLLIE_INSTALL_MIRROR     a base URL that replaces https://api.github.com and https://github.com.
#                             The script asks it for /repos/<repo>/tags and for
#                             /<repo>/releases/download/<tag>/<file>. The token is never sent to it.
#
# The layout is the one `collie update` reads: <COLLIE_DIR>\versions\<X.Y.Z> holds one release, and
# <COLLIE_DIR>\current is a directory junction to one of them. A standard user can make a junction.
# A symbolic link needs Developer Mode, so this uses none.
#
# Everything is inside functions, and the last line calls them. If the download of this file stops
# half way, `iex` gets no last line, and nothing runs.

function Stop-CollieInstall([string]$Message) {
  throw "collie install: $Message"
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

# The newest strict release tag (vX.Y.Z), compared by number. A prerelease is never picked: pin it.
function Select-CollieNewestTag([string[]]$Names) {
  $strict = @($Names | Where-Object { $_ -cmatch '^v[0-9]+\.[0-9]+\.[0-9]+$' })
  if ($strict.Count -eq 0) { return $null }
  return @($strict | Sort-Object { [version]$_.Substring(1) })[-1]
}

# Check a downloaded file against its sidecar line "<sha256>  <name>". Returns the problem, or $null.
function Get-CollieDigestProblem([string]$Sidecar, [string]$Name, [string]$Actual) {
  $words = @("$Sidecar".Trim() -split '\s+')
  if ($words.Count -lt 2 -or $words[0] -notmatch '^[0-9a-fA-F]{64}$') {
    return "$Name.sha256 is not one '<sha256>  <name>' line"
  }
  if ($words[1].TrimStart('*') -ne $Name) { return "$Name.sha256 names $($words[1]), not $Name" }
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
  if ("$PathValue".EndsWith(';')) { return "$PathValue$Entry" }
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
      Stop-CollieInstall "your user PATH is stored as $kind, which this script does not edit. Add $Entry to it by hand."
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

# Download Url to OutFile. Returns 200, the HTTP status of a failure, or 0 when no server answered.
function Get-CollieFile([string]$Url, [string]$OutFile) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -ErrorAction Stop
    return 200
  } catch {
    Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
    return (Get-CollieHttpCode $_)
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
    Stop-CollieInstall "$current is a real folder or file, not a junction, so it is not Collie's to remove. Move it aside, then run this again."
  }
  $old = Get-CollieLinkTarget $current
  switch (Get-CollieLinkState $staged) {
    "link" { Remove-CollieLink $staged }
    "other" { Stop-CollieInstall "$staged is in the way and is not a junction. Move it aside, then run this again." }
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
      Stop-CollieInstall "could not point $current at $Target ($why). $current is missing now, and putting it back failed too. Make it again by hand:  cmd /c mklink /J `"$current`" `"$old`""
    }
  }
  Stop-CollieInstall "could not point $current at $Target ($why). $current still names $old. Nothing was changed."
}

# Add the PATH entry, unless COLLIE_NO_PATH_EDIT says no. Returns one line that says what happened.
function Publish-CollieName([string]$Dir) {
  $bin = Join-Path $Dir "current\bin"
  if ($env:COLLIE_NO_PATH_EDIT -eq "1") {
    return "COLLIE_NO_PATH_EDIT=1 is set, so your PATH was not changed. Run Collie as $bin\collie.exe."
  }
  if (Set-CollieUserPath $bin) { return "Added $bin to your user PATH." }
  return "$bin is on your user PATH already."
}

function Invoke-CollieInstall {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = "$env:COLLIE_UPDATE_REPO".Trim()
  if ($repo -eq '') { $repo = "AltanS/collie" }
  $dir = "$env:COLLIE_DIR".Trim()
  if ($dir -eq '') {
    if ("$env:LOCALAPPDATA" -eq '') { Stop-CollieInstall "LOCALAPPDATA is not set. Set COLLIE_DIR to the folder to install into." }
    $dir = Join-Path $env:LOCALAPPDATA "collie"
  }
  $dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($dir).TrimEnd('\')
  $mirror = "$env:COLLIE_INSTALL_MIRROR".Trim().TrimEnd('/')
  if ($mirror -ne '' -and $mirror -notmatch '^https?://') {
    Stop-CollieInstall "COLLIE_INSTALL_MIRROR='$mirror' is not an http or https URL."
  }

  # A pinned tag is checked before anything is fetched or touched.
  $pin = "$env:COLLIE_TAG".Trim()
  if ($pin -ne '' -and $pin -cnotmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') {
    Stop-CollieInstall "COLLIE_TAG='$pin' is not a release tag. It has to look like v1.0.0, or v1.0.0-beta.49 for a prerelease."
  }

  $problem = Get-CollieHostProblem (Get-CollieArch) ([Environment]::OSVersion.Version.Build)
  if ($null -ne $problem) { Stop-CollieInstall $problem }

  # Leave an existing install alone, unless a tag was pinned. A pin lays that version down BESIDE
  # what is there and points `current` at it. That is the way back when the installed version is
  # the broken one.
  $rescue = $false
  if (Test-Path -LiteralPath $dir) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Stop-CollieInstall "$dir is a file. Move it aside, or set COLLIE_DIR to somewhere else." }
    $isGit = Test-Path -LiteralPath (Join-Path $dir ".git")
    $hasVersions = Test-Path -LiteralPath (Join-Path $dir "versions") -PathType Container
    if ($isGit -and $pin -ne '') {
      Stop-CollieInstall "$dir is a git checkout, and COLLIE_TAG only pins a binary install. Pin it with git instead:  git -C $dir checkout $pin"
    }
    if ($hasVersions -and -not $isGit -and $pin -ne '') {
      Write-CollieLine "Collie is already installed at $dir. Laying $pin down beside it, and pointing current at it."
      $rescue = $true
    } elseif ($isGit -or $hasVersions) {
      Write-CollieLine "Collie is already installed at $dir. Leaving it alone."
      Write-CollieLine "To move it forward, run:  collie update"
      Write-CollieLine "To put one specific version there instead, run this script again with COLLIE_TAG=vX.Y.Z"
      return
    } else {
      $other = @(Get-ChildItem -LiteralPath $dir -Force | Where-Object { $_.Name -ne ".staging" })
      if ($other.Count -gt 0) { Stop-CollieInstall "$dir already exists and is not a Collie install. Move it aside, or set COLLIE_DIR to somewhere else." }
    }
  }

  # Which release. The tags are the list `collie update` reads too, never `releases/latest`. A
  # GitHub token, if you have one, goes with this ONE call, never with a download and never to a mirror.
  $tag = $pin
  if ($tag -eq '') {
    $api = if ($mirror -ne '') { $mirror } else { "https://api.github.com" }
    $headers = @{ Accept = "application/vnd.github+json" }
    $tokenFrom = ''
    foreach ($name in "COLLIE_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN") {
      $value = [Environment]::GetEnvironmentVariable($name)
      if ("$value" -ne '') { $tokenFrom = $name; break }
    }
    if ($tokenFrom -ne '' -and $mirror -eq '') { $headers.Authorization = "Bearer " + [Environment]::GetEnvironmentVariable($tokenFrom) }
    $later = "Try again later, or name the version you want and skip this call:  `$env:COLLIE_TAG = 'vX.Y.Z'"
    try {
      $answer = Invoke-WebRequest -UseBasicParsing -Uri "$api/repos/$repo/tags?per_page=100" -Headers $headers -ErrorAction Stop
    } catch {
      $code = Get-CollieHttpCode $_
      if ($code -eq 0) { Stop-CollieInstall "could not reach $api to list the releases. Check your network and try again." }
      if ($code -eq 401 -and $headers.ContainsKey("Authorization")) { Stop-CollieInstall "GitHub refused the token in $tokenFrom (HTTP 401). Fix it or remove it, then run this again." }
      if ($code -eq 403 -or $code -eq 429) {
        Stop-CollieInstall "GitHub's API rate limit says no (HTTP $code). Without a token GitHub allows 60 calls an hour per network address. Set GH_TOKEN to a GitHub token with no scopes, wait an hour, or name the version you want:  `$env:COLLIE_TAG = 'vX.Y.Z'  (the tags are at https://github.com/$repo/releases)."
      }
      Stop-CollieInstall "$api answered HTTP $code when asked for the tags of $repo. $later"
    }
    $names = @($answer.Content | ConvertFrom-Json | ForEach-Object { $_ } | ForEach-Object { "$($_.name)" })
    $tag = Select-CollieNewestTag $names
    if ($null -eq $tag) { Stop-CollieInstall "no release tag found for $repo. Report this at https://github.com/$repo/issues." }
  }
  $version = $tag.Substring(1)
  $platform = "windows-x64"
  $zipName = "collie-$version-$platform.zip"
  $base = if ($mirror -ne '') { "$mirror/$repo/releases/download/$tag" } else { "https://github.com/$repo/releases/download/$tag" }
  $versionDir = Join-Path $dir "versions\$version"
  $current = Join-Path $dir "current"

  # The pinned version may be on disk already: then the rescue is a junction flip and nothing more.
  if ($rescue -and (Test-Path -LiteralPath $versionDir)) {
    if (-not (Test-Path -LiteralPath (Join-Path $versionDir "bin\collie.exe"))) {
      Stop-CollieInstall "$versionDir is there but holds no bin\collie.exe. Move it aside and run this again."
    }
    $now = Get-CollieLinkTarget $current
    if ($null -ne $now -and $now.TrimEnd('\') -eq $versionDir) {
      Write-CollieLine (Publish-CollieName $dir)
      Write-CollieLine "OK  Collie $tag is installed at $dir and current names it already. Nothing was changed, and nothing was downloaded."
      return
    }
    Set-CollieCurrent $dir $versionDir
    Write-CollieLine (Publish-CollieName $dir)
    Write-CollieLine "OK  Collie $tag was already at $versionDir. current now names it, and nothing was downloaded."
    Write-CollieLine "If Collie is running, run  collie restart  to start this version."
    return
  }

  # Download, and verify before anything is unpacked. The scratch folder is inside COLLIE_DIR, and
  # it is removed on every way out.
  $createdDir = -not (Test-Path -LiteralPath $dir)
  $staging = Join-Path $dir ".staging"
  $work = Join-Path $staging "install-$PID"
  try {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $zip = Join-Path $work $zipName
    if ($mirror -ne '') { Write-CollieLine "Downloading Collie $tag for $platform from the mirror $mirror ..." }
    else { Write-CollieLine "Downloading Collie $tag for $platform ..." }
    $code = Get-CollieFile "$base/$zipName" $zip
    if ($code -eq 0) { Stop-CollieInstall "could not reach the download for $zipName. Check your network and try again." }
    if ($code -ne 200) {
      Stop-CollieInstall "release $tag has no $platform artifact (HTTP $code). Either that tag does not exist, or it was published before Collie shipped a Windows zip. Check the tag against https://github.com/$repo/releases"
    }
    if ((Get-CollieFile "$base/$zipName.sha256" "$zip.sha256") -ne 200) {
      Stop-CollieInstall "could not download $zipName.sha256. Refusing to install an unverified binary. Nothing was installed."
    }
    $manifestPath = Join-Path $work "manifest.json"
    if ((Get-CollieFile "$base/collie-$version.manifest.json" $manifestPath) -ne 200) {
      Stop-CollieInstall "could not download the release manifest for $version. Nothing was installed."
    }
    $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1) {
      Stop-CollieInstall "release $version uses a manifest this installer does not understand. Get a newer install.ps1 from https://colliepwa.dev/install.ps1"
    }
    $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    $problem = Get-CollieDigestProblem ([System.IO.File]::ReadAllText("$zip.sha256")) $zipName $digest
    if ($null -ne $problem) {
      Stop-CollieInstall "$problem. The download was discarded and nothing was installed. Try again. If it happens again, report it at https://github.com/$repo/issues."
    }
    $entry = @($manifest.artifacts | Where-Object { $_.platform -eq $platform -and "$($_.sha256)" -eq $digest })
    if ($entry.Count -eq 0) { Stop-CollieInstall "the digest of $zipName is not the one release $version's manifest names. Nothing was installed." }

    # Lay it down: one complete payload per version, and `current` names one of them.
    $unpacked = Join-Path $work "unpacked"
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked -Force
    $payload = Join-Path $unpacked "collie-$version-$platform"
    if (-not (Test-Path -LiteralPath (Join-Path $payload "bin\collie.exe"))) {
      Stop-CollieInstall "$zipName does not contain bin\collie.exe. Refusing to install it."
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $dir "versions") | Out-Null
    if (Test-Path -LiteralPath $versionDir) { Stop-CollieInstall "$versionDir exists already. Move it aside and run this again." }
    try { Move-CollieItem $payload $versionDir }
    catch { Stop-CollieInstall "could not move the payload into $versionDir ($($_.Exception.Message))." }
    Set-CollieCurrent $dir $versionDir
  } finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    if ((Test-Path -LiteralPath $staging) -and @(Get-ChildItem -LiteralPath $staging -Force).Count -eq 0) {
      Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
    }
    if ($createdDir -and (Test-Path -LiteralPath $dir) -and @(Get-ChildItem -LiteralPath $dir -Force).Count -eq 0) {
      Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
    }
  }

  $published = Publish-CollieName $dir
  $collie = if ($env:COLLIE_NO_PATH_EDIT -eq "1") { "$current\bin\collie.exe" } else { "collie" }
  $herdr = Get-Command herdr -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

  # What is left is yours.
  Write-CollieLine ""
  Write-CollieLine "OK  Collie $tag is installed at $dir. Nothing is running yet."
  Write-CollieLine $published
  if ($null -eq $herdr) {
    Write-CollieLine "note: herdr is not on your PATH. Collie on Windows needs Herdr. Get it from https://herdr.dev"
    Write-CollieLine "      Herdr's own installer:  irm https://herdr.dev/install.ps1 | iex"
  }
  Write-CollieLine ""
  Write-CollieLine "Three steps are left. Each one is yours to take:"
  Write-CollieLine ""
  if ($env:COLLIE_NO_PATH_EDIT -eq "1") { Write-CollieLine "  1. Open a new terminal." }
  else { Write-CollieLine "  1. Open a new terminal, so that it reads the new PATH." }
  Write-CollieLine ""
  Write-CollieLine "  2. Start Herdr in a terminal of its own, and keep it open:"
  Write-CollieLine "       herdr"
  Write-CollieLine ""
  Write-CollieLine "  3. Start Collie, then print the address to open on your phone:"
  Write-CollieLine "       $collie start"
  Write-CollieLine "       $collie url"
  Write-CollieLine ""
  Write-CollieLine "Collie on Windows is experimental. A Windows machine cannot join a crew in this release."
  Write-CollieLine "collie.exe is not signed. Windows 11 Smart App Control can block it, and you cannot override that."
  Write-CollieLine "Read $current\docs\security.md before you open the URL on a phone. Collie gives remote shell access to this machine, by design."
}

function Install-Collie([string]$ScriptPath, [object[]]$Arguments) {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  $code = 0
  if (@($Arguments).Count -gt 0) {
    [Console]::Error.WriteLine("collie install: unknown option '$(@($Arguments)[0])'. install.ps1 takes no options. Steer it with COLLIE_DIR, COLLIE_UPDATE_REPO and COLLIE_TAG.")
    $code = 2
  } else {
    try { Invoke-CollieInstall } catch { [Console]::Error.WriteLine($_.Exception.Message); $code = 1 }
  }
  # From a file, the exit code tells the caller. From `irm | iex`, exit would close your window.
  if ($code -ne 0 -and "$ScriptPath" -ne '') { exit $code }
}

Install-Collie $MyInvocation.MyCommand.Path $args
