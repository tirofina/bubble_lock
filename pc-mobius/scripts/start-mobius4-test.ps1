param(
  [string]$Mobius4Root = $env:MOBIUS4_ROOT,
  [int]$Port = 7599,
  [string]$AdminIdentity = $(if ($env:MOBIUS4_ADMIN_IDENTITY) { $env:MOBIUS4_ADMIN_IDENTITY } else { 'pb-core-admin-local' }),
  [ValidateSet('docker', 'source')]
  [string]$Mode = 'docker'
)

if ([string]::IsNullOrWhiteSpace($Mobius4Root)) {
  throw 'MOBIUS4_ROOT points to the Mobius4 source directory.'
}

$resolvedRoot = (Resolve-Path $Mobius4Root).Path
$env:CSE_POA = "http://127.0.0.1:$Port"
$env:CSE_ADMIN = $AdminIdentity
Write-Host "Mobius4 admin identity: $AdminIdentity"
Push-Location $resolvedRoot
try {
  if ($Mode -eq 'docker') {
    $env:HTTP_PUBLISH_PORT = [string]$Port
    Write-Host "Starting Mobius4 Docker Compose profile from $resolvedRoot on port $Port"
    docker compose up --build
  }
  else {
    $env:NODE_CONFIG = (@{
      http = @{ port = $Port }
      cse = @{ poa = @($env:CSE_POA); admin = $AdminIdentity }
    } | ConvertTo-Json -Compress)
    Write-Host "Starting Mobius4 source profile from $resolvedRoot on port $Port"
    npm run start
  }
}
finally {
  Pop-Location
}
