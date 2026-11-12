# 그룹 제품 경로 실행 증거

2026-11-12 10:28 UTC 실행, 브랜치 `feature/final-integration`, 담당 PC-MOBIUS-INTEGRATION. 결과는 PASS다.

포털의 장치별 canonical 승인을 동일 저장소의 durable GroupDispatcher와 실제 CSE `/fopt`로 연결했다. CSE 멤버 게시가 성공한 명령만 기존 Gateway 큐에서 조회·claim할 수 있다. 그룹 정산은 인증된 native 장치 ACK/readback 결과만 사용한다.

| 검증 | 기대 | 실제 |
|---|---|---|
| 변경 전 RED | 새 제품 경로 회귀 실패 | 3/3 실패: 그룹 조회·재시도 404, CSE 게시 0건 |
| 변경 후 회귀 | 기존·신규 포털·그룹·claim 시험 통과 | 33/33 PASS |
| 실제 CSE 첫 `/fopt` | A만 UPDATE 허용, B UPDATE 거절 | 2004/4103, CSE 상태 A=true/B=false/C=false |
| CSE 성공과 ACK 구분 | CSE 게시만으로 장치 적용 판정 금지 | appliedCount=0 |
| Gateway 입장 | CSE 실패 B는 poll·claim 금지 | B poll 빈 배열, 회귀에서 authorize=false |
| 모의 장치 ACK | canonical claim·payload·readback 결속 | A ACK 뒤 appliedCount=1, 위조 receipt 403 |
| 재시작과 재시도 | A 보존, B만 동일 canonical 명령 재시도 | 멤버 시도 수 A=1/B=2, B의 CSE 2004 |
| 최종 재시작 | 정산·중복 영수증 보존 | SETTLED 2명, 양쪽 receipt DUPLICATE |
| 현재 권한·유효기간 | 만료·회수 후 재게시 금지 | 회귀 PASS, 5초 reservation/claim 제한 유지 |
| 승인 저장 실패·동시 재전송 | 저장 전 외부 전송 금지, 중복 게시 금지 | 회귀 PASS |
| 구문·diff | 변경 JavaScript 구문 및 공백 검사 | 8개 `node --check`, `git diff --check` PASS |

실제 CSE는 CSE 담당자가 제공한 Mobius4 4.25.0, pin `e8f75b1`의 loopback A를 사용했다. 설치·CSE 재시작은 이 작업에서 수행하지 않았다. 실제 TLS 1.3/mTLS API, 두 모의 Gateway, 두 모의 키링의 별도 상태 journal을 사용했다. 세 번째 장치는 승인에서 제외했다. BLE·실제 Pi·키링 실물 시험은 포함하지 않는다.

실행 명령은 다음과 같다.

```sh
node --test pc-mobius/test/group-product.test.mjs pc-mobius/test/group-dispatcher.test.mjs pc-mobius/test/portal.test.mjs pc-mobius/test/gateway-control.test.mjs
RUN_TMP=/tmp/bubble-group-PaNYVd node pc-mobius/scripts/run-group-product-real.mjs \
  --endpoint http://127.0.0.1:39777 --originator PREPARED_CSE_TEST_ORIGINATOR \
  --evidence docs/final-evidence/group
```

`regression.log`는 33개 회귀의 원본 결과다. `actual-cse-group.json`은 멤버 상태, CSE readback, 승인 canonical 명령, 모의 장치 journal, 2회 재시작 결과다. `http-trace.json`은 실제 mTLS API 응답이고 `actual-cse.log`는 러너의 최종 PASS 출력이다. RED 원본은 그룹 세션 `bash_1`에 보존됐으며 최초 실패 3건의 요약을 위 표에 기록했다.

| 파일 | SHA-256 |
|---|---|
| `actual-cse-group.json` | `4769717b1e412db63bb3c450f5d57d8913c532941862f809f8c3366c29350998` |
| `http-trace.json` | `e6d64af6b5c6c676362e89b9556ded1b9ce150e12255b9e40bae7688d0667027` |
| `actual-cse.log` | `24005f9e00f19842b33621cc68e435792a970153754c3dff5dc3c690339ac246` |
| `regression.log` | `672589cf0a7165d369a6297d120f3c779ad1288cf5d84a12e0277b7afc0eb97f` |

LSP는 freshness timeout으로 새 진단을 제공하지 못했다. 위 구문 검사와 실행 회귀를 사용했다. 루트가 전달한 변경 전 전체 `npm run verify` 13단계 baseline은 PASS이며, 이 그룹 작업은 해당 전체 검증을 중복 실행하지 않았다. 그룹 시험은 JSON 영속 저장소로 수행했고 PostgreSQL 그룹 다중 프로세스 동시성은 별도 검증하지 않았다.

설정과 API·복구 절차는 [그룹 제품 경로](../../../pc-mobius/integration/GROUP_PRODUCT.md)를 따른다.

## 부분 승인 실패 추가 회귀

root 검토에서 두 번째 canonical 명령 발급이 실패하면 첫 명령에 `groupRequestId`가 아직 없어 CSE 게시 전 Gateway poll로 반환되는 결함을 재현했다. `partial-approval-red.log`에 실패 응답을 보존했다. 표지를 개별 발급과 같은 승인 트랜잭션에서 저장하고, 원래 명령의 승인 재전송은 현재 정책을 검사하면서 CSE 게시 대기를 허용하도록 수정했다. poll과 authorize의 게시 입장 제한은 유지한다.

`node --test pc-mobius/test/group-product.test.mjs pc-mobius/test/group-dispatcher.test.mjs pc-mobius/test/portal.test.mjs pc-mobius/test/gateway-control.test.mjs`는 34/34 PASS다. `partial-approval-green.log`가 원본이다.

실제 배포 CSE의 내부 HTTP 주소에 root 소유 loopback 중계를 두고 다음 명령을 실행했다. originator는 로컬 비밀 설정에서 읽고 공개 로그에 쓰지 않았다.

```sh
node pc-mobius/scripts/run-group-product-real.mjs \
  --endpoint=http://127.0.0.1:40773 --originator="$CSE_ADMIN" \
  --evidence=docs/final-evidence/group/partial-approval
```

exit 0, 실제 TLS API에서 두 번째 발급 실패 403 뒤 Gateway poll은 200/`commands:[]`, 같은 승인 재시도는 200이었다. 실제 CSE 응답은 2004/4103/2004, 최종 두 멤버 SETTLED이며 두 번 재시작 뒤 중복 영수증도 보존했다. 추가 원문은 `partial-approval/{actual-cse-group.json,http-trace.json}`와 `partial-approval-surface.log`다.

러너의 시험 PKI·서버·상태는 종료 시 정리했다. 중계는 `stop(true)` 후 같은 loopback 주소의 연결이 `ECONNREFUSED`임을 확인했다. 배포 대상 노트북에는 접속하지 않았고 새 Docker 포트 공개도 하지 않았다.
