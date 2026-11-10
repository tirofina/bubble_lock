# Feather LED 시험 절차의 로컬 리허설

KEYRING 남호 · DOC-REV 2.0.0 · Gateway 0.2.7 · 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93` · 2026-11-10.

실제 팀 Node mTLS API와 격리 Mobius4를 열고 전체 Gateway worker를 실행했다. Feather의 BLE와 GPIO는 소프트웨어 시험 장치가 대역했다. 명령 수신 경로에는 실제 Gateway HTTPS 조회·승인, SQLite 기록, CSE 저장·조회가 포함된다.

| 시험 | 확인 결과 |
|---|---|
| 기본 fixture 실행 | 정상 종료. 중앙 명령 0개, 명령 증거 파일 없음 |
| 명시적 ON/OFF | `LED_ON` 파일 전까지 실행 0회. `LED_OFF` 파일 전까지 ON 1회. 최종 실행 순서 ON → OFF |
| 영수증 대조 | 다른 명령 ID 2개, CSE 영수증 2건. CLI가 SQLite의 해시·본문·전송 완료와 일치함을 확인. 읽기값을 바꾼 영수증은 거절 |
| 격리와 정리 | Pi 전송 bundle에 Gateway 키만 포함. 두 fixture 종료 뒤 bundle 제거. 시험 컨테이너와 네트워크 잔여 0개 |

기본 Gateway 71개와 리허설 2개가 통과했다. 실제 Pi, Feather BLE·GPIO와 LED 육안 확인은 실물 단계에서 수행한다. [실물 시험 절차](../../raspberry-pi-gateway/TESTING.md#feather-led-onoff-시험)

리허설에는 기존 [CSE 시험 환경](../../raspberry-pi-gateway/TESTING.md#별도-실제-cse10개)을 사용한다. `KEYRING_TEST_TEAM_REF`를 위 팀 commit으로 지정한 뒤 저장소 루트에서 다음을 실행한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/pi_led_cycle_test.py -v
```

| 로컬 로그 | SHA-256 |
|---|---|
| `basic.log` | `2e7d00c07f7c7fd15ba75d958b85092a97c98587bd63b074648c2038aab9b675` |
| `rehearsal-final.log` | `6de246322174b836852d6215f41ca37dd31ecbdc1b677ed95ae0c37d1f84ffb3` |
