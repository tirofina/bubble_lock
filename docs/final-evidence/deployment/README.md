# 단일 서버 배포 실행 증거

실행일은 2026-11-12다. 전부 데스크톱 WSL의 로컬 Docker와 실제 자체 Keycloak에서 수행했다. 실제 도메인·노트북·외부 IdP·MEC·지도 공급자에는 접속하지 않았다. 로컬 CSE는 고정 패치 이미지이며 장치 입력·위치 fixture는 모의다. 실제 Pi·BLE 장비를 시험했다고 주장하지 않는다.

실행 환경:

```sh
cd /home/gunp4ng/working/bubblelock-final-20261112/repo
export COMPOSE_PROJECT_NAME=bubblelock-secure
export RUN_TMP="$PWD/.local/deployment-secure"
export PUBLIC_DOMAIN=
export HTTP_PORT=19080 HTTPS_PORT=19443 MQTT_PORT=19883
export BIND_ADDRESS=127.0.0.1
```

설정·기동 명령은 `deployment/RUNBOOK.md`의 초기 실행 순서다. 세 역할·가구와 CA·client secret·DB/MEC 키는 `configure.mjs`가 무작위 생성한다. 비밀값과 백업 dump는 Git 제외 `.local`에만 있다. 실제 런타임에는 서비스별 named volume만 마운트했다. `docker compose config`의 env 값이나 `accounts.json`을 공개 증거에 복사하지 않는다.

| 실행 명령·표면 | 결과·증거 |
|---|---|
| `node --test deployment/test/bff-bind.test.mjs` | loopback에 고정한 원인에서 ECONNREFUSED: `bff-bind-red.log`; 수정 후 기존 세션 시험 포함 7/7: `bff-green.log` |
| `node --test deployment/test/configure.test.mjs` | 기본 443의 `:443` issuer 불일치를 검출: `config443-red.log`; canonical URL로 수정 후 `config443-green.log` |
| `node --test deployment/test/configure.test.mjs deployment/test/bff-bind.test.mjs web-dashboard/test/oidc-session.test.ts` | 8/8 PASS: `config-and-session-tests.log` |
| `docker compose --progress plain -f deployment/compose.yaml build api` | exit 0: `app-build.log` |
| 실제 Ego Browser의 Keycloak code 로그인·BFF callback | guardian/visitor/operator 모두 실제 subject와 등록 scope 확인, token expiry 증가로 refresh 확인, logout 뒤 snapshot 401: `browser-roles.json` |
| 실제 OIDC guardian의 포털 승인 | PostgreSQL 정본에 장치·consent·grant·canonical 명령 저장, 실제 CSE `/fopt` 두 멤버 DISPATCHED: `browser-group.json` |
| `node deployment/test/mqtt-live.mjs` | TLS1.3 client cert → 브로커 ACL → 신원 결속 어댑터 → 실제 CSE RSC 2000/readback. forged `fr` 4103, 다른 Gateway topic 발행과 인증서 없는 접속 거부: `mqtt-live.log` |
| `node deployment/test/gateway-https-live.mjs` | 도입 전 실패 `gateway-https-red.log`; 정확한 client cert API 200, CSE CREATE 2001와 저장 조회 2000, 인증서 없음/불일치/전달 헤더 위조/다른 Gateway 403, 위조 admin Origin의 UPDATE 4103: `gateway-https-green.json` |
| `node deployment/test/http-live.mjs` | TLS1.3, 상태 200, 인증 전 포털 401, 여섯 관리 경로 403, HTTP 308, 실제 burst 429, 보안 헤더: `http-live.json` |
| `node deployment/inspect.mjs` | 이전 host bind/root/writable 구성을 거부 `inspection-red.json`; 실제 최종 서비스의 publish/mount/user/read-only/no-new-privileges 통과 `inspection-green.json` |
| `node deployment/backup.mjs` | 실제 중앙·CSE DB dump를 별도 임시 DB에 복원 후 각 application table 확인, 임시 DB 삭제: `backup-restore.json` |
| `node .local/deployment-render.mjs` | 실제 Keycloak guardian 로그인 뒤 배포 앱 지도 렌더링. 기존 모의 위치 fixture만 브라우저에서 주입하고 지도 타일 24건을 로컬 SVG로 응답, 실제 외부 공급자 통신 0. `browser-render.json`, `deployed-desktop.png`(1440×1000), `deployed-mobile.png`(390×844) |
| `node deployment/monitor.mjs` | 현재 실행 서비스 정상: `monitor-green.json` |
| `docker exec ... psql ... SELECT namespace,version ...` | 여러 앱 재생성 뒤 PostgreSQL authority row 유지: `postgres-persistence.log` |
| `docker stats --no-stream ... <프로젝트 label로 선택한 컨테이너>` | 실행 서비스별 실제 메모리: `memory.log` |

브라우저는 작업 공간 `bubblelock-deployment-20261112`에서 실제 Keycloak 폼에 계정을 입력했다. 로컬 자체 CA는 이 작업의 CDP 세션에만 인증서 오류 예외를 설정했다. 서버 간 연결은 실제 CA 검증과 TLS1.3을 유지했다. 세 역할 refresh 실증에서는 로컬 realm의 access token 수명을 45초로 단축했다. 배포 기본은 120초다. token·refresh token·cookie는 증거에 기록하지 않았다. 앱 logout은 BFF 세션을 종료하며, 다음 역할 시험 전 실제 IdP logout 확인 화면으로 SSO 세션도 종료했다.

실제 브라우저에서 발견하고 수정한 원인:

- custom realm에 Keycloak의 기본 `basic` scope를 만들지 않아 access token `sub`가 없었다. 공식 `oidc-sub-mapper`를 client에 명시해 issuer/subject 검증을 유지했다.
- Docker의 빈 volume copy-up이 `/srv` 소유권을 root로 덮어 정적 파일 게시를 막았다. `volume.nocopy:true`로 init의 uid를 보존했다.
- 기존 `shared/validation.ts`의 `Ajv.compile`이 `new Function`을 쓰므로 엄격 CSP에서 실제 `EvalError`와 빈 root가 발생했다. 허용 origin을 유지하며 `script-src`의 `unsafe-eval` 호환 설정을 추가했다.
- 기존 Mobius native MQTT는 topic과 payload `fr`를 결속하지 않는다. 공개 익명 listener를 만들지 않고 인증서 CN ACL과 별도 신원 검사를 통과한 요청만 같은 originator의 CSE HTTPS로 전달했다.

전체 저장소의 최종 13단계 검증은 부모 세션이 한 번 실행해 합친다. 이 lane은 완료된 집계 검증을 중복 실행하지 않는다. 운영 도메인의 DNS/HTTP-01, 인증서 발급·갱신 cron 설치, 외부 알림 수신기, 대상 서버 배포와 실제 Pi 연결은 승인·운영 정보가 필요한 실행이며 이번 로컬 PASS와 구분한다.

부모가 최종 `npm run verify` 13단계 PASS를 전달했다. Ego의 `Page.captureScreenshot`는 시간 초과였으므로 도구를 설치·수리하지 않고 이미 설치된 Chromium과 omowright의 작업 전용 프로필로 캡처했다. 캡처 브라우저는 실제 자체 IdP에 로그인했으며 캡처 후 종료하고 해당 프로필을 제거했다. 모바일의 문서 폭은 viewport와 같은 390px이고, 데스크톱은 1440px viewport에서 문서 폭 1425px다. 화면의 모의 위치·핀·BLE 원과 계정 표시를 직접 확인했다.

소스 점검: 배포 JS 파일은 책임별 17–96줄이며 새 스크립트 문법 검사와 갱신 shell의 `sh -n`이 통과했다. 설정·볼륨 초기화·CSE provisioning·신원 검사·inspection·backup·monitor를 각각 분리했고, 검증 우회를 위한 타입 억제나 비어 있는 구현은 추가하지 않았다. Dockerfile/YAML LSP는 설치돼 있지 않아 새로 설치하지 않았으며 실제 Compose 파싱·Docker 빌드·실행으로 확인했다.
