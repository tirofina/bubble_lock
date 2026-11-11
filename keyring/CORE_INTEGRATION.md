# CORE·Gateway 통합 계약

DOC-REV 2.0.0 · 2026-11-10 · Gateway 계약 1.0.0.

중앙 통합 이력 `413fd31`·`191b603`과 키링 역할 브랜치 `686f7b4`를 연결했다. BLE 탐색 취소, BlueZ READ/notification 순서 수정, Feather·실제 Pi 관측 증거를 함께 보존한다.

<<<<<<< HEAD
## 관측과 명령
=======
- 펌웨어 `keyring-0.2.0`과 Gateway 기본 GATT profile `core-v1`은 팀 service `7f8a0001-4b6e-4f4e-9b0a-505249564255`, state `...0002...`, command `...0003...`, ack `...0004...`를 사용한다. 장치 식별을 위한 identity `...0005...`를 KEYRING extension으로 추가했다.
- 기존 펌웨어 profile은 `KEYRING_LEGACY_GATT=1`, Gateway는 `BLE_GATT_PROFILE=keyring-v01`로 명시 선택한다. 자동 downgrade하지 않는다. 이번 작업에서 실제 firmware flash는 하지 않았다.
- BLE 내부 프레임은 bootId·uptime·nullable battery와 sensorValues를 유지한다. UTC/RSSI는 Gateway가 관측하므로 CORE의 timestamp/batteryPct/rssiDbm으로 내보내는 변환을 별도로 둔다. UUID 일치만으로 팀의 BLE payload 전체와 동일하다고 주장하지 않는다. 이 확장·변환 계약은 CORE owner의 수용이 필요하다.
- `CORE_BRIDGE_ENABLED=true`는 telemetry와 성공 ACK를 SQLite outbox에 추가하고 팀 MQTT topic으로 보낸다. direct oneM2M cin 원본도 유지한다. 기존 CORE v1 토픽은 broker PUBACK까지 확인한다. epoch 전용 경로의 적용 영수증은 별도 계약이다.
- batteryPct는 실제 측정 SOC를 정수 반올림한다. 일반 CORE v1 경로는 배터리 또는 RSSI가 없으면 projection을 보내지 않는다. epoch 전용 후보는 미확인 값을 null로 보내며 원본 관측은 cin에 보존한다.
- CORE가 deviceId:sequence로 dedup하므로 device별 uint32 sequence를 SQLite에 따로 유지한다. 원래 bootId/firmwareSequence를 함께 남긴다. sequence 소진 시 오류로 보존하며 자동 wrap하지 않는다. DB를 삭제하면 이 연속성을 잃으므로 일반 복구로 사용하지 않는다.
- Gateway 0.2.11은 SQLite에서 장치별로 가장 먼저 대기열에 들어간 CORE 관측만 전송 대상으로 삼는다. 그 행이 재시도 대기 중이면 같은 장치의 최신 CORE 관측도 기다린다. 다른 장치의 CORE 관측과 native 관측·영수증은 계속 처리한다. [재시도 순서와 SDT 시험](evidence/2026-11-10-core-retry-order/README.md)
- 성공 ACK만 READBACK_VERIFIED로 변환하고 measurementScope=gpio-at-application을 함께 보낸다. 실제 모터 작동을 센서로 검증한 값이 아니다. 실패/미확정 결과는 원래 상세 receipt cin에 기록한다.
>>>>>>> origin/codex/keyring-namho

기본 `core-v1` BLE UUID와 키링 identity 확장을 사용한다. Gateway는 실제 battery/RSSI가 있는 관측을 CORE telemetry로 투영하고 bootId·firmwareSequence·gatewayId·timestampSource를 보존한다. nullable 원본 관측은 native oneM2M CIN에 저장한다.

CORE는 HTTP PUT 또는 MQTT UPDATE `op=3`, `rvi=4`로 binarySwitch 상태를 전송한다. MQTT To는 CSE/SP/절대 주소 범위를 변환하며 UPDATE 완료 코드 `2004`를 사용한다. flexContainer와 Group member type은 `28`이다.

중앙 `GatewayControl`은 현재 consent/grant와 등록 장치를 연결해 canonical command를 발급한다. 명령의 `version`, `gatewayId`, `deviceId`, `commandId`, `claimId`, `desiredState.state`, `issuedAt`, `deadline`, `grantRevision`, `ownershipEpoch`를 CORE `sendCommand(command)`와 Group `memberCommands`에 보존한다. canonical hash와 전송 입장 generation은 중앙 기록·lane·outbox에서 같은 명령에 결속한다.

## Gateway API

<<<<<<< HEAD
| 경로 | 동작 |
|---|---|
| `GET /api/v1/gateways/{id}/credentials/status` | 인증서 revision·ACTIVE/LOST/REVOKED 상태 |
| `GET /api/v1/gateways/{id}/commands?limit=16` | 현재 유효한 canonical 명령 최대 16개 |
| `POST /api/v1/gateways/{id}/authorize` | command·claim·grant·epoch·hash·기한 재확인 |
| `POST /api/v1/gateways/{id}/dispatch-start` | 영속 intent 기록 후 BLE 전송 직전 현재 claim·전송 입장 확인 |
| `POST /api/v1/gateways/{id}/receipts` | epoch·revision·hash·readback을 검증한 결과 정산 |
| `POST /v1/gateways/{id}/commands` | `bubble:command` 권한 소유자의 명령 발급 |
=======
Gateway 0.2.5는 팀 main `715ef58`의 실제 mTLS API에서 명령을 받아 정상 worker로 처리한 뒤 격리 Mobius4의 native receipt까지 확인했다. GATT는 모의 장치를 썼다. 연결 전 grant를 회수하면 중앙의 현재 승인 응답으로 거절되고 쓰기가 발생하지 않았다. [명령 통합 증거](evidence/2026-11-10-central-dispatch/README.md)

중앙에서 HTTP로 발급한 명령을 CORE MQTT ACK 정산과 연결하려면 중앙 명령 레코드를 CORE의 ACK 검증에서 조회할 수 있어야 한다. 현재 main의 `GatewayBridge.handleAck`는 `pendingCommands` 또는 `commandPayloads`에서 기대 명령을 읽고, `sendCommand`가 그 맵을 채운다. 이번 시험의 native cin 확인과 CORE의 `ACK_RECORDED`는 별도 단계로 추적한다.

팀 main 원본을 대상으로 이 차이를 재현했다. HTTP 발급 명령의 ACK는 `REVIEW`로 남았고, CORE에 등록된 명령은 ACK의 payloadHash만 바꿔도 `ACK_RECORDED`가 됐다. 중앙 발급·승인 기록, 인증된 Gateway ID, CSE native receipt를 결속하는 KEYRING 후보는 정상 입력 2개와 거절 사례 7개를 검증했다. 운영에서의 원자적 정산과 ACK 수신기 연결은 팀 owner 경계다. [결속 후보](integration-candidate/README.md) · [실행 증거](evidence/2026-11-10-core-ack-binding/README.md)

후속 KEYRING 후보는 CSE 원본 조회와 과거 승인 판정에 이어, 같은 명령의 영수증 재전송과 내용 충돌을 영속 정산 경계에서 구분한다. CORE 적용에는 인증된 CSE GET, 팀 발급·승인 조회, 정산 고유 키를 가진 중앙 저장소, ACK 또는 CSE 알림 수신 연결이 필요하다. [중앙 정산 후보](integration-candidate/README.md#cse-명령-영수증의-중앙-정산-후보)

Scoped 개발 환경에는 Gateway별 명령 영수증 컨테이너와 한 건씩 호출하는 정산 명령을 추가했다. 이 경로는 기존 팀 상태 파일에서 발급·승인을 읽고 인증된 CSE의 원본 영수증을 별도 POSIX 저장소에 정산한다. 운영 CORE의 자동 수신 경로와 중앙 DB 연결은 별도다. [임시 정산 준비와 실행 절차](dev/mobius4/README.md#명령-영수증-정산-준비)

팀 PostgreSQL에 적용할 정산 테이블과 `pg.Pool` 어댑터 후보를 추가했다. 기존 CORE 감사 journal을 유지하면서 중앙에서 확정한 명령당 한 행을 보관한다. CORE owner가 실제 companion DB 적용과 수신기 연결을 맡는다. [PostgreSQL 정산 저장 후보](integration-candidate/README.md#postgresql-정산-저장-후보)

Mobius4의 새 cin 알림을 받아 PostgreSQL에 URI를 보관하고, 원본 조회와 정산을 재시도하는 수신 함수와 작업자 후보를 추가했다. 운영 CORE에서 인증된 콜백 경로·구독·작업 루프와 DB 마이그레이션을 연결해야 한다. [알림 정산 후보](integration-candidate/README.md#mobius4-알림에서-원본-정산까지)

대기열에 도달하기 전 유실된 알림은 팀 명령·승인 스냅샷과 인증 CSE 원본을 대조해 보완하도록 복구 스윕을 추가했다. 운영 CORE는 원래 CSE 경로의 배정 기록, 영수증 보존 기간과 스윕 주기를 설정한다. [알림 유실 복구 후보](integration-candidate/README.md#대기열-도달-전-유실-복구)

handover 후에는 이전 epoch뿐 아니라 대상 Gateway도 확인해야 한다. 팀 원본 API는 이전 Gateway가 같은 장치에 등록된 상태에서 현재 epoch의 새 명령을 승인했다. 활성 Edge와 Gateway를 명시적으로 연결한 후보는 발급·조회·승인에서 이전 Gateway를 차단했다. 롤백 뒤 원래 Gateway 복구와 API 재기동 후 판정 유지도 확인했다. 운영 적용은 팀의 정본 Edge → Gateway 매핑과 drain 계약에 따른다. [후보와 입력](integration-candidate/README.md#handover-뒤-활성-gateway-검증) · [mTLS 시험](evidence/2026-11-10-handover-owner/README.md)

같은 장치의 순서가 맞아도 팀 CORE 브리지에서 CSE UPDATE가 동시에 실행되면 최신 상태가 옛 값으로 덮인다. 격리 Mobius4에서 옛 ON 요청을 지연시켜 최종 ON을 재현했다. [관측 순서 후보](integration-candidate/README.md#core-관측의-동시-갱신)를 거치면 최종 OFF를 확인했고, 소유권이 바뀐 뒤 이전 Gateway의 갱신과 적용 여부가 불명확한 자원의 후속 갱신은 차단됐다. 운영 연결에는 원래 발행 epoch를 보존하는 인증 수신 경로와 중앙 handover·중복 판정 연동이 남아 있다. [실행 기록](evidence/2026-11-10-core-concurrent-order/README.md)

Gateway 0.2.12와 KEYRING 수신 후보는 발행 시점의 epoch를 SQLite와 별도 MQTT 토픽에 보존한다. 중앙이 장치·epoch별 토픽의 쓰기 권한을 해당 Gateway 인증서에만 부여하면 수신 후보가 원래 소유권을 복원할 수 있다. 팀 CORE v1 본문은 유지한다. ACL, 중앙 라우팅, handover drain과 실제 CSE 적용 연결이 필요하다. [입력·ACL·전환 계약](integration-candidate/README.md#발행-당시-epoch를-보존하는-mqtt-수신-후보)

격리 프로필에 전용 브로커와 중앙 소비자를 연결했다. Gateway 0.2.13의 native HTTPS 설정을 사용하면 epoch MQTT와 분리할 수 있다. 이번에는 빈 자원 생성·재조회와 소비자 구독까지 확인했다. 실제 토픽 거절과 handover 후 SDT 적용은 별도 시험 범위다. [서버 준비 기록](evidence/2026-11-10-core-scoped-stack/README.md)

Gateway 0.2.14는 epoch 관측과 일치하는 CSE 적용 영수증을 받아야 해당 outbox 행을 완료한다. 중앙 소비자는 확인한 최신 cursor의 영수증을 재전송할 수 있다. Gateway, 소비자, 응답 ACL을 함께 적용해야 한다. [적용 영수증 계약](integration-candidate/README.md#epoch-관측의-적용-영수증)

KEYRING 전환 후보는 SDT UPDATE와 활성 Gateway 교체를 같은 자원 대기열에서 처리한다. 팀 handover가 새 epoch를 활성화하기 전에 이 경계에서 미확정 UPDATE를 보류하도록 연결할 수 있다. 격리 프로필에서 전환용 소비자가 구독했고 초기 A7 소유권을 조회했다. B8 전환과 A9 롤백 실행은 별도 시험 범위다. [전환 계약](integration-candidate/README.md#sdt-적용과-소유권-전환) · [배치 기록](evidence/2026-11-10-core-scoped-handover-rollout/README.md)

Gateway 0.2.18은 epoch 전용 경로에서 배터리·RSSI가 없는 관측을 nullable 형식 1.1.0으로 보낸다. 격리 Mobius4에는 Feather의 별도 SDT와 토픽을 준비했다. 두 버튼은 native cin의 `buttonState`에 남고 SDT에는 실제 관측의 `state`를 쓴다. [Feather 설정](dev/mobius4/README.md#feather-벤치-경로)

## 소유권
>>>>>>> origin/codex/keyring-namho

`/api/v1`과 `/v1` Gateway 경로는 같은 계약을 제공한다. Gateway 인증서는 principalId·fingerprint·등록 gatewayId에 결속된다. 승인 응답은 `contracts/keyring/authorization.schema.json`, 상태 응답은 `credential-status.schema.json`을 따른다. 등록과 LOST 수명주기는 [Gateway 등록](../pc-mobius/integration/GATEWAY_REGISTRATION.md)에 정리한다.

## 영수증과 재시도

CORE는 중간 RECEIVED/FORWARDED ACK를 대기 상태로 유지하고 device·grant·epoch·readback이 일치하는 READBACK_VERIFIED에서 완료한다. MQTT publish 중 도착한 즉시 ACK/oneM2M 응답도 처리한다. Group 재시도는 중앙에서 발급한 원래 명령을 보존한다.

Gateway native receipt, CORE ACK, 중앙 receipt outbox는 SQLite 원자 staging과 독립 재시도를 사용한다. broker PUBACK은 broker 수신 증거, 중앙 oneM2M 처리 영수증은 정책·장치 결과 증거로 기록한다. 웹은 CORE와 통합 서비스 receipt를 같은 JSONL에서 읽는다.

## 검증과 인계

`npm run verify`에서 Python Gateway와 Node 중앙 API를 실제 TLS 1.3/mTLS로 연결한다. 명령 조회, Python/JS canonical hash, 승인·전송 입장, 최종 영수증, grant 회수, 인증서·범위, Panic 사건·위치 lease와 회귀시험을 실행한다.

기존 [Feather·Pi 실물 증거](evidence/2026-11-10-pi-feather/README.md)는 화면 유지, 인증된 BlueZ 연결, 버튼 관측을 기록한다. 초기 observation READ를 notification 구독 전에 완료해 READ echo와 알림 조각의 경계를 보존한다. 전체 신규 통합 경로의 실물 실행은 [외부 실증 TODO](../docs/external-validation-todo.md)로 관리한다. 임시·교체 CSE 설정은 [Mobius4 환경](dev/mobius4/README.md)을 따른다.
