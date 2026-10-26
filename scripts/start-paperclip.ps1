# Start Paperclip, logging to the instance's server log. Windows has no Paperclip service ("paperclipai service" is
# not supported on win32), so this runs at logon from the Startup folder, or by hand. With no window at all:
#   conhost.exe --headless pwsh.exe -NoLogo -ExecutionPolicy Bypass -File start-paperclip.ps1
# Stop it with stop-paperclip.ps1. Started from Windows (Explorer, the Startup folder), Paperclip outlives Claude
# Desktop; started from inside a Claude session, it stops when Desktop quits (2026-10-14, 7:01 PM).
#
# A shutdown from the Start menu ends Paperclip and its database without a clean stop, and can leave the database's
# lock (db\postmaster.pid) behind. After the next boot the process number in it can belong to another program, and
# Paperclip then refuses its own database ("Refusing to reuse PostgreSQL: its data directory belongs to another
# instance", 2026-10-26 9:23 AM, after the 1:07 AM shutdown). So when no Paperclip database is running and the lock
# names no database process, the lock is set aside before the start (renamed postmaster.pid.stale-<date-time>, never
# deleted) and one log line says so. A running database keeps its lock (Paperclip reuses that database), and a
# Paperclip that is running but not answering yet is never started a second time (Benny, 2026-10-26, CAR-598: "Fix.").
#
# The parameters are for tests; the Startup shortcut passes none.
param(
  [string]$Instance = (Join-Path $env:USERPROFILE '.paperclip\instances\default'),
  [string]$Health = 'http://127.0.0.1:3100/api/health',
  [string]$ServerMatch = 'paperclipai[\\/]dist[\\/]index\.js"?\s+run',   # as stop-paperclip.ps1 finds the server
  [string]$DatabaseMatch = '@embedded-postgres[\\/].*postgres\.exe',     # Paperclip's embedded PostgreSQL
  [string]$RunScript = ''                                                # a stand-in for "paperclipai run"
)

try { Invoke-RestMethod $Health -TimeoutSec 3 | Out-Null; Write-Host 'Paperclip is already running.'; exit 0 } catch { }
$log = Join-Path $Instance 'logs\paperclip-server.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Note([string]$line) {
  $stamped = "[start-paperclip $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $line"
  Write-Host $stamped
  Add-Content -LiteralPath $log -Value $stamped
}

# Every process but this script's own runs (their command lines carry the patterns above when a test passes them).
$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -notmatch 'start-paperclip\.ps1' })

$server = @($procs | Where-Object { $_.CommandLine -match $ServerMatch })
if ($server.Count) {
  Note "Paperclip is running (process $($server[0].ProcessId)) but does not answer yet: not starting a second one. If it stays silent, stop it with stop-paperclip.ps1 and start it again."
  exit 0
}

$lock = Join-Path $Instance 'db\postmaster.pid'
if (Test-Path -LiteralPath $lock) {
  $lockPid = 0
  [void][int]::TryParse("$(Get-Content -LiteralPath $lock -TotalCount 1)".Trim(), [ref]$lockPid)
  $databases = @($procs | Where-Object { $_.CommandLine -match $DatabaseMatch })
  $owner = if ($lockPid -gt 0) { $procs | Where-Object { $_.ProcessId -eq $lockPid } | Select-Object -First 1 } else { $null }
  $ownerIsDatabase = $owner -and ($owner.Name -eq 'postgres.exe' -or $owner.CommandLine -match $DatabaseMatch)
  if ($databases.Count -or $ownerIsDatabase) {
    Note "A Paperclip database is running (process $(if ($ownerIsDatabase) { $lockPid } else { $databases[0].ProcessId })): its lock stays, and Paperclip reuses that database."
  } else {
    $aside = "postmaster.pid.stale-$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"
    $was = if ($owner) { "now $($owner.Name), not a database" } elseif ($lockPid -gt 0) { 'no longer running' } else { 'no process number' }
    try {
      Rename-Item -LiteralPath $lock -NewName $aside -ErrorAction Stop
      Note "Set aside a stale database lock: db\postmaster.pid named process $lockPid ($was), and no Paperclip database is running. Kept as db\$aside."
    } catch {
      Note "Could not set aside the stale database lock db\postmaster.pid: $($_.Exception.Message)"
    }
  }
}

try { $Host.UI.RawUI.WindowTitle = 'Paperclip' } catch { }
if ($RunScript) { & $RunScript *>&1 | Tee-Object -FilePath $log -Append }
else { paperclipai run *>&1 | Tee-Object -FilePath $log -Append }
