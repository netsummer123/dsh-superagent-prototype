<#
.SYNOPSIS
  Standalone start/stop/restart/status for the dsh-superagent service (one DSH profile).

.DESCRIPTION
  Windows-native manager for the superagent profile. It launches the profile as a detached Node process
  (survives the shell that started it), records its PID, clears a stale state-directory lock before starting,
  and reports health through the orchestrator management API.

  Port and state directory come from the profile's cordis.patch.yml (default port 50282).

  Exit codes for status/restart/start:
    0  the service runs normally
    1  it does not run, runs twice, is unreachable, or its runtime reports an error (a restart may fix it)
    2  it runs but a component (a Source, a Policy sync) reports an error (a restart does not fix it)
    3  it runs and waits for setup (a restart does not fix it)

.EXAMPLES
  powershell -ExecutionPolicy Bypass -File scripts\superagent.ps1 start
  powershell -ExecutionPolicy Bypass -File scripts\superagent.ps1 status
  powershell -ExecutionPolicy Bypass -File scripts\superagent.ps1 stop
  powershell -ExecutionPolicy Bypass -File scripts\superagent.ps1 restart
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status')]
  [string]$Action = 'status',

  # DSH profile to manage (default superagent).
  [string]$Profile = 'superagent',

  # DSH home (default %USERPROFILE%\.dsh).
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),

  # Node executable (default: node on PATH, else the nvm4w install).
  [string]$Node = '',

  # Path to the DSH CLI entrypoint (default: resolve from the global npm install).
  [string]$DshBin = ''
)

$ErrorActionPreference = 'Stop'

# --- Resolve paths --------------------------------------------------------------------------
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'

if (-not (Test-Path $ProfileDir)) { throw "Profile not found: $ProfileDir" }

if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source }
  elseif (Test-Path 'C:\nvm4w\nodejs\node.exe') { $Node = 'C:\nvm4w\nodejs\node.exe' }
  else { throw 'node.exe not found; pass -Node <path>' }
}
if (-not $DshBin) {
  $candidates = @(
    'C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js',
    (Join-Path (Split-Path $Node -Parent) 'node_modules\@deepseek-ai\dsh\lib\bin.js')
  )
  $DshBin = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $DshBin) { throw 'DSH CLI entrypoint not found; pass -DshBin <path to lib\bin.js>' }
}

# --- Read port and stateDir from the profile patch ------------------------------------------
function Get-PatchValue([string]$key) {
  if (-not (Test-Path $PatchFile)) { return $null }
  $lines = Get-Content $PatchFile
  foreach ($line in $lines) {
    if ($line -match "^\s*$([regex]::Escape($key))\s*:\s*(.+?)\s*$") { return $Matches[1].Trim('"', "'") }
  }
  return $null
}
$Port = Get-PatchValue 'port'
if (-not $Port) { $Port = '50282' }
$StateDir = Get-PatchValue 'stateDir'
if (-not $StateDir) { $StateDir = Join-Path $DshHome "state\$Profile" }
$Port = [int]$Port

# --- Control files --------------------------------------------------------------------------
$ControlDir = Join-Path $StateDir '.control'
$PidFile = Join-Path $ControlDir 'pid'
$LogDir = Join-Path $StateDir '.logs'
$BaseUrl = "http://127.0.0.1:$Port"

New-Item -ItemType Directory -Force -Path $ControlDir, $LogDir | Out-Null

function Get-RecordedPid {
  if (Test-Path $PidFile) {
    $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($raw -and ($raw -as [int])) { return [int]$raw }
  }
  return $null
}

# All Node processes whose command line runs this profile.
function Get-SuperagentProcesses {
  Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*--profile $Profile*" } |
    ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; CommandLine = $_.CommandLine } }
}

function Test-PortListening {
  $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

# Runs an authenticated GET against the management API and returns the parsed JSON, or $null on failure.
function Invoke-State {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "$BaseUrl/orchestrator/api/state" `
      -Headers @{ 'x-orchestrator-request' = '1' } -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { return ($resp.Content | ConvertFrom-Json) }
  } catch { }
  return $null
}

# --- Actions --------------------------------------------------------------------------------
function Start-Service2 {
  $procs = @(Get-SuperagentProcesses)
  if ($procs.Count -gt 0) {
    Write-Host "Already running (pid $($procs[0].Id)); use restart to restart." -ForegroundColor Yellow
    return (Status-Service2)
  }

  # Remove a stale proper-lockfile lock left by an abrupt kill; safe because no process runs this profile now.
  $lock = Join-Path (Split-Path $StateDir -Parent) "$Profile.lock"
  if (Test-Path $lock) { Remove-Item -Recurse -Force $lock -ErrorAction SilentlyContinue }

  $stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
  $log = Join-Path $LogDir "superagent-$stamp.log"
  $errLog = Join-Path $LogDir "superagent-$stamp.err.log"

  Write-Host "Starting superagent profile '$Profile' on $BaseUrl ..."
  $p = Start-Process -FilePath $Node -WindowStyle Hidden -PassThru `
    -ArgumentList @("`"$DshBin`"", '--profile', $Profile) `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $log -RedirectStandardError $errLog

  Set-Content -Path $PidFile -Value $p.Id -Encoding ascii
  Write-Host "Launched pid $($p.Id). Log: $log"

  # Wait up to 90s for the runtime to report ready.
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { Write-Host "Process exited early (code $($p.ExitCode)). See $errLog" -ForegroundColor Red; Remove-Item $PidFile -ErrorAction SilentlyContinue; return 1 }
    $state = Invoke-State
    if ($state -and $state.health -and $state.health.runtime -and $state.health.runtime.state -ne 'starting') {
      Write-Host 'Ready.' -ForegroundColor Green
      return (Status-Service2)
    }
    Start-Sleep -Seconds 2
  }
  Write-Host 'Timed out waiting for the runtime to become ready; it may still be starting. Check the log.' -ForegroundColor Yellow
  return (Status-Service2)
}

function Stop-Service2 {
  $procs = @(Get-SuperagentProcesses)
  if ($procs.Count -eq 0) { Write-Host 'Not running.' -ForegroundColor Yellow; Remove-Item $PidFile -ErrorAction SilentlyContinue; return 0 }
  foreach ($proc in $procs) {
    Write-Host "Stopping pid $($proc.Id) ..."
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { Write-Host "  could not stop $($proc.Id): $_" -ForegroundColor Red }
  }
  # Wait for the port to free.
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and (Test-PortListening)) { Start-Sleep -Milliseconds 500 }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  # Clear the lock a hard kill may leave behind.
  $lock = Join-Path (Split-Path $StateDir -Parent) "$Profile.lock"
  if (Test-Path $lock) { Remove-Item -Recurse -Force $lock -ErrorAction SilentlyContinue }
  Write-Host 'Stopped.' -ForegroundColor Green
  return 0
}

function Status-Service2 {
  $procs = @(Get-SuperagentProcesses)
  if ($procs.Count -eq 0) {
    Write-Host "superagent: not running" -ForegroundColor Yellow
    return 1
  }
  if ($procs.Count -gt 1) {
    Write-Host "superagent: $($procs.Count) processes serve this profile ($($procs.Id -join ', ')); run stop then start" -ForegroundColor Red
    return 1
  }
  $state = Invoke-State
  if (-not $state) {
    Write-Host "superagent: running (pid $($procs[0].Id)) but $BaseUrl does not answer" -ForegroundColor Red
    return 1
  }
  $runtime = $state.health.runtime
  $runtimeState = if ($runtime) { $runtime.state } else { 'unknown' }
  $color = switch ($runtimeState) { 'ready' { 'Green' } 'starting' { 'Yellow' } default { 'Red' } }
  Write-Host "superagent: pid $($procs[0].Id) | runtime=$runtimeState | $BaseUrl" -ForegroundColor $color

  # Setup requirements (exit 3) and per-component errors (exit 2).
  $setupPending = $false
  if ($state.setup) {
    foreach ($k in 'problem', 'feishuProblem', 'dingtalkProblem', 'gitlabProblem') {
      $v = $state.setup.$k
      if ($v) { $setupPending = $true; Write-Host "  setup needed: $($v.detail)" -ForegroundColor Yellow }
    }
  }
  $componentError = $false
  if ($state.health) {
    foreach ($name in $state.health.PSObject.Properties.Name) {
      $h = $state.health.$name
      if ($h -and $h.state -eq 'error') { $componentError = $true; Write-Host "  part error [$name]: $($h.detail)" -ForegroundColor Red }
    }
  }
  if ($runtimeState -eq 'error') { return 1 }
  if ($componentError) { return 2 }
  if ($setupPending) { return 3 }
  return ($(if ($runtimeState -eq 'ready') { 0 } else { 1 }))
}

function Restart-Service2 {
  Stop-Service2 | Out-Null
  return (Start-Service2)
}

# --- Dispatch -------------------------------------------------------------------------------
switch ($Action) {
  'start'   { $code = Start-Service2 }
  'stop'    { $code = Stop-Service2 }
  'restart' { $code = Restart-Service2 }
  'status'  { $code = Status-Service2 }
}
exit $code
