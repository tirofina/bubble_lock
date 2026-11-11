# CORE 관측 재시도 순서

KEYRING 남호 · DOC-REV 2.0.0 · Gateway 0.2.11 · 2026-11-10.

기존 Gateway는 같은 장치의 오래된 CORE 관측이 backoff 중일 때 뒤의 최신 관측을 선택했다. 기존 소스의 SQLite 재열기 회귀시험에서 순서 역전을 확인했다. 0.2.11은 CORE 관측의 장치별 선두 행만 전송 후보로 사용한다.

| 시험 | 실제 결과 |
|---|---|
| SQLite 재열기와 backoff | 같은 장치의 후속 CORE 관측은 대기. 다른 장치의 CORE 관측과 native 관측은 선택됨. 복구 뒤 원본 순서 0 → 1 |
| 팀 CORE → 실제 SDT | 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93`의 handler에 역순 1 → 0을 넣으면 최종 상태 ON. 수정된 SQLite의 0 → 1을 넣으면 최신 OFF. 두 경우 실제 Mobius4 `pb:binarySwitch`를 mTLS로 갱신하고 읽음 |
| Native 관측 | CORE backoff 동안 일반 cin 2건을 실제 CSE에 저장 |
| 호환 범위 | Windows 기본 75개, 격리 Mobius4 11개, 별도 SDT 1개와 Ubuntu SQLite 3.45.1 회귀 1개 통과. wheel 모듈 14개가 소스와 일치 |

SDT 시험은 SQLite가 선택한 payload를 원본 CORE의 메시지 handler에 순서대로 전달했다. 브로커 전달과 중앙 UPDATE의 동시 실행, 서로 다른 Gateway의 handover, 실물 Pi 배포는 별도 검증 범위다. 종료 뒤 시험 컨테이너·네트워크는 0개였다.

[실제 CSE 시험 환경](../../raspberry-pi-gateway/TESTING.md)을 사용하고 `KEYRING_TEST_CENTRAL_TREE`를 위 팀 커밋에서 `pc-mobius`를 추출한 루트로 지정한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/core_retry_order.py -v
```

| 로컬 파일 | SHA-256 |
|---|---|
| `baseline.log` | `1bf6f16f24a27e44bd3c192f47e255c88a2a9fc6d890cadae85adf76e2ab8ae8` |
| `basic.log` | `17e9321e9a2c3e66a904e89da6744b3e2ccae8ecaf2ca87d68f4dc177d352ce2` |
| `core-cse.log` | `f84818c01b3d7b89b80187027517ccf0336d81cae3e7f3b5b4669fa354a50eef` |
| `native-cse.log` | `773358f964cdd07903454e5b951d8edfdf05707b662d68628b5877df975c88d7` |
| `ubuntu-regression.log` | `7a50dfe495573e7460bc852d70a3db14014f6e1ddf9593bb8b5d850e2d1e6ff8` |
| `privacy_bubble_gateway-0.2.11-py3-none-any.whl` | `cd9999550c128d64b648823eaa3d5ac3f2661f2f0fdff05d301634617f7a15ac` |
