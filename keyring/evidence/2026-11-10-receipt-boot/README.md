# BLE 적용 영수증의 부팅 ID 검증

KEYRING 남호 · DOC-REV 2.0.0 · Gateway 0.2.8 · R01, R02, R10 · 2026-11-10.

| 시험 | 실제 결과 |
|---|---|
| 수정 전 모의 GATT | 현재 세션에서 commandId와 payloadHash가 일치하는 이전 bootId의 `APPLIED`가 대기 명령을 완료했다. 회귀시험 실패 |
| 수정 후 모의 GATT | 관계없는 이전 알림은 건너뛰고, 일치하는 이전 bootId의 `APPLIED`는 세션을 종료했다. 과거 `DUPLICATE`는 원래 bootId와 readback을 유지했다 |
| 팀 mTLS → Gateway worker → 모의 GATT → 격리 Mobius4 | 틀린 bootId의 `APPLIED`에 명령 프레임은 한 번만 전송됐다. 성공 ACK 없이 `INDETERMINATE` 영수증 1건을 저장했고 CSE readback이 SQLite와 일치했다 |
| 패키지 | wheel 버전 0.2.8과 Python 모듈 13개를 소스와 대조 |

기본 73개와 중앙 연동 5개 시험이 통과했다. 팀 main은 `715ef58df6c901480eb71fb3b9278e8df6547d93`이다. 이전 부팅 영수증은 모의 GATT에서 주입했다. 실제 Pi 배포와 장치의 재부팅·journal 재전송은 별도 실물 시험이다. 임시 컨테이너와 네트워크는 종료 뒤 0개였다. [재현 명령](../../raspberry-pi-gateway/TESTING.md)

| 로컬 파일 | SHA-256 |
|---|---|
| `baseline.log` | `23eb0884f9215a64d4af18fc7feea1b6aae6b0a16e8f1b6d4db9f3fff9583657` |
| `basic.log` | `9887a67ec484582b4ff4d26c45313a328bb9629300cc48b59d3d19a7f9d6f575` |
| `central.log` | `b859975df7541f425c5e86c8766998a3c6d562ca12303d5b55c6fb70be4b2fd0` |
| `privacy_bubble_gateway-0.2.8-py3-none-any.whl` | `96b4a867f87595c4a56f383e2990bfd17483b2a3412f599a66d4eeae7ac4c616` |
