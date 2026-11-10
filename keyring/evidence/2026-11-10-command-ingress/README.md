# Gateway 중앙 명령 수신 우선순위 시험

KEYRING 남호 · DOC-REV 2.0.0 · Gateway 0.2.7 · 2026-11-10.

| 시험 | 결과 |
|---|---|
| 로컬 기본 시험 | 71개 통과. MQTT 대기열 16건에서도 HTTPS 조회 수행. 두 채널의 같은 ID는 HTTPS 발급본만 반환 |
| MQTT 단독 수신 | 목록 오류를 주입했을 때 해시 변조, 회수, 기한 만료, 중앙 접근 불가 사본 제외. 정확한 승인과 기한이 있는 사본을 배치에 한 번 포함 |
| 팀 main 중앙 통합 | 3개 통과. 실제 Node mTLS authorize에 같은 ID의 변조본과 발급본을 보내 발급본만 수신. 기존 전체 Gateway 시험에서 정상 명령 1개 프레임과 CSE receipt 1건, 회수 명령 쓰기 0회와 거절 receipt 1건 확인 |
| 로컬 wheel | `privacy_bubble_gateway-0.2.7-py3-none-any.whl` 빌드. 메타데이터 버전과 Python 모듈 13개를 소스와 대조 |

팀 main은 `715ef58df6c901480eb71fb3b9278e8df6547d93`이다. 목록 오류와 CORE 수신은 로컬에서 주입했다. 전체 worker 시험은 모의 GATT와 실제 격리 Mobius4를 사용했다. 종료 뒤 시험 컨테이너와 네트워크 잔여는 0개였으며 기존 개발 컨테이너 4개가 실행 중이었다. Pi 실물 데몬 실행 증거는 [Gateway 0.2.5 기록](../2026-11-10-pi-full-daemon/README.md)에 있다.

Gateway는 이후 수신분에 이 규칙을 적용한다. 기존 SQLite 명령 행과 영수증을 유지한다. MQTT 단독 수신에서 중앙 확인이 실패한 사본은 보존하지 않는다. 중앙이 반복 반환하는 활성 발급본은 다음 HTTPS 조회 때 다시 받을 수 있다.

재현 명령은 [Gateway 시험 절차](../../raspberry-pi-gateway/TESTING.md)에 있다. 로컬 로그와 wheel의 SHA-256을 기록했다.

| 파일 | SHA-256 |
|---|---|
| `unit.log` | `e0f86dbdc36fd575368697852b207898ae2059266ac9474be5e5c97eedcb20eb` |
| `integration.log` | `57d0a249d90ef429e1f011b46c61459d5d42e78b90e4440d88ffa9b5ea0fdc1d` |
| `wheel-check-final.log` | `db2e7c5048f313aa5cdc8855b295796941164f938e6ec222cc3947caa2977738` |
| `privacy_bubble_gateway-0.2.7-py3-none-any.whl` | `726e3e79d172983013523e2355ce0e663dc582dcaa99520d81ebb0b3bf032c70` |
