$ErrorActionPreference = 'Stop'
$project = 'privacy-bubble-keyring-receipt-dev'
$migrations = @(
  (Join-Path $PSScriptRoot '../.local/scoped/command-api/team-source/pc-mobius/db/migrations/001_core_receipts.sql'),
  (Join-Path $PSScriptRoot '../../../integration-candidate/sql/001_command_receipt_settlement.sql'),
  (Join-Path $PSScriptRoot '../../../integration-candidate/sql/002_receipt_notification_inbox.sql')
)
$sql = ($migrations | ForEach-Object { Get-Content -Raw -Encoding utf8 -LiteralPath $_ }) -join "`n"
$privateRoot = Join-Path $PSScriptRoot '.local'
$passwordPath = Join-Path $privateRoot 'database-password'
if (-not (Test-Path -LiteralPath $passwordPath -PathType Leaf)) {
  $volumes = docker volume ls --format '{{.Name}}'
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect local Docker volumes.' }
  if ($volumes -contains "${project}_receipt_pgdata") { throw 'Restore the password for the existing isolated database.' }
  New-Item -ItemType Directory -Path $privateRoot -Force | Out-Null
  $password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
  $stream = [IO.File]::Open($passwordPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write([Text.Encoding]::ASCII.GetBytes($password)) } finally { $stream.Dispose() }
}
$compose = @('--project-name', $project, '-f', (Join-Path $PSScriptRoot 'compose.yaml'))
docker compose @compose up -d --no-build --pull never --wait --wait-timeout 90 postgres
if ($LASTEXITCODE -ne 0) { throw 'Isolated receipt database preparation stopped.' }
$sql | docker compose @compose exec -T postgres psql -X -v ON_ERROR_STOP=1 --single-transaction `
  -U keyring_receipt_dev -d keyring_receipt_dev -f -
if ($LASTEXITCODE -ne 0) { throw 'Isolated receipt database schema transaction failed.' }
