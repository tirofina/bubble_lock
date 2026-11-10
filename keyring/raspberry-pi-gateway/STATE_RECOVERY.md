# Gateway 상태 보관과 신원 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · Gateway0.2.3 · 로컬 POSIX 시험 통과 / Pi·중앙 복구 미완료.

SQLite journal/outbox/fence/dedup/CORE sequence를 보관하고 다른 Gateway 설정의 DB 사용을 차단한다. [실제 Linux POSIX 시험10개](../evidence/2026-10-30-posix-state/README.md)가 소스·설치 wheel에서 각각 통과했다. 실제 flock/fsync·권한·WAL·CLI snapshot/adopt·ENOSPC·adoption 변경 감지를 새 합성 DB로 확인했다. 운영 DB·실물 Pi·전원 손실·중앙 복구 활성화는 미완료다.

## 상태의 경계

새 빈 DB는 gateway_state metadata에 configured Gateway ID/Originator/CSE ID/RVI/관측·receipt·health container path를 기록한다. 시작할 때 같은 binding인지 확인하며 다른 설정이거나 archive quarantine이면 BLE·전송을 시작하지 않는다. 신원이 있는 DB에서 필수 data table이 빠져도 조용히 새로 만들어 실행하지 않는다.

이 binding은 **로컬 설정·파일 일관성**이다. 중앙 신원 인증·grant·lease·attestation이나 rollback 방지 checkpoint가 아니다. mTLS·credential status·실행 직전 authorize·장치 NVS journal은 계속 필요하다. 동일한 CSE ID를 다른 서버에서 재사용하면 이 metadata만으로 같은 실제 서버라고 확인할 수 없다.

endpoint URL·broker 주소·인증서 경로는 binding에 넣지 않아 주소/credential 교체는 설정으로 가능하다. Gateway principal/CSE 자원 경로를 바꾸는 경우에는 이전 state를 그대로 새 정체성에 연결하지 않는다. 새로운 realm에는 새 DB 경로를 사용하고 이전 파일·fence·미정산 자료를 보존한다. 테스트 서버의 데이터·credential을 운영 환경에 자동 이관하지 않는다.

## 수동 snapshot

`bubble-gateway-state snapshot`은 Python [sqlite3 backup API](https://docs.python.org/3.11/library/sqlite3.html#sqlite3.Connection.backup)로 committed WAL을 포함한 일관된 복사본을 만든다. live `.db` 파일만 복사하고 `-wal`을 놓치는 방식이 아니다. source connection은 read-only이며 command/fence/outbox 등 원본 data row를 수정하지 않는다. 새 private 폴더/파일만 만들고 기존 output을 덮어쓰거나 삭제하지 않는다.

복사본에는 gateway_state QUARANTINED와 archive ID를 기록한다. 따라서 복사본은 원본과 byte-identical 파일이 아니며, application data table을 보존하는 logical snapshot이다. archive DB를 GATEWAY_DATABASE로 지정해도 daemon이 시작을 거절한다. 오래된 snapshot의 fence/command/dedup/CORE sequence로 돌아가면 중복/순서 문제가 생길 수 있어, 로컬 백업 성공만으로 복구 활성화를 허용하지 않는다.

아래는 사용자가 보관을 실제 요청했을 때 사용할 명령 예다. 이번 작업에서 실행하지 않았다. 환경 파일과 DB 경로는 기존 배포와 동일해야 한다.

```sh
sudo systemctl stop privacy-bubble-gateway
sudo install -d -o bubble-gateway -g bubble-gateway -m 0700 /var/lib/privacy-bubble-gateway/keyring-gateway-archives
sudo -u bubble-gateway /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-gateway-state snapshot \
  --env-file /etc/privacy-bubble/gateway.env \
  --output /var/lib/privacy-bubble-gateway/keyring-gateway-archives/state-001
sudo systemctl start privacy-bubble-gateway
```

도구는 daemon과 같은 DB `.lock`을 잡는다. 서비스를 자동으로 중지·재시작하지 않으며 같은 파일을 다른 도구에서 동시에 쓰지 않는다. output의 parent가 있어야 하고 output 자체는 새 폴더여야 한다. 기본 copy timeout120초는 운영 옵션이며 성능 측정/수용 SLA가 아니다. `--timeout`5~3600초로 선택할 수 있다.

archive에는 gateway.sqlite3와 [manifest.json](../../contracts/keyring/gateway-state-archive.schema.json)이 생긴다. manifest는 configured binding/hash, 실제 table count·저장된 command status 수, DB byte 수/SHA256, QUARANTINED·not-settled·central-reconciliation-required를 기록한다. DB와 manifest를 fsync하고 마지막에 디렉터리를 동기화한다. 실패의 부분 output은 자동 삭제하지 않는다. 파일 생성·manifest 존재만으로 전체 물리 복구나 중앙 정산을 완료했다고 표시하지 않는다.

snapshot에는 관측/command/claim/device metadata가 **평문**으로 포함된다. PKI·passkey·env 파일을 함께 복사하지 않지만 기존 application payload의 개인정보가 제거되는 것은 아니다. owner-only 폴더0700/파일0600으로 만들고 공개 Git에 넣지 않는다. keyring-gateway-archives/는 Git ignore다. 별도 암호화/보관 권한/매체 관리는 운영 정책이 필요하며 SHA256은 서명이 아니다.

## 이전0.1.x DB의 명시적 adoption

신원 metadata가 없는 비어 있지 않은 DB는 startup에서 STATE_LEGACY_ADOPTION_REQUIRED로 중단한다. 자동으로 현재 Gateway 소유라고 추정하지 않는다. 기존 원본 DB를 올바른 Gateway/CSE 설정으로 계속 사용할 때만 아래 명령으로 adoption한다. 다른 Gateway/realm으로의 이전이나 오래된 backup 복구를 위한 우회 명령이 아니다.

```sh
sudo -u bubble-gateway /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-gateway-state adopt \
  --env-file /etc/privacy-bubble/gateway.env \
  --output /var/lib/privacy-bubble-gateway/keyring-gateway-archives/pre-adoption-001
```

서비스를 중지한 유지보수 창에서 실행한다. 도구는 command/receipt/outbox의 Gateway ID·command hash/연결·container path와 식별자 형태를 읽고 다른 설정이면 거절한다. 과거 device가 현재 BLE fleet에 없더라도 이력을 지우거나 새 device에 바꾸지 않는다. record가 없는 fence/sequence의 원래 중앙 principal을 이 검사만으로 인증할 수는 없으므로 **원본 DB와 같은 Gateway/CSE 설정을 선택하는 것은 운영자의 명시적 책임**이다.

원본에 metadata를 추가하기 **전에** 새 격리 snapshot과 manifest를 완성한다. 이후 source data_version이 바뀌지 않았는지 확인하고 SQLite write transaction에서 binding을 추가한다. 초기 daemon에 없던 core_sequences table은 필요한 경우 빈 table로 추가한다. command/fence/observation/outbox/기존 CORE sequence row는 수정·삭제·재실행하지 않는다. 이미 올바르게 bound된 원본이면 binding을 다시 쓰지 않는다.

commit 후 [adoption.json](../../contracts/keyring/gateway-state-adoption.schema.json)에 실제 bindingAdded 여부를 기록한다. DB commit 뒤 receipt 쓰기 실패가 날 수도 있어, receipt 부재만으로 metadata가 추가되지 않았다고 단정하지 않는다. 원본/부분 output을 보존하고 startup error·metadata 상태를 기준으로 조사한다. mismatch나 quarantine을 강제로 LIVE로 바꾸는 flag는 없다.

## 복구 활성화에 남은 중앙 계약

이 버전은 snapshot을 실수로 시작하는 것을 막으며, **restore activation 명령은 아직 제공하지 않는다**. 전체 R12/continuity 완료를 주장하지 않는다. 다음 항목을 PC-MOBIUS-INTEGRATION/CORE와 맞춘 뒤 복구 활성화 경로를 구현해야 한다.

- snapshot 이후 수락/적용/정산한 commandId와 현재 claim/grant/epoch의 authoritative checkpoint.
- 이전 Gateway 정지·credential/ownership 이전과 새 current authorization. 로컬 binding이 이를 승인하지 않음.
- 장치 NVS PREPARED/COMPLETED와 중앙 receipt 대조, 불명확한 dispatch의 재실행 금지.
- outbox의 실제 oneM2M receipt·dedup 상태와 CORE sequence의 현재 상한. 오래된 sequence를 새 상태로 사용하지 않음.
- checkpoint 검증/적용/활성화 사이 crash·재시도·rollback 처리 및 signed/인증된 복구 승인 계약.

원래 DB를 그대로 재시작하는 기존 경로는 유지한다. DISPATCHING이 남아 있으면 기존 service가 INDETERMINATE receipt를 만들고 동작을 재실행하지 않는다. 새 백업을 활성 상태로 가장하지 않는다.

## 인수 항목의 현재 증거

아래는 로컬 부분 증거다. approver/gate 승인과 실물 결과는 남아 있다.

| ID | 로컬 실제 결과 | 남은 범위 |
|---|---|---|
| KR-STATE-01 | 기본 단위시험의 identity 재시작/table 검사와 Linux CLI의 mismatch 거절 | Pi 실제 배포/startup |
| KR-STATE-02 | Linux CLI가 실제 committed WAL·command/fence/outbox/CORE sequence row 보존·manifest hash·0700/0600 확인 | Pi SD카드·전원 손실 내구성 |
| KR-STATE-03 | 별도 프로세스 flock로 CLI/daemon entry 차단, 실제 ENOSPC/partial output/기존 output/symlink 거절 | 장시간 CLI copy timeout·실물 저장 장치. timeout=-1 API 시험은 이미 경과한 deadline만 확인 |
| KR-STATE-04 | 합성 legacy CLI adopt·hash 오류 거절·실제 fsync 후 다른 프로세스 DB 변경 감지·원본 row 보존 | 운영 원본 식별·DB commit 후 receipt 쓰기 중단·중앙 정산 |
| KR-STATE-05 | QUARANTINED Store 시작·CLI 재보관 거절·snapshot byte 보존 | 중앙 승인 후 activation은 별도 경로 |
| KR-STATE-ACTIVATE-01 | 계약 미확정·미구현 | 중앙 checkpoint/권한·NVS/CORE 대조와 복구 승인/활성화 |

재현은 [TESTING.md](TESTING.md)의 별도 POSIX10개 절차를 따른다. 비특권 Linux x86_64/tmpfs에서 수행했으며 Pi ARM 실물·기존 DB adoption/backup 결과로 표시하지 않는다. 전체 daemon은 시작하지 않았고 lock 시험의 entry는 serve 전에 중단됐다.
