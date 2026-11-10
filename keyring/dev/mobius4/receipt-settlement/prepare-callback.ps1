param([string]$OpenSslPath = 'C:/Program Files/Git/usr/bin/openssl.exe')

$ErrorActionPreference = 'Stop'
$tlsRoot = Join-Path $PSScriptRoot '../.local/scoped/tls'
$peerRoot = Join-Path $PSScriptRoot '.local/callback-peer'
$relayCert = Join-Path $peerRoot 'relay.pem'
$relayKey = Join-Path $peerRoot 'relay.key'
if (Test-Path -LiteralPath $peerRoot) {
  if ((Test-Path -LiteralPath $relayCert -PathType Leaf) -and (Test-Path -LiteralPath $relayKey -PathType Leaf)) { return }
  throw 'A partial callback peer directory exists. Retain it before issuing another peer.'
}
$openssl = (Get-Command $OpenSslPath -CommandType Application).Source
$ca = Join-Path $tlsRoot 'ca.pem'
$caKey = Join-Path $tlsRoot 'ca.key'
if (-not (Test-Path -LiteralPath $ca -PathType Leaf) -or -not (Test-Path -LiteralPath $caKey -PathType Leaf)) {
  throw 'Prepare the scoped Mobius4 CA first.'
}
New-Item -ItemType Directory -Path $peerRoot | Out-Null
$request = Join-Path $peerRoot 'relay.csr'
$extensions = Join-Path $peerRoot 'relay.ext'
@('basicConstraints=critical,CA:FALSE', 'extendedKeyUsage=clientAuth') |
  Set-Content -LiteralPath $extensions -Encoding ascii
& $openssl req -new -newkey rsa:2048 -nodes -keyout $relayKey -out $request -subj '/CN=scoped-receipt-relay'
if ($LASTEXITCODE -ne 0) { throw 'Could not generate the scoped receipt relay key and request.' }
$serial = '0x' + [Guid]::NewGuid().ToString('N')
& $openssl x509 -req -in $request -CA $ca -CAkey $caKey -set_serial $serial -days 7 -extfile $extensions -out $relayCert
if ($LASTEXITCODE -ne 0) { throw 'Could not issue the scoped receipt relay certificate.' }
