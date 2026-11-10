param(
  [Parameter(Mandatory = $true)][string]$Mobius4Root,
  [Parameter(Mandatory = $true)][string]$TeamCoreRoot
)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $Mobius4Root).Path
$sourceRevision = (git -C $sourceRoot rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $sourceRevision -ne 'e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8') {
  throw 'Expected the pinned Mobius4 checkout.'
}
$store = Get-Item -LiteralPath (Join-Path $TeamCoreRoot 'pc-mobius/integration/src/integration-store.mjs')
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $store.FullName).Hash -ne
    '859471001F5BCF4770BDF01C7DAC4C221D2AE03BD487CA895DF29FC3CB73F2CF') {
  throw 'Expected the team IntegrationStore from main 715ef58.'
}
$stateRoot = Join-Path $PSScriptRoot '.local/scoped'
if (Test-Path -LiteralPath $stateRoot) { throw 'Scoped profile exists; keep its current state and use start-scoped.ps1.' }
New-Item -ItemType Directory -Path $stateRoot | Out-Null
$tlsDir = New-Item -ItemType Directory -Path (Join-Path $stateRoot 'tls')
$configDir = New-Item -ItemType Directory -Path (Join-Path $stateRoot 'config')
New-Item -ItemType Directory -Path (Join-Path $stateRoot 'receipt-routes') | Out-Null
@{gatewayId='gw-a'; deviceId='kr-handover'; ownershipEpoch=7} | ConvertTo-Json -Compress |
  Set-Content -LiteralPath (Join-Path $configDir.FullName 'owner.json') -Encoding utf8NoBOM
$issuer = Join-Path $PSScriptRoot 'scoped-telemetry/generate-certificates.sh'
docker run --rm --pull never --network none --entrypoint /bin/sh `
  --mount "type=bind,source=$issuer,target=/issue.sh,readonly" `
  --mount "type=bind,source=$($tlsDir.FullName),target=/output" `
  privacy-bubble-keyring-dev-certificates:local /issue.sh
if ($LASTEXITCODE -ne 0) { throw 'Scoped certificate provisioning stopped; its partial files were retained.' }
$sourceForCompose = $sourceRoot.Replace('\', '/')
$storeForCompose = $store.FullName.Replace('\', '/')
$databasePassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
$originator = 'S' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(12)).ToLowerInvariant()
@"
MOBIUS4_ROOT=$sourceForCompose
SCOPED_TEAM_STORE=$storeForCompose
DB_PW=$databasePassword
CSE_ADMIN=$originator
KEYRING_CSE_TLS_PORT=8760
KEYRING_MQTT_TLS_PORT=8884
"@ | Set-Content -LiteralPath (Join-Path $stateRoot 'compose.env') -Encoding utf8NoBOM
Write-Host 'Scoped profile and TLS files prepared.'
