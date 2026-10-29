# Gateway 모의 단위 테스트

DOC-REV 2.0.0 · KEYRING / 남호 · 2026-10-29.

이번 작업의 사용자 허가로 Python 단위 테스트를 실행했다. 테스트는 합성 명령·identity와 각 테스트가 생성한 임시 SQLite만 사용한다. 운영 설정·인증서·기존 DB를 읽지 않고 scanner, BLE 연결, MQTT broker, HTTPS 서버, daemon을 시작하지 않는다.

저장소 루트에서 개발 환경의 Python과 아래 명령을 사용한다. 먼저 `pyproject.toml`의 Gateway 의존성(bleak/httpx/paho-mqtt)을 설치해야 한다. 테스트 프레임워크는 Python 표준 `unittest`다.

```powershell
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src')
python -m unittest discover -s keyring/raspberry-pi-gateway/tests -v
```

| 파일 | 기대 결과 |
|---|---|
| test_protocol.py | claim/grant와 승인 hash 일치, 승인 기한 제한, JSON 중복 키/비유한 값 거절, 분할 메시지 복원, INA219 단위·부호·계산 검사, 모의 BLE 20바이트 송신과 실패 시 세션 해제 |
| test_store.py | 중복/충돌·실행 intent 유지, fence·용량 오류의 원자성, 재부팅을 넘어 CORE sequence 증가, receipt 전달 확정, WAL backup의 데이터 보존, 격리된 복사본 실행 거절, 명시적 legacy adoption과 잘못된 hash/덮어쓰기 거절 |
| test_dispatch.py | 승인/credential/기한 오류 시 BLE 미송신, BLE 이전 intent 기록, timeout·readback 불일치 처리, 자동 재실행 방지, 실제 전송 함수 성공 이후에만 outbox 전달 확정 |
| test_transport.py | 모의 oneM2M application receipt만 성공 판정, 미응답 시 같은 cin 이름으로 HTTP fallback, CSE 거절 시 우회 전송 금지, HTTP request ID 및 충돌 자원 내용 일치 검사 |
| test_journal.py | prepared record를 적용 성공으로 바꾸지 않고 보존, 잘못된 readback·중복 commandId 거절, 오류 후 volatile capture 닫기 |

Windows Python에서 37개가 통과했다. [실행 증거](../evidence/2026-10-29-local-validation/README.md)에 명령과 로그를 연결한다. `test_store.py`는 Windows에서 제공되지 않는 POSIX directory fsync만 모의 처리한다. SQLite backup·transaction·quarantine·hash와 실제 임시 파일 I/O는 수행한다. POSIX 파일 권한·advisory lock·디스크 전원 손실 내구성, Raspberry Pi/BlueZ, 실제 TLS/MQTT/BLE, 장치 NVS·GPIO·물리 출력은 이 결과로 검증하지 않는다.

실물·통합 시험과 release는 별도 완료 조건이다. 현재 테스트 통과가 중앙 승인/settlement/checkpoint 계약의 확정이나 제품 전체 검증을 의미하지 않는다.
