param([switch]$RefreshIngress)

$ErrorActionPreference = 'Stop'
$environmentPath = Join-Path $PSScriptRoot '.local/scoped/compose.env'
if (-not (Test-Path -LiteralPath $environmentPath)) { throw 'Run prepare-scoped.ps1 first.' }
foreach ($key in @('MOBIUS4_ROOT', 'SCOPED_TEAM_STORE', 'DB_PW', 'CSE_ADMIN', 'KEYRING_CSE_TLS_PORT', 'KEYRING_MQTT_TLS_PORT')) {
  if (Test-Path -LiteralPath "Env:$key") { throw "Remove the inherited $key override for this scoped command." }
}
$compose = @('--project-name', 'privacy-bubble-keyring-scoped', '--env-file', $environmentPath,
  '-f', (Join-Path $PSScriptRoot 'compose.yaml'), '-f', (Join-Path $PSScriptRoot 'compose.scoped.yaml'))
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
  Write-Host 'Scoped broker and consumer refresh requested.'
  exit 0
}
docker compose @compose up -d --no-build --pull never --wait --wait-timeout 120 postgres broker mobius4 tls
if ($LASTEXITCODE -ne 0) { throw 'Scoped Mobius4 startup failed.' }
node (Join-Path $PSScriptRoot 'bootstrap.mjs') --scoped
if ($LASTEXITCODE -ne 0) { throw 'Scoped CSE resource provisioning stopped before the consumer was started.' }
docker compose @compose up -d --no-build --pull never --no-deps scoped-consumer
if ($LASTEXITCODE -ne 0) { throw 'Scoped consumer startup failed.' }
Write-Host 'Scoped resources provisioned and consumer start requested.'
