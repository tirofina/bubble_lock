# Gateway 로컬 시험

Gateway 0.2.11의 CORE 재시도 순서는 기본 75개, 격리 Mobius4 11개, 별도 팀 CORE → SDT 통합 1개에서 검증했다. [실행 기록](../evidence/2026-11-10-core-retry-order/README.md)

`cse_integration_tests/core_retry_order.py`를 별도로 실행하면 팀 CORE → SDT 재시도 순서와 중앙 동시 갱신 후보를 함께 시험한다. `KEYRING_TEST_CENTRAL_TREE`는 팀 main `715ef58`의 `pc-mobius`가 들어 있는 디렉터리로 지정한다. 브리지 메시지 핸들러에 직접 전달한 뒤 격리 Mobius4에서 실제 SDT 상태를 읽는다. [동시 갱신·handover 기록](../evidence/2026-11-10-core-concurrent-order/README.md)

Gateway 0.2.10의 부팅별 버튼 누계는 기본 74개, 실제 격리 Mobius4 통합 11개를 통과했다. [버튼 관측 시험](../evidence/2026-11-10-button-presses/README.md)

Gateway 0.2.9의 읽기 전용 journal 대조는 최종 wheel에서 기본 73개와 격리 Mobius4 통합 시험을 통과했다. [시험과 재현 명령](../evidence/2026-11-10-journal-reconcile/README.md)

Gateway 0.2.8은 기본 73개와 중앙 명령 통합 5개 시험이 통과했다. 현재 부팅과 다른 `APPLIED`를 미확정으로 처리하고 과거 `DUPLICATE` readback은 보존한다. [부팅 ID 시험](../evidence/2026-11-10-receipt-boot/README.md)

Gateway 0.2.7은 기본 71개, 중앙 명령 통합 4개, 별도 MQTT 6개 시험이 통과했다. 중앙 명령 통합은 실제 Mosquitto의 명령·ACK 전송과 Mobius4 영수증 대조를 포함한다. [수신 시험](../evidence/2026-11-10-command-ingress/README.md) · [브로커 시험](../evidence/2026-11-10-mqtt-command-wire/README.md)

Gateway 0.2.6은 로컬 기본 시험 67개와 실제 Ubuntu systemd의 시작 전 검사 3개가 통과했다. systemd 시험은 배포 unit의 격리 설정을 복사한 임시 unit에서 wheel의 `--check-config`를 실행하고, 성공한 경우에만 본 실행 표시를 남긴다. [실행 범위와 재현 절차](../evidence/2026-11-10-deployment-preflight/README.md)

Gateway 0.2.5 소스에서 기본 63개와 [중앙 명령 통합 2개](../evidence/2026-11-10-central-dispatch/README.md)가 통과했다. 후자는 팀 Node mTLS API, Gateway 전체 worker, 모의 GATT, 실제 격리 Mobius4를 실행한다.

## 중앙 명령 통합 시험

위 증거에 기록된 팀 main SHA에서 `pc-mobius` 전체와 `tests/integration/gateway-server.mjs`를 새 임시 경로에 추출한다. `KEYRING_TEST_CENTRAL_TREE`는 두 경로를 포함한 추출 루트다. 아래 명령은 앞선 [실제 CSE 시험](#별도-실제-cse10개)과 같은 Python 경로, OpenSSL, 캐시된 Docker 이미지를 사용한다. Node도 필요하다.

```powershell
$env:KEYRING_TEST_CENTRAL_TREE = '<팀 main을 추출한 절대 경로>'
$env:PYTHONPATH = ('src','tests','integration_tests' | ForEach-Object {
    Join-Path $PWD ('keyring/raspberry-pi-gateway/' + $_)
}) -join [IO.Path]::PathSeparator
python keyring/raspberry-pi-gateway/cse_integration_tests/central_dispatch.py -v
```

실행마다 새 시험 PKI·중앙 등록·Gateway SQLite와 격리 CSE 자원을 쓴다. 정상 명령의 중복 poll, 연결 전 grant 회수, receipt의 CSE readback, 정상 종료를 검증한다. 하드웨어는 모의 GATT 경계다.

MQTT 단독 수신 시험은 목록 조회에만 503 오류를 주입한다. 대기열에 직접 넣는 사례와 실제 Mosquitto의 QoS 1 토픽으로 보내는 사례가 있다. 두 사례에서 팀 Node API의 mTLS 승인을 실제로 요청한다. 브로커 사례는 인증서별 명령 발행 권한, 승인 전후 처리, 모의 GATT 프레임, CORE ACK와 CSE 영수증 일치를 확인한다.

정상 명령 사례는 CSE에서 읽은 영수증과 실행 직전 중앙 승인 응답을 Node의 ACK 결속 검사에도 전달한다. 이 재현은 팀 main `715ef58`의 CORE 동작을 기준으로 한다. [재현 결과](../evidence/2026-11-10-core-ack-binding/README.md)

## 실물 BLE 거리·재연결 기록

Gateway 0.2.16의 `bubble-keyring-ble-characterize`는 Pi의 BlueZ와 기존 Gateway GATT 수신기를 사용하는 현장 기록 도구다. 등록된 장치와 펌웨어를 지정하고 `feather-bench` 또는 `r18-pcb`를 선택한다. 각 선택은 펌웨어 identity의 보드 revision과 대조된다. Gateway와 같은 DB 경로의 프로세스 lock을 사용하므로, 시험 전에 해당 Gateway 서비스와 별도 BLE 관측기를 중지한다. 주소와 DB 경로는 실제 로컬 설정을 사용한다.

```sh
bubble-keyring-ble-characterize --mode range --hardware feather-bench \
  --gateway-id gw-feather-bench --device-id keyring-feather-lab --address "$FEATHER_ADDRESS" \
  --firmware-revision feather-probe-0.1.1 --distance-cm 100 --seconds 90 \
  --database "$GATEWAY_DATABASE" --output "$PRIVATE_EVIDENCE/feather-range-100cm.json"
```

거리는 실제 측정값을 입력한다. 거리별로 Pi·장치 위치, 장애물, 방향, 펌웨어와 시간 조건을 맞춘 뒤 새 파일로 기록한다. `--mode reconnect`에서는 첫 알림 표시를 확인한 후 연결을 끊고 복구한다. 도구가 BLE 연결 종료를 감지한 시점에서 새 세션의 첫 알림까지 걸린 시간을 기록한다. 복구 시간에는 실험자가 링크를 복구하는 데 걸린 시간도 포함된다.

JSON에는 최초 READ와 구독 준비 전 데이터가 제외된 알림 수, 세션별 sequence 간격, 새 세션까지의 경과 시간, 같은 부팅인지 여부가 남는다. RSSI는 접속 준비 시점에 남아 있던 광고 RSSI와 그 나이를 기록하고 측정값이 없으면 `null`이다. sequence 간격은 펌웨어 내부 생략과 무선 전달 손실을 따로 식별하지 못한다. 출력에는 BLE 주소, 원래 boot ID, 센서 payload나 비밀값을 담지 않는다. `RECORDED`는 요청한 측정 종류의 관측이 남았음을 나타낸다. CSE 수신이나 생산 합격 판정은 별도 증거로 기록한다.

제작 PCB의 sleep·wake·배터리 입력 전력은 외부 계측과 [전력 측정 지점 설명](../firmware/POWER_MONITOR.md)을 함께 사용한다. 이 도구는 소스와 회귀시험 코드만 준비했다.

### r18 wake 기록

Gateway 0.2.17의 `--mode wake`는 r18 전용이다. 로컬 provisioning에서 sleep을 켠 keyring-0.7.4를 대상으로 한다. 먼저 연결해서 알림을 받은 뒤 BLE를 닫고 `--idle-seconds` 동안 기다린다. 다른 BLE 클라이언트가 붙어 있거나 움직임이 감지되면 실제 절전 진입이 늦어질 수 있다. 도구의 wake 안내가 나오면 해당 자극을 가한다. 버튼·움직임 시험은 장치가 실제로 절전한 뒤 타이머로 먼저 깨기 전에 진행한다. 타이머 시험은 안내 후 장치를 움직이지 않는다.

```sh
bubble-keyring-ble-characterize --mode wake --hardware r18-pcb \
  --gateway-id "$GATEWAY_ID" --device-id "$KEYRING_ID" --address "$KEYRING_ADDRESS" \
  --firmware-revision keyring-0.7.4 --distance-cm "$MEASURED_DISTANCE_CM" \
  --idle-seconds "$IDLE_SECONDS" --expect-wake confirm --seconds 90 \
  --database "$GATEWAY_DATABASE" --output "$PRIVATE_EVIDENCE/r18-wake-confirm.json"
```

`--expect-wake`는 `confirm`, `panic`, `motion`, `timer`를 선택한다. 최초 복구 알림의 부팅이 이전과 달라야 하고, 같은 부팅의 health 알림에 기대 원인과 핀 마스크가 있어야 한다. 확인 GPIO6은 64, 비상 GPIO7은 128이며 두 핀이 함께 보고되면 개별 버튼 항목에 맞지 않는다. 나중에 다른 부팅에서 받은 원인은 첫 복구 기록에 합치지 않는다. 초기 연결과 복구 수신에 각각 최대 `--seconds`를 사용한다. BLE 해제 후 첫 알림까지의 값에는 의도한 유휴 대기 시간이 포함된다. 실제 절전 진입 시각·소비전류는 외부 계측으로 기록한다.

## Feather LED ON/OFF 시험

Feather 명령 펌웨어 0.2.0과 [Pi 벤치 연결 절차](../evidence/2026-11-10-pi-full-daemon/README.md#재현-절차)를 사용한다. PC의 시험 fixture는 새 CA·Mobius4 컨테이너·팀 중앙 API를 열고, Gateway와 Guardian에 별도 인증서를 발급한다. Guardian은 PC에만 두고 Pi에는 Gateway bundle을 전달한다. Pi는 Gateway 0.2.7 이상, 새 SQLite, `FIRMWARE_REVISION_ALLOWLIST=feather-probe-0.2.0`, `MQTT_ENABLED=false`, `CORE_BRIDGE_ENABLED=false`로 시작한다.

```powershell
$bench = '<저장소 밖의 새 절대 경로>'
python keyring/raspberry-pi-gateway/cse_integration_tests/pi_daemon_fixture.py --team-ref 715ef58 --output $bench --led-cycle
```

1. `STACK_READY` 이후 SSH 터널과 Pi 시험 데몬을 시작한다. 내장 빨간 LED가 꺼져 있는지 확인한다.
2. `LED_ON_READY`가 나오면 다른 터미널에서 같은 출력 폴더에 `LED_ON` 빈 파일을 만든다. `LED_ON_RECORDED`가 나오고 빨간 LED가 켜졌는지 직접 확인한다.
3. `LED_OFF_READY`가 나온 뒤 같은 폴더에 `LED_OFF` 빈 파일을 만든다. `LED_OFF_RECORDED` 뒤 실제 LED 소등을 확인한다.
4. Pi 시험 데몬을 종료하고 이번 시험 SQLite의 일관된 사본을 가져온다. 닫힌 DB에 WAL이 남아 있으면 SQLite backup으로 사본을 만든다. PC 시험 폴더의 `STOP` 파일로 격리 stack을 종료한다.

중간에 중단하면 Pi 시험 데몬을 먼저 종료해 BLE를 끊고 실제 LED 소등을 확인한다. 증거 파일은 두 단계의 발급과 readback을 따로 저장한다. 완주하면 `led-cycle.json`을 출력한다. 아래 도구는 로컬 DB 사본을 읽기 전용으로 열어 명령 해시, CSE readback, 영수증 전송 완료를 비교한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/pi_led_cycle.py `
    --evidence (Join-Path $bench 'led-cycle.json') --database '<Pi 시험 DB 사본>'
```

출력의 `dataBindingsVerified`는 데이터 대조 결과다. `physicalLedObserved`는 비워 두며 실제 LED 확인 기록은 따로 남긴다. [로컬 리허설 기록](../evidence/2026-11-10-pi-led-rehearsal/README.md)

### 기존 Scoped Mobius4에서 Feather LED 시험

[격리 명령 API와 Pi 설정](../dev/mobius4/README.md#feather-벤치-명령-api)을 사용한다. Feather 명령 프로필과 실제 Pi 데몬이 준비되면 PC에서 기존 Gateway 가상환경으로 아래 도구를 실행한다. `$bench`는 아직 없는 로컬 비공개 디렉터리이며, 부모 디렉터리는 먼저 준비한다.

```powershell
$env:PYTHONPATH = Join-Path $PWD 'keyring/raspberry-pi-gateway/src'
python keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_led_cycle.py --output $bench
```

`LED_ON_READY`, `LED_OFF_READY`가 각각 출력된 뒤에만 `$bench`에 해당 이름의 `LED_ON`, `LED_OFF` 파일을 만든다. 각 단계는 같은 부팅 세션의 명령 전 관측을 읽고, 팀 API에서 60초 grant를 받은 뒤 25초 기한의 명령을 발급한다. 실제 LED를 눈으로 확인한 결과는 따로 기록한다. 도구는 Mobius4 원본 영수증과 명령 후 관측을 확인하고 단계별 grant 회수 응답을 로컬에 저장한다.

명령 발급 요청 전의 `led-*-intent.json`에 command ID와 CSE 자원명이 있다. 응답을 받기 전에 중단되면 새 명령을 보내기 전에 이 ID로 팀 상태와 원본 영수증을 대조한다. 전체가 끝난 뒤 Pi SQLite 대조에 `pi_led_cycle.py --gateway gw-a --evidence <led-cycle.json> --database <Pi SQLite 사본>`을 쓴다. 중앙 정산은 각 command ID로 [정산 명령](../dev/mobius4/README.md#명령-영수증-정산-준비)을 별도로 실행한다. 중간에 중단하려면 `STOP` 파일을 만들고 실제 LED 상태를 확인한다.

#### Pi 명령 세션

Pi의 일반 계정에서 저장소 루트로 이동한다. 짝지은 Feather 주소 한 줄을 소유자 전용 파일에 기록한다. `--address-file`에는 그 파일을, `--tls-dir`에는 `ca.pem`, `gateway-a.pem`, `gateway-a.key`가 있는 소유자 전용 폴더를 지정한다. Gateway 의존성이 설치된 기존 시험 가상환경의 Python을 사용한다.

```sh
tool=keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_pi.py
"$pi_python" "$tool" prepare --session "$bench_session" \
  --address-file "$paired_address_file" --tls-dir "$scoped_gateway_tls"
```

`prepare`는 로컬 TLS 파일을 읽고 `~/.local/state/privacy-bubble-feather-command/<세션>/profile.json`을 만든다. Pi 포워딩 포트가 8760과 8787과 다르면 `--cse-port`와 `--api-port`를 함께 지정한다. 실행 단계에서 상속된 Gateway 환경변수를 사용하지 않는다.

Feather 명령 프로필 `0.2.0`과 두 SSH 포워딩이 준비되면 같은 Feather를 쓰는 관측 프로세스를 종료한 뒤 아래 명령을 실행한다. 실행한 Gateway는 해당 세션의 `gateway.sqlite3`를 사용한다. Pi 사용자당 명령 벤치 한 개가 실행되며, 기본 Gateway의 SQLite 잠금도 유지한다.

```sh
"$pi_python" "$tool" run --session "$bench_session"
```

재시작할 때는 같은 세션명을 사용한다. 시험 종료 뒤 Gateway를 정상 종료하고 SQLite backup으로 사본을 만든다. 미전송 행이 있으면 원래 세션과 CSE 자원에서 대조한다.

## 이전 시험 기록

2026-11-10 Gateway 0.2.4의 기본 시험은 **58개 통과**다. BlueZ가 READ 값을 구독 callback에도 전달하는 회귀시험을 추가했고, 수정 전 실패와 수정 후 통과를 확인했다. 실제 Pi Zero 2 W에서도 90초 연속 관측과 A0/A1 입력 수신이 통과했다. [Pi 실행 기록](../evidence/2026-11-10-pi-feather/README.md)을 따른다. 아래 이전 날짜의 실행 수와 CSE·POSIX 결과는 당시 기록이다.

DOC-REV2.0.0 · KEYRING / 남호 · 2026-10-30 · Gateway0.2.3.

현재 실제 CSE suite10개와 별도 Linux POSIX suite10개가 소스·기존0.2.3 설치 wheel에서 각각 통과했다. [영속 큐·프로세스 중단 복구 증거](../evidence/2026-10-30-outbox-cse/README.md)에 로그와 hash를 보존한다. 기본56개·별도 MQTT6개와 firmware0.7.0의3개 프로필 빌드는 변경하지 않았으며 [직전 실행 기록](../evidence/2026-10-30-real-cse/README.md)을 유지한다. skipped0이다.

## 준비

Python3.11+와 pyproject.toml 의존성, OpenSSL 실행 파일, Python TLS1.3 지원이 필요하다. OpenSSL을 찾지 못하면 KEYRING_TEST_OPENSSL을 지정한다. 필수 환경이 없을 때 skip하지 않고 실패한다. 설치본 시험은 네트워크 없이 새 target에 설치한 후 import 경로·version·Python module의 LF 정규화 일치를 확인했다.

## 기본56개

모의 BLE/MQTT/HTTP·합성 명령·새 임시 SQLite48개와 실제 loopback HTTPS/TLS8개다. 기본 suite는 Docker container를 시작하지 않는다.

```powershell
$env:KEYRING_TEST_OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src')
python -m unittest discover -s keyring/raspberry-pi-gateway/tests -v
```

| 파일 | 확인한 동작 |
|---|---|
| test_protocol.py | claim/grant/hash·기한, JSON framing, INA219 단위·부호·계산, BLE20byte 송신 실패 |
| test_ble_sessions.py | 이전 callback 무시, 새 연결 정상 수신, 중단 WRITE의 새 연결 전송 차단, handshake 실패 ready 차단 |
| test_receipt_outbox.py | ACK 재생성 차단·재시작·독립 재시도·용량 오류 원자성·busy loop 방지 |
| test_store.py | command/dedup/fence/outbox·CORE sequence·WAL backup/quarantine/명시적 adoption |
| test_dispatch.py | 승인·credential·기한 실패 시 미송신, intent 선기록, 미확정 실행 자동 재시도 차단 |
| test_transport.py | oneM2M application response, fallback cin 동일성, 거절 우회 차단, RI/충돌 비교, MQTT To3가지 범위 변환 |
| test_journal.py | prepared 보존·잘못된 readback/중복 ID 거절·capture 닫기 |
| test_https_tls.py | 실제 TLS1.3/mTLS·HTTP, CA/client/서버 이름·무인증·TLS1.2 거절, redirect/proxy 차단 |

인증서·키·HTTPS server/socket은 시험이 생성하고 종료 시 정리한다. POSIX directory fsync는 Windows에서 모의 처리한다. 기존 DB·실제 BLE·Gateway daemon은 실행하지 않는다.

## 별도 MQTT6개

integration_tests/는 실제 Mosquitto/Paho TLS1.3·mTLS·CN별 ACL을 사용한다. oneM2M 응답 peer는 합성 fixture다. application response, PUBACK만 있을 때 HTTPS fallback, wrong-rqi 무시, CSE 거절 우회 차단, 다른 Originator ACL 거절, broker 종료 시 pending request 실패를 확인한다.

```powershell
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/tests')
python -m unittest discover -s keyring/raspberry-pi-gateway/integration_tests -v
```

Docker daemon과 캐시된 eclipse-mosquitto:2가 필요하다. --pull never와127.0.0.1 임시 포트, fresh test PKI, 소유 token을 사용한다.

## 별도 실제 CSE10개

cse_integration_tests/는 실제 Mobius4와 새 PostgreSQL/PostGIS를 실행한다. 기존5개는 HTTPS/MQTT3가지 주소·저장/조회, 중복 방지, 충돌 거절, CSE 재시작 후 조회다. 추가5개는 실제 Store/Gateway 송신 loop를 연결해 SQLite 다시 열기/observation dedup, native receipt 확인 플래그, CSE 중단/backoff/복구, 원격 저장 직후 송신 프로세스 강제 종료/동일 요청 복구, 충돌한 outbox행 보존을 확인한다.

delivery_child.py는 새 시험 DB와 test PKI로 송신 loop만 실행하고 원격 확인 직후 로컬 확인 전에 exit73으로 종료한다. parent는 같은 SQLite를 열고 동일 요청을 재전송해 cin1개를 확인한다. Gateway 전체 daemon·BLE·credential/poll/dispatch/health loop는 실행하지 않는다. 시험 child의 exit73과 전체 unittest의 성공 exit0을 구분한다.

```powershell
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/tests') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/integration_tests')
python -m unittest discover -s keyring/raspberry-pi-gateway/cse_integration_tests -v
```

캐시 이미지 privacy-bubble-keyring-mobius4:local, postgis/postgis:17-3.5, eclipse-mosquitto:2, nginx:1.28-alpine과 keyring/dev/mobius4/의 개발 template이 필요하다. 새 network와 tmpfs DB만 사용한다. 기존 개발 stack/DB는 사용하지 않는다. 종료 전 label/token을 확인한 소유 resource만 제거한다. 로그 수집은 KEYRING_TEST_CSE_LOG_DIR 또는 KEYRING_TEST_MQTT_LOG_DIR을 새 경로로 지정한다. image 자동 다운로드는 없다.

CSE 테스트 principal은 합성 admin mapping이다. 중앙 PKI/principal→AE/Originator·ACP/grant, INTEGRATION API·Group/SDT 명령·실물 Pi/BlueZ·키링·앱/웹·전력/거리·영상/release는 미완료다. 로컬 시험은 중앙 gate 승인을 뜻하지 않는다.

과거 [TLS55개](../evidence/2026-10-30-https-tls/README.md), [MQTT6개](../evidence/2026-10-30-mqtt-wire/README.md), [영수증47개](../evidence/2026-10-30-receipt-routing/README.md), [BLE42개](../evidence/2026-10-30-ble-sessions/README.md), [firmware3개](../evidence/2026-10-29-local-validation/README.md)는 당시 기록으로 유지한다.

## 별도 Linux POSIX10개

[실행 증거](../evidence/2026-10-30-posix-state/README.md)에 source/installed console CLI10개와 실제 flock·directory fsync·권한0700/0600·WAL snapshot·명시적 legacy adoption·ENOSPC·partial output·quarantine·concurrent write 결과를 보존했다. Windows 기본 tests/가 대체한 directory fsync를 이 suite에서는 실제 Linux syscall로 실행한다. 별도 프로세스 write 주입 wrapper도 실제 fsync를 먼저 호출한다.

Docker daemon, 캐시된 privacy-bubble-keyring-dev-certificates:local base, 기존 Gateway wheel과 PowerShell7이 필요하다. 새 시험 image build에서만 Python/pip 개발 package를 다운로드한다. 기존 개발 PKI entrypoint는 실행하지 않는다.

```powershell
docker build --pull=false -t privacy-bubble-keyring-posix-test:local -f keyring/raspberry-pi-gateway/posix_integration_tests/Dockerfile keyring/raspberry-pi-gateway/posix_integration_tests
& ./keyring/raspberry-pi-gateway/posix_integration_tests/run-posix.ps1 -Wheel '<기존 wheel 절대경로>' -LogFile '<새 로그 절대경로>'
```

runner는 --pull never/network none/UID65532/read-only root로 실행하며 source/wheel만 read-only mount한다. wheel 설치는 --no-index --no-deps다. 새/tmp SQLite와256KiB/limited tmpfs만 사용한다. 새 log path를 요구하며 label/token 일치 자원만 정리한다. 시험 종료 후 host source/wheel은 그대로다.

TLS/env는 시험용 placeholder 파일이다. snapshot/adopt는 새 합성 DB에만 실행한다. daemon entry는 다른 프로세스 lock 때문에 serve 전에 중단되므로 BLE·network·전체 daemon은 실행하지 않는다. API timeout=-1은 이미 경과한 deadline 확인이다. fsync는 tmpfs에서 실행했으며 Pi ARM/SD카드 전원 손실·운영 DB·중앙 복구 승인·실물 시험은 남아 있다. 기본56/MQTT6/CSE10/firmware3은 이번 POSIX checkpoint에서 변경·재실행하지 않았다.

## Docker ARM64 Gateway 실행

2026-11-10 Docker Desktop에서 `python:3.12-slim-bookworm`의 `linux/arm64` 이미지를 실행했다. ARM64 Debian 사용자 공간에 현재 Gateway wheel을 빌드·설치한 뒤 기본 57개 시험이 통과했다. Docker는 Pi Zero 2 W의 SD 부팅, Wi-Fi 및 Bluetooth 어댑터 시험을 별도 실물 단계로 남긴다.

재현할 때 임시 입력 폴더에 이 Gateway의 `pyproject.toml`, `src`, `tests`를 복사한다. PowerShell에서 `$inputDir`를 해당 절대경로로 설정한 후 실행한다.

```powershell
docker pull --platform linux/arm64 python:3.12-slim-bookworm
docker run --rm --platform linux/arm64 --mount "type=bind,source=$inputDir,target=/input,readonly" python:3.12-slim-bookworm sh -ec 'uname -m && cp -a /input /tmp/gateway && pip install /tmp/gateway && python -m unittest discover -s /input/tests -v'
```

빌드와 설치에 Python 공개 패키지 저장소를 사용한다. 시험은 모의 BLE와 테스트용 loopback TLS·SQLite를 사용한다.
