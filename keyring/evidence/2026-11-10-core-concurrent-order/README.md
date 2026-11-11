# CORE 관측의 동시 갱신과 handover

KEYRING 남호 · DOC-REV 2.0.0 · 2026-11-10. 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93`, Gateway 0.2.11, Node 24.22.1.

실제 팀 `GatewayBridge`의 메시지 핸들러에 Gateway 형식의 관측을 전달했다. 먼저 받은 ON을 CSE 전송 직전에 멈춘 상태에서 뒤의 OFF를 넣었다. 양쪽 모두 격리 Mobius4에 TLS 1.3/mTLS로 UPDATE를 보내고 oneM2M 응답 2004와 별도 SDT 조회 2000을 확인했다.

| 시나리오 | 실제 결과 |
|---|---|
| 팀 원본 동시 UPDATE | OFF → ON 순으로 완료. SDT 최종 상태 ON |
| 자원별 직렬화 후보 | ON → OFF 순으로 완료. SDT 최종 상태 OFF. 대기 한도 초과와 이미 반영된 sequence를 차단 |
| Gateway 교체와 롤백 | 이전 Gateway·epoch와 위조한 payload ID를 차단. 새 Gateway의 sequence 0과 롤백 뒤 새 epoch를 허용. SDT 최종 상태 OFF |
| 반영 후 응답 유실 주입 | SDT에 ON을 저장한 직후 예외를 주입. 팀 파일 저장소를 다시 열어 `PENDING`이 남고 후속 OFF가 차단되는 것을 확인 |
| 저장과 전송 사이의 소유권 변경 | 소유권을 다시 확인해 CSE 전송을 차단하고 직전 cursor를 복원 |
| Gateway 재시도 순서 재검증 | CORE sequence 0 → 1과 최신 OFF를 다시 확인. CORE 대기 중 native cin 2건을 별도로 저장 |

두 통합 시험이 통과했다. 소유권과 epoch는 시험에서 공급했고 저장소는 같은 Node 프로세스에서 다시 열었다. 브로커 인증·구독, 운영 handover drain, 전원 차단 뒤 복구, 다중 실행 주체 간 제어 및 실물 연동은 별도 검증 범위다. 종료 뒤 격리 시험 컨테이너와 네트워크는 남아 있지 않았다.

[실제 CSE 시험 환경](../../raspberry-pi-gateway/TESTING.md)을 사용하고 `KEYRING_TEST_CENTRAL_TREE`를 위 팀 커밋에서 `pc-mobius`를 추출한 루트로 지정한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/core_retry_order.py -v
```

| 로컬 파일 | SHA-256 |
|---|---|
| `sdts.log` | `456bfc8e51af305885a8861208188fc668637eb1921832afbeb589e247b3f751` |
