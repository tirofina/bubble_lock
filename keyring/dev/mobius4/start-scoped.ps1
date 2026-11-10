param([switch]$RefreshIngress)

$ErrorActionPreference = 'Stop'
$environmentPath = Join-Path $PSScriptRoot '.local/scoped/compose.env'
if (-not (Test-Path -LiteralPath $environmentPath)) { throw 'Run prepare-scoped.ps1 first.' }
foreach ($key in @('MOBIUS4_ROOT', 'SCOPED_TEAM_STORE', 'DB_PW', 'CSE_ADMIN', 'KEYRING_CSE_TLS_PORT', 'KEYRING_MQTT_TLS_PORT')) {
  if (Test-Path -LiteralPath "Env:$key") { throw "Remove the inherited $key override for this scoped command." }
}
$compose = @('--project-name', 'privacy-bubble-keyring-scoped', '--env-file', $environmentPath,
  '-f', (Join-Path $PSScriptRoot 'compose.yaml'), '-f', (Join-Path $PSScriptRoot 'compose.scoped.yaml'))

function Wait-ScopedSubscription {
  $consumerId = docker compose @compose ps --all --quiet scoped-consumer
  if ($LASTEXITCODE -ne 0 -or -not $consumerId) { throw 'Could not identify the scoped consumer after start.' }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($timer.Elapsed.TotalSeconds -lt 30) {
    $state = docker inspect --format '{{.State.Status}}|{{.State.StartedAt}}' $consumerId
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect scoped consumer state.' }
    $status, $startedAt = $state -split '\|', 2
    if ($status -in @('exited', 'dead')) { throw 'Scoped consumer exited before subscribing. Inspect its logs.' }
    if ($status -eq 'running') {
      $ready = docker logs --since $startedAt --tail 80 $consumerId 2>&1 |
        Select-String -CaseSensitive -Pattern '^SCOPED_SUBSCRIBED receipts=1 handover=1$'
      if ($LASTEXITCODE -ne 0) { throw 'Could not read scoped consumer startup logs.' }
      if ($ready) {
        Write-Host 'Scoped consumer subscribed with receipts and handover enabled.'
        return
      }
    }
    Start-Sleep -Milliseconds 500
  }
  throw 'Scoped consumer readiness is unconfirmed. Inspect the running instance before retrying.'
}

$operatorLock = [IO.File]::Open((Join-Path $PSScriptRoot '.local/scoped/config/handover.lock'),
  [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  if ($RefreshIngress) {
    $running = docker compose @compose ps --status running --services
    if ($LASTEXITCODE -ne 0) { throw 'Could not read scoped service state.' }
    foreach ($service in @('postgres', 'mobius4', 'tls', 'broker', 'scoped-consumer')) {
      if ($running -notcontains $service) { throw "Start the scoped profile before refreshing ingress ($service is down)." }
    }
    $consumer = docker compose @compose ps --quiet scoped-consumer
    if ($LASTEXITCODE -ne 0 -or -not $consumer) { throw 'Could not identify the scoped consumer.' }
    docker compose @compose stop --timeout 35 scoped-consumer
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the scoped consumer; broker refresh was withheld.' }
    $exitCode = docker inspect --format '{{.State.ExitCode}}' $consumer
    if ($LASTEXITCODE -ne 0 -or $exitCode -ne '0') {
      throw 'Scoped consumer did not exit cleanly. Review its cursor before resuming ingress.'
    }
    docker compose @compose up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 30 broker
    if ($LASTEXITCODE -ne 0) { throw 'Scoped broker refresh failed; the consumer remains stopped.' }
    docker compose @compose up -d --no-deps --no-build --pull never --force-recreate scoped-consumer
    if ($LASTEXITCODE -ne 0) { throw 'Scoped consumer refresh failed.' }
    Wait-ScopedSubscription
    return
  }
  docker compose @compose up -d --no-build --pull never --wait --wait-timeout 120 postgres broker mobius4 tls
  if ($LASTEXITCODE -ne 0) { throw 'Scoped Mobius4 startup failed.' }
  node (Join-Path $PSScriptRoot 'bootstrap.mjs') --scoped
  if ($LASTEXITCODE -ne 0) { throw 'Scoped CSE resource provisioning stopped before the consumer was started.' }
  docker compose @compose up -d --no-build --pull never --no-deps scoped-consumer
  if ($LASTEXITCODE -ne 0) { throw 'Scoped consumer startup failed.' }
  Wait-ScopedSubscription
} finally {
  $operatorLock.Dispose()
}
