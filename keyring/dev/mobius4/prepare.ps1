param(
  [Parameter(Mandatory = $true)][string]$Mobius4Root,
  [switch]$Start
)
$ErrorActionPreference = 'Stop'
$expectedRevision = 'e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8'
$sourceRoot = (Resolve-Path -LiteralPath $Mobius4Root).Path
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'Dockerfile'))) { throw 'Mobius4 Dockerfile missing.' }
$sourceRevision = (git -C $sourceRoot rev-parse HEAD).Trim()
if ($sourceRevision -ne $expectedRevision) { throw 'Upstream revision changed; review it before changing this pinned profile.' }
$stateRoot = Join-Path $PSScriptRoot '.local'
$environmentPath = Join-Path $stateRoot 'compose.env'
if (Test-Path -LiteralPath $environmentPath) { throw 'Local profile exists; use start.ps1. Existing secrets are preserved.' }
New-Item -ItemType Directory -Path (Join-Path $stateRoot 'tls') -Force | Out-Null
function New-LocalSecret {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToHexString($bytes).ToLowerInvariant()
}
$databaseSecret = New-LocalSecret
$adminIdentity = 'S' + (New-LocalSecret).Substring(0,24) # Mobius4 AE-ID storage is varchar(30).
$sourceForCompose = $sourceRoot.Replace('\', '/')
@"
MOBIUS4_ROOT=$sourceForCompose
DB_PW=$databaseSecret
CSE_ADMIN=$adminIdentity
KEYRING_CSE_TLS_PORT=8759
KEYRING_MQTT_TLS_PORT=8883
"@ | Set-Content -LiteralPath $environmentPath -Encoding utf8NoBOM
@"
user keyring-dev-gateway
topic write /oneM2M/req/$adminIdentity/Mobius4/json
topic read /oneM2M/resp/$adminIdentity/Mobius4/json
topic write privacy-bubble/gateway/pi-keyring-local/telemetry
topic write privacy-bubble/gateway/pi-keyring-local/ack
topic read privacy-bubble/gateway/pi-keyring-local/command
"@ | Set-Content -LiteralPath (Join-Path $stateRoot 'mqtt.acl') -Encoding utf8NoBOM
$certificateImage = 'privacy-bubble-keyring-dev-certificates:local'
docker build -f (Join-Path $PSScriptRoot 'certificates.Dockerfile') -t $certificateImage $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Certificate tool image could not be built; existing profile state retained.' }
docker run --rm --mount "type=bind,source=$(Join-Path $stateRoot 'tls'),target=/output" $certificateImage
if ($LASTEXITCODE -ne 0) { throw 'Certificate provisioning failed; existing state retained for explicit recovery.' }
Write-Host 'Local Mobius4 profile prepared. No tests or device execution were performed.'
if ($Start) { & (Join-Path $PSScriptRoot 'start.ps1') }
