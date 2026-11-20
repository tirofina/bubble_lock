# 포털 승인과 실제 CSE 그룹 실행

포털의 `commands/approve`는 선택한 각 장치의 canonical 명령과 승인 결과를 먼저 영속 저장한다. `core.group`이 설정되면 같은 저장소를 사용하는 `GroupDispatcher`가 CSE 그룹을 만들고 실제 `/fopt`에 `cod:binSh.state`를 게시한다. 요청에 없는 가구 장치는 그룹에 넣지 않는다.

CSE 집계의 멤버별 `2004` 응답이 해당 canonical 명령의 Gateway 입장을 연다. `4103`, 누락·잘못된 멤버 응답, 통신 오류는 `RETRY_PENDING`으로 남는다. CSE 성공은 목표 상태 게시 결과다. 실제 장치 적용은 기존 Gateway poll → authorize → dispatch-start → native receipt의 ACK/readback 경로에서 확인하며 이때만 그룹 멤버를 `READBACK_VERIFIED`로 바꾼다.

명령의 commandId, claimId, grantRevision, ownershipEpoch, deadline, canonical payload hash는 재시도와 재시작 중 유지한다. 발급 시점부터 시작하는 기존 5초 reservation/claim 입장 제한도 유지한다. 유효기간이 끝난 명령은 새 claim으로 바꾸거나 자동 연장하지 않는다. 현재 grant·consent·Gateway·epoch·장치 연결을 검사한 뒤 CSE를 게시하고, 장치 실행 직전 기존 Gateway 검증을 다시 통과한다.

## 설정

기존 통합 API 설정의 `core`에 다음 구조를 넣는다. CSE 부모 AE, SDT 자원, ACP는 배포 시 준비한다. originator는 부모에 그룹 CREATE, 선택한 멤버에 UPDATE 권한을 가진다. 각 resourcePath는 장치 하나의 고유한 binarySwitch다.

```json
{
  "core": {
    "group": {
      "cse": {
        "endpoint": "http://127.0.0.1:7599",
        "cseBase": "/Mobius",
        "originator": "REGISTERED_GROUP_AE_ID",
        "parentPath": "/Mobius/household-1"
      },
      "members": {
        "keyring-A": {
          "deviceId": "keyring-A",
          "gatewayId": "pi-01",
          "groupId": "household-1",
          "resourcePath": "/Mobius/household-1/switch-A"
        },
        "keyring-B": {
          "deviceId": "keyring-B",
          "gatewayId": "pi-02",
          "groupId": "household-1",
          "resourcePath": "/Mobius/household-1/switch-B"
        }
      }
    }
  }
}
```

`groupId`는 포털 householdId와 일치한다. 서버에 등록된 Gateway/장치/가구와 포털의 장치 등록을 먼저 완료한다. `core.group`을 생략한 데모·기존 개별 명령 경로는 기존 큐를 사용한다.

## 조회와 재시도

| POST 경로 | 본문 | 권한과 결과 |
|---|---|---|
| `/v1/portal/commands/approve` | 기존 requestId, grantId, idempotencyKey | guardian + 현재 가구 grant, 승인 commit 뒤 CSE 게시 |
| `/v1/portal/commands/group` | `{"requestId":"..."}` | 가구 구성원, 영속 그룹 멤버별 상태·시도 수·appliedCount |
| `/v1/portal/commands/retry` | `{"requestId":"..."}` | guardian + bubble:command, 미확인 멤버 재검사·재시도 |

승인 재전송은 기존 승인과 그룹을 반환하며 이미 게시된 CSE 명령을 다시 쓰지 않는다. 재시작 전 승인만 commit되고 그룹이 아직 만들어지지 않았으면 같은 승인 재전송 또는 `commands/retry`가 원래 canonical 명령으로 그룹을 복구한다. 기존 그룹의 실패 멤버는 `commands/retry`로 복구한다. 이미 CSE에 게시된 멤버는 재게시하지 않는다. ACK가 늦게 도착하면 기존 claim에 대한 검증 결과로 정산한다. 그룹 조회는 영속 native 정산 결과를 다시 결합하므로 receipt 저장 직후 프로세스가 종료돼도 readback을 복구한다.

## 재현과 증거

저장소 루트에서 준비된 로컬 CSE의 주소와 등록 originator를 사용한다. 러너는 CSE를 설치하거나 다른 런타임을 시작하지 않는다.

```sh
node --test pc-mobius/test/group-product.test.mjs pc-mobius/test/group-dispatcher.test.mjs pc-mobius/test/portal.test.mjs pc-mobius/test/gateway-control.test.mjs
RUN_TMP=/path/to/owned-temp node pc-mobius/scripts/run-group-product-real.mjs \
  --endpoint http://127.0.0.1:7599 --originator REGISTERED_TEST_ORIGINATOR \
  --evidence docs/final-evidence/group
```

러너는 실제 CSE에 `/Mobius/group-final-*` 자원과 ACP를 만들고 두 모의 Gateway·키링, 선택하지 않은 세 번째 장치를 준비한다. 자체 시험 인증서로 실제 TLS 1.3/mTLS API를 사용한다. 첫 fanout의 2004/4103 부분 성공, 실패 장치의 poll 차단, 실제 CSE readback, 별도 모의 장치 상태 journal의 native receipt, 재시작 후 실패 멤버 재시도, 동일 canonical claim, 최종 재시작과 duplicate receipt를 검사한다. 생성한 CSE 자원과 시험 PKI·상태 임시 폴더는 종료 시 삭제한다.

실행 증거는 [최종 그룹 증거](../../docs/final-evidence/group/README.md)에 있다. 이 시험의 장치는 모의 장치이며 실제 Pi·키링의 BLE·실물 ACK 검증은 장비 담당자가 수행한다.
