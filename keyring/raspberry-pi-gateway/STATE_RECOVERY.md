# Gateway 상태 보관과 신원 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · Gateway0.2.3 · 로컬 POSIX 시험 통과 / Pi·중앙 복구 미완료.

SQLite journal/outbox/fence/dedup/CORE sequence를 보관하고 다른 Gateway 설정의 DB 사용을 차단한다. [실제 Linux POSIX 시험10개](../evidence/2026-10-30-posix-state/README.md)가 소스·설치 wheel에서 각각 통과했다. 실제 flock/fsync·권한·WAL·CLI snapshot/adopt·ENOSPC·adoption 변경 감지를 새 합성 DB로 확인했다. 운영 DB·실물 Pi·전원 손실·중앙 복구 활성화는 미완료다.

## 상태의 경계

새 빈 DB는 gateway_state metadata에 configured Gateway ID/Originator/CSE ID/RVI/관측·receipt·health container path를 기록한다. 시작할 때 같은 binding인지 확인하며 다른 설정이거나 archive quarantine이면 BLE·전송을 시작하지 않는다. 신원이 있는 DB에서 필수 data table이 빠져도 조용히 새로 만들어 실행하지 않는다.

Gateway 0.2.35는 기존 binding과 기본 테이블을 확인한 뒤 `credential_receipts`를 추가한다. 보관본에는 이 테이블과 행 수가 포함된다. 이전 버전의 보관 도구로 열려면 0.2.35 적용 전 보관본을 사용한다. [자격 전환 영수증](RECEIPT_ROUTING.md#자격-상태-전환-영수증)

Gateway 0.2.46은 기존 binding 확인 뒤 `commands`에 중앙 영수증 등록 표시를 추가한다. 보관본은 이 표시와 아직 전송 중인 중앙 outbox 행을 함께 보존한다. 새 중앙 배포에는 새 Gateway DB 경로를 사용한다. [중앙 명령 영수증 정산](RECEIPT_ROUTING.md#중앙-명령-영수증-정산)

Gateway 0.2.57은 기존 DB에 `http_retry_windows` 테이블을 추가한다. SQLite 보관본에 이 테이블도 포함된다. 대기는 같은 Linux 부팅의 동일한 HTTPS 호스트와 포트에 적용한다. 0.2.56 이하의 스키마 검사는 이 테이블이 추가된 DB를 거절한다.

Gateway 0.2.83은 `observations`에 버튼 누계와 해당 부팅 ID를 저장하는 열을 추가한다. 업그레이드 전 관측의 누계는 비어 있으며, 같은 부팅의 다음 유효한 `buttonPresses`부터 기록한다. 새 누계는 관측·전송 대기열과 같은 트랜잭션으로 저장된다. 이전 Gateway가 순번과 부팅 ID만 갱신한 DB에서는 현재 부팅과 일치하는 누계만 사용한다.

Gateway 0.2.86은 `commands`에 장치별 대기열 조회에 쓰는 `device_id`를 추가한다. 대기 중인 기존 명령은 저장된 `deviceId`에서 이 값을 채운다. 기존 명령 본문·payload hash·영수증·실행 상태는 그대로 보존한다.

이 binding은 **로컬 설정·파일 일관성**이다. 중앙 신원 인증·grant·lease·attestation이나 rollback 방지 checkpoint가 아니다. mTLS·credential status·실행 직전 authorize·장치 NVS journal은 계속 필요하다. 동일한 CSE ID를 다른 서버에서 재사용하면 이 metadata만으로 같은 실제 서버라고 확인할 수 없다.

endpoint URL·broker 주소·인증서 경로는 binding에 넣지 않아 주소/credential 교체는 설정으로 가능하다. Gateway principal/CSE 자원 경로를 바꾸는 경우에는 이전 state를 그대로 새 정체성에 연결하지 않는다. 새로운 realm에는 새 DB 경로를 사용하고 이전 파일·fence·미정산 자료를 보존한다. 테스트 서버의 데이터·credential을 운영 환경에 자동 이관하지 않는다.

## CSE 배포 전환

Gateway 0.2.22에서 새 DB를 만들 때 `M2M_CSE_DEPLOYMENT_ID`에 CSE 데이터 저장소를 식별하는 운영자 배정 ID를 지정한다. 같은 저장소의 주소나 터널이 바뀌면 ID는 유지한다. 별도 저장소로 교체할 때는 새 ID와 새 `GATEWAY_DATABASE`를 함께 지정한다. ID가 바뀌거나 설정에서 빠지면 Gateway가 `STATE_CSE_DEPLOYMENT_MISMATCH`를 기록하고 기존 DB의 쓰기와 BLE·전송 시작 전에 종료한다.

배포 ID 없는 기존 DB는 기존 환경 파일로 계속 사용한다. 이 파일에 새 ID만 넣어 DB에 덧씌우는 경로는 차단된다. 기존 큐는 원래 환경에서 처리하고, 보관이 필요하면 해당 환경 파일로 아래 snapshot을 만든다. 새 배포에서 이전 파일을 활성화하려면 중앙 복구 승인이 필요하다.

배포 ID는 Gateway 설정과 SQLite가 같은 저장소를 가리킨다는 운영자 배정값이다. 실제 서버와 연결할 때는 mTLS 설정과 CSE 자원도 확인한다. 새 Feather 명령 벤치 프로필은 `scoped-mobius4`를 기록한다.

### 명령 영수증 컨테이너 ID 고정

Gateway 0.2.23의 선택 설정 `M2M_RECEIPT_CONTAINER_RI`에는 CSE 관리자가 기존 경로에서 확인한 컨테이너의 `ri`를 지정한다. 새 DB에 배포 ID와 함께 기록하며 이후 pin을 바꾸거나 빼면 `STATE_RECEIPT_CONTAINER_MISMATCH`로 시작을 중단한다. 기존 설정과 DB는 원래 방식으로 유지할 수 있다.

전송 전 Gateway가 mTLS HTTPS로 이름 경로를 조회해 요청 ID, 응답 코드, container 타입과 `ri`를 확인한다. MQTT와 HTTPS fallback은 확인한 자원 ID에 직접 CREATE한다. Gateway 0.2.27부터는 CREATE 응답의 contentInstance 타입·부모 ID·이름·자원 ID를 확인하고, 같은 영수증을 HTTPS GET으로 다시 읽어 자원 ID와 본문이 일치할 때만 전달 완료로 기록한다. 중복 CREATE 응답은 기존 자원의 타입·부모 ID·이름·본문을 대조한다. 조회 오류와 불일치 때는 원래 요청 ID를 큐에 보존한다. MQTT CREATE 성공 뒤 GET이 실패하면 그 시도에서 HTTPS CREATE를 추가로 보내지 않는다.

설정 전 Gateway 자격에 이름 경로 GET, 자원 ID로 contentInstance CREATE, 원래 이름 경로의 자식 GET을 허용한다. 격리 벤치에서는 [컨테이너 권한 준비](../dev/mobius4/README.md#명령-영수증-정산-준비)를 완료한 뒤 새 세션에 해당 Gateway의 ID를 지정한다.

### 관측 컨테이너 ID 고정

Gateway 0.2.55의 선택 설정 `M2M_OBSERVATION_CONTAINER_RI`는 CSE에서 관측 컨테이너의 `ri`를 확인한 뒤 새 DB에 지정한다. ID를 바꾸거나 빼면 `STATE_OBSERVATION_CONTAINER_MISMATCH`로 시작을 중단한다. 관측과 영수증이 한 컨테이너를 공유하면 지정된 ID가 같은 경로에 적용된다. 두 설정을 함께 지정할 때는 ID가 같아야 한다.

Gateway는 전송 전에 HTTPS GET으로 컨테이너 이름과 `ri`의 일치를 확인한다. MQTT와 HTTPS는 확인된 ID로 관측을 생성하고, 응답 및 저장본의 부모·자원 ID·본문을 대조한 뒤 완료를 기록한다. 같은 이름에 다른 자원이 생겼거나 확인에 실패하면 관측은 원래 요청 ID로 SQLite에 남는다. `--check-command-route`도 관측 ID가 설정돼 있으면 중앙 요청 전에 이를 검사한다. 이름 경로 GET, 자원 ID CREATE와 자식 GET에 Gateway 권한을 부여한다.

### Gateway 상태 컨테이너 ID 고정

Gateway 0.2.79의 선택 설정 `M2M_HEALTH_CONTAINER_RI`는 heartbeat와 자격 상태 전환 영수증을 기존 CSE 컨테이너에 연결한다. `M2M_CSE_DEPLOYMENT_ID`와 새 DB 경로를 함께 사용한다. 기존 DB의 값이 바뀌거나 빠지면 `STATE_HEALTH_CONTAINER_MISMATCH`로 시작을 중단한다. 여러 경로가 같은 컨테이너 이름을 공유하면 그 이름에 지정된 ID가 모두 일치해야 하며, 해당 이름의 전송은 같은 ID로 보호된다.

전송 전에 이름 경로로 ID를 확인하고, 자원 ID로 CREATE한 뒤 저장된 원본의 부모·ID·본문을 다시 대조한다. 경로가 교체되거나 HTTPS 재시도가 대기 중이면 기존 행을 SQLite에 남긴다. `--check-command-route`는 health ID가 설정된 경우 중앙 API를 읽기 전에 확인한다. Gateway에 이름 경로 GET, ID 경로 CREATE 및 자식 GET 권한을 부여한다.

## 중앙 API 배포 전환

Gateway 0.2.54는 새 DB에서 `PC_API_DEPLOYMENT_ID`를 지정하면 중앙 API 저장소의 운영자 배정 ID를 binding v3에 기록한다. 동일한 Mobius4를 쓰는 경우에도 중앙 저장소 ID가 달라지거나 설정에서 빠지면 `STATE_PC_API_DEPLOYMENT_MISMATCH`로 중단한다. `--check-config`와 `--check-command-route`는 기존 DB의 binding을 읽기 전용으로 먼저 검사한다. 명령·관측 재전송은 데몬 시작 때 같은 검사를 통과해야 한다.

같은 중앙 저장소의 주소만 바뀌면 `PC_API_URL`을 갱신하고 ID를 유지한다. 별도 중앙 저장소에는 새 ID와 새 `GATEWAY_DATABASE`를 지정한다. 이미 ID 없이 만든 DB는 기존 설정으로 전송·보관하며, 새 ID를 넣어 기존 DB의 소유를 바꾸는 경로는 없다. 이 값은 로컬 일관성 확인에 사용한다. 서버의 mTLS·자격 상태·실행 승인은 별도로 확인한다.

### 전환 전 대기열 확인

Gateway 0.2.75의 `plan-cutover`는 현재 SQLite를 읽기 전용으로 열고 두 설정을 비교한다. 기존 데몬을 중지한 유지보수 창에서 원본 DB의 daemon lock으로 보호한다. 두 환경 파일은 각각 완전한 설정이어야 한다. 프로세스의 환경 변수나 다른 파일의 값을 가져오지 않는다.

```sh
sudo -u bubble-gateway /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-gateway-state plan-cutover \
  --env-file /etc/privacy-bubble/gateway.env \
  --target-env-file /etc/privacy-bubble/gateway-next.env
```

- `databaseAction`이 `reuse-existing`이면 설정상 동일한 binding과 기존 DB 경로를 사용한다. URL이나 MQTT 주소가 바뀌면 팀의 CSE·중앙 API·브로커와 실제 저장소의 동일성을 확인한다. `targetMissingDeploymentIds`는 설정에 빠진 배포 ID를 보여준다.
- `use-new-database`이면 binding이 바뀌고 새 DB 경로가 비어 있다. 기존 DB에 다른 binding을 지정하거나 같은 binding으로 별도 빈 DB를 지정하면 오류가 난다. 새 DB 경로에 파일이나 SQLite WAL·SHM·journal이 있어도 오류가 난다.
- `outboxByRoute`는 native 관측·health, native 명령 영수증, credential 영수증, CORE telemetry·ACK, 중앙 telemetry·영수증의 저장 행 수다. 표시되지 않는 경로는 0건이다. `journal`에는 수신·dispatch 중 명령, outbox 등록 전 native 영수증, 중앙 등록 표시가 없는 명령 영수증과 미전달 credential 영수증이 포함된다. 각 단계에 같은 영수증이 포함될 수 있다. `sourceCentralReceiptStagingEnabled`로 중앙 등록 경로가 켜져 있었는지 확인한다.
- Gateway 0.2.76의 `targetHolds`는 기존 DB를 재사용할 때 후보 설정에 의해 보류될 건수를 보여준다. CORE 브리지·명령·중앙 전송 경로의 비활성화와 CORE telemetry의 epoch 불일치를 반영한다. 기존 중앙 영수증 경로가 활성화돼 있었다면 중앙 등록 전 명령 영수증도 센다. 새 DB를 사용할 때 값은 `null`이며 기존 큐는 원본 DB에 남는다.
- Gateway 0.2.94의 `journal.dispatchingByFinalBleWrite`는 `DISPATCHING`을 마지막 BLE 조각 미시도 `notStarted`, 전송 가능 `possiblyStarted`, 기록 없음 `unknown`으로 집계한다. 열이 없는 이전 DB는 `unknown`으로 집계한다.
- Gateway 0.2.104의 `coreSequenceContinuity`는 새 DB로 이어받을 CORE 순번이 있는 장치 수, 새 설정의 토픽·epoch와 겹치는 원본 대기 건수, uint32 순번을 소진한 장치 수를 보여준다. 기존 DB를 재사용하는 경우에는 `null`이다.

CORE 브리지를 끈 데몬은 기존 CORE telemetry와 ACK를 SQLite에 남기고 native 전송을 이어간다. 같은 배포에서 브리지를 다시 켜면 설정된 epoch에 해당하는 telemetry와 활성화된 명령 경로의 ACK가 재전송 대상에 들어간다. 보류 행은 계속 outbox 용량에 포함된다.

보고서는 집계와 변경된 설정 이름을 stdout에 출력한다. 새 DB를 초기화하거나 기존 큐를 복사·삭제·전송하는 동작은 없다. 배포 전 기존 큐와 dispatch 중 명령을 원래 배포에서 대조하고 필요한 상태를 [격리 snapshot](#수동-snapshot)으로 보관한다. 집계가 비어 있어도 중앙 정산과 새 배포의 실제 신원·권한 확인은 남는다. 팀 저장소와 실제 Pi에서의 전환 시험은 대기 중이다.

#### 새 배포 DB에 CORE 순번 이어받기

`plan-cutover`가 `use-new-database`를 보고하고 후보 설정에도 등록된 키링의 CORE 순번이 있으면, 원본 Gateway를 중지한 유지보수 창에서 새 DB를 준비한다. Gateway 0.2.120은 Gateway ID가 바뀌는 경우에도 같은 키링의 순번을 이어받는다. CORE v1의 중복 기준은 `deviceId:sequence`다. 기존 배포에서 새 CORE 범위와 겹치는 전송을 먼저 확인한다. 새 DB의 상위 디렉터리는 Gateway 계정이 쓸 수 있어야 한다.

```sh
sudo -u bubble-gateway /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-gateway-state prepare-cutover \
  --env-file /etc/privacy-bubble/gateway.env \
  --target-env-file /etc/privacy-bubble/gateway-next.env
```

이 명령은 양쪽 데몬 잠금을 확인하고 새 binding의 DB에 유지할 장치별 마지막 할당 순번만 기록한다. 다음 관측은 그 순번에 1을 더해 전송된다. 후보 설정에서 CORE가 꺼져 있어도 나중에 켤 때를 위해 순번을 보존한다. 새 설정과 같은 범위에 원본 CORE 관측이 대기 중이거나 활성 후보 장치의 순번을 소진했으면 중단한다. 대기열·명령·영수증·권한 기록은 원래 배포 DB에 남는다.

새 DB 준비는 전환 전 로컬 작업이다. 준비한 뒤 대상 환경으로 `--check-config`를 수행한다. Gateway 0.2.121의 `--check-cse-routes`는 같은 DB binding을 먼저 확인하고, 대상 CSE의 관측·health와 명령이 활성화된 경우의 영수증 컨테이너를 HTTPS GET으로 대조한다. 중앙 API가 준비되면 `--check-command-route`로 중앙 자격과 활성 명령도 확인한다. CSE 점검의 성공은 설정한 컨테이너를 조회했다는 뜻이다. MQTT 전달과 CREATE 권한은 별도 통합시험에서 확인한다. 새 Gateway가 관측을 전송하기 시작하면 같은 CORE 범위로 이전 Gateway를 다시 시작하기 전에 팀과 현재 순번 및 소유권을 대조한다.

### 기존 배포의 명령과 키링 저널 대조

Gateway 0.2.77의 `bubble-keyring-reconcile`은 전체 기기 비교에서 키링 보관본에 없는 Gateway 명령도 확인한다. 원본 배포 환경 파일과 같은 기기의 키링 저널, 격리 SQLite snapshot을 지정한다. 기존 Mobius4에 연결할 수 없는 경우 보관본만 비교한다.

```sh
bubble-keyring-reconcile --archive-only --env-file gateway-old.env \
  --gateway-archive /path/to/gateway-archive --device-archive /path/to/device-archive
```

원래 환경 파일의 TLS 경로 선언은 유지할 수 있으며 보관본 비교에는 실제 인증서와 개인키가 필요 없다. `deviceComparison`은 키링 기록과 Pi 영수증의 대조 결과다. 이 모드에서 Mobius4 영수증은 `nativeReceiptSource: not-checked`로 남는다. `gatewayOnlyPending`은 키링 저널에 없는 해당 기기의 수신·dispatch 중 명령과 미전달 native·중앙 영수증을 보여준다. `count`에는 전체 건수, `commands`에는 최대 128개 명령 ID·payload hash·로컬 상태가 들어가며 전체 건수가 `reviewCount`에 포함된다. 이 결과만으로 명령이 장치에 전달됐는지나 중앙에서 정산됐는지 판정할 수 없다. 출력은 기기 명령 식별자를 포함하므로 원본 보관본과 함께 보관한다.

`gatewayOnlyPending.commands`의 `DISPATCHING` 행은 `bleFinalWriteMayHaveStarted`에 미시도 `false`, 전송 가능 `true`, 기록 없음 `null`을 표시한다. `true`인 명령은 기기·CSE·중앙 기록을 대조해 실제 전달 여부를 확인한다. 각 행은 원래 검토 건수에 포함된다.

Gateway 0.2.95에서 위 `--archive-only` 명령에 `--team-state /path/to/runtime.json`을 추가하면 같은 원래 배포에서 보관한 중앙 정산 기록도 읽는다. `gatewayOnlyPending.commands[].centralReceipt`에는 명령과 영수증 본문·해시·claim·소유권 epoch가 팀의 `GATEWAY_RECEIPT_SETTLED` 이벤트와 일치하는지 표시한다. 일치하면 중앙 실행 상태와 이벤트 ID를 출력한다. Pi 영수증, 중앙 명령, 중앙 영수증이 각각 빠진 경우와 기록 불일치도 구분한다. 이 옵션은 네트워크 없이 보관본을 비교하며 검토 대상 건수를 유지한다.

기존 CSE를 읽을 수 있으면 Gateway 0.2.78의 `--check-gateway-only-native`를 사용한다. 원래 배포 환경 파일의 `M2M_RECEIPT_CONTAINER_RI`와 mTLS 설정을 사용하며 프로세스 환경 변수는 가져오지 않는다.

```sh
bubble-keyring-reconcile --check-gateway-only-native --env-file gateway-old.env \
  --gateway-archive /path/to/gateway-archive --device-archive /path/to/device-archive
```

격리 SQLite의 로컬 명령·영수증을 확인하고 기존 CSE 컨테이너 ID를 검증한 뒤 원래 요청 ID로 각 `contentInstance`를 조회한다. `gatewayOnlyPending.commands[].nativeReceipt`에 일치, 본문 불일치, 로컬 또는 CSE 영수증 누락을 기록한다. 읽어온 원본 ID와 시각은 본문 해시와 함께 남긴다. 일치한 행도 `reviewCount`에 남으며 기존 Pi 전달 상태와 중앙 정산은 이 명령에서 변경하지 않는다.

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

## 종료된 CORE epoch 보관

Gateway 0.2.15의 `bubble-gateway-state retire-core`는 중앙에서 종료가 확인된 CORE telemetry 전송 행을 보관한 뒤 활성 outbox에서 정리한다. 같은 Gateway와 CSE의 LIVE DB, scoped 설정에 있는 장치, 현재 설정보다 낮은 epoch만 선택할 수 있다. epoch 전환 전의 기존 토픽 행을 보관할 때는 `--retired-epoch unscoped`를 명시한다. 해당 장치의 중앙 전환과 이전 경로 종료 여부는 운영자가 확인한다.

예를 들어 scoped 설정에 `kr-handover`의 epoch 9가 배정된 같은 Gateway에서 epoch 7 행을 보관할 때는 서비스를 중지한 유지보수 창에서 다음 명령을 쓴다.

```sh
sudo -u bubble-gateway /opt/bubble_lock/keyring/raspberry-pi-gateway/.venv/bin/bubble-gateway-state retire-core \
  --env-file /etc/privacy-bubble/gateway.env \
  --device-id kr-handover --retired-epoch 7 \
  --output /var/lib/privacy-bubble-gateway/keyring-gateway-archives/core-epoch-7
```

동일한 daemon lock을 잡은 상태에서 전체 WAL 포함 스냅샷을 먼저 저장한다. 스냅샷과 원본에서 선택한 행의 개수·해시, Gateway·장치·epoch, 원본 request ID를 대조한다. 원본 파일이나 SQLite 내용이 바뀌면 정리를 중단한다. native 관측, 명령 영수증, command journal, fence, CORE sequence는 그대로 남는다. 선택된 CORE 행은 격리 스냅샷에 보존된다.

`retirement-plan.json`은 원본 변경 전, `retirement.json`은 SQLite commit 후에 기록한다. 행 해시는 RQI 순서의 각 SQLite 행을 canonical JSON으로 인코딩하고 행마다 LF를 붙인 바이트의 SHA-256이다. commit 후 파일 기록이 실패하면 plan과 스냅샷을 보존한 채 실제 대기열 상태를 확인한다. 두 파일의 스키마는 [CORE 보관 기록](../../contracts/keyring/gateway-core-retirement.schema.json)에 있다. 중앙 적용이나 명령 정산을 증명하는 영수증은 아니다. 소스와 회귀시험 코드만 반영했으며 기존 DB에서 실행한 기록은 없다.

## 복구 활성화에 남은 중앙 계약

이 버전은 snapshot을 실수로 시작하는 것을 막으며, **restore activation 명령은 아직 제공하지 않는다**. 전체 R12/continuity 완료를 주장하지 않는다. 다음 항목을 PC-MOBIUS-INTEGRATION/CORE와 맞춘 뒤 복구 활성화 경로를 구현해야 한다.

- snapshot 이후 수락/적용/정산한 commandId와 현재 claim/grant/epoch의 authoritative checkpoint.
- 이전 Gateway 정지·credential/ownership 이전과 새 current authorization. 로컬 binding이 이를 승인하지 않음.
- 장치 NVS PREPARED/COMPLETED와 중앙 receipt 대조, 불명확한 dispatch의 재실행 금지.
- outbox의 실제 oneM2M receipt·dedup 상태와 CORE sequence의 현재 상한. 오래된 sequence를 새 상태로 사용하지 않음.
- checkpoint 검증/적용/활성화 사이 crash·재시도·rollback 처리 및 signed/인증된 복구 승인 계약.

Gateway 0.2.93은 원래 DB로 재시작할 때 `DISPATCHING`의 마지막 BLE 조각 기록을 확인한다. 실행 의도 트랜잭션은 `ble_final_write_started=0`을 저장한다. 마지막 조각을 보내기 전 별도 트랜잭션에서 값을 `1`로 바꾸고, 커밋이 끝난 뒤 권한과 전송 기한을 다시 확인한다.

재시작 시 값이 `0`이면 `REJECTED / DISPATCH_NOT_SENT`를 남긴다. 값이 `1`이면 마지막 조각이 전달됐을 가능성이 있으므로 `INDETERMINATE / RESTART_INTERRUPTED`를 남긴다. 열이 없던 DB의 기존 행은 업그레이드 후에도 `null`이며 같은 미확정 경로를 사용한다. 명령은 재시작에서 자동으로 재실행하지 않는다. 보관본의 활성화 조건은 위 절차를 따른다.

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
