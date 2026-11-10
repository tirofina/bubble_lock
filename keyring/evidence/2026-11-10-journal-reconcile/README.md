# 장치 journal과 Gateway·Mobius4 영수증 대조

KEYRING 남호 · DOC-REV 2.0.0 · Gateway 0.2.9 · 2026-11-10.

합성 r18 journal과 실제 Gateway의 격리 SQLite snapshot을 사용했다. 최종 wheel에서 비교 CLI를 실행하고 실제 Mobius4의 HTTPS/mTLS 영수증을 조회했다. 대상은 동일 장치의 명령 10건이었다.

| 시험 | 실제 결과 |
|---|---|
| 완료 및 이전 부팅의 중복 결과 | 두 영수증이 원래 bootId와 readback에 일치. 한 건은 Gateway 전송 완료 표시가 0으로 남아 검토 대상 |
| 준비 기록과 실패 readback | 준비 1건을 미확정으로 유지. 준비 기록의 성공 영수증 1건은 불일치. 실제 읽기값 불일치를 기록한 실패 영수증 1건은 일치한 실패로 분류 |
| 누락과 변조 | Gateway 명령·영수증 누락, CSE 누락·본문 변경, 장치/명령 hash 불일치를 각각 분류 |
| 보관본 검증 | 장치 보관본과 Gateway SQLite의 바이트 변조, 다른 CSE 자원으로 바꾼 설정 모두 중단 |
| 읽기 전용 | 입력 보관본의 바이트와 실제 CSE cin 6건 유지. 10건 중 검토 대상 9건 |

최종 wheel에서 기본 시험 73개가 통과했다. 설치본 Python 모듈 14개를 소스와 비교했고 새 console entry를 불러왔다. 실제 키링 NVS와 Pi에서 보관본을 수집하는 과정은 별도 실물 시험이다. 시험 컨테이너와 네트워크는 종료 뒤 0개였다.

재현은 [실제 CSE 시험 환경](../../raspberry-pi-gateway/TESTING.md#별도-실제-cse10개)에서 다음 명령을 실행한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/journal_reconcile_test.py -v
```

| 로컬 파일 | SHA-256 |
|---|---|
| `basic-final.log` | `05c16c0762daba9e7293c349d566ba9eb761dfd649d775e8c8eb27fca11793b9` |
| `reconcile-final.log` | `9157f1f395ebb0e516c037f1c9d0bf9e6deabf9435aec0ecf52345fa4957ca04` |
| `package-check.log` | `38c9d6d467318741b87f471f000d3a4543432af711afbfff8dc72d9a3c366d8a` |
| `privacy_bubble_gateway-0.2.9-py3-none-any.whl` | `241f4cb08225a00da4d412af376d93b9affce0a8eee1371ff1f8a0c6846f5431` |
