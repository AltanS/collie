[CmdletBinding()]
param(
  [ValidateSet('Install', 'Restore', 'Status')]
  [string]$Action = 'Install',
  [string]$OriginalCheckout = (Join-Path $env:USERPROFILE '.local\share\collie'),
  [string]$ConfigDir = (Join-Path $env:APPDATA 'herdr\plugins\config\herdr.collie'),
  [switch]$UseBuiltArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$control = Join-Path $PSScriptRoot 'collie-ctl.ps1'
$originalControl = Join-Path $OriginalCheckout 'contrib\windows\collie-ctl.ps1'
$omp = (Get-Command omp.exe -ErrorAction Stop).Source
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$stateDir = Join-Path $root 'build\omp-live-install'
$stateFile = Join-Path $stateDir 'installation.json'
$oldTask = 'herdr.collie'
$newTask = 'herdr.collie.omp-live'
$extensionFile = Join-Path $root 'omp\extension.ts'

# OMP's Windows plugin linker requires symlink privileges. Its supported explicit
# extension setting loads the same source without elevation or a second copy.
function Get-OmpExtensions {
  $json = & $omp config get extensions --json
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the OMP extension configuration.' }
  return @((($json -join "`n") | ConvertFrom-Json).value)
}

function Set-OmpLiveEnabled([bool]$Enabled) {
  $entries = @(Get-OmpExtensions | Where-Object { $_.Replace('\', '/') -ine $extensionFile.Replace('\', '/') })
  if ($Enabled) { $entries += $extensionFile }
  $json = ConvertTo-Json -InputObject @($entries) -Compress
  # Windows PowerShell 5.1's native argument binder needs escaped JSON quotes.
  & $omp config set extensions ($json.Replace('"', '\"'))
  if ($LASTEXITCODE -ne 0) { throw 'Could not update the OMP extension configuration.' }
}

function Invoke-Control([string]$Script, [string]$Task, [string]$Verb) {
  $saved = $env:COLLIE_TASK_NAME
  try {
    $env:COLLIE_TASK_NAME = $Task
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Script -TaskConfigDir $ConfigDir $Verb
    if ($LASTEXITCODE -ne 0) { throw "Collie $Verb failed ($Task)." }
  } finally {
    $env:COLLIE_TASK_NAME = $saved
  }
}

if ($Action -eq 'Status') {
  Invoke-Control $control $newTask 'status'
  & $omp config get extensions --json
  exit $LASTEXITCODE
}

if ($Action -eq 'Restore') {
  if (-not (Test-Path -LiteralPath $stateFile)) { throw 'No installation record exists for this fork.' }
  $installed = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  $ConfigDir = [string]$installed.configDir
  $originalControl = Join-Path ([string]$installed.originalCheckout) 'contrib\windows\collie-ctl.ps1'
  Invoke-Control $control $newTask 'uninstall'
  if (-not $installed.extensionWasConfigured) { Set-OmpLiveEnabled $false }
  Invoke-Control $originalControl $oldTask 'start'
  Write-Output 'Original Collie restored. Tailscale and original settings were not changed. Restart open OMP processes to unload Live.'
  exit 0
}

if (-not (Test-Path -LiteralPath $originalControl)) { throw 'Original Collie Windows installation was not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $ConfigDir '.env'))) { throw 'The original private Collie configuration was not found.' }
if ($UseBuiltArtifacts) {
  if (-not (Test-Path -LiteralPath (Join-Path $root 'web\dist\index.html'))) { throw 'Build the fork before using -UseBuiltArtifacts.' }
} else {
  Invoke-Control $control $newTask 'build'
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
if (-not (Test-Path -LiteralPath $stateFile)) {
  $task = Get-ScheduledTask -TaskName $oldTask -ErrorAction Stop
  Export-ScheduledTask -TaskName $oldTask | Set-Content -LiteralPath (Join-Path $stateDir 'original-task.xml') -Encoding Unicode
  @{
    originalCheckout = [IO.Path]::GetFullPath($OriginalCheckout)
    configDir = [IO.Path]::GetFullPath($ConfigDir)
    originalTaskState = [string]$task.State
    extensionWasConfigured = @(Get-OmpExtensions | Where-Object { $_.Replace('\', '/') -ieq $extensionFile.Replace('\', '/') }).Count -gt 0
    installedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

Set-OmpLiveEnabled $true

try {
  if (Get-ScheduledTask -TaskName $newTask -ErrorAction SilentlyContinue) {
    Invoke-Control $control $newTask 'stop'
  }
  Invoke-Control $originalControl $oldTask 'stop'
  Invoke-Control $control $newTask 'start'
  $running = Get-ScheduledTask -TaskName $newTask -ErrorAction Stop
  if ($running.State -ne 'Running') { throw 'The fork did not remain running.' }
} catch {
  $failure = $_
  try { Invoke-Control $control $newTask 'stop' } catch { Write-Warning $_ }
  try { Invoke-Control $originalControl $oldTask 'start' } catch { Write-Warning $_ }
  $installed = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  if (-not $installed.extensionWasConfigured) {
    try { Set-OmpLiveEnabled $false } catch { Write-Warning $_ }
  }
  throw $failure
}
Write-Output 'Collie OMP Live installed on the existing private URL. Open a new OMP pane, or restart an existing OMP process and resume its session, then tap Live on the phone.'
Write-Output "Restore: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action Restore"
