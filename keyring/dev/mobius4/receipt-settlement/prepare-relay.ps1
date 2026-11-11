param([switch]$RefreshRelay)

$ErrorActionPreference = 'Stop'
$devRoot = Split-Path -Parent $PSScriptRoot
$profile = Join-Path $devRoot '.local/scoped'
$environmentPath = Join-Path $profile 'compose.env'
foreach ($key in @('MOBIUS4_ROOT', 'SCOPED_TEAM_STORE', 'DB_PW', 'CSE_ADMIN', 'KEYRING_CSE_TLS_PORT', 'KEYRING_MQTT_TLS_PORT')) {
  if (Test-Path -LiteralPath "Env:$key") { throw "Remove the inherited $key override for this scoped command." }
}
if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.local/callback-peer/relay.key') -PathType Leaf)) {
  throw 'Prepare the scoped Mobius4 and callback peer first.'
}
$compose = @('--project-name', 'privacy-bubble-keyring-scoped', '--env-file', $environmentPath,
  '-f', (Join-Path $devRoot 'compose.yaml'), '-f', (Join-Path $devRoot 'compose.scoped.yaml'))
$operatorLock = [IO.File]::Open((Join-Path $profile 'config/handover.lock'),
  [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $running = docker compose @compose ps --status running --services
  if ($LASTEXITCODE -ne 0 -or $running -notcontains 'mobius4' -or $running -notcontains 'tls') {
    throw 'Start the scoped Mobius4 and TLS services first.'
  }
  $recreate = @()
  if ($RefreshRelay) { $recreate = @('--force-recreate') }
  docker compose @compose up -d --no-deps --no-build --pull never @recreate receipt-relay
  if ($LASTEXITCODE -ne 0) { throw 'Scoped receipt relay preparation stopped.' }
  $relay = docker compose @compose ps --all --quiet receipt-relay
  if ($LASTEXITCODE -ne 0 -or -not $relay) { throw 'Scoped receipt relay container was not found.' }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $status, $startedAt = (docker inspect --format '{{.State.Status}}|{{.State.StartedAt}}' $relay) -split '\|', 2
    if ($LASTEXITCODE -ne 0 -or $status -in @('exited', 'dead')) { throw 'Scoped receipt relay is not running.' }
    $ready = docker logs --since $startedAt --tail 10 $relay 2>&1 | Select-String -Pattern '^SCOPED_RECEIPT_RELAY_READY$'
    if ($ready) { break }
    Start-Sleep -Milliseconds 250
  } while ($timer.Elapsed.TotalSeconds -lt 15)
  if (-not $ready) { throw 'Scoped receipt relay TLS readiness is unconfirmed.' }
  node (Join-Path $PSScriptRoot 'register-subscriptions.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Receipt subscription provisioning stopped.' }
} finally {
  $operatorLock.Dispose()
}
