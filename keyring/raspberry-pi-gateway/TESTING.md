# Gateway 단위·로컬 HTTPS 시험

DOC-REV2.0.0 · KEYRING / 남호 · 2026-10-30 · Gateway0.2.2.

현재 suite는55개다. 소스와 기존 설치 wheel에서 각각55개가 통과했고 skipped0이다. 47개는 모의 BLE/MQTT/HTTP와 합성 명령·새 임시 SQLite를 사용한다. 추가8개는 매 실행 새 test PKI와127.0.0.1 전용 HTTPS server로 실제 TLS/HTTP를 확인한다. 운영 인증서·기존 DB·실제 BLE·broker/CSE·Gateway daemon은 사용하지 않는다.

## 준비와 실행

Python3.11+와 pyproject.toml의 Gateway 의존성, OpenSSL 실행 파일, Python TLS1.3 지원이 필요하다. OpenSSL을 찾지 못하면 KEYRING_TEST_OPENSSL에 실행 파일을 지정한다. 필요한 환경이 없을 때 TLS 시험을 skip하지 않고 실패시킨다. 저장소 root에서 개발 환경의 Python으로 실행한다.

```powershell
$env:KEYRING_TEST_OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src')
python -m unittest discover -s keyring/raspberry-pi-gateway/tests -v
```

OpenSSL이 PATH에 있으면 별도 실행 파일 지정은 생략한다. 설치 패키지 시험은 PYTHONPATH를 격리 설치 디렉터리로 지정하고 import 경로·version·각 Python 모듈이 소스와 일치함을 확인한 뒤 같은 suite를 실행했다. Gateway runtime source와 wheel은 이번에 변경·재빌드하지 않았다.

## 시험 범위

| 파일 | 기대 결과 |
|---|---|
| test_protocol.py | claim/grant/hash·기한 검사, JSON framing, INA219 단위·부호·계산, BLE20byte 송신과 실패 처리 |
| test_ble_sessions.py | 이전 callback 무시, 새 연결 정상 수신, 중단한 명령의 새 연결 전송0회, handshake 실패 시 ready0회 |
| test_receipt_outbox.py | ACK 재생성 차단·재시작·경로별 독립 재시도·용량 오류 원자성·busy loop 방지 |
| test_store.py | command/dedup/fence/outbox·CORE sequence·WAL backup/quarantine/명시적 adoption |
| test_dispatch.py | 승인·credential·기한 실패 시 BLE 미송신, intent 선기록, 미확정 실행 자동 재시도 차단 |
| test_transport.py | 모의 oneM2M application receipt, 같은 cin으로 fallback, CSE 거절 우회 금지, RI/충돌 내용 검사 |
| test_journal.py | prepared 보존·잘못된 readback/중복 ID 거절·capture 닫기 |
| test_https_tls.py | 실제 로컬 TLS1.3/mTLS·oneM2M HTTP, 잘못된 CA/client/서버 이름·무인증·TLS1.2 거절, redirect/proxy 차단 |

TLS fixture의 인증서·키는 임시 폴더에서 생성하고 종료 시 삭제한다. 시험용 server와 proxy socket도 종료 시 닫는다. test_store.py의 POSIX directory fsync는 Windows에서 모의 처리하며 실제 SQLite/임시 파일 처리는 수행한다.

[최신 TLS55개 실행 증거](../evidence/2026-10-30-https-tls/README.md)에 로그·환경·hash를 연결했다. 이전 [영수증47개·wheel build](../evidence/2026-10-30-receipt-routing/README.md), [BLE42개](../evidence/2026-10-30-ble-sessions/README.md), [firmware3개 build](../evidence/2026-10-29-local-validation/README.md)는 당시 기록으로 유지한다.

실제 Pi/BlueZ·중앙 MQTT TLS/ACL·CSE·principal/AE/grant/ACP, 장비 출력·전력/거리·영상·release는 미완료다. 로컬 TLS 결과를 중앙 정책 승인이나 전체 G-SEC 통과로 표시하지 않는다.
