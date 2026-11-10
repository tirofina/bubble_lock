$ErrorActionPreference = 'Stop'
$environmentPath = Join-Path $PSScriptRoot '.local/scoped/compose.env'
if (-not (Test-Path -LiteralPath $environmentPath)) { throw 'Run prepare-scoped.ps1 first.' }
foreach ($key in @('MOBIUS4_ROOT', 'SCOPED_TEAM_STORE', 'DB_PW', 'CSE_ADMIN', 'KEYRING_CSE_TLS_PORT', 'KEYRING_MQTT_TLS_PORT')) {
  if (Test-Path -LiteralPath "Env:$key") { throw "Remove the inherited $key override for this scoped command." }
}
$compose = @('--project-name', 'privacy-bubble-keyring-scoped', '--env-file', $environmentPath,
  '-f', (Join-Path $PSScriptRoot 'compose.yaml'), '-f', (Join-Path $PSScriptRoot 'compose.scoped.yaml'))
docker compose @compose up -d --no-build --pull never --wait --wait-timeout 120 postgres broker mobius4 tls
if ($LASTEXITCODE -ne 0) { throw 'Scoped Mobius4 startup failed.' }
node (Join-Path $PSScriptRoot 'bootstrap.mjs') --scoped
if ($LASTEXITCODE -ne 0) { throw 'Scoped CSE resource provisioning stopped before the consumer was started.' }
docker compose @compose up -d --no-build --pull never --no-deps scoped-consumer
if ($LASTEXITCODE -ne 0) { throw 'Scoped consumer startup failed.' }
Write-Host 'Scoped resources provisioned and consumer start requested.'
