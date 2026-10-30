# Gateway 로컬 시험

DOC-REV2.0.0 · KEYRING / 남호 · 2026-10-30 · Gateway0.2.3.

소스와 새0.2.3 wheel 설치본에서 기본56개, 별도 MQTT6개, 실제 Mobius4 CSE5개가 각각 통과했다. skipped0이며 [실행 로그·환경·소스/산출물 SHA256](../evidence/2026-10-30-real-cse/README.md)을 보존한다. firmware0.7.0의 기존3개 프로필 빌드 증거는 유지한다.

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

## 별도 실제 CSE5개

cse_integration_tests/는 합성 oneM2M responder 대신 실제 Mobius4와 새 PostgreSQL/PostGIS를 실행한다. HTTPS 저장/조회, MQTT3가지 주소 범위·application response·저장/조회·HTTPS POST fallback0회, 동일 요청 중복 저장 방지, 내용 충돌 거절/원본 보존, CSE 프로세스 재시작 후 조회를 확인한다.

```powershell
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/tests') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/integration_tests')
python -m unittest discover -s keyring/raspberry-pi-gateway/cse_integration_tests -v
```

캐시 이미지 privacy-bubble-keyring-mobius4:local, postgis/postgis:17-3.5, eclipse-mosquitto:2, nginx:1.28-alpine과 keyring/dev/mobius4/의 개발 template이 필요하다. 새 network와 tmpfs DB만 사용한다. 기존 개발 stack/DB는 사용하지 않는다. 종료 전 label/token을 확인한 소유 resource만 제거한다. 로그 수집은 KEYRING_TEST_CSE_LOG_DIR 또는 KEYRING_TEST_MQTT_LOG_DIR을 새 경로로 지정한다. image 자동 다운로드는 없다.

CSE 테스트 principal은 합성 admin mapping이다. 중앙 PKI/principal→AE/Originator·ACP/grant, INTEGRATION API·Group/SDT 명령·실물 Pi/BlueZ·키링·앱/웹·전력/거리·영상/release는 미완료다. 로컬 시험은 중앙 gate 승인을 뜻하지 않는다.

과거 [TLS55개](../evidence/2026-10-30-https-tls/README.md), [MQTT6개](../evidence/2026-10-30-mqtt-wire/README.md), [영수증47개](../evidence/2026-10-30-receipt-routing/README.md), [BLE42개](../evidence/2026-10-30-ble-sessions/README.md), [firmware3개](../evidence/2026-10-29-local-validation/README.md)는 당시 기록으로 유지한다.
