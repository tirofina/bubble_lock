# 단일 서버 운영

대상은 `gunp4ng-labtop`의 Ubuntu 24.04 x86_64, Docker 29.1/Compose 2.40이다. 이 문서는 승인 후 실행할 명령을 제공한다. 이번 실행은 데스크톱 WSL의 별도 Compose 프로젝트에서만 수행한다. 대상 노트북에 SSH·배포·서비스 변경을 하지 않는다.

운영 도메인은 `bubblelock.iptime.org`다. 공유기의 80/443/8883은 이미 `192.168.0.3`으로 전달된다. 실제 도메인 접속·인증서 발급·노트북 실행은 리드 승인 후 수행한다. 로컬 QA에서는 `PUBLIC_DOMAIN=`으로 비워 `bubble.localhost`만 사용한다.

| 외부 TCP 포트 | 서비스 | 용도 |
|---|---|---|
| 80 | HTTPS 프록시 | Let's Encrypt HTTP-01 발급·갱신, HTTPS 443 리다이렉트 |
| 443 | HTTPS 프록시 | 웹, BFF/API, 자체 OIDC 경로 |
| 8883 | MQTT TLS 브로커 | Pi Gateway mTLS, 인증서 CN별 topic ACL |

PostgreSQL, PostGIS, Mobius HTTP 7599, Keycloak 8080/9000, 내부 API 8787, BFF 4174, 관리 콘솔은 호스트에 publish하지 않는다. Docker publish는 UFW를 우회할 수 있으므로 Compose의 `ports` 세 곳만 허용한다. 내부 통신은 `internal:true`의 app·identity·postgres·onem2m·mqtt·cse-bridge·cse-db·cse-provision 네트워크로 나눈다. PostgreSQL에는 Keycloak·API·db-init만, CSE DB에는 CSE만 접근한다. 설정 복사만 하는 init·static·cert-install 도구는 네트워크를 연결하지 않는다. 프록시와 MQTT만 ingress network에 연결한다. `/identity/admin`, `/identity/management`, `/Mobius`, `/v1`, `/admin`, `/metrics`는 외부 프록시에서 403이다.

설정과 인증서도 host bind mount하지 않는다. `init-volumes.mjs`가 임시 init 컨테이너에 `docker cp`로 필요한 파일만 복사하고 서비스별 uid와 mode를 설정한 뒤 init 컨테이너를 삭제한다. 런타임에는 전용 named volume만 사용한다. API·웹·프록시·MQTT·MQTT 어댑터는 non-root/read-only/cap-drop/no-new-privileges로 실행한다. Keycloak은 첫 시작 augmentation, Mobius는 upstream entrypoint 때문에 root filesystem 쓰기를 허용하되 uid 1000을 사용한다. DB는 데이터 volume에 쓴다. 홈 디렉터리·브라우저 데이터·Docker socket을 컨테이너에 전달하지 않는다.

## 구성과 메모리

Keycloak은 Dex보다 무겁지만 별도 사용자 저장소나 로그인 화면 없이 세 역할의 비밀번호 로그인, 고정 subject 등록, PKCE, refresh rotation, 관리자 계정 관리를 제공한다. 현재 BFF의 HTTPS discovery·RS256·API audience와 바로 연결되므로 선택했다. JWT의 역할 문자열을 신뢰하지 않고 서버의 `(issuer, subject)` 등록과 token scope 교집합으로 권한을 정한다. Guardian/visitor는 같은 가구에 연결하고 operator는 운영 조회 scope만 가진다.

Keycloak 768 MiB(heap 384), PostgreSQL 512, PostGIS 512, CSE 384(heap 192), API 512, 웹 256, 프록시 128, MQTT 128, MQTT 어댑터 128 MiB로 실행 서비스 상한은 3,328 MiB다. 일회성 static 64 MiB를 포함해 3,392 MiB다. 이미지 빌드는 별도이며 서버에서 동시 빌드를 피한다. 4–5 GB 예산 안에서 `docker stats --no-stream`을 확인한다. 실제 유휴·시험 사용량은 실행 증거에 기록한다.

## 초기 실행

저장소 루트에서 실행한다. Node 22.19 이상, OpenSSL, Docker/Compose를 사용한다.

```sh
cp deployment/.env.example deployment/.env
# deployment/.env의 RUN_TMP는 절대 경로로 지정한다.
# 도메인이 없으면 PUBLIC_DOMAIN을 비워두고 bubble.localhost 자체 서명 경로를 쓴다.
set -a; . deployment/.env; set +a
export RUN_TMP="$PWD/.local/deployment"
node deployment/preflight.mjs
node deployment/configure.mjs
docker compose -f deployment/compose.yaml build api cse
node deployment/init-volumes.mjs
docker compose -f deployment/compose.yaml up -d cse
node deployment/provision.mjs
node deployment/init-volumes.mjs
docker compose -f deployment/compose.yaml up -d
node deployment/inspect.mjs
node deployment/monitor.mjs
```

서버 승인 전 데스크톱은 `PUBLIC_DOMAIN=`, `COMPOSE_PROJECT_NAME=bubblelock-secure`, `BIND_ADDRESS=127.0.0.1`, `HTTP_PORT=19080`, `HTTPS_PORT=19443`, `MQTT_PORT=19883`을 쓴다. 서버 승인 후에만 `PUBLIC_DOMAIN=bubblelock.iptime.org`, `BIND_ADDRESS=0.0.0.0`, 80/443/8883을 사용한다. 기존 서비스와 포트를 먼저 확인하고 `preflight.mjs`에서 충돌하면 중단한다. 생성기는 기존 `accounts.json`을 덮어쓰지 않는다. 재기동에는 같은 설정·비밀값을 사용한다.

`RUN_TMP/accounts.json`에 무작위 guardian·visitor·operator 비밀번호와 bootstrap 관리자 정보가 있다. `portal.json`과 `api.json`에는 같은 subject 등록표가 있다. OIDC callback은 정확히 `https://<호스트>:<HTTPS_PORT>/api/auth/callback`이다. 로컬 realm은 `https://bubble.localhost:19443/identity/realms/bubble`이다. 초기 가구는 `household-1`이다. 테스트 계정은 운영 사용 전에 암호를 바꾸고 별도 실제 계정을 subject 등록표에 추가한다.

로그인 후 `/api/auth/session`에 실제 principal이 나타나고, access token 만료 30초 전부터 서버가 refresh한다. 로그아웃은 앱의 BFF 세션과 쿠키를 종료한다. Keycloak SSO 세션은 별도로 남으므로 공유 PC에서 완전히 종료하려면 Keycloak 계정 세션도 종료한다. 앱 재시작은 메모리 세션을 없애므로 재로그인한다.

## MQTT와 CSE

고정 CSE는 4.25.0, revision `e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`의 패치 산출물이다. `cse/README.md`와 artifact manifest를 따른다. PostgreSQL/PostGIS DB와 관리자 originator는 지속 보존한다.

해당 upstream MQTT binding은 topic originator를 응답 주소에만 쓰고 payload `fr`을 검증하지 않는다. 익명 TCP만 지원한다. 따라서 native MQTT를 끄고 `mqtt-bridge.mjs`가 인증서 CN으로 제한된 topic과 `fr`의 일치, 등록 신원, Mobius 경로·operation을 검사한 후 같은 originator로 실제 CSE HTTPS를 호출한다. 관리자 신원을 대신 쓰지 않는다. CSE의 ACP 판정과 실제 `X-M2M-RSC`를 MQTT application response로 반환한다. PUBACK은 성공 기준이 아니다.

브로커에는 익명·평문 listener가 없다. Pi는 `pki/gateway-1.pem`, `gateway-1.key`, `ca.pem`, `MQTT_HOST=<도메인>`, `MQTT_PORT=8883`, `M2M_ORIGINATOR=gateway-1`, `M2M_CSE_ID=bubble-cse`, flat primitive를 사용한다. 생성한 로컬 인증서는 시험용이다. 실제 AE-ID가 다르면 해당 인증서 CN·브로커 ACL·bridge identity 등록·CSE ACP를 같은 revision으로 교체한다. 장치별 다른 인증서와 정확한 topic ACL을 추가한다. CORE 전용 command/epoch topic은 별도 중앙 MQTT 연결과 승인 계약에 맞춰 등록하며 이 native oneM2M ACL을 넓혀 대체하지 않는다.

Pi의 `PC_API_URL=https://bubblelock.iptime.org`, `M2M_CSE_URL=https://bubblelock.iptime.org/onem2m`을 사용한다. observation/receipt/health container는 `/Mobius/bubble-household-1/<GATEWAY_ID>/observations`, `receipts`, `health`다. `GATEWAY_ID`는 생성 전 지정하며 기본은 `gateway-1`이다. `/api/v1/gateways/<등록 ID>/`는 외부 mTLS CA 검증과 인증서 fingerprint 고정을 모두 통과해야 한다. 프록시는 해당 등록 인증서로 중앙 API에 다시 mTLS 연결하고 API는 현재 enrollment를 다시 검사한다. 인증서 전달 헤더는 신뢰하지 않는다. `/onem2m`은 같은 인증서만 허용하고 등록한 세 container 경로에만 접근시키며 upstream `X-M2M-Origin`을 등록 ID로 강제한다. ACP는 해당 Gateway에 CREATE/RETRIEVE만 허용한다. 다른 Gateway, CSE admin/discovery/ACP, UPDATE/DELETE는 거부한다. 인증서 회전은 fingerprint와 enrollment를 함께 갱신한다.

지도 설정은 `.env`의 `VITE_MAP_TILE_URL`, `VITE_MAP_ATTRIBUTION`, `VITE_STADIA_MAPS_KEY`, `VITE_STADIA_MAPS_DOMAIN`을 웹 빌드와 volume 초기화에 함께 전달한다. CSP는 OSM·Stadia와 설정한 사용자 지정 HTTPS origin만 이미지에 허용하고 wildcard를 쓰지 않는다. `strict-origin-when-cross-origin`은 Stadia 도메인 인증의 사이트 Referer를 보존한다. 이 값은 공개 브라우저 설정이므로 서버 비밀키를 넣지 않는다. 로컬 QA는 브라우저에서 지도 공급자 URL을 차단한다.

웹 validator는 빌드 전에 생성·검증한 모듈을 사용한다. 앱 CSP의 script·style은 자체 origin만 허용하며 `unsafe-eval`을 허용하지 않는다. Keycloak 로그인 테마의 실제 inline script와 form 동작에는 `/identity/` 경로의 `script-src 'unsafe-inline'`만 별도로 허용하고, 이 경로에도 나머지 보안 헤더를 명시한다. `/events`는 프록시에서 IP당 4개 연결, BFF에서 전체 기본 64개(`SSE_MAX_STREAMS`)로 제한한다.

설정 volume을 갱신한 기존 배포는 `docker compose -f deployment/compose.yaml restart proxy mqtt web api mqtt-bridge`로 읽는 프로세스를 다시 시작한다. 생성·초기화는 승인된 점검 시간에만 수행한다.

## 인증서·비밀·키 회전

로컬 CA 개인키는 `RUN_TMP/pki/ca.key`에만 남기고 컨테이너에 복사하지 않는다. 로컬 서버/클라이언트 인증서는 30일이다. 운영 HTTPS는 실제 도메인 DNS를 서버로 지정하고 TCP80 HTTP-01 경로를 연 뒤 발급한다. 외부 인증서 발급은 이번 로컬 QA에서 실행하지 않는다.

`monitor.mjs`는 `RUN_TMP/pki/mqtt.pem`(브로커 서버)과 `RUN_TMP/pki/gateway-1.pem`(Gateway 클라이언트)을 매 실행마다 읽는다. 둘 중 하나라도 없거나 유효기간이 14일 이하이면 JSON `ALERT`, 종료 코드 1을 반환한다. `CERT_ALERT_DAYS=14`로 경보 시점을 조정할 수 있다. 이 경보를 1분 주기 운영 알림에 연결하고, 30일짜리 인증서는 만료 전에 담당자가 점검 시간에 수동 교체한다. 로컬 파일의 만료 확인과 별도로 교체 후 실제 MQTT TLS 및 Gateway HTTPS 연결도 시험한다.

MQTT·Gateway 인증서 수동 회전 순서: 현재 `RUN_TMP/pki`와 CA 개인키, 두 인증서 및 프록시 설정을 보호된 백업으로 보존한다. 같은 CA로 새로운 `mqtt` 서버 인증서(운영 도메인과 `mqtt` SAN, `serverAuth`)와 `gateway-1` 클라이언트 인증서(등록 Gateway ID의 CN, `clientAuth`)를 30일짜리로 별도 보호 폴더에 발급하고 `openssl verify -CAfile "$RUN_TMP/pki/ca.pem"`으로 각각 확인한다. CA 자체를 바꾸는 경우에는 아래의 기존 CA/새 CA 신뢰 중첩 순서를 먼저 따른다. 새 CA와 Gateway 인증서·키를 Pi에 **배포만** 하고 아직 활성화하지 않는다. 점검 시간에 새 Gateway 인증서 지문을 프록시의 `@GATEWAY_FINGERPRINT@` 설정에 반영하고, 새 브로커 서버 인증서·키와 프록시의 Gateway 클라이언트 인증서·키를 각각 해당 설정 volume에 복사하여 소유권·0600 권한을 유지한다. `init-volumes.mjs` 전체 재실행은 공개 HTTPS 인증서를 로컬 시험용 인증서로 덮어쓰므로 회전에 사용하지 않는다. 프록시와 브로커를 재시작한 뒤 Pi의 새 인증서를 활성화하고 재접속한다. 이 전환 사이에는 이전 지문 인증서의 Gateway HTTPS 요청이 거절될 수 있으므로 점검 창에서 수행한다. `node deployment/test/mqtt-live.mjs`와 `node deployment/test/gateway-https-live.mjs`의 정상·위조·타 Gateway 거부를 확인하고, 성공한 인증서만 `RUN_TMP/pki/mqtt.pem`·`gateway-1.pem`에 반영한 후 `node deployment/monitor.mjs`가 `HEALTHY`인지 확인한다. 실패하면 보호해 둔 기존 인증서·프록시 설정·Pi 신뢰 설정을 함께 복구한다. 이 절차는 자동 교체를 실행하지 않는다.

```sh
docker compose -f deployment/compose.yaml --profile tools run --rm certbot certonly \
  --webroot -w /var/www/acme -d "$PUBLIC_DOMAIN" --email "$ACME_EMAIL" --agree-tos --no-eff-email
```

발급된 `acme-certs` named volume의 `live/<domain>/fullchain.pem`, `privkey.pem`을 제어된 init 컨테이너로 `proxy-config/public.pem`, `public.key`에 복사하고 uid 101, mode 600을 유지한다. 프록시를 재시작한다. 12시간마다 `certbot renew`를 실행하고 성공 후 같은 복사·재시작을 수행한다. 만료 14일 전부터 경보를 발생시킨다. MQTT 인증서도 같은 도메인 SAN을 사용하거나 별도 사설 CA를 Pi에 신뢰시킨다. MQTT CA 교체는 새 CA를 먼저 Pi trust bundle에 추가 → 서버·클라이언트 인증서 교체 → 재접속·ACL 시험 → 이전 CA 제거 순서다.

첫 발급 후 `docker compose -f deployment/compose.yaml --profile tools run --rm cert-install`과 `docker compose -f deployment/compose.yaml restart proxy`를 실행한다. 자동 갱신은 서비스 계정의 cron에 `0 */12 * * * cd <저장소> && set -a && . deployment/.env && set +a && sh deployment/renew-certificates.sh >> <보호된 로그> 2>&1`로 등록한다. 발급 실패는 기존 인증서를 유지하며 cron 실패·만료 경보를 운영 알림에 연결한다. 초기화 스크립트를 다시 실행하면 로컬 인증서를 복사하므로 실제 인증서 사용 후에는 `cert-install`을 다시 실행한다.

`RUN_TMP`, 백업, `.env`는 소유자만 읽는 0700/0600으로 관리하고 Git에 넣지 않는다. 서버에서는 전용 서비스 계정과 암호화된 오프라인 백업을 사용한다. DB 암호는 SQL `ALTER ROLE`과 env 파일을 함께 바꾸고 해당 컨테이너만 재생성한다. BFF client secret은 Keycloak에서 새 값 발급 후 `portal.json` 교체·web-config 초기화·웹 재시작으로 반영한다. JWT signing key는 새 RSA 키를 활성화한 뒤 기존 access token 수명과 JWKS 캐시 5분 이상을 기다리고 이전 키를 비활성화한다. 공유 MEC 암호키는 기존 암호문 복구에 필요하므로 DB와 함께 보존하고 데이터 재암호화 없이 삭제하지 않는다.

Keycloak 관리 콘솔은 외부에서 닫혀 있다. 관리 명령은 승인된 서버 터미널의 `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh ...`로 내부 `http://localhost:8080/identity`에 접속한다. bootstrap 관리자 암호는 운영 관리자 생성 후 폐기한다. CLI 인증 cache를 공유 홈에 저장하지 않는다.

## 백업·복구·장애 훈련

```sh
BACKUP_DIR="$RUN_TMP/backup-$(date -u +%Y%m%dT%H%M%SZ)" node deployment/backup.mjs
```

스크립트는 중앙 DB와 CSE DB를 custom-format dump로 저장하고 별도 DB에 실제 복원한 뒤 application table 존재를 확인한다. 현재 DB를 덮어쓰지 않는다. 운영 백업은 두 dump, 원래 `RUN_TMP`의 설정·CA·MEC 키, named volume의 receipts·CSE admin identity·MQTT persistence를 함께 암호화해 별도 매체에 보관한다. 일일 백업과 변경 전 백업을 남기며 보관 기한은 개인정보 보존 정책에 맞춘다. DB 간 일관된 복구점이 필요하면 API·어댑터·CSE 쓰기를 먼저 중지한 상태에서 두 dump를 만든다.

전체 복구는 새 Compose 프로젝트와 새 named volume에 동일 버전 이미지를 준비 → 비밀·설정 volume 복원 → PostgreSQL/PostGIS 시작 → `pg_restore --exit-on-error`로 두 DB 복원 → CSE 관리자 identity volume 복원 → CSE/API/IdP/웹/어댑터 시작 순서다. 원래 장애 volume은 조사 전까지 보존한다. `inspect.mjs`, `monitor.mjs`, 세 역할 로그인·권한·MQTT CSE 응답 시험을 통과한 뒤 포트포워딩을 새 인스턴스로 전환한다. 분기마다 격리 프로젝트에서 복원 시간과 데이터 손실 구간을 기록한다.

복구 훈련은 API 재시작 후 DB 가구·정책 유지, 웹 재시작 후 세션 종료·재로그인, 브로커 재시작 후 TLS 재연결·같은 rqi application response, DB 중단 시 신규 작업 실패 및 복구 후 재조회로 수행한다. 전송 결과는 commandId·claim·ACK/readback으로 확인하고 MQTT QoS를 물리 동작 중복 방지로 간주하지 않는다.

## 감시와 종료

`monitor.mjs`는 컨테이너 중단, OOM, unhealthy와 MQTT 서버·Gateway 인증서 만료 14일 전을 JSON `ALERT`와 exit 1로 반환한다. 1분 주기로 실행하고 실패 결과를 운영자가 사용하는 알림 수신기로 연결한다. 알림 수신 주소가 제공되지 않아 외부 알림 발송은 하지 않는다. DB 용량/디스크 80%, 컨테이너 메모리 상한 80%, 백업 24시간 초과, refresh 실패 증가, 프록시 5xx/429, MQTT 연결·CSE 거절 수, receipts outbox 정체도 별도로 감시한다. 로그는 서비스당 10 MB × 3개로 회전한다. 프록시는 IP별 API 20req/s, 로그인 5req/s, burst 제한과 TLS1.3·보안 헤더를 제공한다.

```sh
node deployment/inspect.mjs
node deployment/monitor.mjs
docker compose -f deployment/compose.yaml ps
docker compose -f deployment/compose.yaml logs --tail=100 --no-color
docker stats --no-stream
```

대회 종료 시 공유기의 80/443/8883 포트포워딩을 해제하고, 소유한 프로젝트에만 `docker compose -f deployment/compose.yaml down`을 실행한다. 백업 보존 여부를 확인하기 전 `down -v`를 사용하지 않는다. 다른 서비스·컨테이너·호스트 방화벽을 변경하지 않는다. 테스트 계정과 인증서를 폐기하고 임시 외부 DNS를 정리한다.

Cloudflare Tunnel을 쓰면 원격 인바운드 80/443 포트포워딩 대신 outbound 터널로 웹·OIDC HTTPS를 전달할 수 있다. 프록시의 공개 origin, issuer, callback을 터널 도메인으로 일치시키고 관리 경로 차단은 그대로 유지한다. 일반 HTTP 터널은 Pi의 raw MQTT8883을 대신하지 않으므로 MQTT는 별도 승인된 TLS 경로/VPN 또는 지원되는 TCP 터널을 설계한다. 이번 작업에서는 Cloudflare 계정·네트워크를 연결하지 않는다.
