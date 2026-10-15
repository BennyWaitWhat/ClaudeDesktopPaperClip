# Start Paperclip, logging to the instance's server log. Windows has no Paperclip service ("paperclipai service" is
# not supported on win32), so this runs at logon from the Startup folder, or by hand. With no window at all:
#   conhost.exe --headless pwsh.exe -NoLogo -ExecutionPolicy Bypass -File start-paperclip.ps1
# Stop it with stop-paperclip.ps1. Started from Windows (Explorer, the Startup folder), Paperclip outlives Claude
# Desktop; started from inside a Claude session, it stops when Desktop quits (2026-10-14, 7:01 PM).
$health = 'http://127.0.0.1:3100/api/health'
try { Invoke-RestMethod $health -TimeoutSec 3 | Out-Null; Write-Host 'Paperclip is already running.'; exit 0 } catch { }
$log = Join-Path $env:USERPROFILE '.paperclip\instances\default\logs\paperclip-server.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$Host.UI.RawUI.WindowTitle = 'Paperclip'
paperclipai run *>&1 | Tee-Object -FilePath $log -Append
