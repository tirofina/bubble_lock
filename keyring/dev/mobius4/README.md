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

나중에 실제 Mobius 서버로 바꿀 때는 `M2M_CSE_URL`/RVI/Originator/container/CA·credential과 `PC_API_URL`을 교체한다. dev CA·관리자 매핑·local DB를 운영 환경에 이관하지 않는다.

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

2026-11-10에 격리 TLS 프록시의 Gateway별 경로를 반영하고 두 빈 컨테이너를 생성했다. CORE 인증서의 생성 요청은 모두 HTTP 201·oneM2M 2001을 받았고 응답 RQI가 일치했다. Gateway 인증서별 접근과 실제 영수증 정산은 별도 확인이 남아 있다. [배치 증거](../../evidence/2026-11-10-scoped-command-receipts/provisioning.json)

정산 명령은 CSE loopback 포트에 접근할 수 있는 중앙 측 POSIX 환경에서 실행한다. Node 22 이상, 팀 main `715ef58` 소스, 같은 팀 API가 명령 발급·승인에 사용한 `pc-mobius/integration/state/runtime.json` 또는 그 시점의 로컬 스냅샷이 필요하다. `.local/scoped`에서 CORE 인증서와 CSE 포트를 읽는다. WSL에서 실행할 경우 PC의 해당 loopback 포트에 접근할 수 있어야 하며 정산 디렉터리는 Linux 파일시스템에 둔다.

```sh
tool=./keyring/dev/mobius4/receipt-settlement
npm install --prefix "$tool" --ignore-scripts --no-package-lock
install -d -m 700 "$ledger"
node "$tool/settle.mjs" --team-root "$team_root" --state "$team_state" \
  --ledger "$ledger" --gateway gw-a --command "$issued_command_id"
```

`--ack`에 같은 명령의 CORE MQTT ACK 본문을 담은 로컬 JSON을 선택적으로 지정할 수 있다. 조회는 CSE의 TLS·요청 ID를 검증하고 팀 스냅샷을 한 번만 읽는다. 결과는 JSON 한 줄이다. 신규·중복 정산은 종료 코드 0, 원본 도착 대기는 2, 불일치 검토는 3, 연결·설정·저장 실패는 1이다. 정산 결과는 별도 디렉터리에 저장한다. [정산 계약](../../integration-candidate/README.md#cse-명령-영수증의-중앙-정산-후보)

### Feather 벤치 명령 API

PC의 `https://127.0.0.1:8787`에 팀 main `715ef58`의 mTLS API를 띄운다. 런처는 로컬 Git 객체에서 해당 팀 소스를 추출하고 scoped CA로 벤치 운영자 인증서를 발급한다. Git for Windows의 OpenSSL을 기본으로 사용한다. 첫 시작에 `gw-a`의 `keyring-feather-lab`과 벤치 주체 `scoped-feather-bench`를 등록한다. 이후 시작은 같은 등록을 읽고 저장된 자격 상태를 유지한다.

```powershell
./keyring/dev/mobius4/start-scoped-command-api.ps1
```

등록 뒤 `READY`가 출력되면 해당 터미널에서 API가 실행 중이다. Pi의 Gateway A 인증서는 명령 조회·현재 승인·자격 상태만 사용할 수 있다. 운영자 인증서는 벤치 주체의 동의, grant 발급·회수와 해당 Gateway 명령 발급에 사용한다. 동의·grant·장치 명령은 시작 과정에서 생성하지 않는다. 운영자 개인키는 PC의 `.local/scoped/command-api/`에 둔다.

이 명령 벤치는 관측용 Feather `0.1.1`과 별도로 명령 프로필 `0.2.0` 및 새 Pi SQLite를 사용한다. PC의 두 loopback 포트를 승인된 SSH 역방향 터널로 Pi의 loopback에 연결할 때는 8760과 8787을 각각 전달한다. Pi에는 scoped CA와 Gateway A 인증서 및 키를 사용한다.

```dotenv
GATEWAY_ID=gw-a
FIRMWARE_REVISION_ALLOWLIST=feather-probe-0.2.0
BLE_GATT_PROFILE=core-v1
M2M_CSE_URL=https://127.0.0.1:8760
M2M_RECEIPT_CONTAINER=/Mobius/privacy-bubble-test-ae/command-receipts-a
PC_API_URL=https://127.0.0.1:8787
MQTT_ENABLED=false
CORE_BRIDGE_ENABLED=false
```

정산 명령의 `--team-root`에는 `.local/scoped/command-api/team-source`, `--state`에는 같은 폴더의 `runtime.json`을 넣는다. 다른 연결 설정은 [Feather 명령 프로필](../../firmware/feather_probe/README.md#내장-led를-쓰는-명령-프로필)을 따른다. 2026-11-10에는 로컬 API 리스너와 장치 등록까지 준비했다. [배치 증거](../../evidence/2026-11-10-scoped-command-api/provisioning.json)

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
docker compose --project-name privacy-bubble-keyring-scoped --env-file ./keyring/dev/mobius4/.local/scoped/compose.env -f ./keyring/dev/mobius4/compose.yaml -f ./keyring/dev/mobius4/compose.scoped.yaml down
```

[격리 프로필 준비 기록](../../evidence/2026-11-10-core-scoped-stack/README.md) · [영수증 ACL·소비자 배치 기록](../../evidence/2026-11-10-core-scoped-receipt-rollout/README.md)
