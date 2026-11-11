# 장치 journal 보관·정산 경계

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · firmware keyring-0.5.0 · implemented / unverified.

장치의 32개 NVS record를 실제 BLE로 읽고 새 폴더에 보관하는 수동 경로를 추가했다. 이번 작업에서는 도구를 실행하지 않았으며 실제 snapshot·보관 파일·측정 receipt를 생성하지 않았다. 검증·빌드·장비 실행도 미실행이다.

**보관은 정산과 별개다.** 보관 성공으로 JOURNAL_FULL이 해제되지 않는다. 현재 펌웨어에는 erase/compact/reset 명령이 없다. 중앙의 영속 정산 계약이 생기기 전까지 32개 한계와 중복 실행 방지 이력을 유지한다.

## BLE 읽기 계약

CORE-v1 service에 `7f8a0006-4b6e-4f4e-9b0a-505249564255` READ/WRITE characteristic을 KEYRING 확장으로 추가했다. 명시적 legacy profile에서는 `8b8f0006-8e7a-4f36-a8c2-1c9b5d620001`이다. 기존 다섯 characteristic의 payload는 유지한다. READ/WRITE 모두 기존 장치별 bonding·암호화·MITM 권한을 요구한다. 이 권한을 가진 Gateway는 과거 command metadata를 읽을 수 있으므로 bond/passkey 접근을 제한한다.

WRITE는 RAM snapshot selector이며 NVS나 출력을 수정하지 않는다. callback은 bounded queue에 요청을 넣고 main loop가 복구된 record를 static RAM에 복사한다. NVS load 오류는 storage_error, capture 시작 때 모터/음향/대기 명령이 있으면 busy다. 실패를 빈 정상 journal로 표시하지 않는다.

selector는 정확히8byte이며 ATT MTU23의 단일 WRITE에 들어간다.

| byte | 형식 | 의미 |
|---|---|---|
| 0 | uint8 | protocol version1 |
| 1 | uint8 | operation1 capture /2 record /3 close |
| 2~5 | uint32 little-endian | request ID. 응답은 소문자8자리 hex |
| 6 | uint8 | snapshot record index0~31, capture/close는0 |
| 7 | uint8 | part0 또는1, capture/close는0 |

WRITE ACK는 selector 전달을 뜻한다. Gateway는 READ에서 같은 requestId의 JSON을 기다린다. attribute가 잠시 selector나 이전 응답을 담을 수 있어 한 번에 하나씩 요청한다. queue full·잘못된 selector는 timeout이다.

keyring-0.7.7은 현재 인증된 연결의 READ에만 응답을 제공한다. 유효한 selector를 받으면 공개할 값을 비우고, Gateway는 같은 requestId의 응답이 올라올 때까지 조회한다. 한 번 시작한 긴 READ는 최초 응답의 사본을 이어서 읽는다.

operation1은 [manifest schema](../contracts/keyring/ble-journal-manifest.schema.json)의 frozen manifest를 반환한다. deviceId/bootId, snapshotId, capturedUptimeMs, capacity32, recordCount/preparedCount, format1, maxEpoch/maxGrant를 포함한다. 이후 신규 명령으로 원본 journal이 늘어도 snapshot은 유지된다. snapshot은 연결 generation과120초 TTL에 묶이며 close·disconnect·새 capture로 해제/교체해도 NVS는 유지한다.

operation2는 [record part schema](../contracts/keyring/ble-journal-record-part.schema.json)에 따라 record를 두 조각으로 반환한다. snapshotId/index/part/parts·requestId를 맞춰야 한다. 응답은 LF 포함512byte 이하이며 초과는 overflow다. operation3은 volatile capture를 닫고 type:closed를 반환한다. 오류 응답은 version/requestId/status만 가진다. status는 storage_error/busy/expired/invalid_index/overflow다.

part0은 commandId/payloadHash/원래 bootId/epoch/grant, part1은 phase/ackCode/desiredState/readback/acceptedUptimeMs/appliedUptimeMs/storageCrc32다. PREPARED는 INDETERMINATE이고 readback/appliedUptimeMs는 null이다. COMPLETED만 적용 당시 GPIO readback을 가진다. 시간은 **record의 bootId** 기준이며 capture boot의 uptime으로 환산하지 않는다. [조립 record schema](../contracts/keyring/journal-record.schema.json)와 별도로 Gateway가 시각 순서·unique ID·prepared 수·fencing 상한을 판정한다.

storageCrc32는 native NVS record의 CRC metadata다. JSON에서 재계산 가능한 서명이나 attestation이 아니다. 장치 load의 CRC/형식 오류는 capture를 막는다. 보관 파일 SHA256도 중앙 서명·물리적 진동 증거가 아니다.

keyring-0.7.5에서 record 읽기 오류나 중복 ID는 저널 전체를 `storage_error`로 처리한다. 기본 NVS 자체에 복구가 필요한 두 SDK 오류에서는 Arduino의 자동 삭제를 막고 BLE 시작 전에 잠근다. 이 상태에서는 USB 직렬 로그와 파티션 보존 절차로 상태를 확인한다. [펌웨어 복구 경계](firmware/README.md)

keyring-0.7.8은 앞에서부터 채운 연속 슬롯과 감소하지 않는 epoch·grantRevision만 정상으로 복구한다. 중간 슬롯 누락과 새 기록의 쓰기 후 읽기 불일치는 저널을 잠근다.

keyring-0.7.9는 같은 NVS namespace의 `journal-tail` 키에 CRC와 사용 슬롯 수를 따로 저장한다. 형식 1 기록만 있는 장치는 기존 기록을 읽고, 첫 새 명령 직전에 그 개수를 기준점으로 저장한다. 그다음 새 형식 2 PREPARED 기록과 개수 증가를 순서대로 확인한 뒤에 출력을 허용한다. 유효한 개수보다 형식 2 PREPARED가 하나 앞서면 부팅 때 개수만 복구한다. 슬롯 수 감소, 형식 2 기록이 있는데 키가 사라짐, 기타 불일치는 `storage_error`로 처리한다. 형식 2를 이해하는 펌웨어로 복구하며 BLE snapshot의 `format:1`은 기존 전송 계약에 해당한다.

이 키는 개별 슬롯 유실을 감지한다. NVS 파티션 전체 유실이나 기록과 개수 키가 함께 과거 상태로 돌아가는 상황의 검출에는 장치 외부의 독립 체크포인트가 필요하다. 중앙 정산과 공간 회수는 아래 별도 계약을 따른다.

관측 sensorValues에 journalUsed/journalPrepared/journalCapacity를 추가했다. NVS 불건전 시 앞의 두 값은 null이며 512byte 한도로 생략될 수도 있다. 누락을 빈 journal로 해석하지 않는다. 실제 보관 목록은 export manifest에 따른다.

## Raspberry Pi 수동 보관

Linux/BlueZ에 안전하게 등록된 장치를 사용한다. 도구는 passkey agent를 설치하거나 자동 승인하지 않는다. `bubble-keyring-journal`은 foreground Gateway와 같은 DB path의 `.lock`을 사용한다. 별도 client 연결 전에 Gateway 서비스를 사용자 작업으로 중지한다. 도구가 서비스 시작/종료·DB 읽기/쓰기·중앙 API 호출을 수행하지는 않는다.

아래는 실제 보관을 요청했을 때의 명령 예다. ID/주소는 실제 등록값, output은 존재하지 않는 폴더로 바꾼다. 이번 작업에서 실행하지 않았다.

```sh
sudo systemctl stop privacy-bubble-gateway
sudo install -d -o bubble-gateway -g bubble-gateway -m 0700 /var/lib/privacy-bubble-gateway/keyring-journal-archives
sudo -u bubble-gateway /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-keyring-journal \
  --device-id REAL_DEVICE_ID --address AA:BB:CC:DD:EE:FF \
  --database /var/lib/privacy-bubble-gateway/gateway.sqlite3 \
  --gatt-profile core-v1 --firmware-revision keyring-0.7.0 \
  --output /var/lib/privacy-bubble-gateway/keyring-journal-archives/capture-001
sudo systemctl start privacy-bubble-gateway
```

DB 경로가 다르면 서비스 lock과 협조할 수 없다. 현재 도구의 firmware 기본 revision은 정확히 keyring-0.7.0이며 구형 장치에 확장이 없으면 중단한다. ID/service·identity를 확인하고 capture 전후 identity가 같아야 한다. selector 응답 각각3초, 전체 capture90초 제한이다. BLE 오류 뒤 자동 재연결·capture 재시도는 없다.

새 폴더0700과 파일0600을 생성하고 O_EXCL로 덮어쓰기를 막는다. records.jsonl을 쓰고 fsync한 뒤 마지막에 [manifest.json](../contracts/keyring/journal-archive.schema.json)을 쓴다. manifest는 장치 identity, frozen manifest, 실제 record 수, 파일 byte 수/SHA256, Gateway 보관 시각, settlementStatus:not-settled, deviceJournalModified:false를 담는다. 실제 manifest count0일 때만 빈 journal로 보관한다. 중간 I/O 실패의 부분 폴더를 자동 삭제하거나 완료로 취급하지 않는다.

파일은 장치·command ID/hash를 포함하는 **평문**이다. 접근이 제한된 로컬 저장소로 보관하고 공개 Git에 넣지 않는다. keyring-journal-archives/는 Git ignore한다. 암호화 백업·중앙 업로드·공개 evidence 게시를 수행하지 않는다. SHA256/fsync가 매체 고장·전원 차단 내구성이나 공격자의 파일/manifest 동시 변조를 완전히 보장하지는 않는다.

daemon의 `BleFleet.capture_journal(device_id)`는 기존 장치 명령 lock으로 직렬화한 같은 capture helper를 제공한다. 자동 호출·파일 저장은 없다. 호출자가 중앙 dispatch와 maintenance 창을 조정해야 한다.

## 이전 장치 보관본과 비교

Gateway 0.2.28의 `bubble-keyring-journal-compare`는 장치 밖에 보관한 신뢰할 수 있는 이전 archive와 같은 장치의 최신 archive를 읽는다. 두 파일의 SHA256, 장치·보드 ID, 서로 다른 snapshot ID와 수집 시각 순서를 확인한다. 같은 부팅에서 수집했다면 장치 uptime 순서도 확인한다. 펌웨어 버전은 달라도 된다.

```sh
bubble-keyring-journal-compare --baseline "$TRUSTED_OLDER_ARCHIVE" --current "$RECENT_ARCHIVE"
```

이전 기록이 같은 순서와 내용으로 남고 epoch·grantRevision 상한이 유지되면 `CONTINUOUS`와 추가된 기록 수를 출력한다. 기록 누락, 순서 변경, 내용 변경, 권한 상한 감소는 `REVIEW_REQUIRED`로 구분한다. JSON에는 두 snapshot ID와 파일 해시, 문제가 발견된 슬롯 번호가 남는다. 종료 코드는 정상 비교 0, 검토 필요 2, 읽기·무결성·순서 오류 1이다.

비교에는 두 보관본과 검증된 수집 순서가 필요하다. 기기 전체 NVS가 초기화된 뒤 이전 보관본에 있던 기록이 빠졌을 때 이를 드러낼 수 있다. 두 사본의 provenance와 호스트 시각은 운영자가 확인한다. 장치·CSE·DB를 접속하거나 수정하지 않으며 결과의 정산 상태는 `not-settled`다. 회귀시험 소스는 추가했고 이 버전의 실행과 빌드는 미실행이다.

## 장치 journal과 Gateway·CSE 영수증 대조

Gateway 0.2.9의 `bubble-keyring-reconcile`은 위 장치 archive와 `bubble-gateway-state snapshot`으로 생성한 Gateway archive를 사용한다. 같은 장치와 Gateway 설정의 보관본을 선택한다. SQLite 사본과 파일 해시, 장치·Gateway·CSE 자원 식별자를 확인한다. CSE에는 설정된 mTLS로 HTTPS GET만 보낸다.

```sh
env -i PATH=/usr/bin:/bin /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-keyring-reconcile \
  --env-file /etc/privacy-bubble/gateway.env \
  --device-archive /var/lib/privacy-bubble-gateway/keyring-journal-archives/capture-001 \
  --gateway-archive /var/lib/privacy-bubble-gateway/state-archives/snapshot-001
```

- `matched_applied`는 장치의 완료 기록·bootId·적용 당시 readback, SQLite 본문과 CSE 영수증이 일치한 경우다. 과거 `DUPLICATE` 영수증은 최초 적용 당시 기록과 비교한다.
- CSE 영수증이 일치하지만 Gateway 전송 완료 표시가 0이면 `gatewayDelivered:false`로 남기고 검토 건수에 포함한다. 비교 과정에서 SQLite 보관본과 CSE 자원은 유지한다.
- `device_prepared`, `matched_readback_failure`, 기록 누락·불일치는 검토 항목이다. `reviewCount`와 기록별 결과를 함께 확인한다. 장치 기록이 빈 보관본은 결과 목록도 비어 있다.
- 정상 종료는 비교 보고서를 생성했다는 뜻이다. 입력 보관본의 해시 오류, CSE 인증·통신 오류는 종료 코드 1이다. 결과에는 두 보관본 ID, 조회 시각, 자원, 조회한 영수증 해시가 포함되므로 비공개 위치에 보관한다.

보고서의 정산 상태는 `not-settled`다. 중앙 승인과 장치 journal 회수는 아래 계약을 따른다. [격리 Mobius4 시험](evidence/2026-11-10-journal-reconcile/README.md)

### r18 실물 명령 한 건 대조

Gateway 0.2.60은 장치 저널을 수집한 부팅에서 실행한 명령 한 건을 골라 비교한다. 정식 r18 펌웨어로 실행한 시험의 정확한 command ID와 저널을 수집할 때의 보드·펌웨어 revision을 지정한다. 현재 정식 r18 펌웨어 revision은 `keyring-0.7.14`다.

```sh
bubble-keyring-reconcile --env-file "$GATEWAY_ENV" \
  --device-archive "$DEVICE_ARCHIVE" --gateway-archive "$GATEWAY_ARCHIVE" \
  --same-boot-command "$COMMAND_ID" --board-revision r18-hand-solder \
  --firmware-revision keyring-0.7.14
```

대상 명령이 없거나 다른 부팅에서 실행됐거나 수집한 identity의 revision이 다르면 CSE 조회 전에 중단한다. `selectedCommand`에는 장치 저널의 수신·적용 uptime이, 명령 결과에는 Gateway ACK 코드와 Mobius4 원본 영수증 대조가 남는다. 완료 기록의 영수증 펌웨어도 수집 identity와 일치해야 `matched_applied`가 된다. 최초 적용을 확인할 때는 `gatewayAckCode: APPLIED`와 `gatewayDelivered: true`를 함께 확인한다.

r18의 ON은 최대 1,000ms의 펄스다. 펄스 길이와 출력이 꺼지는 시점은 계측기로 기록하고 같은 command ID를 붙인다. 이후 중앙 정산은 아래 절차로 대조한다.

### 격리 PostgreSQL 정산 기록 대조

위 비교 도구의 최신 소스는 장치 기록 파일의 SHA256과 CSE 원본의 `ri`·`ct`도 기록한다. 그 JSON을 비공개 파일에 저장하면 [격리 DB 조회](dev/mobius4/README.md#명령별-영수증-증거-조회)에서 같은 장치·Gateway·명령의 정산 기록을 한 번에 비교할 수 있다. 발급 명령 전체를 결속하는 payload hash, 영수증 hash, readback, CSE 원본 ID와 생성 시각을 확인한다.

- `settlement_matched`는 장치·Gateway·CSE가 비교된 적용 기록과 격리 DB의 정산 행이 일치함을 뜻한다. Gateway 전송 완료 표시가 없으면 검토 건수에 남는다.
- `settlement_missing`은 비교된 적용 기록에 중앙 정산 행이 없음을 뜻한다. `settlement_mismatch`는 불일치 필드를 반환한다. `journal_review_required`에는 PREPARED, readback 실패 등 기존 검토 건이 남는다.
- `settlement_source_unbound`는 기존 중앙 행에 CSE 키와 원본 경로가 기록되지 않은 경우다. 둘 중 한 필드가 누락됐거나 격리 CSE 설정과 다르면 불일치로 분류한다.

출력은 원본 비교 보고서의 SHA256을 포함한다. 이 해시는 두 보고서를 연결하며 보관본의 발급자 인증은 별도다. 결과가 모두 일치해도 장치 journal 정산 상태는 `not-settled`로 남는다. 회수에는 아래 중앙 계약이 필요하다.

## 장기 운영에 남은 중앙 계약

PC-MOBIUS-INTEGRATION/CORE와 아래 내용을 같은 revision으로 정한 뒤 reclaim 경로를 구현한다. 키링은 없는 승인을 생성하지 않는다.

- snapshot/record hash를 원본 commandId·claimId·grant·epoch·ACK와 영속 결합하는 settlement receipt/조회 경로.
- PREPARED/INDETERMINATE 처리와 재실행 금지. 불명확한 결과를 성공 정산하지 않는 규칙.
- command ID 보존 기간·retire 범위와 old owner/오래된 명령을 영구 차단할 checkpoint/epoch. record 삭제와 함께 maxEpoch를 잃으면 안 된다.
- checkpoint 수락·reclaim 사이 전원 차단 복구와 다른 장치/회수/만료 settlement를 거절할 인증·기한 계약.
- 중앙 보관 손실·재설치·장치 교체의 recovery/reprovision 권한. SD·로컬 archive만으로 flash를 지우지 않는다.

## 미실행 인수 항목

| ID | 남은 확인 | 결과 |
|---|---|---|
| KR-JOURNAL-EXPORT-01 | MITM bond 권한·구형 UUID 미지원 | 미실행 |
| KR-JOURNAL-EXPORT-02 | 0/32 records·PREPARED/COMPLETED·frozen capture 중 신규 명령 | 미실행 |
| KR-JOURNAL-EXPORT-03 | 조각/requestId 혼합·timeout/TTL·disconnect·CRC·index/queue 경계 | 미실행 |
| KR-JOURNAL-EXPORT-04 | daemon lock·identity/revision·원본 보존·부분 파일/덮어쓰기 거절 | 미실행 |
| KR-JOURNAL-SETTLE-01 | 중앙 계약·crash-safe reclaim·과거 ID/epoch 재실행 거절 | 계약 미확정·미실행 |
