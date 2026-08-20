$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message - expected '$Expected', got '$Actual'" }
}

function Assert-Contains([string]$Actual, [string]$Expected, [string]$Message) {
  if (-not $Actual.Contains($Expected)) { throw "$Message - '$Expected' not found in '$Actual'" }
}

$temp = Join-Path ([IO.Path]::GetTempPath()) "collie-ctl-$([guid]::NewGuid().ToString('N'))"
$savedConfigDir = $env:HERDR_PLUGIN_CONFIG_DIR
$savedTaskName = $env:COLLIE_TASK_NAME
$savedPort = $env:COLLIE_PORT
$savedSocketPath = $env:HERDR_SOCKET_PATH
$savedTaskRunLevel = $env:COLLIE_TASK_RUN_LEVEL
$originalPluginRoot = $null

try {
  New-Item -ItemType Directory -Path $temp | Out-Null
  @'
COLLIE_PORT=9123
COLLIE_HOST="127.0.0.1"
'@ | Set-Content -LiteralPath (Join-Path $temp ".env") -Encoding Ascii
  $env:HERDR_PLUGIN_CONFIG_DIR = $temp
  $env:COLLIE_TASK_NAME = "herdr.collie-test"
  Remove-Item Env:COLLIE_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:COLLIE_TASK_RUN_LEVEL -ErrorAction SilentlyContinue
  $env:HERDR_SOCKET_PATH = "\\.\pipe\collie-test"

  . (Join-Path $PSScriptRoot "collie-ctl.ps1")
  Assert-Equal $script:Port 9123 ".env port"
  Assert-Equal $env:COLLIE_HOST "127.0.0.1" ".env quoted value"

  $originalPluginRoot = $script:PluginRoot
  $script:PluginRoot = Join-Path $temp "launcher plugin & space"
  $launcherScripts = New-Item -ItemType Directory -Path (Join-Path $script:PluginRoot "contrib\windows") -Force
  'param([string]$Command); if ($Command -eq "fail") { exit 23 }; "action:$Command"' |
    Set-Content -LiteralPath (Join-Path $launcherScripts "collie-ctl.ps1") -Encoding Ascii
  Write-CollieActionLauncher
  $launcher = Join-Path $script:PluginRoot "build\collie-action-v1.exe"
  Assert-Equal ((& "\\?\$launcher" version | Out-String).Trim()) "action:version" "canonical action launcher execution"
  & $launcher fail *> $null
  Assert-Equal $LASTEXITCODE 23 "action launcher exit code"
  $launcherBody = Get-Content -LiteralPath $launcher -Raw
  Write-CollieActionLauncher
  Assert-Equal (Get-Content -LiteralPath $launcher -Raw) $launcherBody "immutable action launcher"

  $script:PluginRoot = Join-Path $temp "lazy-plugin"
  New-Item -ItemType Directory -Path (Join-Path $script:PluginRoot "web") -Force | Out-Null
  $script:lazyApplicationBuilds = 0
  function Resolve-Bun { "C:\fake\bun.exe" }
  function Invoke-CollieApplicationBuild([string]$Bun) { $script:lazyApplicationBuilds++ }
  Ensure-CollieBuild | Out-Null
  Assert-Equal $script:lazyApplicationBuilds 1 "lazy start builds the application"
  $script:PluginRoot = $originalPluginRoot

  "crashed stdout" | Set-Content -LiteralPath $script:LogFile
  "crashed stderr" | Set-Content -LiteralPath $script:ErrorLogFile
  Preserve-CollieCrashLogs
  Assert-Contains (Get-Content -LiteralPath $script:PreviousLogFile -Raw) "crashed stdout" "crash stdout preservation"
  Assert-Contains (Get-Content -LiteralPath $script:PreviousErrorLogFile -Raw) "crashed stderr" "crash stderr preservation"

  $swapRoot = Join-Path $temp "web"
  New-Item -ItemType Directory -Path (Join-Path $swapRoot "dist"), (Join-Path $swapRoot "dist-staging") | Out-Null
  "live" | Set-Content -LiteralPath (Join-Path $swapRoot "dist\index.html")
  "staged" | Set-Content -LiteralPath (Join-Path $swapRoot "dist-staging\index.html")
  function Move-Item {
    param([string]$LiteralPath, [string]$Destination, [switch]$Force)
    if ((Split-Path -Leaf $LiteralPath) -eq "dist-staging") { throw "simulated staged move failure" }
    Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
  }
  try {
    Install-CollieWebDist $swapRoot
    throw "failed web swap was accepted"
  } catch {
    Assert-Contains $_.Exception.Message "simulated staged move failure" "web swap failure"
  }
  Remove-Item Function:\Move-Item
  Assert-Contains (Get-Content -LiteralPath (Join-Path $swapRoot "dist\index.html") -Raw) "live" "failed web swap preserves live dist"

  "not valid" | Set-Content -LiteralPath (Join-Path $temp "invalid.env") -Encoding Ascii
  try {
    Import-CollieEnv (Join-Path $temp "invalid.env")
    throw "invalid .env line was accepted"
  } catch {
    Assert-Contains $_.Exception.Message "invalid .env line" ".env validation"
  }

  "$PID|0" | Set-Content -LiteralPath $script:PidFile -NoNewline
  Stop-RecordedCollieProcesses
  Assert-Equal (Test-Path -LiteralPath $script:PidFile) $false "stale launcher PID record is cleared"

  $script:registered = $null
  $script:enabled = @()
  $script:disabled = @()
  $script:started = @()
  $script:stopped = @()
  function New-ScheduledTaskAction($Execute, $Argument, $WorkingDirectory) {
    [pscustomobject]@{ Execute = $Execute; Argument = $Argument; WorkingDirectory = $WorkingDirectory }
  }
  function New-ScheduledTaskTrigger([switch]$AtLogOn, $User) {
    [pscustomobject]@{ AtLogOn = $AtLogOn; User = $User }
  }
  function New-ScheduledTaskPrincipal($UserId, $LogonType, $RunLevel) {
    [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
  }
  function New-ScheduledTaskSettingsSet {
    param(
      [switch]$AllowStartIfOnBatteries,
      [switch]$DontStopIfGoingOnBatteries,
      $ExecutionTimeLimit,
      $MultipleInstances,
      $RestartCount,
      $RestartInterval,
      [switch]$StartWhenAvailable
    )
    [pscustomobject]@{
      ExecutionTimeLimit = $ExecutionTimeLimit
      RestartCount = $RestartCount
      RestartInterval = $RestartInterval
    }
  }
  function Register-ScheduledTask {
    param($TaskName, $Action, $Trigger, $Principal, $Settings, $Description, [switch]$Force)
    $script:registered = [pscustomobject]@{
      TaskName = $TaskName
      Action = $Action
      Trigger = $Trigger
      Principal = $Principal
      Settings = $Settings
    }
  }
  function Enable-ScheduledTask($TaskName) { $script:enabled += $TaskName }
  function Get-ScheduledTask($TaskName) { [pscustomobject]@{ TaskName = $TaskName; State = "Ready" } }
  function Disable-ScheduledTask($TaskName) { $script:disabled += $TaskName }
  function Start-ScheduledTask($TaskName) { $script:started += $TaskName }
  function Stop-ScheduledTask($TaskName) { $script:stopped += $TaskName }
  function Unregister-ScheduledTask($TaskName, [switch]$Confirm) { $script:unregistered += $TaskName }

  Register-CollieTask | Out-Null
  Assert-Equal $script:registered.TaskName "herdr.collie-test" "task ownership"
  Assert-Contains $script:registered.Action.Argument "_exec-bridge" "task action"
  Assert-Contains $script:registered.Action.Argument $temp "task preserves resolved config dir"
  Assert-Contains $script:registered.Action.Argument "\\.\pipe\collie-test" "task preserves resolved socket path"
  Assert-Equal $script:registered.Trigger.User ([Security.Principal.WindowsIdentity]::GetCurrent().Name) "logon trigger user"
  Assert-Equal $script:registered.Principal.RunLevel "Limited" "task privilege"
  Assert-Equal $script:registered.Settings.ExecutionTimeLimit ([TimeSpan]::Zero) "task execution limit"
  Assert-Equal $script:registered.Settings.RestartCount 999 "task restart policy"
  Assert-Contains $script:registered.Action.Execute "conhost.exe" "task launcher is headless"
  Assert-Contains $script:registered.Action.Argument "--headless" "task action asks for no console"

  $env:COLLIE_TASK_RUN_LEVEL = "highest"
  function Test-Administrator { $true }
  Register-CollieTask | Out-Null
  Assert-Equal $script:registered.Principal.RunLevel "Highest" "explicit elevated task"
  function Test-Administrator { $false }
  try {
    Register-CollieTask | Out-Null
    throw "non-Administrator registered an elevated task"
  } catch {
    Assert-Contains $_.Exception.Message "requires Administrator" "elevated task privilege gate"
  }
  Remove-Item Env:COLLIE_TASK_RUN_LEVEL

  Stop-Collie | Out-Null
  Assert-Equal ($script:disabled -join ",") "herdr.collie-test" "stop disables only Collie's task"
  Assert-Equal ($script:stopped -join ",") "herdr.collie-test" "stop stops only Collie's task"

  $script:unregistered = @()
  $uninstallOutput = Uninstall-Collie | Out-String
  Assert-Equal ($script:unregistered -join ",") "herdr.collie-test" "uninstall always removes Collie's task"
  Assert-Contains $uninstallOutput "operator-managed" "uninstall leaves Tailscale Serve unchanged"

  $fakeTailscale = Join-Path $temp "tailscale.cmd"
  "@echo off`r`nif `%1`==serve if `%2`==status echo https://host.example.ts.net`r`n" |
    Set-Content -LiteralPath $fakeTailscale -Encoding Ascii
  function Resolve-Tailscale { $fakeTailscale }
  function Test-HerdrReady { $true }
  function Get-CollieUrl { "https://host.example.ts.net" }
  $statusOutput = Show-CollieStatus | Out-String
  Assert-Contains $statusOutput "serve config:" "status includes Tailscale configuration"
  Assert-Contains $statusOutput "https://host.example.ts.net" "status includes Tailscale mapping"

  $script:disabled = @()
  function Ensure-CollieBuild {}
  function Test-HerdrReady([int]$Attempts = 1) { $false }
  function Show-CollieStatus {}
  $startOutput = Start-Collie 3>&1 | Out-String
  Assert-Contains $startOutput "temporarily unavailable" "temporary Herdr outage warning"
  Assert-Equal ($script:started -join ",") "herdr.collie-test" "start launches Collie's task"
  Assert-Equal ($script:disabled -join ",") "" "temporary Herdr outage keeps Collie's task enabled"

  function Invoke-TestGit([string]$Repo, [string[]]$GitArgs) {
    & git -c user.name=collie-test -c user.email=test@example.invalid -C $Repo @GitArgs | Out-Null
    Assert-LastExit "test git $($GitArgs -join ' ')"
  }

  $origin = Join-Path $temp "origin"
  New-Item -ItemType Directory -Path $origin | Out-Null
  Invoke-TestGit $origin @("init", "-q", "-b", "main")
  "v1" | Set-Content -LiteralPath (Join-Path $origin "VERSION") -NoNewline
  "lock-v1" | Set-Content -LiteralPath (Join-Path $origin "bun.lock") -NoNewline
  Invoke-TestGit $origin @("add", "-A")
  Invoke-TestGit $origin @("commit", "-qm", "first")
  $originUri = ([Uri]::new($origin)).AbsoluteUri

  $managed = Join-Path $temp "managed"
  New-Item -ItemType Directory -Path $managed | Out-Null
  Invoke-TestGit $managed @("init", "-q")
  Invoke-TestGit $managed @("remote", "add", "origin", $originUri)
  Invoke-TestGit $managed @("fetch", "-q", "--depth", "1", "origin", "HEAD")
  Invoke-TestGit $managed @("checkout", "-q", "--detach", "FETCH_HEAD")
  "v2" | Set-Content -LiteralPath (Join-Path $origin "VERSION") -NoNewline
  Invoke-TestGit $origin @("add", "-A")
  Invoke-TestGit $origin @("commit", "-qm", "second")
  "rewritten-by-build" | Set-Content -LiteralPath (Join-Path $managed "bun.lock") -NoNewline

  $script:PluginRoot = $managed
  Assert-Equal (Test-CollieManagedCheckout) $true "managed checkout detection"
  $managedOutput = Update-CollieCheckout | Out-String
  Assert-Contains $managedOutput "Herdr-managed checkout" "managed update path"
  Assert-Equal (Get-Content -Raw -LiteralPath (Join-Path $managed "VERSION")) "v2" "managed checkout update"
  Assert-Equal (Get-Content -Raw -LiteralPath (Join-Path $managed "bun.lock")) "lock-v1" "managed update discards build dirt"
  Assert-Equal ((& git -C $managed rev-parse --is-shallow-repository | Out-String).Trim()) "true" "managed checkout stays shallow"
  Assert-Equal (Test-CollieManagedCheckout) $true "managed checkout stays detached"
  $registryOutput = Refresh-CollieRegistry | Out-String
  Assert-Contains $registryOutput "registry left alone" "managed update does not re-link"

  $linked = Join-Path $temp "linked"
  & git clone -q $originUri $linked
  Assert-LastExit "test git clone"
  Invoke-TestGit $origin @("commit", "-q", "--allow-empty", "-m", "third")
  $script:PluginRoot = $linked
  Assert-Equal (Test-CollieManagedCheckout) $false "linked checkout detection"
  $linkedOutput = Update-CollieCheckout | Out-String
  Assert-Contains $linkedOutput "git pull --ff-only" "linked update path"
  Assert-Equal ((& git -C $linked rev-parse HEAD | Out-String).Trim()) ((& git -C $origin rev-parse HEAD | Out-String).Trim()) "linked checkout update"
  Assert-Equal ((& git -C $linked symbolic-ref --short HEAD | Out-String).Trim()) "main" "linked checkout stays on branch"

  $plain = Join-Path $temp "plain"
  New-Item -ItemType Directory -Path $plain | Out-Null
  $script:PluginRoot = $plain
  try {
    Update-CollieCheckout | Out-Null
    throw "a non-git checkout was accepted"
  } catch {
    Assert-Contains $_.Exception.Message "herdr plugin install AltanS/collie --yes" "non-git update recovery"
  }
  $script:PluginRoot = $originalPluginRoot

  Write-Output "OK Windows lifecycle tests"
} finally {
  if ($originalPluginRoot) { $script:PluginRoot = $originalPluginRoot }
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
  [Environment]::SetEnvironmentVariable("HERDR_PLUGIN_CONFIG_DIR", $savedConfigDir, "Process")
  [Environment]::SetEnvironmentVariable("COLLIE_TASK_NAME", $savedTaskName, "Process")
  [Environment]::SetEnvironmentVariable("COLLIE_PORT", $savedPort, "Process")
  [Environment]::SetEnvironmentVariable("HERDR_SOCKET_PATH", $savedSocketPath, "Process")
  [Environment]::SetEnvironmentVariable("COLLIE_TASK_RUN_LEVEL", $savedTaskRunLevel, "Process")
}
