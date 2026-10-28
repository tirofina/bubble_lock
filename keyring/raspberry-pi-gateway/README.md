# Raspberry Pi Gateway

DOC-REV 2.0.0의 팀 CORE 계약을 연결했다. `BLE_GATT_PROFILE=core-v1`이 새 기본값이며 기존 UUID는 `keyring-v01`로 지정한다. `CORE_BRIDGE_ENABLED=true`는 telemetry/성공 ACK의 영속 전송과 command topic 수신을 추가한다. 원본 oneM2M cin·권한 검사는 유지한다. CORE payload 차이와 승인 필드 공백은 [연동 메모](../CORE_INTEGRATION.md)를 따른다. 로컬 테스트 서버 설정은 [Mobius4](../dev/mobius4/README.md)에 있다.

Python 3.11 이상과 Linux BlueZ를 사용하는 KEYRING 현장 daemon이다. BLE 관측을 SQLite outbox에 저장하고 MQTT 또는 HTTPS로 oneM2M contentInstance를 생성한다. 중앙에서 받은 명령은 최신 승인·credential·deadline을 확인한 뒤 BLE로 전달한다.

현재 상태는 **소스 작성 / unverified**다. 아래 명령은 Raspberry Pi에서 사용자가 수동으로 수행할 배포 절차이며, 이번 작업에서는 설치·빌드·실행·장비 연결을 하지 않았다.

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

중앙 경로 설정은 다음을 구분한다.

| 설정 | 의미 |
|---|---|
| `M2M_CSE_URL` | `https://host:port` 형태의 origin. `/Mobius`는 넣지 않음 |
| `M2M_*_CONTAINER` | `/Mobius/{AE}/observations`처럼 전체 oneM2M resource path |
| `PC_API_URL` | HTTPS base URL. 코드가 `/api/v1/gateways/{GATEWAY_ID}`를 덧붙임. `/api/v1`을 중복 입력하지 않음 |
| `M2M_ORIGINATOR`, `M2M_CSE_ID` | MQTT topic의 단일 segment이면서 중앙과 합의한 식별자 |
| `M2M_RVI` | 예시 `3`을 그대로 확정값으로 사용하지 않고 Mobius capability probe 결과로 결정 |
| `MQTT_WRAPPED_PRIMITIVE` | 기본 `false`는 flat oneM2M primitive. PC capability probe에서 `m2m:rqp` wrapper가 필요한 경우에만 `true`로 설정하며 다른 형식의 자동 재시도는 하지 않음 |
| `BLE_DEVICES` | `deviceId → 실제 BLE 주소` JSON 객체. 1~32대, 중복 주소 불허 |
| `FIRMWARE_REVISION_ALLOWLIST` | 쉼표로 구분한 정확한 firmwareRevision. 비워 두면 추가 revision 제한만 생략 |

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

bonding이 완료된 주소를 `BLE_DEVICES`에 넣는다. `BLE_PAIR=true`는 필수다. daemon 자체는 passkey 입력 UI나 자동 승인 agent를 제공하지 않으므로 새 장치의 첫 등록은 이 과정이 필요하다. 실제 Raspberry Pi 어댑터·BlueZ에서의 scan/connection·bond 동작은 아직 검증하지 않았다.

## 수동 실행 또는 systemd 배포

foreground 실행 명령은 다음과 같다. 같은 데이터베이스를 사용하는 프로세스는 하나만 허용한다. systemd 서비스가 이미 실행 중이면 중복으로 실행하지 않는다.

```sh
sudo -u bubble-gateway /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-gateway --env-file /etc/privacy-bubble/gateway.env --log-level INFO
```

서비스를 사용할 경우 사용자가 아래 명령을 직접 수행한다.

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
- `MAX_OUTBOX_ROWS`와 `MAX_OUTBOX_BYTES`는 미전송 payload 수와 합산 byte 예산이다. SQLite 파일·WAL·command journal의 전체 디스크 크기 제한은 아니다. 관측은 outbox 예산의 90%를 사용하고 나머지를 receipt에 남긴다.
- queue가 가득 차면 기존 항목을 삭제하지 않는다. BLE 전달 대기 항목은 메모리에서 재시도하지만 버퍼가 넘치거나 프로세스가 종료되면 아직 저장되지 않은 관측을 복구할 수 없다. [IO 메모](IO_NOTES.md)에 drop counter와 reconnect 경계를 정리했다.
- 완료한 commandId도 journal에 남긴다. `MAX_COMMANDS` 도달 시 새 명령을 거절하고 자동 삭제하지 않는다. 장치 NVS journal과 Gateway DB의 보존·이관은 중앙의 명령 보존 기간과 함께 정해야 한다. 저장소를 지워 단순히 한도를 초기화하면 중복 실행 방어 근거를 잃는다.
- credential 상태 조회 실패 또는 freshness 만료에서는 새 실행을 보류한다. 저장된 명령은 credential이 복구되거나 deadline이 만료될 때까지 pending 상태로 남는다. LOST/REVOKED는 신규 실행을 거절한다.
- 실행 직전 중앙 authorize 응답의 ID·claim·hash·grant·epoch·expiry를 확인한다. 중앙의 dispatch/회수 race 처리까지 대신하는 것은 아니다.
- wall clock이 monotonic clock에 비해 2초를 넘게 점프하면 실행을 막는다. 시계를 동기화한 뒤 Gateway를 재시작해야 한다. `time-sync.target` 순서만으로 시각 정확도가 보장되지는 않는다.
- timeout·재시작 중 dispatch는 성공으로 간주하지 않으며 같은 동작을 자동 재실행하지 않는다. `TIMEOUT` 또는 `INDETERMINATE` receipt로 중앙에서 정산한다. 이미 만들어진 receipt의 전달 재시도와 장치 동작 재실행은 별개다.

oneM2M은 같은 `rqi`의 CREATE 성공 응답을 받아야 전송 완료 처리한다. MQTT PUBACK은 완료 근거가 아니다. HTTPS fallback도 동일한 contentInstance 이름을 쓰며, 이름 충돌은 기존 payload가 일치할 때만 완료로 처리한다.

수용 항목과 중앙 인수 조건은 [KEYRING 인수인계](../../docs/keyring-handoff.md)에 있다. **검증·빌드·실행 미실행.**
