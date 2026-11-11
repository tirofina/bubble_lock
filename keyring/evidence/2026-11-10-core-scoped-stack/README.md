# CORE epoch 격리 개발 프로필 준비

KEYRING 남호 · DOC-REV 2.0.0 · 2026-11-10. 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93`, Mobius4 `e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`.

| 준비 항목 | 관찰 결과 |
|---|---|
| 격리 Compose 프로젝트 | 별도 network, PostGIS·identity·cursor volume 생성. PostgreSQL healthy, Mobius4·TLS proxy·브로커·소비자 실행 |
| 호스트 포트 | CSE `127.0.0.1:8760`, 브로커 `127.0.0.1:8884`. 기존 개발 프로필의 8759·8883과 컨테이너 4개도 계속 실행 |
| 빈 oneM2M 자원 | AE 1개, cnt 3개, SDT 1개 생성. 5개 모두 HTTP 201·RSC 2001 |
| 기설치 자원 재사용 | 같은 자원 5개를 GET으로 조회. RQI, 이름·타입·SDT specialization 일치. 모두 HTTP 200·RSC 2000 |
| 중앙 소비자 | 전용 브로커 mTLS 연결과 QoS 1 구독 완료를 `SCOPED_SUBSCRIBED`로 확인 |

관측을 발행하지 않은 상태에서 프로필을 준비했다. Gateway 0.2.13 빌드, 두 인증서의 쓰기 권한 거절 시험, handover 시 SDT UPDATE와 readback, 운영 승인, Pi·BLE·실물 시험은 미실행이다. 임시 CA와 소유권 파일을 사용하는 개발 경로다.

[준비·시작 명령과 포트 설정](../../dev/mobius4/README.md#epoch-전용-mqtt-프로필)

| 로컬 파일 | SHA-256 |
|---|---|
| `provision.log` | `bb38067df5e541bddfeb4c1687c2d27addebac8896c2774e6f093c20b32fd411` |
| `created-resources.json` | `176c252c9faa3925b7cc0391124bd325548c821691bf50d8a4ba13af161de88d` |
| `resource-reuse.log` | `a343a18398484ccc12e6c226a56011755c216dd3821cea9ee79f891442010acc` |
| `services.log` | `b81085928344cb88b6c29bea4517916cc122dbe681d30716a88a35c05a19d0f2` |
