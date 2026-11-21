# 고정 upstream Mobius4 CSE

배포 CSE는 `upstream.json`에 고정한 Mobius4 4.25.0 revision
`e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`을 사용한다. 빌더는 GitHub archive의
SHA-256 `cd22adacf6800a1450c2c45033ba1f58079ef9104bd7f06b3c24fbcc994c8aa4`를 먼저 확인한다.

## 산출물

- `artifacts/mobius4-e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8-upstream.tar.gz`
- 아티팩트 SHA-256: `5fde2378568aeb11ae8366b69e7b9b029b31d229fc6b1e845127fc68d25ad56e`
- image: `bubblelock/mobius4:4.25.0-upstream`
- `artifacts/manifest.json`: upstream archive, release 아티팩트, lockfile, 의존성 patcher의 SHA-256 수록

`apply-mobius-dependencies.mjs`는 `package.json`과 `package-lock.json`의 의존성 버전만 교체한다.
`cse/`와 `docker/`의 소스·동작 파일은 upstream 바이트를 유지한다. 빌더는 교체 대상 두 파일의
원본 SHA-256과 결과 SHA-256을 확인하고 반복 적용 상태를 manifest에 기록한다.

`prepare-specialization.mjs`는 배포 설정인 binarySwitch XSD와 registry를 `config/`에 만든다.
아티팩트는 `node_modules`와 timestamp backup을 제외하고 정렬·고정 mtime·고정 소유자로 묶는다.

## 빌드

PowerShell:

```powershell
$env:RUN_TMP = Join-Path (Resolve-Path '.local') 'cse-artifact-build'
$env:npm_config_cache = Join-Path $env:RUN_TMP 'npm-cache'
node pc-mobius/scripts/build-mobius-artifact.mjs
docker build -f deployment/cse/Dockerfile -t bubblelock/mobius4:4.25.0-upstream .
```

Linux:

```sh
export RUN_TMP="$(mktemp -d /tmp/bubble-cse.XXXXXX)"
export npm_config_cache="$RUN_TMP/npm-cache"
node pc-mobius/scripts/build-mobius-artifact.mjs
docker build -f deployment/cse/Dockerfile -t bubblelock/mobius4:4.25.0-upstream .
```

## 구독 검증 설정

`local.json` 내용:

```json
{
  "cse": {
    "subscription_verification": true
  }
}
```

`deployment/compose.yaml`은 이 파일을 `/app/config/local.json:ro`에 마운트한다. Mobius4의
node-config가 기본 설정과 로컬 설정을 병합한다. AE 자원 ID를 `nu`로 쓰는 수신기는 verification
request의 `cr`을 등록 creator와 대조한다. URL `nu`는 upstream Mobius4의 직접 URL 경로로 전달된다.

## 실행 계약

| 변수 | 값과 역할 |
|---|---|
| `DB_HOST`, `DB_PORT` | `cse-db`, `5432` |
| `DB_NAME`, `DB_USER`, `DB_PW` | 전용 Mobius PostgreSQL 계정 |
| `DB_POOL_MAX` | `5` |
| `CSE_TYPE` | `1` |
| `CSE_ID` | `/bubble-cse` |
| `CSE_BASE_RN` | `Mobius` |
| `CSE_POA` | `http://cse:7599` |
| `CSE_ADMIN` | 운영 관리 Originator |
| `HTTP_PORT` | `7599` |
| `HTTPS_ENABLED`, `HTTPS_PORT` | `true`, `8443` |
| `HTTPS_KEY`, `HTTPS_CERT`, `HTTPS_CHAIN` | `/run/cse`의 TLS 파일 |
| `MQTT_ENABLED` | `false` |
| `NODE_OPTIONS` | `--max-old-space-size=192` |
| `LOG_LEVEL` | `error` |

PostgreSQL에는 PostGIS extension을 만든다. upstream `docker/entrypoint.js`가 CSE를 시작하고
`/var/lib/mobius4` volume이 관리 상태를 보존한다. health check는 `GET /Mobius`의 HTTP 200과
`X-M2M-RSC: 2000`을 확인한다.

## outbound 경계

VM의 `cse-lan-firewall.sh`는 CSE 컨테이너 IP 기준으로 established·related, VM DNS resolver의
UDP·TCP 53, `cse-db`의 TCP 5432, 승인된 내부 AE callback IP·TCP 포트를 순서대로 ACCEPT한 뒤
나머지 신규 outbound를 DROP한다. Docker 배포에서는 이 규칙을 `DOCKER-USER` chain의 Docker 자동
규칙보다 앞에 둔다. 이 네트워크 경계가 URL `nu`의 송신 범위를 관리한다.

## 실제 두 CSE 재현

```powershell
$env:MOBIUS4_ROOT = '<아티팩트 압축 해제 및 npm ci 완료 경로>'
node pc-mobius/scripts/run-acp-isolated.mjs
```

runner는 loopback CSE 두 개와 실행별 PostgreSQL DB를 만들고 역할별 ACP, 표준 구독 생성·검증·회수,
위치 보호를 검사한다. 종료 단계는 CSE 프로세스와 실행별 DB를 정산한다.
