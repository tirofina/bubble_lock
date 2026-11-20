# Starts the self-hosted dashboard for LAN access: BFF on 127.0.0.1:4174 with local password accounts,
# and Vite on 0.0.0.0:5173 proxying /api and /events to the BFF. Firewall settings are left unchanged.
# Accounts: node web-dashboard/scripts/add-local-account.mjs <username> <guardian|operator> --password <pw>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$web = Join-Path $repo 'web-dashboard'
$accounts = Join-Path $repo '.local\portal-accounts.json'
if (-not (Test-Path $accounts)) { throw "Accounts file not found: $accounts. Create accounts with web-dashboard/scripts/add-local-account.mjs first." }

$bff = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'serve:local' -WorkingDirectory $web -PassThru -NoNewWindow
$vite = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev:lan' -WorkingDirectory $web -PassThru -NoNewWindow

$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -ExpandProperty IPAddress
Write-Host ''
Write-Host 'BubbleLock dashboard'
Write-Host '  This PC:  http://127.0.0.1:5173/'
foreach ($ip in $ips) { Write-Host "  LAN:      http://${ip}:5173/" }
Write-Host '  Guardian: #/user/overview   Operator: #/operator/overview'
Write-Host 'Press Ctrl+C to stop both processes.'
try {
  Wait-Process -Id $bff.Id, $vite.Id
} finally {
  foreach ($process in @($bff, $vite)) {
    if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
  }
}
