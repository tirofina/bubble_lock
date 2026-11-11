param(
  [switch]$PrepareOnly,
  [string]$OpenSslPath = 'C:/Program Files/Git/usr/bin/openssl.exe',
  [ValidateSet('legacy', 'integration')][string]$Mode = 'legacy'
)

$ErrorActionPreference = 'Stop'
$profileRoot = Join-Path $PSScriptRoot '.local/scoped'
$tlsRoot = Join-Path $profileRoot 'tls'
$Mode = $Mode.ToLowerInvariant()
$selection = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'scoped-command-profiles.json') | ConvertFrom-Json).$Mode
$apiRoot = Join-Path $profileRoot $selection.directory
$revision = $selection.revision
$revisionPath = Join-Path $apiRoot 'team-revision'
foreach ($name in @('ca.pem', 'server.pem', 'server.key', 'gateway-a.pem')) {
  if (-not (Test-Path -LiteralPath (Join-Path $tlsRoot $name) -PathType Leaf)) {
    throw 'Prepare the scoped Mobius4 profile first.'
  }
}

if (-not (Test-Path -LiteralPath $apiRoot)) {
  $openssl = (Get-Command $OpenSslPath -CommandType Application).Source
  $caKey = Join-Path $tlsRoot 'ca.key'
  if (-not (Test-Path -LiteralPath $caKey -PathType Leaf)) { throw 'The local scoped CA key is needed for operator enrollment.' }
  New-Item -ItemType Directory -Path $apiRoot | Out-Null
  $archive = Join-Path $apiRoot 'team-source.zip'
  $repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
  $sourcePaths = @('pc-mobius')
  if ($Mode -eq 'integration') { $sourcePaths += 'contracts/keyring' }
  git -C $repository archive --format=zip --output=$archive $revision @sourcePaths
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned team source.' }
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $apiRoot 'team-source')
  $operatorKey = Join-Path $apiRoot 'operator.key'
  $operatorRequest = Join-Path $apiRoot 'operator.csr'
  $operatorCertificate = Join-Path $apiRoot 'operator.pem'
  $extensions = Join-Path $apiRoot 'operator.ext'
  @('basicConstraints=critical,CA:FALSE', 'extendedKeyUsage=clientAuth') |
    Set-Content -LiteralPath $extensions -Encoding ascii
  & $openssl req -new -newkey rsa:2048 -nodes -keyout $operatorKey -out $operatorRequest -subj '/CN=scoped-command-operator'
  if ($LASTEXITCODE -ne 0) { throw 'Could not generate the scoped operator key and request.' }
  $serial = '0x' + [Guid]::NewGuid().ToString('N')
  & $openssl x509 -req -in $operatorRequest -CA (Join-Path $tlsRoot 'ca.pem') -CAkey $caKey `
    -set_serial $serial -days 7 -extfile $extensions -out $operatorCertificate
  if ($LASTEXITCODE -ne 0) { throw 'Could not issue the scoped operator certificate.' }
  Set-Content -LiteralPath $revisionPath -Value $revision -Encoding ascii
}

if (-not (Test-Path -LiteralPath $revisionPath) -or (Get-Content -LiteralPath $revisionPath) -ne $revision) {
  throw 'The existing command API folder has an incomplete or different team source. Keep it for recovery.'
}
if ($PrepareOnly) {
  Write-Output "SCOPED_COMMAND_API_PREPARED $Mode $revision"
  return
}
if ($Mode -eq 'integration') {
  $modules = Join-Path $apiRoot 'team-source/pc-mobius/node_modules'
  foreach ($name in @('ajv', 'ajv-formats', 'pg', 'mqtt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $modules $name) -PathType Container)) {
      throw 'Install the pinned team package dependencies in command-api-integration/team-source/pc-mobius before starting.'
    }
  }
}
node (Join-Path $PSScriptRoot 'scoped-command-api.mjs') $Mode
if ($LASTEXITCODE -ne 0) { throw 'Scoped command API exited with an error.' }
