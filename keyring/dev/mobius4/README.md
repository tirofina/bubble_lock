# KEYRING 임시 Mobius4 환경

DOC-REV 2.0.0 · 팀 CORE 기준 commit `91a281b` · upstream은 [IoTKETI/mobius4](https://github.com/IoTKETI/mobius4) commit `e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`에 고정했다. 실제 CSE 소스는 저장소에 복제하지 않고 외부 `MOBIUS4_ROOT` 경로로 연결한다.

2026-10-28: 사용자의 Docker 재실행 이후 로컬 CA/client certificate와 서버 이미지를 생성하고 컨테이너 4개를 기동했다. 최초 AE 생성은 varchar(30) 식별자 제한으로 실패했고 임시 관리자 ID를 25자로 수정했다. 이 상태는 서버 provisioning이며 Gateway·실물/E2E 검증 evidence가 아니다.

Mobius4는 초기 관리자 ID를 DB에 고정하므로 기존 dev DB를 migration하거나 삭제하지 않고 새 `pgdata_v2`/`identity_v2` volume으로 생성했다. 최초 `pgdata`/`identity` volume과 이전 local env는 보존되어 있다. 이후 관리자 ID 변경이나 volume 삭제를 일반 재시작 절차로 사용하지 않는다.

## 구성

Compose project `privacy-bubble-keyring-dev`는 별도 PostGIS DB·Mosquitto·Mobius4·TLS proxy를 사용한다. DB와 plaintext HTTP/MQTT는 Compose 내부 전용이다. 호스트에는 `https://localhost:8759`와 mTLS MQTT `localhost:8883`만 127.0.0.1에 bind한다. 실제 Pi에서 접근하려면 별도의 팀 네트워크·DNS·인증서 SAN·방화벽·bind 정책을 먼저 정해야 한다. 현재 상태를 Pi 통합 완료로 표시하지 않는다.

TLS 1.3과 임시 CA/client certificate를 생성한다. dev client의 CN은 `keyring-dev-gateway`다. 해당 인증서만 proxy를 사용하며 proxy의 관리자 originator 매핑은 이 격리된 개발 CSE만을 위한 것이다. 운영 환경에서는 등록된 AE와 ACP에 바인딩해야 한다. CA 개인키와 client 개인키는 서버·브로커에 mount하지 않는다.

## 최초 생성

Docker Desktop Linux engine이 정상 동작한 뒤 PowerShell 7에서 수행한다. 다음 명령은 실제 dependency image 다운로드·로컬 인증서 생성·서버 image build/start를 수행하는 provisioning이며, 하드웨어 시험을 실행하지 않는다.

```powershell
cd "C:\Users\NH\Documents\ChatGPT\mobius 해커톤\github_upload\bubble_lock"
./keyring/dev/mobius4/prepare.ps1 -Mobius4Root "C:\Users\NH\Documents\ChatGPT\mobius 해커톤\github_upload\_local\mobius4" -Start
```

준비 후 재시작은 `./keyring/dev/mobius4/start.ps1`다. 로컬 `.local/compose.env`, `.local/mqtt.acl`, `.local/tls/`는 Git과 Docker build context에서 제외된다. 기존 설정/키가 있으면 prepare는 덮어쓰지 않는다. 중간 실패 시 기존 상태를 보존하고 필요한 부분만 명시적으로 복구해야 한다. 일반 종료는 다음 명령을 사용하며 volume 삭제 옵션은 추가하지 않는다.

```powershell
docker compose --env-file ./keyring/dev/mobius4/.local/compose.env -f ./keyring/dev/mobius4/compose.yaml down
```

## Gateway 설정

빈 AE·관측/receipt/health container·초기 binarySwitch 자원 생성은 저장소 루트에서 `node ./keyring/dev/mobius4/bootstrap.mjs`로 수행한다. 요청은 직렬 7초 간격이며 기존 자원은 덮어쓰지 않는다. 초기 binarySwitch의 false는 dev-bootstrap/unobserved 표시가 있는 초기값이며 실물 관측이 아니다. 실제 설치 receipt는 `.local/resource-provisioning.json`에 남는다. 장치 명령·가짜 센서 이벤트는 생성하지 않는다.

- `M2M_CSE_URL=https://localhost:8759`, `M2M_CSE_ID=Mobius4`, `M2M_RVI=4`.
- `TLS_CA_FILE`, `TLS_CERT_FILE`, `TLS_KEY_FILE`에는 생성된 ca.pem/client.pem/client.key의 절대 경로를 지정한다. Gateway Linux 환경에서의 경로를 사용하며 Windows 경로를 Pi에 복사하지 않는다.
- `M2M_ORIGINATOR`는 local compose.env의 CSE_ADMIN과 동일한 값을 로컬 설정에만 사용한다. 이 값은 임시 관리자 credential이므로 출력·공개하지 않는다.
- `MQTT_HOST=localhost`, `MQTT_PORT=8883`, `CORE_BRIDGE_ENABLED=true`, `GATEWAY_ID=pi-keyring-local`은 현재 dev ACL 조합이다. 다른 ID는 ACL과 함께 교체한다.
- `BLE_GATT_PROFILE=core-v1`이며 identity extension과 BLE payload 변환은 [CORE 연동 메모](../../CORE_INTEGRATION.md)에 설명했다.

`/api/`는 항상 503/allowed=false다. INTEGRATION 서버가 없는 상태에서 임의 승인이나 가짜 명령을 제공하지 않는다. 실제 `PC_API_URL`과 credential/authorize API를 연결하기 전에는 Gateway 명령 실행이 차단된다.

관측/receipt/health container와 binarySwitch 자원은 CORE owner가 준비해야 한다. 포함한 specialization registry는 `pb:binarySwitch`를 위한 로컬 설정이며 팀의 공통 파일을 변경하지 않는다. CORE 제공 하니스의 `create-state`는 현재 ty=4로 기록돼 있어 flexContainer ty=28과 불일치한다. 이 차이는 [인수 메모](../../CORE_INTEGRATION.md)에 기록했고 팀 원본은 보존했다.

나중에 실제 Mobius 서버로 바꿀 때는 `M2M_CSE_URL`/RVI/Originator/container/CA·credential과 `PC_API_URL`을 교체한다. 운영 서버의 별도 데이터 저장소에는 새 `M2M_CSE_DEPLOYMENT_ID`와 새 `GATEWAY_DATABASE`를 지정한다. 새 중앙 API 저장소에는 `PC_API_DEPLOYMENT_ID`를 배정한다. [Mobius4 배포 전환](../../raspberry-pi-gateway/STATE_RECOVERY.md#cse-배포-전환) · [중앙 API 배포 전환](../../raspberry-pi-gateway/STATE_RECOVERY.md#중앙-api-배포-전환)

## Epoch 전용 MQTT 프로필

`privacy-bubble-keyring-scoped`는 같은 Mobius4 이미지와 SDT 정의를 사용하고 별도 Compose network·DB·CSE identity·cursor volume을 만든다. MQTT는 `127.0.0.1:8884`, CSE HTTPS는 `https://localhost:8760`에 바인딩한다. 브로커는 TLS 1.3/mTLS listener 하나를 열고 익명 접속·retained publish를 막도록 구성한다. 기존 개발 프로필은 별도 포트와 볼륨을 사용한다.

| 임시 인증서 | 허용된 epoch 발행 | CSE HTTPS |
|---|---|---|
| `gateway-a.pem` | `gw-a/telemetry-epoch/kr-handover/7`, `gw-a/telemetry-epoch/kr-handover/9` | native 관측·영수증·health 컨테이너 |
| `gateway-b.pem` | `gw-b/telemetry-epoch/kr-handover/8` | native 관측·영수증·health 컨테이너 |
| `client.pem` | epoch 토픽 구독 전용 | 자원 준비와 `bubbleState` UPDATE |

브로커 ACL은 표의 발행 경로 앞에 `privacy-bubble/gateway/`를 붙여 사용한다. Nginx는 두 Gateway의 직접 SDT 갱신을 제한한다. 중앙 소비자가 장치의 활성 Gateway와 epoch를 확인하고, oneM2M의 응답 RSC 2004와 일치하는 요청 ID를 받은 뒤에만 SDT cursor를 적용 완료로 저장한다. 브로커 세션은 메모리에 있으며 디스크에 저장되는 cursor와 별개다.

Gateway 0.2.14는 적용 영수증을 기다린다. 새 ACL은 해당 Gateway에만 `telemetry-result/{deviceId}/{epoch}` 읽기를, 중앙 소비자에만 쓰기를 부여한다. 이전 프로필을 실행 중이면 새 ACL과 소비자 소스를 함께 적용한다. [적용 영수증 계약](../../integration-candidate/README.md#epoch-관측의-적용-영수증)

기존 개발 이미지가 로컬에 있는 상태에서 역할 저장소 루트 기준으로 실행한다. `$teamCoreRoot`는 팀 main `715ef58`의 `pc-mobius`가 들어 있는 경로이고, `$mobius4Root`는 위에 고정한 upstream checkout이다.

```powershell
./keyring/dev/mobius4/prepare-scoped.ps1 -Mobius4Root $mobius4Root -TeamCoreRoot $teamCoreRoot
./keyring/dev/mobius4/start-scoped.ps1
```

두 번째 명령은 격리 서버와 소비자를 기동하고 빈 oneM2M 자원을 준비한다. 기존 scoped 자원이 있으면 RQI·타입·이름·SDT specialization을 조회해 재사용한다. TLS 키, 임시 관리자 값과 `config/owner.json`은 `.local/scoped/`에만 생성된다. 기본 초기 소유권은 `gw-a`·`kr-handover`·epoch 7이다. 새 소비자는 이 파일을 최초 등록에만 사용하고 이후에는 cursor 저장소의 소유권을 사용한다. 운영 전환에는 중앙 정본과 이전 writer의 drain이 필요하다.

실행 중인 이 임시 프로필에서 ACL과 소비자만 갱신할 때는 시험용 발행자를 멈춘 뒤 아래 명령을 사용한다. 소비자가 정상 종료한 다음 브로커와 소비자만 교체한다. PostgreSQL·Mobius4·TLS proxy와 저장된 cursor는 계속 사용한다. 시작·갱신 명령은 현재 소비자가 `SCOPED_SUBSCRIBED receipts=1 handover=1 feather=1`을 기록한 뒤 반환한다. 대기 시간이 초과되면 현재 컨테이너 상태와 로그를 확인한다.

```powershell
./keyring/dev/mobius4/start-scoped.ps1 -RefreshIngress
```

Gateway에서는 위 포트와 해당 Gateway 인증서를 사용한다. `MQTT_ENABLED=true`, `M2M_MQTT_ENABLED=false`, `CORE_BRIDGE_ENABLED=true`를 지정한다. `CORE_TELEMETRY_EPOCHS`에는 현재 배정된 `kr-handover`의 epoch를 지정하고 `BLE_DEVICES`에는 같은 장치 ID를 쓴다. native cin은 HTTPS를 사용한다. CSE 포트의 `/api/`는 503을 반환하며 명령 벤치에는 별도의 API 포트를 사용한다.

### 명령 영수증 정산 준비

Scoped bootstrap은 명령 영수증 정산 전용 빈 컨테이너도 준비한다. A와 B는 각자 인증서로 자기 컨테이너에만 생성하고 이름으로 조회할 수 있다. 기존 관측·상태·공용 영수증 경로도 유지한다. Gateway HTTPS 경로는 쿼리나 이스케이프 없이 정해진 그대로 사용한다.

| `GATEWAY_ID` | 새 명령 벤치의 `M2M_RECEIPT_CONTAINER` |
|---|---|
| `gw-a` | `/Mobius/privacy-bubble-test-ae/command-receipts-a` |
| `gw-b` | `/Mobius/privacy-bubble-test-ae/command-receipts-b` |

이미 시작한 scoped 서버에 적용할 때는 발행 작업이 끝난 뒤 아래 명령으로 TLS 프록시만 교체하고 전용 컨테이너 두 개를 준비한다. 같은 이름의 컨테이너가 있으면 조회하여 그대로 사용한다. 준비 결과는 `.local/scoped/command-receipts-provisioning.json`에 남긴다. 새 경로는 새 명령 벤치의 전용 SQLite 설정에 지정한다. 기존 DB의 대기 중인 영수증은 원래 경로에서 처리한다. 명령 발급·승인에는 별도의 실제 팀 INTEGRATION mTLS API를 설정한다.

```powershell
./keyring/dev/mobius4/prepare-scoped-command-receipts.ps1
```

2026-11-10에 격리 TLS 프록시의 Gateway별 경로를 반영하고 두 빈 컨테이너를 생성했다. CORE 인증서의 생성 요청은 모두 HTTP 201·oneM2M 2001을 받았고 응답 RQI가 일치했다. [배치 증거](../../evidence/2026-11-10-scoped-command-receipts/provisioning.json)

자원 ID 고정 옵션을 쓰려면 격리 발행을 마친 뒤 아래 명령으로 기존 두 컨테이너의 `ri`를 조회한다. 격리 TLS 프록시만 다시 띄우며, 각 인증서에 자기 컨테이너의 이름 경로 GET과 자원 ID POST를 부여한다. 기존에 저장한 ID와 다르면 갱신을 중단한다.

```powershell
./keyring/dev/mobius4/prepare-scoped-command-receipts.ps1 -PinReceiptRoutes
```

`SCOPED_RECEIPT_PIN gw-a` 뒤의 값은 [새 Pi 명령 세션](../../raspberry-pi-gateway/TESTING.md#pi-명령-세션)의 `--receipt-container-ri`에 사용한다. 2026-11-11에 두 인증서의 자기 컨테이너 GET은 HTTP 200·oneM2M 2000, 교차 GET은 HTTP 403을 확인했다. 실제 영수증 POST 검증은 남아 있다. [핀 배치 증거](../../evidence/2026-11-11-scoped-receipt-pin/provisioning.json)

정산 명령은 CSE loopback 포트에 접근할 수 있는 중앙 측 POSIX 환경에서 실행한다. Node 22 이상, 팀 main `715ef58` 소스, 같은 팀 API가 명령 발급·승인에 사용한 `pc-mobius/integration/state/runtime.json` 또는 그 시점의 로컬 스냅샷이 필요하다. `.local/scoped`에서 CORE 인증서와 CSE 포트를 읽는다. WSL에서 실행할 경우 PC의 해당 loopback 포트에 접근할 수 있어야 하며 정산 디렉터리는 Linux 파일시스템에 둔다.

```sh
tool=./keyring/dev/mobius4/receipt-settlement
npm install --prefix "$tool" --ignore-scripts --no-package-lock
install -d -m 700 "$ledger"
node "$tool/settle.mjs" --team-root "$team_root" --state "$team_state" \
  --ledger "$ledger" --gateway gw-a --command "$issued_command_id"
```

`--ack`에 같은 명령의 CORE MQTT ACK 본문을 담은 로컬 JSON을 선택적으로 지정할 수 있다. 조회는 CSE의 TLS·요청 ID를 검증하고 팀 스냅샷을 한 번만 읽는다. 결과는 JSON 한 줄이다. 신규·중복 정산은 종료 코드 0, 원본 도착 대기는 2, 불일치 검토는 3, 연결·설정·저장 실패는 1이다. 정산 결과는 별도 디렉터리에 저장한다. [정산 계약](../../integration-candidate/README.md#cse-명령-영수증의-중앙-정산-후보)

#### 격리 PostgreSQL 정산 실행

별도 Compose 프로젝트 `privacy-bubble-keyring-receipt-dev`가 PostgreSQL을 `127.0.0.1:5544`에 연다. [Feather 벤치 명령 API](#feather-벤치-명령-api)를 준비할 때 추출한 팀 SQL과 KEYRING의 정산·대기열 SQL을 새 전용 DB에 한 트랜잭션으로 적용한다. 암호는 정산 도구의 `.local/database-password`에 보관한다. Mobius4의 기존 DB와 별도 볼륨을 사용한다.

```powershell
$tool = './keyring/dev/mobius4/receipt-settlement'
& "$tool/prepare-database.ps1"
npm install --prefix $tool --ignore-scripts --no-package-lock
node "$tool/run.mjs"
```

`npm`이 없는 PC에서는 `pnpm --dir $tool install --ignore-scripts --lockfile=false`로 같은 고정 의존성을 준비한다.

정산 프로세스는 scoped 명령 API의 저장된 `runtime.json`을 읽고, CSE 원본을 인증 조회해 대기열과 정산 테이블을 처리한다. 기본으로 최근 승인 120분을 반복해서 확인한다. `--lookback-minutes`로 이전 승인 구간을 포함하거나 `--once`로 복구 한 페이지와 대기열 작업 최대 10건만 실행할 수 있다. 종료할 때는 실행 터미널에서 Ctrl+C를 사용한다. DB만 멈추려면 같은 Compose 파일로 `stop postgres`를 호출한다.

이 개발 프로세스의 입력은 팀 상태와 CSE 원본 조회다. CORE 콜백 인증·구독은 운영 연동에서 별도로 구성한다. 2026-11-10에 전용 DB와 두 빈 KEYRING 테이블을 준비하고, Node 프로세스의 시작과 PostgreSQL 대기열 조회를 확인했다. 실제 명령 영수증의 조회·정산은 남아 있다. [전용 DB 준비 증거](../../evidence/2026-11-10-receipt-database/provisioning.json) · [정산 프로세스 시작 증거](../../evidence/2026-11-10-scoped-receipt-runtime/startup.json)

같은 날 부정 영수증 분류와 CSE 원본 출처 검사가 포함된 코드로 격리 작업자를 다시 시작했다. 준비 로그와 전용 PostgreSQL 연결을 확인했고 전후 대기열·전달·정산은 각 0행이었다. [작업자 갱신 증거](../../evidence/2026-11-10-scoped-receipt-worker-refresh/startup.json)

#### 격리 영수증 콜백 수신

전용 PostgreSQL과 Node 의존성을 준비한 뒤 scoped CA로 단기 중계 인증서를 발급하고 콜백 수신기를 시작한다. 수신기는 등록한 중계 인증서의 SHA-256 지문을 사용한다. 중계 개인키는 PC의 정산 도구 `.local/callback-peer/`에 둔다.

```powershell
$tool = './keyring/dev/mobius4/receipt-settlement'
& "$tool/prepare-callback.ps1"
node "$tool/callback.mjs"
```

`SCOPED_RECEIPT_CALLBACK_READY`가 나오면 `https://127.0.0.1:8790/onem2m/keyring/receipt-notifications`에서 수신한다. 별도 터미널에서 중계를 시작하고 Gateway A/B의 전용 영수증 컨테이너 아래 `keyring-settlement` 구독을 등록한다.

```powershell
& "$tool/prepare-relay.ps1"
```

중계기는 scoped Mobius4와 네트워크 공간을 공유하고 그 안의 `127.0.0.1:8791`에만 바인딩한다. 호스트 포트는 게시하지 않는다. Mobius4의 HTTP POST를 받아 등록된 중계 인증서로 PC의 mTLS 콜백에 전달한다. CSE 컨테이너가 교체됐거나 중계 소스를 갱신했을 때는 `-RefreshRelay`로 중계만 다시 띄운다. 같은 이름의 구독이 이미 있으면 설정을 대조해 재사용한다. [Mobius4 알림 계약](../../integration-candidate/README.md#mobius4-알림에서-원본-정산까지)

2026-11-10에 중계와 PC 수신기의 TLS 연결, 그리고 두 구독의 HTTP 201·oneM2M 2001 응답을 확인했다. 현재 Mobius4는 직접 URL로 등록하는 구독에서 발신 검증을 생략한다. 실제 명령 영수증이 생성될 때의 콜백 수신과 정산은 남아 있다. [콜백 시작 증거](../../evidence/2026-11-10-scoped-receipt-callback/startup.json) · [중계와 구독 준비 증거](../../evidence/2026-11-10-scoped-receipt-relay/provisioning.json)

#### 명령별 영수증 증거 조회

실제 명령 ID가 있으면 아래 명령으로 PostgreSQL 대기열, 전달 경로, 정산 기록을 한 번에 읽는다.

```powershell
node "$tool/inspect.mjs" --gateway gw-a --command $issuedCommandId
```

`deliveries`의 `CSE_CALLBACK`은 인증 콜백에서 수신한 기록이고 `RECOVERY_SWEEP`은 복구 조회가 대기열로 넘긴 기록이다. `queuedNew`가 참인 경로가 처음 대기열 행을 만들었다. `settlement`에는 최종 readback과 승인 이벤트 ID, 영수증 해시가 있다. 2026-11-10에 전달 경로 테이블을 전용 DB에 적용했고 콜백과 작업자의 재기동을 확인했다. 대기열·전달·정산 테이블은 모두 0행이었다. [배치 증거](../../evidence/2026-11-10-scoped-receipt-provenance/provisioning.json)

장치 journal을 검토할 때는 [Gateway 비교 보고서](../../JOURNAL_RETENTION.md#격리-postgresql-정산-기록-대조)를 비공개 파일에 보관한 뒤 같은 Gateway를 지정한다. 한 번의 읽기 쿼리로 최대 32개 명령의 정산 기록을 확인한다.

```powershell
node "$tool/inspect.mjs" --gateway gw-a --journal-report $privateReportPath
```

같은 부팅의 명령 한 건을 지정한 보고서는 수집한 보드·펌웨어 revision, 명령 ID, 적용 uptime과 ACK를 함께 반환한다. 중앙 정산·Pi 전달·최초 `APPLIED` ACK가 모두 확인되면 `originalApplicationMatched`가 참이다. [r18 명령 대조](../../JOURNAL_RETENTION.md#r18-실물-명령-한-건-대조)

### Feather 벤치 명령 API

PC의 `https://127.0.0.1:8787`에 팀 main `715ef58`의 mTLS API를 띄운다. 런처는 로컬 Git 객체에서 해당 팀 소스를 추출하고 scoped CA로 벤치 운영자 인증서를 발급한다. Git for Windows의 OpenSSL을 기본으로 사용한다. 첫 시작에 `gw-a`의 `keyring-feather-lab`과 벤치 주체 `scoped-feather-bench`를 등록한다. 이후 시작은 같은 등록을 읽고 저장된 자격 상태를 유지한다.

```powershell
./keyring/dev/mobius4/start-scoped-command-api.ps1
```

등록 뒤 `READY`가 출력되면 해당 터미널에서 API가 실행 중이다. Pi의 Gateway A 인증서는 명령 조회·현재 승인·자격 상태만 사용할 수 있다. 운영자 인증서는 벤치 주체의 동의, grant 발급·회수와 해당 Gateway 명령 발급에 사용한다. 동의·grant·장치 명령은 시작 과정에서 생성하지 않는다. 운영자 개인키는 PC의 `.local/scoped/command-api/`에 둔다.

이 명령 벤치는 관측용 Feather `0.1.1`과 별도로 명령 프로필 `0.2.0` 및 새 Pi SQLite를 사용한다. 승인된 시험에서 PC의 두 포트를 Pi loopback으로 전달한다. `$piHost`에는 해당 Pi의 SSH 접속 주소를 지정한다. 포워딩이 준비된 동안 터미널을 열어 둔다.

```powershell
ssh -N -T -o ExitOnForwardFailure=yes `
  -R 127.0.0.1:8760:127.0.0.1:8760 -R 127.0.0.1:8787:127.0.0.1:8787 $piHost
```

Pi에는 scoped CA의 `ca.pem`, `gateway-a.pem`, `gateway-a.key`를 소유자 전용 폴더에 둔다. `gw-a`의 mTLS 인증서를 검증한 임시 프록시가 CSE originator를 매핑하므로 `CSE_ADMIN`은 PC에 둔다. Gateway 설정과 SQLite 생성은 [Pi 명령 세션](../../raspberry-pi-gateway/TESTING.md#pi-명령-세션) 절차를 따른다.

새 scoped CA에는 `keyCertSign`과 `cRLSign`이 담긴 critical `keyUsage`가 포함된다. 이전 격리 CA를 쓰는 환경에서는 Pi의 엄격한 TLS 검증이 이 확장을 요구할 수 있다. 보완한 격리 CA로 인증서 검증과 Pi 사전 점검을 다시 수행한다.

명령 프로필의 관측은 `gw-a` 전용 `command-observations-a`에, 영수증은 `command-receipts-a`에 보낸다. 이미 시작한 scoped 프로필에서는 발행을 마친 뒤 `prepare-scoped-command-receipts.ps1 -FeatherObservationsOnly`로 관측 컨테이너만 준비한다. [관측 컨테이너 배치 증거](../../evidence/2026-11-10-scoped-feather-led-cycle/provisioning.json)

관측 자원 ID 고정을 쓰는 새 Pi 세션에는 발행을 멈춘 뒤 아래 명령으로 기존 컨테이너의 `ri`를 조회한다. 격리 프록시는 `gw-a`의 컨테이너 이름 GET과 해당 ID의 POST를 허용한다. 기존에 고정한 `ri`와 다른 자원이 조회되면 프록시 갱신 전에 멈춘다.

```powershell
./keyring/dev/mobius4/prepare-scoped-command-receipts.ps1 -PinObservationRoute
```

출력의 `SCOPED_OBSERVATION_PIN gw-a` 뒤 ID를 새 Pi 세션의 `--observation-container-ri`에 넣는다. 영수증 ID는 `-PinReceiptRoutes`로 별도로 확인한다. [Pi 명령 세션](../../raspberry-pi-gateway/TESTING.md#pi-명령-세션)

정산 명령의 `--team-root`에는 `.local/scoped/command-api/team-source`, `--state`에는 같은 폴더의 `runtime.json`을 넣는다. 다른 연결 설정은 [Feather 명령 프로필](../../firmware/feather_probe/README.md#내장-led를-쓰는-명령-프로필)과 [Scoped LED 시험 절차](../../raspberry-pi-gateway/TESTING.md#기존-scoped-mobius4에서-feather-led-시험)를 따른다. 2026-11-10에는 로컬 API 리스너와 장치 등록까지 준비했다. [API 배치 증거](../../evidence/2026-11-10-scoped-command-api/provisioning.json)

#### 최신 INTEGRATION API 벤치

팀 main `bc2a45d`는 새 포트 `127.0.0.1:8788`과 `.local/scoped/command-api-integration/`을 사용한다. 이 폴더에 고정한 팀 소스, 계약, 운영자 인증서와 중앙 상태를 둔다. 첫 실행에서 `gw-a`, 시험용 가구와 장치 `keyring-feather-lab`을 등록한다. 기존 등록은 동일한 Gateway·가구·장치인지 대조한다.

```powershell
$tool = './keyring/dev/mobius4'
& "$tool/start-scoped-command-api.ps1" -Mode integration -PrepareOnly
npm --prefix "$tool/.local/scoped/command-api-integration/team-source/pc-mobius" ci --omit=dev --ignore-scripts
& "$tool/start-scoped-command-api.ps1" -Mode integration
```

PC에 pnpm이 설치돼 있으면 패키지 설치 단계에서 팀의 `package-lock.json`을 읽어 같은 프로필에 pnpm 잠금 파일을 만들 수 있다.

```powershell
$teamPackage = "$tool/.local/scoped/command-api-integration/team-source/pc-mobius"
pnpm --dir $teamPackage import
pnpm --dir $teamPackage install --frozen-lockfile --prod --ignore-scripts
```

`READY`의 `mode`가 `integration`이면, Pi의 시험 세션을 새로 준비하면서 `--api-mode integration`을 지정한다. SSH 포워딩의 PC·Pi API 포트는 둘 다 `8788`을 사용한다. 이 모드는 Gateway 0.2.47 이상의 `dispatch-start`, 중앙 영수증과 중앙 관측을 켠다. PC의 LED 도구에도 `--api-mode integration`을 사용한다. [Pi 세션 설정](../../raspberry-pi-gateway/TESTING.md#pi-명령-세션)

통합 런처의 `GET /api/v1/gateways/gw-a/bench-capabilities`는 시험 Gateway 인증서에 모드와 팀 커밋, 지원 경로를 반환한다. Pi는 이 응답을 확인한 뒤 시작한다.

중앙 정산의 정본은 최신 프로필의 `runtime.json`에 있는 `gatewayCommands`와 `gatewayDeviceReceipts`다. `gatewayTelemetry`에는 수용한 관측의 식별자와 암호화된 위치 참조가 남는다. 기존 벤치의 콜백·PostgreSQL 정산 도구는 기존 프로필을 읽는다.

통합 모드의 LED 도구는 같은 명령이 중앙에서 `APPLIED_VERIFIED`로 정산된 뒤 다음 단계로 넘어간다. 완료 증거는 Pi SQLite 사본과 이 프로필의 중앙 상태 사본을 읽어 대조한다. [최신 중앙 API 시험 결과 대조](../../raspberry-pi-gateway/TESTING.md#최신-중앙-api의-시험-결과-대조)

2026-11-11에 잠금 파일로 Node 패키지를 설치하고 `8788`의 루프백 리스너와 시험 Gateway·가구·장치 등록을 확인했다. [준비 기록](../../evidence/2026-11-11-current-central-bench/provisioning.json)

#### r18 격리 명령 API

`r18` 프로필은 PC의 `127.0.0.1:8789`와 `.local/scoped/command-api-r18/`을 사용한다. `gw-b` 인증서에 `keyring-r18-lab`과 시험 주체 `scoped-r18-bench`를 등록한다. `READY`와 Pi의 인증된 기능 조회에는 `r18-hand-solder`, `keyring-0.7.14`가 함께 표시된다.

```powershell
$tool = './keyring/dev/mobius4'
& "$tool/start-scoped-command-api.ps1" -Mode r18 -PrepareOnly
npm --prefix "$tool/.local/scoped/command-api-r18/team-source/pc-mobius" ci --omit=dev --ignore-scripts
& "$tool/start-scoped-command-api.ps1" -Mode r18
```

격리 Mobius4에서 발행을 멈춘 뒤 아래 명령으로 `command-receipts-b`, `command-observations-b`, `command-health-b`를 준비하고 `gw-b`의 receipt·observation ID를 확인한다.

```powershell
& "$tool/prepare-scoped-command-receipts.ps1"
& "$tool/prepare-scoped-command-receipts.ps1" -R18TelemetryOnly
& "$tool/prepare-scoped-command-receipts.ps1" -PinReceiptRoutes
& "$tool/prepare-scoped-command-receipts.ps1" -PinR18ObservationRoute
```

Pi loopback에 기존 CSE 포트와 API `8789`를 전달한다. Pi에서는 Gateway B 인증서와 고정 ID를 넣어 [r18 Pi 명령 세션](../../raspberry-pi-gateway/TESTING.md#r18-pi-명령-세션)을 준비한다. 중앙 상태 사본은 `command-api-r18/runtime.json`에서 확보한다. 이 프로필의 실제 준비·실행·명령 발급은 미실행이다.

### 격리 소유권 전환

새 소비자와 ACL을 배치한 뒤 아래 명령을 쓴다. `Forward`는 A의 epoch 7에서 B의 8로, `Rollback`은 B의 8에서 A의 9로 전환한다. 이전 epoch 토픽은 지연 관측 재현을 위해 격리 ACL에 남긴다. 실제 활성 소유권은 소비자가 대조한다.

```powershell
./keyring/dev/mobius4/handover-scoped.ps1 -Status
./keyring/dev/mobius4/handover-scoped.ps1 -Direction Forward
./keyring/dev/mobius4/handover-scoped.ps1 -Direction Rollback
```

전환 요청은 SDT 갱신과 같은 대기열에서 처리된다. `PENDING` cursor, 이전 소유권 불일치, 저장 결과 불확실 상태에서는 전환 완료를 반환하지 않는다. 명령 대기 시간이 초과되면 `-Status`로 영속 소유권과 cursor 상태를 읽는다. 격리 프로필에 handover 소비자·ACL을 배치하고 `-Status`로 초기 A7을 확인했다. [배치 기록](../../evidence/2026-11-10-core-scoped-handover-rollout/README.md)

### Feather 벤치 경로

화면과 두 버튼만 쓰는 `feather-probe-0.1.1` 벤치용으로 `featherState` SDT와 전용 토픽을 준비했다. Pi에서 Gateway 0.2.19의 [scoped relay](../../firmware/feather_probe/README.md#feather-scoped-적용-영수증)를 사용하는 경우, 등록된 실제 BLE 주소에 `keyring-feather-lab`을 지정하고 아래 값을 사용한다.

```dotenv
GATEWAY_ID=gw-a
FIRMWARE_REVISION_ALLOWLIST=feather-probe-0.1.1
BLE_GATT_PROFILE=core-v1
MQTT_ENABLED=true
M2M_MQTT_ENABLED=false
CORE_BRIDGE_ENABLED=true
CORE_TELEMETRY_EPOCHS={"keyring-feather-lab":1}
MQTT_HOST=localhost
MQTT_PORT=8884
M2M_CSE_URL=https://localhost:8760
PC_API_URL=https://localhost:8760
```

Pi가 별도 호스트라면 PC의 loopback HTTPS 8760과 MQTT 8884를 승인된 SSH reverse tunnel로 Pi의 loopback에 연결한다. scoped CA와 `gateway-a.pem`·`gateway-a.key`만 해당 Pi의 private 경로로 전달한다. CSE originator와 native 컨테이너는 기존 scoped 로컬 설정을 따른다.

이 벤치의 배터리와 미확인 RSSI는 `null`로 보낸다. A0·A1과 해제는 native `observations`의 `buttonState`로 확인한다. `featherState`에는 기존 펌웨어의 관측 `state`가 들어간다. Gateway A는 이 자원을 읽을 수 있고, scoped 소비자가 갱신한다. 빈 자원의 Gateway A HTTPS 조회를 확인했다. Pi의 실제 관측·영수증 왕복은 아직 실행하지 않았다. [서버 준비 기록](../../evidence/2026-11-10-core-scoped-feather-rollout/README.md) · [읽기 경로 준비](../../evidence/2026-11-10-core-scoped-feather-readback/README.md)

```powershell
docker compose --project-name privacy-bubble-keyring-scoped --profile receipt-relay --env-file ./keyring/dev/mobius4/.local/scoped/compose.env -f ./keyring/dev/mobius4/compose.yaml -f ./keyring/dev/mobius4/compose.scoped.yaml down
```

[격리 프로필 준비 기록](../../evidence/2026-11-10-core-scoped-stack/README.md) · [영수증 ACL·소비자 배치 기록](../../evidence/2026-11-10-core-scoped-receipt-rollout/README.md)
