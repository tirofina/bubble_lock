$ErrorActionPreference = 'Stop'
$environmentPath = Join-Path $PSScriptRoot '.local/compose.env'
if (-not (Test-Path -LiteralPath $environmentPath)) { throw 'Run prepare.ps1 with the external Mobius4 path first.' }
foreach ($certificate in @('ca.pem', 'server.pem', 'server.key', 'client.pem', 'client.key')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".local/tls/$certificate"))) {
    throw 'Certificate provisioning is incomplete. Existing partial state must be recovered without silent key replacement.'
  }
}
docker compose --env-file $environmentPath -f (Join-Path $PSScriptRoot 'compose.yaml') up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Mobius4 provisioning did not complete. Do not report the server as ready.' }
Write-Host 'Compose startup requested. Runtime readiness and integration tests are separate evidence.'
