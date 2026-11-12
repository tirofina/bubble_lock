# Raspberry Pi Gateway

DOC-REV 2.0.0의 팀 CORE 계약을 연결했다. `BLE_GATT_PROFILE=core-v1`이 새 기본값이며 기존 UUID는 `keyring-v01`로 지정한다. `CORE_BRIDGE_ENABLED=true`는 telemetry/성공 ACK의 영속 전송과 command topic 수신을 추가한다. 원본 oneM2M cin·권한 검사는 유지한다. CORE payload 차이와 승인 필드 공백은 [연동 메모](../CORE_INTEGRATION.md)를 따른다. 로컬 테스트 서버 설정은 [Mobius4](../dev/mobius4/README.md)에 있다.

Gateway 0.2.12의 선택 설정 `CORE_TELEMETRY_EPOCHS`는 `BLE_DEVICES`에 등록한 모든 장치의 epoch를 담은 JSON 객체다. 각 epoch는 중앙 배정값이며 0부터 2147483647 사이의 정수여야 한다. `CORE_BRIDGE_ENABLED=true`에서만 쓸 수 있다. 전환 후 이전 epoch와 기존 unscoped 전송 행은 SQLite에 보류된다. 설정을 생략하면 기존 CORE 토픽을 사용하며 epoch가 저장된 행은 보류된다. 배포 전 [정확한 토픽 ACL과 중앙 수신 조건](../integration-candidate/README.md#발행-당시-epoch를-보존하는-mqtt-수신-후보)을 충족해야 한다.

Gateway 0.2.13에서는 `M2M_MQTT_ENABLED=false`로 native cin을 HTTPS에 고정한 채 CORE MQTT를 별도로 사용할 수 있다. 생략하면 native MQTT는 `MQTT_ENABLED`를 따른다. 이 설정은 oneM2M listener가 없는 [격리 epoch 브로커](../dev/mobius4/README.md#epoch-전용-mqtt-프로필)에 사용한다.

Gateway 0.2.14부터 epoch 관측은 일치하는 CSE 적용 영수증을 받아야 SQLite에서 완료 처리한다. 일반 관측과 명령 영수증은 scoped 응답 대기와 별도로 전송한다. 중앙 소비자와 응답 토픽 ACL을 같은 변경으로 배치한다. [적용 영수증 계약](../integration-candidate/README.md#epoch-관측의-적용-영수증)

Gateway 0.2.15의 `bubble-gateway-state retire-core`는 전환 뒤 보류된 이전 epoch 행을 운영자가 보관하고 정리할 때 사용한다. daemon을 중지하고 현재보다 낮은 epoch를 명시하면 격리 스냅샷과 보관 계획을 저장한 뒤 해당 CORE 행만 정리한다. [상태 보관 절차](STATE_RECOVERY.md#종료된-core-epoch-보관)

임시 Mobius4에서 팀 서버로 전환하기 전에 `bubble-gateway-state plan-cutover`로 기존 DB의 대기열과 명령 저널을 확인한다. 현재 환경과 전환 후보 환경을 각각 지정한다. [전환 전 대기열 확인](STATE_RECOVERY.md#전환-전-대기열-확인)

Python 3.11 이상과 Linux BlueZ를 사용하는 KEYRING 현장 daemon이다. BLE 관측을 SQLite outbox에 저장하고 MQTT 또는 HTTPS로 oneM2M contentInstance를 생성한다. 중앙에서 받은 명령은 최신 승인·credential·deadline을 확인한 뒤 BLE로 전달한다.

Pi Zero 2 W의 별도 시험 폴더에 Gateway 0.2.5를 설치했다. 임시 사용자 systemd 서비스로 전체 데몬을 실행해 실제 Feather 관측 27개와 Gateway 상태 16개를 격리 Mobius4에서 확인했다. 재시작 뒤 SQLite에 남은 관측 한 건의 원본 해시도 CSE와 일치했다. 0.2.4에서 수행한 버튼 관측과 PC 모의 GATT 명령 시험은 각각 별도 증거다. 실물 명령과 배포용 systemd 설정 시험이 남아 있다. [Pi 전체 데몬](../evidence/2026-11-10-pi-full-daemon/README.md) · [버튼 관측](../evidence/2026-11-10-pi-feather/README.md) · [명령 통합 시험](../evidence/2026-11-10-central-dispatch/README.md)

아래 절차는 중앙 인증서·API와 연결할 전체 Gateway 배포용이다. Gateway 0.2.6의 배포용 시작 검사는 로컬 Linux systemd와 시험용 TLS 파일로 검증했다. Pi 실물 실행은 위의 0.2.5 벤치 결과다. [시작 검사 시험](../evidence/2026-11-10-deployment-preflight/README.md)

[BLE_SESSIONS.md](BLE_SESSIONS.md)에 연결 교체 시 남은 명령 조각 전송 중단·이전 callback 무시·실패한 handshake의 ready 차단을 설명한다. GATT/중앙 wire schema와 DB format은 유지한다.

[RECEIPT_ROUTING.md](RECEIPT_ROUTING.md)에 native 영수증과 CORE ACK의 최초 원자적 등록·독립 재시도·중복 생성 차단을 설명한다. CORE projection 선택은 최초 staging 시 고정하며 설정 변경만으로 과거 native 영수증에 ACK를 소급 생성하지 않는다.

[최신 HTTPS/TLS 실행 증거](../evidence/2026-10-30-https-tls/README.md)에 임시 PKI·loopback server로 확인한 TLS1.3/mTLS·실패 경계를 기록한다. 개발 suite는 OpenSSL 실행 파일이 필요하다. 실제 운영 PKI·MQTT ACL·Pi/CSE 통합은 별도다.

[별도 MQTT wire6개](../evidence/2026-10-30-mqtt-wire/README.md)는 임시 Mosquitto2.1.2·TLS1.3/mTLS·CN topic ACL·application receipt·HTTPS fallback을 실제 broker로 확인했다. 기본55개와 구분해 명시 실행하며, 기존 운영/개발 서버는 변경하지 않는다.

## 먼저 준비할 환경

- Python 3.11+, Bluetooth LE 어댑터, BlueZ system bus, 올바르게 동기화된 시스템 시계.
- 이번 작업의 코드가 포함된 저장소를 `/opt/bubble_lock`에 복사한 배포본. 원격 main에 이 코드가 이미 있다고 가정하지 않는다.
- [펌웨어 안내](../firmware/README.md)에 따라 장치별 deviceId·passkey가 설정된 키링. flash 절차도 해당 문서에 있으며 이번 작업에서 실행하지 않았다.
- PC-MOBIUS 담당이 발급·등록한 Gateway client certificate와 private key, 서버 CA bundle.
- 중앙 commands/authorize/credentials API와 AE·container·ACP·broker ACL. 현재 API는 [계약 후보](../INTERFACE_NOTES.md)이므로 중앙의 준비가 필요하다.

HTTP와 MQTT는 동일 CA/client certificate/key를 사용하며 TLS 1.3 이상을 요구한다. CA bundle에는 두 서버를 검증할 수 있는 발급 체인이 있어야 한다. credential 발급·등록·회전은 이 daemon이 수행하지 않는다.

## 설치 절차

아래는 Raspberry Pi OS 계열의 최초 설치 예시다. `/path/to/prepared/bubble_lock`와 `/path/to/issued`는 실제 전달받은 파일 경로로 바꾼다. 이미 존재하는 계정에는 useradd를 반복하지 않는다.

```sh
sudo apt update
sudo apt install python3 python3-venv bluez dbus
sudo useradd --system --user-group --home-dir /var/lib/privacy-bubble-gateway --no-create-home --shell /usr/sbin/nologin bubble-gateway
sudo install -d -o root -g root -m 0755 /opt/bubble_lock
sudo cp -a /path/to/prepared/bubble_lock/. /opt/bubble_lock/
sudo python3 -m venv /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv
sudo /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/python -m pip install /opt/bubble_lock/keyring/raspberry-pi-gateway
sudo install -d -o root -g bubble-gateway -m 0750 /etc/privacy-bubble
sudo install -d -o root -g bubble-gateway -m 0750 /etc/privacy-bubble/tls
sudo install -d -o bubble-gateway -g bubble-gateway -m 0700 /var/lib/privacy-bubble-gateway
sudo install -o root -g bubble-gateway -m 0640 /path/to/issued/ca.pem /etc/privacy-bubble/tls/ca.pem
sudo install -o root -g bubble-gateway -m 0640 /path/to/issued/client.pem /etc/privacy-bubble/tls/client.pem
sudo install -o root -g bubble-gateway -m 0640 /path/to/issued/client.key /etc/privacy-bubble/tls/client.key
sudo install -o root -g bubble-gateway -m 0640 /opt/bubble_lock/keyring/raspberry-pi-gateway/.env.example /etc/privacy-bubble/gateway.env
sudoedit /etc/privacy-bubble/gateway.env
```

`.env.example`의 `REPLACE_*`, `*.example.invalid`, `00:00:00:00:00:00`은 실제 값이 없는 placeholder다. 인증서나 개인키 원문은 환경변수에 넣지 않고 파일 경로로 전달한다. 환경 파일은 `KEY=value` 형식이며 shell 명령·변수 치환을 사용하지 않는다.

새 배포에는 `M2M_CSE_DEPLOYMENT_ID`와 전용 `GATEWAY_DATABASE`를 지정한다. 기존 DB를 계속 쓰거나 CSE 주소만 옮길 때는 [상태 보관과 배포 전환](STATE_RECOVERY.md#cse-배포-전환)의 설정을 따른다.

중앙 경로 설정은 다음을 구분한다.

| 설정 | 의미 |
|---|---|
| `M2M_CSE_URL` | `https://host:port` 형태의 origin. `/Mobius`는 넣지 않음 |
| `M2M_*_CONTAINER` | `/Mobius/{AE}/observations`처럼 전체 oneM2M resource path |
| `PC_API_URL` | HTTPS base URL. 코드가 `/api/v1/gateways/{GATEWAY_ID}`를 덧붙임. `/api/v1`을 중복 입력하지 않음 |
| `PC_API_DEPLOYMENT_ID` | 새 DB를 중앙 API 저장소에 연결하는 선택 설정. 같은 저장소의 주소를 바꾸면 ID를 유지하고, 새 저장소에는 새 ID와 DB 경로를 지정함. [중앙 API 배포 전환](STATE_RECOVERY.md#중앙-api-배포-전환) |
| `PC_DISPATCH_START_REQUIRED` | `true`일 때 BLE 쓰기 전 중앙 `POST /dispatch-start` 승인을 요구함. 기존 고정 벤치 프로필의 기본값은 `false`. [명령 기한](BLE_SESSIONS.md#승인-기한과-gatt-전송) |
| `COMMANDS_ENABLED` | 기본 `true`. `false`이면 관측·health 전송을 유지하고 명령 조회·실행·장치 명령 영수증 처리를 중지함. 관측·health와 분리된 영수증 컨테이너가 필요함. [r18 관측 전용 세션](TESTING.md#r18-pi-관측-전용-세션) |
| `NATIVE_OBSERVATION_TRACE` | 기본 `false`. `true`이면 Mobius4 관측 응답을 확인하고 Pi outbox에서 완료 처리한 뒤 INFO 로그에 요청 ID, 본문 해시, 전송 확인 경로, 새 자원 생성 여부와 Gateway 부팅 ID를 기록함. |
| `CENTRAL_RECEIPTS_ENABLED` | `true`일 때 중앙 `POST /receipts`에 명령 영수증을 보냄. 기본값은 `false`. 같은 중앙 배포에서 기존 DB로 활성화하면 이전 영수증도 전송 대기열에 추가함. [중앙 영수증 정산](RECEIPT_ROUTING.md#중앙-명령-영수증-정산) |
| `CENTRAL_TELEMETRY_ENABLED` | `true`일 때 새 BLE 관측을 중앙 `POST /telemetry`에도 보냄. 기본값은 `false`. 중앙 배포의 Gateway·장치·가구 등록이 필요함. [중앙 관측 전달](IO_NOTES.md#중앙-관측-전달) |
| `CENTRAL_TELEMETRY_RETENTION_SECONDS` | 중앙 관측 서버의 보관 기간과 같은 초 단위 값. 기본 `86400`, 범위 `1`~`86400`. Pi는 시계 오차 여유 2초를 더한 뒤 중앙 복제본을 만료 처리함. |
| `M2M_ORIGINATOR`, `M2M_CSE_ID` | MQTT topic의 단일 segment이면서 중앙과 합의한 식별자 |
| `M2M_RVI` | 예시 `3`을 그대로 확정값으로 사용하지 않고 Mobius capability probe 결과로 결정 |
| `MQTT_WRAPPED_PRIMITIVE` | 기본 `false`는 flat oneM2M primitive. PC capability probe에서 `m2m:rqp` wrapper가 필요한 경우에만 `true`로 설정하며 다른 형식의 자동 재시도는 하지 않음 |
| `BLE_DEVICES` | `deviceId → 실제 BLE 주소` JSON 객체. 1~32대, 중복 주소 불허 |
| `BLE_OBSERVATION_TIMEOUT` | 새 관측 알림 없이 연결을 유지할 최대 시간. 기본 30초, 범위 5~300초. 초과하면 해당 장치를 다시 연결함. |
| `FIRMWARE_REVISION_ALLOWLIST` | 쉼표로 구분한 정확한 firmwareRevision. 비워 두면 추가 revision 제한만 생략 |
| `BLE_BOARD_REVISION` | 설정하면 해당 Gateway의 BLE 장치가 읽어 준 boardRevision이 이 값과 일치해야 구독과 명령 준비가 진행됨 |

## BlueZ 등록

keyring-0.5.0 장치의 NVS journal을 수동으로 보관하는 `bubble-keyring-journal` 명령도 제공한다. 실제 장치 ID/revision을 대조하고 새 private 폴더에만 기록한다. 자동 실행·NVS 삭제·공간 회수는 없다. [사용 절차와 정산 미확정 항목](../JOURNAL_RETENTION.md)을 따른다. 이번 작업에서는 CLI·장비·빌드·검증을 실행하지 않았다.

서비스 전용 그룹에 BlueZ D-Bus 접근 권한을 부여한다. 일반 사용자 전체에 pairing 권한을 열거나 자동으로 모든 passkey를 승인하는 agent를 추가하지 않는다.

```sh
sudo install -o root -g root -m 0644 /opt/bubble_lock/keyring/raspberry-pi-gateway/deploy/org.bluez.keyring.conf /etc/dbus-1/system.d/org.bluez.keyring.conf
sudo systemctl reload dbus
sudo systemctl start bluetooth
bluetoothctl
```

`bluetoothctl`의 대화형 프롬프트에서 다음 순서로 실제 키링을 등록한다. `AA:BB:CC:DD:EE:FF`도 예시 주소다. 요청되는 passkey에는 해당 장치에 설정한 값을 입력한다.

```text
power on
agent KeyboardOnly
default-agent
scan on
pair AA:BB:CC:DD:EE:FF
trust AA:BB:CC:DD:EE:FF
scan off
quit
```

bonding이 완료된 주소를 `BLE_DEVICES`에 넣는다. `BLE_PAIR=true`는 필수다. daemon 자체는 passkey 입력 UI나 자동 승인 agent를 제공하지 않으므로 새 장치의 첫 등록은 이 과정이 필요하다. 실제 Raspberry Pi 어댑터·BlueZ의 scan/connection·bond는 Feather 벤치에서 확인했으며, 실물 키링 PCB 등록과 전체 daemon 경로는 추가 시험 대상이다.

## 수동 실행 또는 systemd 배포

0.2.6 이상에서 배포 파일을 설치하기 전에 서비스 계정으로 로컬 설정을 점검한다.

```sh
sudo -u bubble-gateway env STATE_DIRECTORY=/var/lib/privacy-bubble-gateway \
  /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-gateway \
  --env-file /etc/privacy-bubble/gateway.env --check-config
```

`--check-config`는 로컬 CA 및 인증서·개인키를 로드하고 키 일치를 확인한다. 0.2.88은 `STATE_DIRECTORY`를 지정한 배포에서 DB·잠금 파일과 SQLite의 WAL·공유 메모리·롤백 저널이 해당 경로 안에 있는지 확인한다. 서비스 계정에는 상태 디렉터리의 쓰기·탐색 권한, 기존 SQLite 파일의 읽기·쓰기 권한, 기존 잠금 파일의 쓰기 권한이 필요하다. 기존 DB의 배포 식별자와 스키마는 읽기 전용 연결로 검사한다. 새 DB는 생성하지 않는다. 서버 인증, 중앙 등록 상태, BlueZ 권한은 실제 연결 단계에서 확인한다.

컨테이너 ID를 설정한 명령 Gateway는 같은 환경 파일에서 `--check-command-route`로 CSE 영수증 컨테이너와 중앙 자격, 활성 명령 목록을 HTTPS GET으로 확인할 수 있다. [격리 Pi 사용 절차](TESTING.md#pi-명령-세션)

Gateway 0.2.121의 `bubble-gateway --env-file gateway.env --check-cse-routes`는 새 Mobius의 관측·health 컨테이너 ID를 HTTPS GET으로 대조한다. 명령이 활성화된 설정은 영수증 컨테이너 ID도 요구한다. 중앙 API가 준비되기 전에 Pi에 넣을 CSE 설정을 먼저 확인할 수 있다. [서버 전환 절차](STATE_RECOVERY.md#새-배포-db에-core-순번-이어받기)

Gateway 0.2.122에서 중앙 API의 PKI가 다르면 `PC_API_TLS_CA_FILE`, `PC_API_TLS_CERT_FILE`, `PC_API_TLS_KEY_FILE`을 함께 지정한다. 이 파일은 중앙 API의 HTTPS 연결에 사용한다. Mobius HTTPS와 MQTT는 `TLS_CA_FILE`, `TLS_CERT_FILE`, `TLS_KEY_FILE`을 사용한다. 중앙 전용 설정을 생략하면 세 경로가 기존 TLS 파일을 공유한다. 두 HTTPS 연결 모두 TLS 1.3과 호스트 이름 검증을 적용하며 `--check-config`에서 구성한 인증서와 키를 읽어 확인할 수 있다. [설정 예시](.env.example)

foreground 실행 명령은 다음과 같다. 같은 데이터베이스를 사용하는 프로세스는 하나만 허용한다. systemd 서비스가 이미 실행 중이면 중복으로 실행하지 않는다.

```sh
sudo -u bubble-gateway /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-gateway --env-file /etc/privacy-bubble/gateway.env --log-level INFO
```

배포용 unit은 같은 환경과 서비스 계정으로 `--check-config`를 실행한 뒤 데몬을 시작한다. 기존 설치를 업그레이드할 때는 unit을 교체하기 전에 해당 가상환경의 Gateway를 0.2.6 이상으로 올리고 위 점검을 통과시킨다. 서비스 배포 시 아래 명령을 사용한다.

```sh
sudo install -o root -g root -m 0644 /opt/bubble_lock/keyring/raspberry-pi-gateway/deploy/privacy-bubble-gateway.service /etc/systemd/system/privacy-bubble-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now privacy-bubble-gateway.service
```

서비스는 `bubble-gateway` 계정으로 실행되고 `/var/lib/privacy-bubble-gateway`만 지속 상태 쓰기 경로로 사용한다. 소스·설정·인증서는 읽기 전용이고 BlueZ는 system D-Bus로 접근한다. 네트워크 namespace는 분리하지 않는다. 로그는 journal에 남으며 payload·키 원문을 출력하지 않도록 작성했다. 설정과 journal 접근은 운영 담당자에게만 부여한다.

설정·인증서 파일 변경은 프로세스 재시작 후 반영된다. 중앙의 새 credential 등록·revision 전환을 먼저 완료한 다음 파일을 교체하고 `sudo systemctl restart privacy-bubble-gateway.service`를 수행한다. 이전 credential 폐기 시점은 PC-MOBIUS 담당과 맞춘다.

## 저장소·권한·시간 동작

Gateway0.2.0은 DB를 configured Gateway/Originator/CSE 자원 identity에 연결한다. 기존의 비어 있지 않은0.1.x DB에는 명시적 adoption이 필요하다. [STATE_RECOVERY.md](STATE_RECOVERY.md)에 같은 원본의 adoption·WAL snapshot·archive quarantine과 미구현 restore activation을 구분했다. 새 도구를 실행하거나 기존 DB를 변경한 것은 아니며 이번에는 소스만 추가했다.

- SQLite WAL과 `synchronous=FULL`을 사용한다. 관측 dedup, command journal, ownership fence, receipt와 outbox를 보존한다. 이미 SQLite에 저장된 전송 항목은 재시작 후 재전송한다.
- 새 명령 영수증을 발송 큐에 등록할 때는 아직 등록되지 않은 항목만 한 번에 최대 128개 고른다. 이전 영수증이 재시도 대기 중이어도 남은 큐 용량에 새 영수증을 등록한다. 이미 전송한 CORE ACK는 재시작 후 다시 만들지 않는다.
- `MAX_OUTBOX_ROWS`와 `MAX_OUTBOX_BYTES`는 미전송 payload 수와 합산 byte 예산이다. SQLite 파일·WAL·command journal의 전체 디스크 크기 제한은 아니다. 관측은 outbox 예산의 90%를 사용하고 나머지를 receipt에 남긴다.
- queue가 가득 차면 기존 항목을 삭제하지 않는다. BLE 전달 대기 항목은 메모리에서 재시도하지만 버퍼가 넘치거나 프로세스가 종료되면 아직 저장되지 않은 관측을 복구할 수 없다. [IO 메모](IO_NOTES.md)에 drop counter와 reconnect 경계를 정리했다.
- 완료한 commandId도 journal에 남긴다. `MAX_COMMANDS` 도달 시 새 명령을 거절하고 자동 삭제하지 않는다. 장치 NVS journal과 Gateway DB의 보존·이관은 중앙의 명령 보존 기간과 함께 정해야 한다. 저장소를 지워 단순히 한도를 초기화하면 중복 실행 방어 근거를 잃는다.
- 명령 수신 시 매번 중앙 HTTPS 목록을 조회한다. MQTT 대기열은 한 번에 최대 16건을 확인하고, 중앙 목록에 같은 commandId가 있으면 그 목록의 발급본을 사용한다. MQTT로만 들어온 명령은 중앙이 정확한 payloadHash와 현재 권한을 확인한 경우에만 남은 배치 자리에 넣는다. 두 채널의 기존 journal 행은 그대로 보존한다.
- Gateway 0.2.96은 HTTPS 목록을 받는 즉시 해당 명령을 SQLite에 기록한다. MQTT 후보 승인이 지연되는 동안에도 저장된 명령은 실행 직전 승인 단계로 진행할 수 있다. 목록 조회는 `REQUEST_TIMEOUT`, MQTT 후보 승인 조회는 `REQUEST_TIMEOUT`과 남은 명령 기한 중 짧은 값으로 제한한다.
- credential 상태 조회 실패 또는 freshness 만료에서는 새 실행을 보류한다. 저장된 명령은 credential이 복구되거나 deadline이 만료될 때까지 pending 상태로 남는다. LOST/REVOKED는 신규 실행을 거절한다.
- Gateway 0.2.34는 상태 조회 시작부터 credential TTL을 계산한다. 상태·revision 변경, 조회 실패 또는 TTL 단절이 있으면 같은 revision으로 복구돼도 이전 로컬 승인 세대는 무효다. 중앙 응답을 기다리던 명령은 새 승인을 요청한다. BLE 전송 중이면 다음 조각 전에 중단하고 미확정 영수증을 남긴다.
- Gateway 0.2.35는 mTLS로 확인한 첫 자격 상태와 이후 상태·revision 전환을 SQLite에 저장한다. 일반 큐가 가득 차도 저장하고, 자리가 생기면 기존 health 컨테이너에 순서대로 보낸다. `credentialTransition`이 붙은 프레임은 관측 당시의 이력이다. 실시간 준비 상태는 일반 heartbeat에서 판정한다. [영수증 전달과 보관](RECEIPT_ROUTING.md#자격-상태-전환-영수증)
- 실행 직전 중앙 authorize 응답의 ID·claim·hash·grant·epoch·expiry를 확인한다. 중앙의 dispatch/회수 race 처리까지 대신하는 것은 아니다.
- wall clock이 monotonic clock에 비해 2초를 넘게 점프하면 실행을 막는다. 시계를 동기화한 뒤 Gateway를 재시작해야 한다. `time-sync.target` 순서만으로 시각 정확도가 보장되지는 않는다.
- timeout·재시작 중 dispatch는 성공으로 간주하지 않으며 같은 동작을 자동 재실행하지 않는다. `TIMEOUT` 또는 `INDETERMINATE` receipt로 중앙에서 정산한다. 이미 만들어진 receipt의 전달 재시도와 장치 동작 재실행은 별개다.
- 쓰기 응답을 지원하는 GATT 명령 특성이 있는 인증 세션을 기다린다. 그 전에는 명령을 `RECEIVED`에 두고 `dispatch_deferred_ble` 카운터를 올린다. 준비된 세션에서 중앙에 승인 요청을 보내며 응답 중 세션이 바뀌면 새 승인까지 기다린다. 실행 의도를 영속화한 뒤 연결이 끊기면 기존 미확정 처리 규칙을 적용한다.

oneM2M은 같은 `rqi`의 CREATE 성공 응답을 받아야 전송 완료 처리한다. MQTT PUBACK은 완료 근거가 아니다. HTTPS fallback도 동일한 contentInstance 이름을 쓰며, 이름 충돌은 기존 payload가 일치할 때만 완료로 처리한다.

Gateway는 HTTPS 429/503의 `Retry-After` 초 단위와 HTTP 날짜를 처리한다. 유효한 시간이 남아 있으면 같은 HTTPS origin의 새 요청을 보류한다. 개별 outbox 행은 서버 대기 시간과 기존 backoff 중 긴 값을 SQLite에 저장한다. 0.2.57은 서버 주소와 포트별 대기 종료를 Linux 부팅 ID와 단조 시계 값으로 보관한다. 같은 부팅에서 데몬을 재시작하면 남은 시간을 이어받고, Pi를 재부팅하면 이전 부팅의 서버별 대기는 정리한다. 중앙 API가 대기 중이면 기존 승인·자격·명령 기한 검사에 따라 실행을 보류한다. 자격 전환 영수증은 MQTT가 연결돼도 HTTPS 저장 확인이 필요하므로 CSE 보류 동안 선택 대상에서 제외한다.

Gateway 0.2.31은 CSE가 재시도를 보류한 동안 HTTPS가 필요한 항목을 대기열 선택에서 건너뛴다. 아직 보내지 않은 항목의 재시도 횟수와 시각을 그대로 유지한다. oneM2M MQTT가 준비돼 있으면 고정 컨테이너 영수증처럼 HTTPS 사전 조회가 필요한 경로만 보류한다. CORE MQTT 항목은 별도 경로로 선택할 수 있다. 이 변경의 시험과 배포는 미실행이다.

수용 항목과 중앙 인수 조건은 [KEYRING 인수인계](../../docs/keyring-handoff.md)에 있다. 로컬 모의 단위 테스트 결과는 [TESTING.md](TESTING.md)에 있다. Pi의 Feather BLE 벤치와 전체 daemon·중앙 서비스·실물 키링 PCB 통합시험을 구분하며, 후자의 검증은 미완료다.
