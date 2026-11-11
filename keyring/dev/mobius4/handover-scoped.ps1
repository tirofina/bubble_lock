param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Transition')]
  [ValidateSet('Forward', 'Rollback')][string]$Direction,
  [Parameter(Mandatory = $true, ParameterSetName = 'Status')][switch]$Status
)

$ErrorActionPreference = 'Stop'
$configRoot = Join-Path $PSScriptRoot '.local/scoped/config'
if (-not (Test-Path -LiteralPath $configRoot -PathType Container)) { throw 'The scoped profile has not been prepared.' }
$container = docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}|{{.State.Running}}|{{.Id}}|{{.State.StartedAt}}' privacy-bubble-keyring-scoped-consumer
if ($LASTEXITCODE -ne 0 -or $container -cnotmatch '^privacy-bubble-keyring-scoped\|true\|([a-f0-9]{64})\|([^|]+)$') {
  throw 'The scoped consumer is not running.'
}
$consumerId, $startedAt = $Matches[1], $Matches[2]
$ready = docker logs --since $startedAt $consumerId 2>&1 | Select-String -SimpleMatch 'SCOPED_SUBSCRIBED receipts=1 handover=1'
if ($LASTEXITCODE -ne 0 -or -not $ready) { throw 'The running scoped consumer has not reported handover readiness.' }

if ($Status) {
  docker exec $consumerId node -e 'const s=JSON.parse(require("node:fs").readFileSync("/var/lib/mobius4/scoped-cursor.json")); const r="/Mobius/privacy-bubble-test-ae/bubbleState"; const o=s.coreTelemetryOwners?.[r]; if(!o) process.exit(1); console.log(JSON.stringify({owner:o,cursorPhase:s.coreTelemetryCursors?.[r]?.phase??"EMPTY"}));'
  if ($LASTEXITCODE -ne 0) { throw 'Could not read the persisted scoped owner.' }
  return
}

$requestId = [Guid]::NewGuid().ToString('N')
$staged = Join-Path $configRoot "handover-$requestId.tmp"
$requestPath = Join-Path $configRoot 'handover-request.json'
$operatorLock = [IO.File]::Open((Join-Path $configRoot 'handover.lock'),
  [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  @{requestId=$requestId; direction=$Direction} | ConvertTo-Json -Compress |
    Set-Content -LiteralPath $staged -Encoding utf8NoBOM
  [IO.File]::Move($staged, $requestPath, $true)
  docker kill --signal=USR2 $consumerId | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not submit the scoped owner transition.' }

  $timer = [Diagnostics.Stopwatch]::StartNew()
  $pattern = "^SCOPED_HANDOVER $requestId ([A-Z_]+)$"
  while ($timer.Elapsed.TotalSeconds -lt 60) {
    $result = docker logs --since $startedAt $consumerId 2>&1 |
      Select-String -CaseSensitive -Pattern $pattern | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { throw "Transition result unavailable ($requestId). Read the persisted owner with -Status." }
    if ($result) {
      $outcome = $result.Matches[0].Groups[1].Value
      if ($outcome -ne 'OWNER_SWITCHED') { throw "Transition $requestId returned $outcome. Read the persisted owner with -Status." }
      Write-Host "Scoped owner transition committed ($requestId)."
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Transition $requestId is still unconfirmed. Read the persisted owner with -Status."
} finally {
  try {
    if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged }
  } finally {
    $operatorLock.Dispose()
  }
}
