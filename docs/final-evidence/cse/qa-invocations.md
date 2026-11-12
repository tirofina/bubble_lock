# 2026-11-12 CSE 실행 원문

cwd: `/home/gunp4ng/working/bubblelock-final-20261112/repo`.
아래 모든 terminal 호출 앞에 다음 export를 전달했다.

```sh
export RUN_TMP=/tmp/bubble-cse-st01a1cf42
export TMPDIR=/tmp/bubble-cse-st01a1cf42 TMP=/tmp/bubble-cse-st01a1cf42 TEMP=/tmp/bubble-cse-st01a1cf42
export XDG_CACHE_HOME=/tmp/bubble-cse-st01a1cf42/cache npm_config_cache=/tmp/bubble-cse-st01a1cf42/npm
export BUN_INSTALL_CACHE_DIR=/tmp/bubble-cse-st01a1cf42/bun
```

## 준비

```sh
curl -fL --retry 2 https://codeload.github.com/IoTKETI/mobius4/tar.gz/e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8 -o "$RUN_TMP/upstream.tar.gz"
tar xzf "$RUN_TMP/upstream.tar.gz" -C "$RUN_TMP"
sha256sum "$RUN_TMP/upstream.tar.gz"
docker run -d --name bubble-cse-st01a1cf42-db -e POSTGRES_USER=bubble -e POSTGRES_PASSWORD=local-cse-regression -e POSTGRES_DB=bubble -p 127.0.0.1::5432 postgis/postgis:16-3.4
docker port bubble-cse-st01a1cf42-db 5432
cd "$RUN_TMP/mobius4-e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

Docker port 결과 `127.0.0.1:32768`.
PostGIS image digest `sha256:44126d872ac91993766c341e369c539e8196614321765d36a6f1bab0419a5fa5`.
비밀번호는 이번 폐기형 로컬 컨테이너 fixture 값이다.
DB 설정 파일 `$RUN_TMP/db.json`은 loopback 32768, user/database `bubble`을 사용했다.

## 최종 패키징과 구문 검사

```sh
set -o pipefail
mkdir -p docs/final-evidence/cse
{ node --check pc-mobius/scripts/build-mobius-artifact.mjs &&
  node --check pc-mobius/scripts/run-acp-isolated.mjs &&
  node pc-mobius/scripts/build-mobius-artifact.mjs;
} 2>&1 | tee docs/final-evidence/cse/package.log
```

exit 0. 원본 checksum 일치, 세 파일 APPLIED, 재적용 세 파일 ALREADY_APPLIED.
최종 archive SHA-256 `7118c23ac70da3c947e4c12df4c5b2c56577cc5bff1f97a8551fc0fb09ff7721`.
변경 전후 hash는 `deployment/cse/artifacts/manifest.json`에 보존했다.

## 패키지의 실제 CSE 회귀

```sh
set -o pipefail
mkdir "$RUN_TMP/release"
tar xzf deployment/cse/artifacts/mobius4-e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8-bubble-subscription-v1.tar.gz -C "$RUN_TMP/release"
ln -s "$RUN_TMP/mobius4-e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8/node_modules" "$RUN_TMP/release/node_modules"
MOBIUS4_ROOT="$RUN_TMP/release" \
MOBIUS4_REVISION=e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8 \
CSE_DB_CONFIG="$RUN_TMP/db.json" CSE_HOLD=1 \
node pc-mobius/scripts/run-acp-isolated.mjs 2>&1 | tee docs/final-evidence/cse/live.log
```

ACP 828/828 PASS, 위치 5/5 PASS. 센서 관측만 모의이며 전송·DB·CSE는 실제 로컬 프로세스다.
PASS 후 그룹 QA 재사용을 위해 의도적으로 유지했다. 실행 디렉터리
`$RUN_TMP/1794478918429_331b82`, runner PID `1977781`.
관리자 연결 파일은 그 디렉터리의 `cse-edges.json`이며 공개 증거에는 자격 증명을 복사하지 않았다.
빌드 이미지와 소스의 패치 세 파일 hash는 동일하다.

## Docker 빌드와 실제 실행

```sh
set -o pipefail
docker build -f deployment/cse/Dockerfile -t bubblelock/mobius4:4.25.0-bubble-subscription-v1 . 2>&1 | tee docs/final-evidence/cse/docker-build.log
docker run -d --name bubble-cse-st01a1cf42-image --network host --memory 384m \
  -e NODE_OPTIONS=--max-old-space-size=192 \
  -e DB_HOST=127.0.0.1 -e DB_PORT=32768 -e DB_NAME=bubble -e DB_USER=bubble -e DB_PW=local-cse-regression \
  -e CSE_ADMIN=Slocal-image-regression-01a1cf42 -e CSE_ID=/image-cse -e CSE_BASE_RN=Mobius \
  -e HTTP_PORT=47599 -e CSE_POA=http://127.0.0.1:47599 -e MQTT_ENABLED=false -e LOG_LEVEL=error \
  bubblelock/mobius4:4.25.0-bubble-subscription-v1
until curl -fsS -H "X-M2M-Origin: Slocal-image-regression-01a1cf42" -H "X-M2M-RI: image-health" -H "X-M2M-RVI: 4" http://127.0.0.1:47599/Mobius -o "$RUN_TMP/image-health.json"; do sleep 1; done
```

실행 감시는 도구 monitor가 담당했다. Docker smoke는 host network에서 로컬 요청으로 실행했고 즉시 컨테이너를 삭제했다.

```sh
set -o pipefail
{ printf "QA image health\n"
  curl -fsS -D - -H "X-M2M-Origin: Slocal-image-regression-01a1cf42" -H "X-M2M-RI: image-health-final" -H "X-M2M-RVI: 4" http://127.0.0.1:47599/Mobius
  printf "\nQA image metadata\n"
  docker image inspect bubblelock/mobius4:4.25.0-bubble-subscription-v1 --format "{{json .Id}} {{.Size}}"
  docker stats --no-stream --format "{{.Name}} {{.MemUsage}}" bubble-cse-st01a1cf42-image
  printf "QA patch bytes inside image\n"
  docker exec bubble-cse-st01a1cf42-image sha256sum cse/reqPrim.js cse/hostingCSE.js cse/noti.js
  printf "QA owned smoke cleanup\n"
  docker rm -fv bubble-cse-st01a1cf42-image
  docker ps -a --filter name=bubble-cse-st01a1cf42-image --format "{{.Names}} {{.Status}}"
} 2>&1 | tee docs/final-evidence/cse/image-smoke.log
```

두 호출 exit 0. HTTP 200/RSC 2000, 43.49MiB/384MiB, 이미지 92,233,834바이트.
삭제 후 smoke 컨테이너 조회는 빈 결과다.

## 범위와 미실행

루트 setup과 verify 13단계 exit 0은 root lane이 전달한 기존 결과로 사용했다.
이 lane에서 전체 검증을 반복하지 않았다. 원격 배포·SSH·외부 대상 서비스 호출·commit·push는 실행하지 않았다.
프로그래밍/Bun/TypeScript/시험 규칙을 읽었다. `security-jev` 스킬은 제공된 skill roots와
로컬 `.codex/skills`, `.claude/skills`에서 찾지 못했다. JEV 없이 실제 CSE 회귀를 수행했다.
Biome와 Dockerfile LSP는 설치되어 있지 않아 진단을 얻지 못했고, Node 구문 검사와 실제 실행을 사용했다.
원본 npm 의존성의 deprecation 경고는 유지했다.
