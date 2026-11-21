# Mobius4 구독 권한: 표준 절차

대상 CSE: 수정하지 않은 Mobius4 4.24.5. CSE 소스 패치는 사용하지 않는다.

## 구독 생성

`<subscription>` 생성에는 부모 자원의 CREATE와 구독 대상 자원의 RETRIEVE가 함께 필요하다(TS-0004 7.4.8.2.1 Recv-6.3). Mobius4 4.24.5는 일반 절차에서 CREATE를, `cse/resources/sub.js`에서 RETRIEVE를 검사한다.

RETRIEVE만 가진 MEC IPE는 `integration/src/cse-subscription-lifecycle.mjs`의 `subscribeWithTransientCreate`로 구독한다.

1. 관리자가 desired ACP에 MEC IPE의 CREATE와 RETRIEVE를 더한다.
2. MEC IPE가 Originator로 `<subscription>`을 만든다. CSE는 MEC IPE를 creator로 기록한다.
3. 관리자가 원래 정책을 되돌리고 readback으로 CREATE가 빠진 것을 확인한다. 생성이 실패해도 정책을 되돌린다.

구독 생성 뒤에는 RETRIEVE만으로 알림을 계속 받는다. CREATE가 열린 짧은 시간에 MEC IPE가 desired에 cin을 쓸 수 있지만, 장치 명령은 이 컨테이너를 거치지 않는다. 중앙 `gateway-control.mjs`가 claimId, grant revision, ownership epoch, deadline을 붙여 Gateway로 보내고, Gateway는 claimId가 없는 명령을 거부하며(`keyring/raspberry-pi-gateway/tests/test_protocol.py` `test_closed_command_requires_claim_and_real_boolean`), 중앙 승인 응답의 claimId나 payload hash가 다르면 실행하지 않는다(같은 파일 `test_authorization_cannot_extend_deadline_or_change_binding`).

## 알림 대상 검증

CSE 설정에 `cse.subscription_verification: true`를 둔다(Mobius4 기본값은 `false`). Docker 실행은 `keyring/dev/mobius4/cse-local.json`을 `/app/config/local.json`으로 마운트하고, 소스 실행은 `pc-mobius/scripts/start-mobius4-test.ps1`이 NODE_CONFIG에 넣는다. `nu`는 URL이 아닌 수신 AE의 자원 ID로 쓴다. 구독을 만들 때 CSE는 `vrq: true`와 creator(`cr`)를 담은 verification request를 수신 AE의 pointOfAccess로 보낸다(Mobius4 `cse/noti.js` `send_verification`). 수신 AE는 신뢰하는 creator에게만 2000으로 답하고, 그 밖의 creator에게는 4101(SUBSCRIPTION_CREATOR_HAS_NO_PRIVILEGE)로 답한다. 응답이 2000이 아니면 CSE는 구독 생성을 5204(SUBSCRIPTION_VERIFICATION_INITIATION_FAILED)로 거절한다(TS-0004 7.4.8.2.1 Recv-6.4, 7.5.1.2.3).

`nu`가 URL이면 Mobius4는 verification request를 보내지 않는다. 표준은 Originator가 아닌 대상에게 verification을 보낼 수 있다(may)고 정하므로 이 동작도 표준 범위 안이다. 대상 검증이 필요한 구독은 자원 ID 형식의 `nu`를 쓴다. KEYRING 영수증 수신기(`keyring/integration-candidate/receipt-notification-ingress.mjs`)는 등록한 `creators` 목록에 있는 creator에게만 2000으로 답하고, 목록이 없으면 모든 verification request를 4101로 거절한다.

## 권한 회수

TS-0004 7.5.1.2.2의 알림 절차는 전송 시점에 권한을 다시 확인하지 않는다. ACP에서 권한만 빼면 기존 구독의 알림이 계속 나간다. 회수는 `revokeSubscriber`로 수행한다.

1. 해당 주체의 `<subscription>`을 먼저 삭제한다. 이미 없는 구독(4004)은 삭제된 것으로 처리한다.
2. 그다음 ACP를 회수 정책으로 바꾼다.

구독을 먼저 지우므로 회수 도중에 알림이 나가지 않는다. handover의 `fence`와 `release`도 ACP 회수와 구독 삭제를 함께 수행한다.

## 재현

```powershell
$env:MOBIUS4_ROOT = '<Mobius4경로>'
node pc-mobius/scripts/run-acp-isolated.mjs
```

runner는 `.local/postgres/connection.json`의 로컬 개발 DB 설정으로 별도 DB와 소스 사본을 만들고, 수정하지 않은 소스로 CSE 두 개를 띄운다. 프로세스와 callback은 loopback에 바인딩한다.

시험 항목:

| 항목 | 기대 결과 |
|---|---|
| RETRIEVE만 가진 MEC IPE의 구독 생성 | 4103 |
| CREATE만 가진 relay의 구독 생성 | 4103 |
| 임시 CREATE 절차로 MEC IPE 구독 생성 | 2001 |
| 절차 뒤 MEC IPE의 CREATE | 정책에 없음, 명령 cin 생성 4103 |
| NOTIFY 권한이 없는 대상으로 구독 생성 | 5204 |
| 회수 전 변경 알림 | 전달됨 |
| 회수 시 구독 삭제 | 2002 |
| 회수 뒤 변경 알림 | 0건 |
