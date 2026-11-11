param([switch]$FeatherObservationsOnly, [switch]$R18TelemetryOnly,
  [switch]$PinReceiptRoutes, [switch]$PinObservationRoute, [switch]$PinR18ObservationRoute)

$ErrorActionPreference = 'Stop'
$selectedOperations = @($FeatherObservationsOnly, $R18TelemetryOnly, $PinReceiptRoutes,
  $PinObservationRoute, $PinR18ObservationRoute) | Where-Object { $_.IsPresent }
if (@($selectedOperations).Count -gt 1) { throw 'Select one scoped operation.' }
$pinning = $PinReceiptRoutes -or $PinObservationRoute -or $PinR18ObservationRoute
$environmentPath = Join-Path $PSScriptRoot '.local/scoped/compose.env'
if (-not (Test-Path -LiteralPath $environmentPath)) { throw 'Run prepare-scoped.ps1 first.' }
foreach ($key in @('MOBIUS4_ROOT', 'SCOPED_TEAM_STORE', 'DB_PW', 'CSE_ADMIN', 'KEYRING_CSE_TLS_PORT', 'KEYRING_MQTT_TLS_PORT')) {
  if (Test-Path -LiteralPath "Env:$key") { throw "Remove the inherited $key override for this scoped command." }
}
$compose = @('--project-name', 'privacy-bubble-keyring-scoped', '--env-file', $environmentPath,
  '-f', (Join-Path $PSScriptRoot 'compose.yaml'), '-f', (Join-Path $PSScriptRoot 'compose.scoped.yaml'))
$operatorLock = [IO.File]::Open((Join-Path $PSScriptRoot '.local/scoped/config/handover.lock'),
  [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $running = docker compose @compose ps --status running --services
  if ($LASTEXITCODE -ne 0 -or $running -notcontains 'postgres' -or $running -notcontains 'mobius4') {
    throw 'Start the scoped database and CSE before preparing command resources.'
  }
  if ($pinning) {
    if ($running -notcontains 'tls') { throw 'Start the scoped TLS proxy before pinning existing routes.' }
    $pinScope = if ($PinObservationRoute) {
      '--scoped-pin-command-observation'
    } elseif ($PinR18ObservationRoute) {
      '--scoped-pin-r18-observation'
    } else {
      '--scoped-pin-command-receipts'
    }
    node (Join-Path $PSScriptRoot 'bootstrap.mjs') $pinScope
    if ($LASTEXITCODE -ne 0) { throw 'Scoped resource pinning stopped before TLS refresh.' }
  }
  docker compose @compose up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 30 tls
  if ($LASTEXITCODE -ne 0) { throw 'Scoped TLS route refresh failed.' }
  if ($pinning) { return }
  $scope = if ($FeatherObservationsOnly) {
    '--scoped-feather-command-observation'
  } elseif ($R18TelemetryOnly) {
    '--scoped-r18-telemetry'
  } else {
    '--scoped-command-receipts'
  }
  node (Join-Path $PSScriptRoot 'bootstrap.mjs') $scope
  if ($LASTEXITCODE -ne 0) { throw 'Scoped command resource provisioning stopped. Existing CSE data was retained.' }
} finally {
  $operatorLock.Dispose()
}
