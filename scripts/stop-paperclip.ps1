# Stop Paperclip cleanly: Ctrl+C to its console, as closing its window would, so it and its database shut down
# themselves. Works whether it runs in a window or hidden (start-paperclip.ps1). Nothing to do when it is not running.
param([uint32]$SendCtrlCTo)

if ($SendCtrlCTo) {
  # The helper half, run as its own process: join Paperclip's console, ignore the Ctrl+C here, send it, leave.
  Add-Type -Name Console -Namespace Win32 -MemberDefinition @"
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);
"@
  [Win32.Console]::FreeConsole() | Out-Null
  if (-not [Win32.Console]::AttachConsole($SendCtrlCTo)) { exit 2 }
  [Win32.Console]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null
  [Win32.Console]::GenerateConsoleCtrlEvent(0, 0) | Out-Null
  Start-Sleep -Milliseconds 500
  [Win32.Console]::FreeConsole() | Out-Null
  exit 0
}

$server = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'paperclipai[\\/]dist[\\/]index\.js"?\s+run' }
if (-not $server) { Write-Host 'Paperclip is not running.'; exit 0 }
$pids = @($server.ProcessId)
foreach ($id in $pids) {
  $p = Start-Process pwsh -ArgumentList '-NoLogo', '-NoProfile', '-File', "`"$PSCommandPath`"", '-SendCtrlCTo', $id -WindowStyle Hidden -PassThru -Wait
  if ($p.ExitCode -ne 0) { Write-Host "Could not reach Paperclip's console (process $id)." }
}

# Paperclip and its database close within seconds; give them a minute.
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and (Get-Process -Id $pids -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 1 }
if (Get-Process -Id $pids -ErrorAction SilentlyContinue) { Write-Host 'Paperclip is still shutting down after a minute.'; exit 1 }
$left = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object { $_.CommandLine -match 'embedded-postgres' })
Write-Host "Paperclip stopped.$(if ($left.Count) { " $($left.Count) of its database processes are still closing." })"
