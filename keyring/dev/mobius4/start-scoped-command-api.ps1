param(
  [switch]$PrepareOnly,
  [string]$OpenSslPath = 'C:/Program Files/Git/usr/bin/openssl.exe'
)

$ErrorActionPreference = 'Stop'
$profileRoot = Join-Path $PSScriptRoot '.local/scoped'
$tlsRoot = Join-Path $profileRoot 'tls'
$apiRoot = Join-Path $profileRoot 'command-api'
$revision = '715ef58df6c901480eb71fb3b9278e8df6547d93'
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
  git -C $repository archive --format=zip --output=$archive $revision pc-mobius
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
if ($PrepareOnly) { return }
node (Join-Path $PSScriptRoot 'scoped-command-api.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Scoped command API exited with an error.' }
