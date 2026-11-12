# 고정 패치 CSE

원본은 기존 `keyring/dev/mobius4/upstream.json`의 commit
`e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`이다. 이 소스의 실제 버전은
4.25.0이다. `CSE_SECURITY.md`의 4.24.5는 과거 시험 버전이다. 기존 저장소의
고정 commit을 재사용해 같은 소스를 배포하며, 새 버전의 세 패치 문맥 일치,
반복 적용, 실제 CSE 두 개의 ACP 828건과 위치 5건을 확인했다.

## 산출물과 빌드

- `artifacts/mobius4-e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8-bubble-subscription-v1.tar.gz`
- `artifacts/manifest.json`: 원본 archive, lockfile, 패치 실행기, 변경 전후 세 파일,
  최종 archive의 SHA-256과 반복 적용 결과.
- 원본·패치 소스와 의존성 lockfile 및 canonical binarySwitch registry를 포함한다.
  `node_modules`와 운영 비밀 설정은 포함하지 않는다.

저장소 루트에서 실행한다. `RUN_TMP`와 cache 경로는 실행별 소유 디렉터리로 지정한다.

```sh
export RUN_TMP="$(mktemp -d /tmp/bubble-cse.XXXXXX)"
export TMPDIR="$RUN_TMP" TMP="$RUN_TMP" TEMP="$RUN_TMP"
export XDG_CACHE_HOME="$RUN_TMP/cache" npm_config_cache="$RUN_TMP/npm"
export BUN_INSTALL_CACHE_DIR="$RUN_TMP/bun"
node pc-mobius/scripts/build-mobius-artifact.mjs
docker build -f deployment/cse/Dockerfile \
  -t bubblelock/mobius4:4.25.0-bubble-subscription-v1 .
```

소스 재생성은 인터넷 다운로드와 npm registry를 사용한다. 원본 archive checksum이
다르면 패치 전에 중단한다. Docker build도 포함된 lockfile로 `npm ci`를 사용한다.
실행 대상 서비스는 로컬 CSE·DB뿐이다.

## 실행 계약

| 변수 | 예시·의미 |
|---|---|
| `DB_HOST`, `DB_PORT` | `postgres`, `5432` |
| `DB_NAME`, `DB_USER`, `DB_PW` | 전용 Mobius DB, 사용자, 비밀번호 |
| `DB_POOL_MAX` | 노트북 구성은 `5` 권장 |
| `CSE_TYPE` | `1`: 독립 IN-CSE |
| `CSE_ID` | `/bubble-cse` |
| `CSE_BASE_RN` | `Mobius`: base 경로 `/Mobius` |
| `CSE_POA` | 내부 서비스 주소 `http://cse:7599` |
| `CSE_ADMIN` | 지속 보존할 관리자 originator; 요청 `X-M2M-Origin` 값 |
| `HTTP_PORT` | `7599` |
| `MQTT_ENABLED` | 현재 배포·검증은 `false` |
| `NODE_OPTIONS` | `--max-old-space-size=192` |
| `LOG_LEVEL` | `error` 또는 운영 로그 수준 |

PostgreSQL DB에 `CREATE EXTENSION IF NOT EXISTS postgis`를 실행한다.
이미지 entrypoint는 upstream의 `docker/entrypoint.js`이며, 관리자 신원 volume
`/var/lib/mobius4`를 보존한다. 컨테이너 상한은 384MiB로 시험했다.

health 요청은 `GET /Mobius`, `X-M2M-Origin: <CSE_ADMIN>`,
`X-M2M-RI: <고유 ID>`, `X-M2M-RVI: 4`이며 HTTP 200과
`X-M2M-RSC: 2000`을 확인한다. 포트는 호스트 loopback 또는 내부 Docker network에 둔다.

HTTPS 변수는 `HTTPS_ENABLED`, `HTTPS_PORT`, `HTTPS_KEY`, `HTTPS_CERT`,
`HTTPS_CHAIN`이다. MQTT를 켜면 `MQTT_HOST`, `MQTT_PORT`를 받지만 이 pin의 inbound
binding은 `tcp://`와 익명 접속만 구성한다. MQTT 사용자·암호·TLS 환경변수는 지원하지
않는다. 이 묶음의 실증은 MQTT 비활성 HTTP 경로다.

## 실제 회귀

`CSE_DB_CONFIG`는 `{ "host", "port", "user", "password", "database" }` JSON 파일이다.
사용자는 격리 시험 DB 생성·삭제와 PostGIS extension 생성 권한이 필요하다.

```sh
MOBIUS4_ROOT=<산출물-압축해제-및-npm-ci-경로> \
MOBIUS4_REVISION=e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8 \
CSE_DB_CONFIG=<로컬-DB-설정.json> \
node pc-mobius/scripts/run-acp-isolated.mjs
```

`RUN_TMP` 아래에 두 CSE를 만들고 loopback에만 바인딩한다.
기본 증거는 `docs/final-evidence/cse`이며 `CSE_EVIDENCE_DIR`로 변경할 수 있다.
종료 시 자식 프로세스와 이번 실행에서 만든 DB만 정리하고 `cleanup.json`에
프로세스 종료 상태와 남은 DB 조회 결과를 기록한다. 원본 소스와 DB 계정은 바꾸지 않는다.
`CSE_HOLD=1`은 PASS 후 연결 파일 위치를 출력하고 SIGTERM/SIGINT까지 CSE를 유지한다.
그룹 QA가 같은 CSE를 재사용할 때만 사용한다.

2026-11-12 결과:

- 실제 두 CSE HTTP ACP 828/828, 위치 5/5 PASS. 위치 센서 입력은 모의 GPS/BLE다.
- 실제 Docker image health HTTP 200 / RSC 2000.
- 이미지 patch bytes 세 개가 manifest와 일치.
- image ID `sha256:2e77edcbd2e5b078c8262ecffd590e0b1a955eebb703d8d39f68e264fe0ca722`.
- image size 92,233,834 bytes, idle 43.49MiB / 384MiB. 부하 최대치 측정은 아니다.
- [실행 원문](../../docs/final-evidence/cse/qa-invocations.md),
  [ACP](../../docs/final-evidence/cse/acp-real-cse.json),
  [위치](../../docs/final-evidence/cse/location-privacy-real-cse.json),
  [이미지 실증](../../docs/final-evidence/cse/image-smoke.log).
