# CORE MQTT 명령과 ACK 경로 시험

KEYRING 남호 · DOC-REV 2.0.0 · Gateway 0.2.7 · R02, R10, R01 · 2026-11-10.

격리 Mosquitto에서 MQTT 3.1.1, TLS 1.3 mTLS, QoS 1로 명령과 ACK를 보냈다. 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93`의 중앙 Node API가 원본을 발급했다. 시험용 CORE peer가 원본과 변조본을 발행했고 Gateway 전체 worker는 모의 GATT에 연결했다. native 영수증은 격리 Mobius4에서 다시 조회했다.

| 기대 | 실제 |
|---|---|
| Gateway 인증서의 명령 발행을 broker ACL이 차단 | 브로커 로그에 발행 거부가 남았고 중앙 승인 단계에 들어가지 않았다 |
| 목록 조회 실패 중에도 변조본의 DB 등록을 차단 | 실제 중앙 API가 같은 ID의 다른 해시를 거절했고 SQLite에 명령 행이 없었다 |
| CORE 형식의 정확한 발급본을 수신하고 연결 뒤 승인 재확인 | 중앙 승인 두 번. 발급본의 해시와 일치했고 모의 GATT 연결 전 쓰기 0회, 연결 뒤 완성 프레임 1개 |
| CORE ACK와 native 영수증의 결과 일치 | QoS 1 ACK를 수신했고 CSE에서 200/2000으로 다시 읽은 영수증 1건의 파생 ACK와 JSON이 일치 |

목록 조회에는 503 오류를 주입했고 중앙 authorize 호출, MQTT 토픽 전송, CSE 저장·조회는 실제로 수행했다. 팀의 운영 CORE 발행기와 ACK 정산, Pi 실물 배포와 Feather 출력은 후속 검증 범위다. 시험 종료 뒤 전용 컨테이너·네트워크는 0개였고 기존 개발 컨테이너 4개가 실행 중이었다.

재현 명령은 [Gateway 시험 절차](../../raspberry-pi-gateway/TESTING.md)에 있다. 로그 원본은 로컬에 보관했다.

| 파일 | 통과 | SHA-256 |
|---|---:|---|
| `basic.log` | 71 | `013696d91a3ad2df071f0e2c5981562d16dbdafa9a3b338ae798a4d15d07e373` |
| `central-final.log` | 4 | `f2da23cc2a29ca7dc6186148f50d56bd605ac99b60cccb872e3f3c1752a0ad1a` |
| `mqtt-existing.log` | 6 | `4652203c1468210a92e67daf5e2a15f58b731200f6df6e6fb122f124370640a8` |
