[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Command,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArgs,
  [string]$TaskConfigDir,
  [string]$TaskSocketPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Community-maintained. This script lives in contrib/windows/, two levels below the plugin root.
$script:PluginRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$script:PluginId = "herdr.collie"
$script:TaskName = if ($env:COLLIE_TASK_NAME) { $env:COLLIE_TASK_NAME } else { "herdr.collie" }

function Resolve-CollieConfigDir {
  if ($env:HERDR_PLUGIN_CONFIG_DIR) {
    return $env:HERDR_PLUGIN_CONFIG_DIR
  }

  $herdr = Get-Command herdr.exe -ErrorAction SilentlyContinue
  if ($herdr) {
    try {
      $resolved = (& $herdr.Source plugin config-dir $script:PluginId 2>$null | Select-Object -First 1).Trim()
      if ($resolved) { return $resolved }
    } catch {
      # Herdr may not be running during login. Fall through to its conventional Windows path.
    }
  }

  $roaming = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\Roaming" }
  return Join-Path $roaming "herdr\plugins\config\$($script:PluginId)"
}

$script:ConfigDir = if ($TaskConfigDir) { $TaskConfigDir } else { Resolve-CollieConfigDir }
$script:EnvFile = Join-Path $script:ConfigDir ".env"
$script:LogFile = Join-Path $script:ConfigDir "collie.log"
$script:ErrorLogFile = Join-Path $script:ConfigDir "collie-error.log"
$script:PreviousLogFile = Join-Path $script:ConfigDir "collie-previous.log"
$script:PreviousErrorLogFile = Join-Path $script:ConfigDir "collie-error-previous.log"
$script:PidFile = Join-Path $script:ConfigDir "collie-processes"

function Import-CollieEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $match = [regex]::Match($trimmed, '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
    if (-not $match.Success) {
      throw "invalid .env line: $line"
    }
    $name = $match.Groups[1].Value
    $value = $match.Groups[2].Value.Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

Import-CollieEnv $script:EnvFile

function Get-ColliePort {
  $port = 8787
  if ($env:COLLIE_PORT) {
    $parsed = 0
    if (-not [int]::TryParse($env:COLLIE_PORT, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
      Write-Warning "COLLIE_PORT=$($env:COLLIE_PORT) is invalid - using 8787"
    } else {
      $port = $parsed
    }
  }
  return $port
}

$script:Port = Get-ColliePort
$script:ServeMode = if ($env:COLLIE_SERVE_MODE -eq "http") { "http" } else { "https" }
$script:SkipServe = $env:COLLIE_SKIP_SERVE -eq "1"
$script:RoamingDir = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\Roaming" }
$script:SocketPath = if ($TaskSocketPath) {
  $TaskSocketPath
} elseif ($env:HERDR_SOCKET_PATH) {
  $env:HERDR_SOCKET_PATH
} else {
  Join-Path $script:RoamingDir "herdr\herdr.sock"
}

function Resolve-Bun {
  $command = Get-Command bun.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    (Join-Path $env:USERPROFILE ".bun\bin\bun.exe"),
    (Join-Path $env:ProgramData "chocolatey\bin\bun.exe"),
    (Join-Path $env:LOCALAPPDATA "bun\bin\bun.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw "bun not found - install Bun and make bun.exe available on PATH"
}

function Resolve-Tailscale {
  $command = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"),
      (Join-Path ${env:ProgramFiles(x86)} "Tailscale\tailscale.exe"),
      (Join-Path $env:LOCALAPPDATA "Tailscale\tailscale.exe")
    )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Invoke-InDirectory([string]$Path, [scriptblock]$Body) {
  Push-Location -LiteralPath $Path
  try { & $Body } finally { Pop-Location }
}

function Assert-LastExit([string]$What) {
  if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

function Write-CollieActionLauncher {
  $launcherDir = Join-Path $script:PluginRoot "build"
  $launcher = Join-Path $launcherDir "collie-action-v1.exe"
  if (Test-Path -LiteralPath $launcher) {
    $stream = [IO.File]::OpenRead($launcher)
    try { $isExecutable = $stream.ReadByte() -eq 77 -and $stream.ReadByte() -eq 90 } finally { $stream.Dispose() }
    if (-not $isExecutable) {
      throw "action launcher was built for POSIX; delete '$launcher' and rebuild"
    }
    return
  }
  New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
  Add-Type -Path (Join-Path $PSScriptRoot "collie-action.cs") -OutputAssembly $launcher -OutputType ConsoleApplication
}

function Install-CollieWebDist([string]$WebRoot) {
  $staging = Join-Path $WebRoot "dist-staging"
  $dist = Join-Path $WebRoot "dist"
  $backup = Join-Path $WebRoot "dist-backup"

  if (Test-Path -LiteralPath $backup) {
    if (Test-Path -LiteralPath $dist) {
      Remove-Item -LiteralPath $backup -Recurse -Force
    } else {
      Move-Item -LiteralPath $backup -Destination $dist
    }
  }
  if (Test-Path -LiteralPath $dist) { Move-Item -LiteralPath $dist -Destination $backup }
  try {
    Move-Item -LiteralPath $staging -Destination $dist
  } catch {
    if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $dist)) {
      Move-Item -LiteralPath $backup -Destination $dist
    }
    throw
  }
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-CollieApplicationBuild([string]$Bun) {
  New-Item -ItemType Directory -Force -Path $script:ConfigDir | Out-Null
  # No version gate here: scripts/check-version.sh is a maintainer release gate and needs bash.
  # Operators never need it; run it from WSL or Git Bash if you are cutting a release.

  Invoke-InDirectory $script:PluginRoot {
    & $Bun install
    Assert-LastExit "root bun install"
    & $Bun run typecheck
    Assert-LastExit "root typecheck"
  }

  $webRoot = Join-Path $script:PluginRoot "web"
  $staging = Join-Path $webRoot "dist-staging"
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  Invoke-InDirectory $webRoot {
    & $Bun install
    Assert-LastExit "web bun install"
    & $Bun run typecheck
    Assert-LastExit "web typecheck"
    & $Bun run build -- --outDir dist-staging --emptyOutDir
    Assert-LastExit "web build"
  }
  Install-CollieWebDist $webRoot
}

function Invoke-CollieBuild {
  $bun = Resolve-Bun
  Write-CollieActionLauncher
  Invoke-CollieApplicationBuild $bun
}

function Ensure-CollieBuild {
  if (Test-Path -LiteralPath (Join-Path $script:PluginRoot "web\dist\index.html")) { return }
  Write-Output "building web UI (first run)..."
  Invoke-CollieApplicationBuild (Resolve-Bun)
}

function Test-Administrator {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-CollieTaskRunLevel {
  $requested = if ($env:COLLIE_TASK_RUN_LEVEL) { $env:COLLIE_TASK_RUN_LEVEL.Trim() } else { "limited" }
  if ($requested -ieq "limited") { return "Limited" }
  if ($requested -ine "highest") { throw "COLLIE_TASK_RUN_LEVEL must be 'limited' or 'highest'" }
  if (-not (Test-Administrator)) { throw "COLLIE_TASK_RUN_LEVEL=highest requires Administrator PowerShell" }
  return "Highest"
}

function Register-CollieTask {
  [void](Resolve-Bun)
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $ctl = Join-Path $PSScriptRoot "collie-ctl.ps1"
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -TaskConfigDir "{1}" -TaskSocketPath "{2}" _exec-bridge' -f $ctl, $script:ConfigDir, $script:SocketPath
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

  # No console, so the bridge is not a closable Windows Terminal tab; the launcher is still $powershell.
  $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
  $action = if (Test-Path -LiteralPath $conhost) {
    New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "{0}" {1}' -f $powershell, $arguments) -WorkingDirectory $script:PluginRoot
  } else {
    New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $script:PluginRoot
  }
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel (Get-CollieTaskRunLevel)
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

  Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Collie mobile bridge for Herdr" -Force | Out-Null
  Enable-ScheduledTask -TaskName $script:TaskName | Out-Null
}

function Test-BridgeReady([int]$Attempts = 25) {
  for ($i = 0; $i -lt $Attempts; $i++) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
      $connect = $client.ConnectAsync("127.0.0.1", $script:Port)
      if ($connect.Wait(200) -and $client.Connected) { return $true }
    } catch {
      # The bridge may still be starting.
    } finally {
      $client.Dispose()
    }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

function Test-HerdrReady([int]$Attempts = 1) {
  for ($i = 0; $i -lt $Attempts; $i++) {
    try {
      $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:Port)/api/snapshot" -TimeoutSec 1
      if ($snapshot.bridge -eq "connected") { return $true }
    } catch {
      # The bridge or Herdr endpoint may still be starting.
    }
    if ($i + 1 -lt $Attempts) { Start-Sleep -Milliseconds 250 }
  }
  return $false
}

function Get-CollieVersion {
  $buildInfo = Join-Path $script:PluginRoot "web\dist\build-info.json"
  if (Test-Path -LiteralPath $buildInfo) {
    $info = Get-Content -LiteralPath $buildInfo -Raw | ConvertFrom-Json
    if ($info.sha) { return "$($info.version)+$($info.sha)" }
    return [string]$info.version
  }
  $manifest = Get-Content -LiteralPath (Join-Path $script:PluginRoot "herdr-plugin.toml") -Raw
  $version = [regex]::Match($manifest, '(?m)^\s*version\s*=\s*"([^"]+)"').Groups[1].Value
  return "$version (manifest; web not built)"
}

function Get-TailscaleStatus {
  $tailscale = Resolve-Tailscale
  if (-not $tailscale) { throw "tailscale not found" }
  $raw = & $tailscale status --json 2>$null | Out-String
  Assert-LastExit "tailscale status"
  return $raw | ConvertFrom-Json
}

function Get-TailscaleDnsName {
  try {
    $status = Get-TailscaleStatus
    return ([string]$status.Self.DNSName).TrimEnd(".")
  } catch {
    return ""
  }
}

function Get-CollieUrl {
  if ($script:SkipServe) {
    if ($env:COLLIE_PUBLIC_URL) { return $env:COLLIE_PUBLIC_URL }
    return "http://127.0.0.1:$($script:Port) (COLLIE_SKIP_SERVE=1; public URL unset)"
  }
  $dnsName = Get-TailscaleDnsName
  if (-not $dnsName) { return "http://127.0.0.1:$($script:Port) (Tailscale name unavailable)" }
  if ($script:ServeMode -eq "http") { return "http://$dnsName`:$($script:Port)" }
  return "https://$dnsName"
}

function Show-CollieServeStatus {
  if ($script:SkipServe) {
    Write-Output "  serve config: skipped (COLLIE_SKIP_SERVE=1)"
    return
  }

  Write-Output "  serve config:"
  $tailscale = Resolve-Tailscale
  if (-not $tailscale) {
    Write-Output "    (tailscale not found)"
    return
  }
  $status = & $tailscale serve status 2>$null
  if ($LASTEXITCODE -eq 0 -and $status) {
    $status | ForEach-Object { Write-Output "    $_" }
  } else {
    Write-Output "    (unavailable)"
  }
}

function Show-CollieStatus {
  $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
  $service = if ($task) { "Task Scheduler ($($script:TaskName)) - $($task.State)" } else { "not supervised" }
  Write-Output ""
  if (Test-HerdrReady) {
    Write-Output "  OK Collie is running - v$(Get-CollieVersion)"
  } elseif (Test-BridgeReady 1) {
    Write-Output "  WARN Collie is running but cannot reach Herdr - check logs"
  } else {
    Write-Output "  WARN Collie is not answering on :$($script:Port) - check logs"
  }
  Write-Output "    service   $service"
  Write-Output "    local     http://127.0.0.1:$($script:Port)"
  Write-Output "    remote    $(Get-CollieUrl)"
  Write-Output ""
  Show-CollieServeStatus
}

function Start-Collie {
  Ensure-CollieBuild
  Register-CollieTask | Out-Null
  Start-ScheduledTask -TaskName $script:TaskName
  Write-Output "bridge started (Task Scheduler: $($script:TaskName))"
  if (-not (Test-HerdrReady 30)) {
    Write-Warning "Collie cannot reach Herdr yet. Herdr may be temporarily unavailable or running as Administrator. The bridge remains supervised and will reconnect."
  }
  Show-CollieStatus
}

function Stop-RecordedCollieProcesses {
  if (-not (Test-Path -LiteralPath $script:PidFile)) { return }
  $record = (Get-Content -LiteralPath $script:PidFile -Raw).Trim()
  $match = [regex]::Match($record, '^(\d+)\|(\d+)$')
  if (-not $match.Success) { throw "invalid Collie process ownership state: $record" }

  $launcherId = [int]$match.Groups[1].Value
  $bridgeId = [int]$match.Groups[2].Value
  $launcher = Get-CimInstance Win32_Process -Filter "ProcessId = $launcherId" -ErrorAction SilentlyContinue
  if ($launcher) {
    $controlScript = Join-Path $PSScriptRoot "collie-ctl.ps1"
    if ($launcher.CommandLine -and $launcher.CommandLine.Contains($controlScript) -and $launcher.CommandLine.Contains("_exec-bridge")) {
      & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $launcherId /T /F | Out-Null
    }
  }

  $bridge = if ($bridgeId -gt 0) {
    Get-CimInstance Win32_Process -Filter "ProcessId = $bridgeId" -ErrorAction SilentlyContinue
  }
  if ($bridge) {
    $bridgeScript = Join-Path $script:PluginRoot "bridge\index.ts"
    if ($bridge.CommandLine -and $bridge.CommandLine.Contains($bridgeScript)) {
      Stop-Process -Id $bridgeId -Force
    }
  }
  Remove-Item -LiteralPath $script:PidFile -ErrorAction SilentlyContinue
}

function Stop-Collie {
  $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Disable-ScheduledTask -TaskName $script:TaskName | Out-Null
  }
  Stop-RecordedCollieProcesses
  if ($task) { Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue }
  Write-Output "bridge stopped"
}

function Uninstall-Collie {
  Stop-Collie
  if (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false
  }
  Write-Output "OK uninstalled: task stopped and removed"
  Write-Output "  Tailscale Serve is operator-managed and was left unchanged"
  Write-Output "  kept: $($script:EnvFile) and the checkout"
}

function Test-CollieGitCommand([string[]]$GitArgs) {
  $savedPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & git -C $script:PluginRoot @GitArgs *> $null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $savedPreference
  }
}

function Test-CollieManagedCheckout {
  return -not (Test-CollieGitCommand @("symbolic-ref", "-q", "HEAD"))
}

function Update-CollieCheckout {
  if (-not (Test-CollieGitCommand @("rev-parse", "--git-dir"))) {
    throw "not a git checkout - refresh with: herdr plugin install AltanS/collie --yes"
  }

  if (-not (Test-CollieManagedCheckout)) {
    Write-Output "updating Collie (git pull --ff-only)..."
    & git -C $script:PluginRoot pull --ff-only
    Assert-LastExit "git pull"
    return
  }

  Write-Output "updating Collie (Herdr-managed checkout: fetch + detach onto origin HEAD)..."
  $shallow = (& git -C $script:PluginRoot rev-parse --is-shallow-repository | Out-String).Trim()
  Assert-LastExit "git shallow check"
  $depth = if ($shallow -eq "true") { @("--depth", "1") } else { @() }
  & git -C $script:PluginRoot fetch @depth origin HEAD
  Assert-LastExit "git fetch"
  & git -C $script:PluginRoot checkout -q --detach --force FETCH_HEAD
  Assert-LastExit "git checkout"
  $head = (& git -C $script:PluginRoot log -1 --format="%h %s" | Out-String).Trim()
  Assert-LastExit "git log"
  Write-Output "now at $head"
}

function Refresh-CollieRegistry {
  if (Test-CollieManagedCheckout) {
    Write-Output "note: Herdr-managed install - registry left alone (re-linking would block plugin reinstall)"
    return
  }
  try {
    & herdr plugin link $script:PluginRoot | Out-Null
    Assert-LastExit "herdr plugin link"
    Write-Output "herdr registry refreshed (re-linked)"
  } catch {
    Write-Warning "could not refresh the Herdr registry; run: herdr plugin link `"$($script:PluginRoot)`""
  }
}

function Apply-CollieUpdate {
  Invoke-CollieBuild
  Stop-Collie
  Start-Collie
  Refresh-CollieRegistry
  Write-Output "OK update complete"
}

function Update-Collie {
  Update-CollieCheckout
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "collie-ctl.ps1") _apply-update
  Assert-LastExit "apply update"
}

function Preserve-CollieCrashLogs {
  if (Test-Path -LiteralPath $script:LogFile) {
    Move-Item -LiteralPath $script:LogFile -Destination $script:PreviousLogFile -Force
  }
  if (Test-Path -LiteralPath $script:ErrorLogFile) {
    Move-Item -LiteralPath $script:ErrorLogFile -Destination $script:PreviousErrorLogFile -Force
  }
}

function Invoke-CollieBridge {
  $bun = Resolve-Bun
  New-Item -ItemType Directory -Force -Path $script:ConfigDir | Out-Null
  $env:HERDR_SOCKET_PATH = $script:SocketPath
  $env:COLLIE_PORT = [string]$script:Port
  $env:HERDR_PLUGIN_CONFIG_DIR = $script:ConfigDir
  if (-not $env:HERDR_PLUGIN_STATE_DIR) {
    $localData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
    $env:HERDR_PLUGIN_STATE_DIR = Join-Path $localData "herdr\plugins\$($script:PluginId)"
  }
  $bridge = Join-Path $script:PluginRoot "bridge\index.ts"
  Stop-RecordedCollieProcesses
  while ($true) {
    "$PID|0" | Set-Content -LiteralPath $script:PidFile -NoNewline
    $process = Start-Process `
      -FilePath $bun `
      -ArgumentList @("run", "`"$bridge`"") `
      -WorkingDirectory $script:PluginRoot `
      -NoNewWindow `
      -PassThru `
      -RedirectStandardOutput $script:LogFile `
      -RedirectStandardError $script:ErrorLogFile
    "$PID|$($process.Id)" | Set-Content -LiteralPath $script:PidFile -NoNewline
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    "$PID|0" | Set-Content -LiteralPath $script:PidFile -NoNewline
    if ($exitCode -eq 0) { exit 0 }
    Preserve-CollieCrashLogs
    Start-Sleep -Seconds 5
  }
}

if ($MyInvocation.InvocationName -eq ".") { return }

switch ($Command) {
  "build" { Invoke-CollieBuild }
  "start" { Start-Collie }
  "stop" { Stop-Collie }
  "restart" { Stop-Collie; Start-Collie }
  "uninstall" { Uninstall-Collie }
  "update" { Update-Collie }
  "_apply-update" { Apply-CollieUpdate }
  "status" { Show-CollieStatus }
  "url" { Get-CollieUrl }
  "version" { Get-CollieVersion }
  "logs" {
    $lines = if ($CommandArgs -and $CommandArgs.Count -gt 0) { [int]$CommandArgs[0] } else { 50 }
    if (Test-Path -LiteralPath $script:PreviousLogFile) { Write-Output "previous bridge crash (stdout):"; Get-Content -LiteralPath $script:PreviousLogFile -Tail $lines -Encoding UTF8 }
    if (Test-Path -LiteralPath $script:PreviousErrorLogFile) { Write-Output "previous bridge crash (stderr):"; Get-Content -LiteralPath $script:PreviousErrorLogFile -Tail $lines -Encoding UTF8 }
    if (Test-Path -LiteralPath $script:LogFile) { Get-Content -LiteralPath $script:LogFile -Tail $lines -Encoding UTF8 } else { "(no log)" }
    if (Test-Path -LiteralPath $script:ErrorLogFile) { Get-Content -LiteralPath $script:ErrorLogFile -Tail $lines -Encoding UTF8 }
  }
  "_exec-bridge" { Invoke-CollieBridge }
  default {
    Write-Error "usage: collie-ctl.ps1 {start|stop|restart|uninstall|update|version|build|status|url|logs}"
  }
}
