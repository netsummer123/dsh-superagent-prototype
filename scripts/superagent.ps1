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

  # DSH home (default: $env:DSH_HOME when set, else %USERPROFILE%\.dsh — matching the documented DSH_HOME relocation).
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),

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

# Whether a process command line is the DSH service for this profile, mirroring `serves()` in the POSIX peer `scripts/dsh-superagent`:
# accept both `--profile <name>` and `--profile=<name>`, and reject an invocation that carries a `plugin` subcommand (the admin
# `dsh plugin --profile <name> add ...` command must never be treated as, or killed as, the service).
function Test-ServesProfile([string]$CommandLine) {
  $tokens = $CommandLine -split '\s+'
  $matched = $false
  $value = $false
  $subcommands = @()
  # Skip the first token (the program path); inspect the rest like the peer's `args[1:]`.
  for ($i = 1; $i -lt $tokens.Count; $i++) {
    $word = $tokens[$i]
    if ($value) { if ($word -eq $Profile) { $matched = $true }; $value = $false }
    elseif ($word -eq '--profile') { $value = $true }
    elseif ($word -eq "--profile=$Profile") { $matched = $true }
    elseif (-not $word.StartsWith('-')) { $subcommands += $word }
  }
  return ($matched -and -not ($subcommands -contains 'plugin'))
}

# All Node processes whose command line runs this profile.
function Get-SuperagentProcesses {
  Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and (Test-ServesProfile $_.CommandLine) } |
    ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; CommandLine = $_.CommandLine } }
}

function Test-PortListening {
  $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

# Runs an authenticated GET against the management API and returns the parsed JSON, or $null on failure.
function Invoke-State {
  $probe = Get-StateProbe
  if ($probe.Kind -eq 'ok') { return $probe.State }
  return $null
}

# Probes the management API and classifies the result so callers can tell "definitely nothing answers" (connection refused)
# from "indeterminate" (timeout, non-2xx, TLS/proxy error, unparsable body). Kind is one of:
#   ok            an instance answered with 2xx JSON (State set)
#   refused       connection actively refused -> no process is listening here (safe to start)
#   unreachable   DNS/route refused/unreachable -> nothing serves this URL (safe to start)
#   indeterminate anything else (timeout, 5xx, bad JSON): an instance may still be up; do NOT assume it is down.
function Get-StateProbe {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "$BaseUrl/orchestrator/api/state" `
      -Headers @{ 'x-orchestrator-request' = '1' } -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
      try { return @{ Kind = 'ok'; State = ($resp.Content | ConvertFrom-Json) } }
      catch { return @{ Kind = 'indeterminate'; State = $null } }  # answered but unparsable: still an instance
    }
    return @{ Kind = 'indeterminate'; State = $null }
  } catch {
    # WebException with a connection-level failure means nothing is listening; anything else (timeout, proxy, TLS) is uncertain.
    $msg = [string]$_.Exception.Message
    $status = $null
    try { if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode } } catch { }
    if ($status) { return @{ Kind = 'indeterminate'; State = $null } }  # got an HTTP status (e.g. 5xx): instance is up
    if ($_.Exception -is [System.Net.WebException]) {
      switch ($_.Exception.Status) {
        ([System.Net.WebExceptionStatus]::ConnectFailure) { return @{ Kind = 'refused'; State = $null } }
        ([System.Net.WebExceptionStatus]::NameResolutionFailure) { return @{ Kind = 'unreachable'; State = $null } }
        ([System.Net.WebExceptionStatus]::HostNotFound) { return @{ Kind = 'unreachable'; State = $null } }
        default { return @{ Kind = 'indeterminate'; State = $null } }
      }
    }
    if ($msg -match 'actively refused|No connection could be made') { return @{ Kind = 'refused'; State = $null } }
    return @{ Kind = 'indeterminate'; State = $null }
  }
}

# --- Actions --------------------------------------------------------------------------------
function Start-Service2 {
  $procs = @(Get-SuperagentProcesses)
  if ($procs.Count -gt 0) {
    Write-Host "Already running (pid $($procs[0].Id)); use restart to restart." -ForegroundColor Yellow
    return (Status-Service2)
  }

  # No matching command line was found, but an instance may still be serving this URL (started another way). Probe the
  # management API before touching the lock or launching a second process against the same state directory and port.
  # Only proceed when the probe proves nothing answers here (connection refused / unreachable). An answered or an
  # indeterminate probe (timeout, 5xx, bad JSON) means an instance MAY be up: refuse and keep the lock rather than deleting
  # a live instance's lock (which would make proper-lockfile's onCompromised abort it) and starting a duplicate.
  $probe = Get-StateProbe
  if ($probe.Kind -eq 'ok') {
    Write-Host "An instance already answers at $BaseUrl but was not launched by this script; refusing to start a second." -ForegroundColor Red
    return (Status-Service2)
  }
  if ($probe.Kind -eq 'indeterminate') {
    Write-Host "Could not confirm that nothing serves $BaseUrl (indeterminate probe). Refusing to start or delete the lock; retry when the endpoint is reachable." -ForegroundColor Red
    return 1
  }

  # The probe proved nothing answers (refused/unreachable): safe to remove a stale proper-lockfile lock.
  # proper-lockfile locks the state directory itself, creating `<stateDir>.lock`, so the path follows $StateDir (not the profile name).
  $lock = "$StateDir.lock"
  if (Test-Path $lock) { Remove-Item -Recurse -Force $lock -ErrorAction SilentlyContinue }

  $stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
  $log = Join-Path $LogDir "superagent-$stamp.log"
  $errLog = Join-Path $LogDir "superagent-$stamp.err.log"

  Write-Host "Starting superagent profile '$Profile' on $BaseUrl ..."
  # Make the launched node process use the same DSH home this script derived ($StateDir/$ProfileDir come from it), whether the
  # home came from $env:DSH_HOME or an explicit -DshHome. Restore the caller's value afterwards.
  $prevDshHome = $env:DSH_HOME
  $env:DSH_HOME = $DshHome
  try {
    $p = Start-Process -FilePath $Node -WindowStyle Hidden -PassThru `
      -ArgumentList @("`"$DshBin`"", '--profile', $Profile) `
      -WorkingDirectory $RepoRoot `
      -RedirectStandardOutput $log -RedirectStandardError $errLog
  } finally {
    if ($null -eq $prevDshHome) { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue } else { $env:DSH_HOME = $prevDshHome }
  }

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
  $failed = $false
  # Ask each process to close gracefully first (CloseMainWindow posts WM_CLOSE where a console/window exists, letting the
  # runtime flush sessions and cancel Executor Sessions as the POSIX peer's SIGINT does). A headless detached node has no
  # window, so CloseMainWindow returns false and there is nothing to close; we then wait the graceful window and, only as a
  # last resort, force-terminate — the one shutdown Windows offers for a process with no console. Either way we verify the
  # result below and never report success while the service survives.
  foreach ($proc in $procs) {
    Write-Host "Stopping pid $($proc.Id) ..."
    try {
      $p = Get-Process -Id $proc.Id -ErrorAction Stop
      [void]$p.CloseMainWindow()
    } catch { Write-Host "  could not signal $($proc.Id): $_" -ForegroundColor Yellow }
  }
  $gracefulDeadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $gracefulDeadline -and @(Get-SuperagentProcesses).Count -gt 0) { Start-Sleep -Milliseconds 250 }
  foreach ($proc in @(Get-SuperagentProcesses)) {
    Write-Host "  pid $($proc.Id) did not stop gracefully; terminating." -ForegroundColor Yellow
    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { Write-Host "  could not stop $($proc.Id): $_" -ForegroundColor Red; $failed = $true }
  }
  # Wait for the port to free.
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and (Test-PortListening)) { Start-Sleep -Milliseconds 500 }
  # A kill may have failed (access denied, protected/elevated process) or a process may still be shutting down and holding
  # the port. In that case the service is still up: keep the PID file and the live instance's lock, and fail, rather than
  # deleting the lock of a running instance (which makes proper-lockfile's onCompromised abort it) and falsely reporting success.
  $survivors = @(Get-SuperagentProcesses)
  $portBusy = Test-PortListening
  if ($failed -or $survivors.Count -gt 0 -or $portBusy) {
    Write-Host "Stop did not finish: $(if ($failed) {'a process could not be killed; '})$($survivors.Count) still match$(if ($portBusy) {', port still listening'}). Kept the PID file and lock." -ForegroundColor Red
    return 1
  }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  # Clear the lock a hard kill may leave behind (only now that nothing serves the profile).
  $lock = "$StateDir.lock"
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
