param(
  [switch]$PrepareOnly,
  [switch]$EnableLocationTrial,
  [string]$OpenSslPath = 'C:/Program Files/Git/usr/bin/openssl.exe',
  [ValidateSet('legacy', 'integration', 'r18')][string]$Mode = 'legacy',
  [string]$FirmwareRevision
)

$ErrorActionPreference = 'Stop'
$profileRoot = Join-Path $PSScriptRoot '.local/scoped'
$tlsRoot = Join-Path $profileRoot 'tls'
$Mode = $Mode.ToLowerInvariant()
if ($EnableLocationTrial -and $Mode -ne 'r18') {
  throw 'EnableLocationTrial requires the r18 loopback profile.'
}
$selection = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'scoped-command-profiles.json') | ConvertFrom-Json).$Mode
$selectFirmware = $PSBoundParameters.ContainsKey('FirmwareRevision')
if ($selectFirmware -and ($Mode -ne 'r18' -or
    $FirmwareRevision -cnotin (@($selection.firmwareRevision) + @($selection.alternateFirmwareRevisions)))) {
  throw 'FirmwareRevision must be a supported r18 command firmware.'
}
$apiRoot = Join-Path $profileRoot $selection.directory
$revision = $selection.revision
$revisionPath = Join-Path $apiRoot 'team-revision'
$gatewayCert = if ($Mode -eq 'r18') { 'gateway-b.pem' } else { 'gateway-a.pem' }
$operatorSubject = if ($Mode -eq 'r18') { '/CN=scoped-command-operator-r18' } else { '/CN=scoped-command-operator' }
foreach ($name in @('ca.pem', 'server.pem', 'server.key', $gatewayCert)) {
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
  if ($Mode -ne 'legacy') { $sourcePaths += 'contracts/keyring' }
  git -C $repository archive --format=zip --output=$archive $revision @sourcePaths
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned team source.' }
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $apiRoot 'team-source')
  $operatorKey = Join-Path $apiRoot 'operator.key'
  $operatorRequest = Join-Path $apiRoot 'operator.csr'
  $operatorCertificate = Join-Path $apiRoot 'operator.pem'
  $extensions = Join-Path $apiRoot 'operator.ext'
  @('basicConstraints=critical,CA:FALSE', 'extendedKeyUsage=clientAuth') |
    Set-Content -LiteralPath $extensions -Encoding ascii
  & $openssl req -new -newkey rsa:2048 -nodes -keyout $operatorKey -out $operatorRequest -subj $operatorSubject
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
if ($Mode -ne 'legacy') {
  $modules = Join-Path $apiRoot 'team-source/pc-mobius/node_modules'
  foreach ($name in @('ajv', 'ajv-formats', 'pg', 'mqtt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $modules $name) -PathType Container)) {
      throw "Install the pinned team package dependencies in $($selection.directory)/team-source/pc-mobius before starting."
    }
  }
}
$nodeArgs = @((Join-Path $PSScriptRoot 'scoped-command-api.mjs'), $Mode)
if ($EnableLocationTrial) { $nodeArgs += '--enable-location-trial' }
if ($selectFirmware) { $nodeArgs += "--firmware-revision=$FirmwareRevision" }
node @nodeArgs
if ($LASTEXITCODE -ne 0) { throw 'Scoped command API exited with an error.' }
