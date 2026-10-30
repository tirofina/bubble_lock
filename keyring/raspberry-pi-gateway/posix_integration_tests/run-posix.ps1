param(
    [Parameter(Mandatory = $true)][string]$Wheel,
    [Parameter(Mandatory = $true)][string]$LogFile,
    [string]$Image = 'privacy-bubble-keyring-posix-test:local'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$wheelPath = (Resolve-Path -LiteralPath $Wheel).Path
$wheelName = [IO.Path]::GetFileName($wheelPath)
if ($wheelName -notmatch '^privacy_bubble_gateway-(\d+\.\d+\.\d+)-py3-none-any\.whl$') {
    throw 'Expected the built privacy-bubble-gateway wheel'
}
$version = $Matches[1]
$gatewayPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$wheelDirectory = [IO.Path]::GetDirectoryName($wheelPath)
$logPath = [IO.Path]::GetFullPath($LogFile, $PWD.Path)
$metadataPath = $logPath + '.metadata.json'
if ((Test-Path -LiteralPath $logPath) -or (Test-Path -LiteralPath $metadataPath)) {
    throw 'Use a new log path; previous evidence is never overwritten'
}
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($logPath)) -PathType Container)) {
    throw 'Log parent must already exist'
}
if ($gatewayPath.Contains(',') -or $wheelDirectory.Contains(',')) {
    throw 'Docker bind paths cannot contain commas'
}
$imageId = (& docker image inspect $Image --format '{{.Id}}')
if ($LASTEXITCODE -or $imageId -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'Build the dedicated POSIX test image first; this runner never pulls images'
}
$token = [guid]::NewGuid().ToString('N')
$containerName = 'keyring-posix-test-' + $token
$taskScript = @'
set -eu
python3 -c 'import json,os,platform,sqlite3; print("POSIX_RUNTIME "+json.dumps({"suite":"source","uid":os.getuid(),"python":platform.python_version(),"machine":platform.machine(),"sqlite":sqlite3.sqlite_version}),flush=True)'
python3 -m unittest discover -s /work/posix_integration_tests -v
python3 -m pip install --no-cache-dir --no-index --no-deps --disable-pip-version-check --target /tmp/gateway-installed "$KEYRING_TEST_WHEEL"
export PYTHONPATH=/tmp/gateway-installed:/work/tests
export KEYRING_TEST_STATE_CLI=/tmp/gateway-installed/bin/bubble-gateway-state
python3 -c 'import bubble_gateway,json,os,pathlib; p=pathlib.Path(bubble_gateway.__file__).parent; assert bubble_gateway.__version__==os.environ["KEYRING_TEST_EXPECTED_VERSION"] and str(p)=="/tmp/gateway-installed/bubble_gateway"; files=list(pathlib.Path("/work/src/bubble_gateway").glob("*.py")); normalized=lambda q:q.read_bytes().replace(b"\r\n",b"\n"); assert all(normalized(q)==normalized(p/q.name) for q in files); print("POSIX_RUNTIME "+json.dumps({"suite":"installed","version":bubble_gateway.__version__,"importPath":str(p),"matchedModules":sorted(q.name for q in files)}),flush=True)'
python3 -m unittest discover -s /work/posix_integration_tests -v
'@
$runCode = 1
try {
    & docker run --rm --pull never --name $containerName --label "privacy-bubble.posix-test-token=$token" `
        --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true `
        --user 65532:65532 --memory 256m --pids-limit 64 `
        --tmpfs '/tmp:rw,size=128m,mode=1777' --tmpfs '/limited:rw,size=256k,mode=1777' `
        --mount "type=bind,source=$gatewayPath,target=/work,readonly" `
        --mount "type=bind,source=$wheelDirectory,target=/wheel,readonly" `
        -e 'PYTHONPATH=/work/src:/work/tests' -e 'KEYRING_TEST_SMALL_FS=/limited' `
        -e "KEYRING_TEST_WHEEL=/wheel/$wheelName" -e "KEYRING_TEST_EXPECTED_VERSION=$version" `
        --entrypoint /bin/sh $imageId -c $taskScript *> $logPath
    $runCode = $LASTEXITCODE
}
finally {
    # --rm normally removes it. An interrupted foreground invocation may leave
    # it running: remove only the exact name whose ownership token matches.
    $remaining = @(& docker ps -aq --filter "name=^/$containerName`$")
    if ($LASTEXITCODE) { throw 'Cannot inspect this test container; no cleanup attempted' }
    foreach ($id in $remaining) {
        if (-not $id) { continue }
        $owner = (& docker container inspect $id --format '{{index .Config.Labels "privacy-bubble.posix-test-token"}}')
        if ($LASTEXITCODE -or $owner -ne $token) { throw 'Test container ownership mismatch; refusing cleanup' }
        & docker rm --force $id | Out-Null
        if ($LASTEXITCODE) { throw 'Owned test container cleanup failed' }
    }
    [ordered]@{
        imageId = $imageId; imageTag = $Image; containerName = $containerName; ownershipToken = $token
        network = 'none'; user = '65532:65532'; readOnlyRoot = $true
        sourceBindReadOnly = $true; wheelBindReadOnly = $true; existingDatabaseMounted = $false
        wheelName = $wheelName; wheelSha256 = (Get-FileHash -LiteralPath $wheelPath -Algorithm SHA256).Hash.ToLowerInvariant()
        exitCode = $runCode; finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8
}
Get-Content -LiteralPath $logPath -Tail 7
exit $runCode
