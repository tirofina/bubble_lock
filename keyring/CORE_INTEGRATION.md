# PC-MOBIUS-CORE 연동 메모

기준 DOC-REV 2.0.0, Gateway 계약 1.0.0. 원격 `main`의 `715ef58`에는 통합 커밋 `413fd31`이 포함돼 있다. 역할 브랜치에는 이 커밋의 Gateway BLE 탐색 취소 수정과 회귀시험을 반영했다.

## 구현한 연결

- 펌웨어 `keyring-0.2.0`과 Gateway 기본 GATT profile `core-v1`은 팀 service `7f8a0001-4b6e-4f4e-9b0a-505249564255`, state `...0002...`, command `...0003...`, ack `...0004...`를 사용한다. 장치 식별을 위한 identity `...0005...`를 KEYRING extension으로 추가했다.
- 기존 펌웨어 profile은 `KEYRING_LEGACY_GATT=1`, Gateway는 `BLE_GATT_PROFILE=keyring-v01`로 명시 선택한다. 자동 downgrade하지 않는다. 이번 작업에서 실제 firmware flash는 하지 않았다.
- BLE 내부 프레임은 bootId·uptime·nullable battery와 sensorValues를 유지한다. UTC/RSSI는 Gateway가 관측하므로 CORE의 timestamp/batteryPct/rssiDbm으로 내보내는 변환을 별도로 둔다. UUID 일치만으로 팀의 BLE payload 전체와 동일하다고 주장하지 않는다. 이 확장·변환 계약은 CORE owner의 수용이 필요하다.
- `CORE_BRIDGE_ENABLED=true`는 telemetry와 성공 ACK를 SQLite outbox에 추가하고 팀 MQTT topic으로 보낸다. direct oneM2M cin 원본도 유지한다. 기존 CORE v1 토픽은 broker PUBACK까지 확인한다. epoch 전용 경로의 적용 영수증은 별도 계약이다.
- batteryPct는 실제 측정 SOC를 정수 반올림한다. battery 또는 RSSI가 없으면 CORE v1이 null을 허용하지 않으므로 projection을 보내지 않는다. 원본 nullable 관측은 cin에 보존한다. 0%나 -127 같은 가짜 측정값으로 채우지 않는다.
- CORE가 deviceId:sequence로 dedup하므로 device별 uint32 sequence를 SQLite에 따로 유지한다. 원래 bootId/firmwareSequence를 함께 남긴다. sequence 소진 시 오류로 보존하며 자동 wrap하지 않는다. DB를 삭제하면 이 연속성을 잃으므로 일반 복구로 사용하지 않는다.
- Gateway 0.2.11은 SQLite에서 장치별로 가장 먼저 대기열에 들어간 CORE 관측만 전송 대상으로 삼는다. 그 행이 재시도 대기 중이면 같은 장치의 최신 CORE 관측도 기다린다. 다른 장치의 CORE 관측과 native 관측·영수증은 계속 처리한다. [재시도 순서와 SDT 시험](evidence/2026-11-10-core-retry-order/README.md)
- 성공 ACK만 READBACK_VERIFIED로 변환하고 measurementScope=gpio-at-application을 함께 보낸다. 실제 모터 작동을 센서로 검증한 값이 아니다. 실패/미확정 결과는 원래 상세 receipt cin에 기록한다.

Gateway0.2.2는 native 영수증과 CORE ACK를 최초 staging 때 한 트랜잭션에서 생성한다. ACK가 전달돼 삭제된 뒤 native 재시도 때문에 다시 생성하지 않는다. 경로별 기존 outbox는 독립 재시도하며 CORE projection 선택은 최초 staging 시 고정한다. 설정을 나중에 켜도 이미 대기 중인 native 영수증을 소급 backfill하지 않는다. [경로 수명·시험](raspberry-pi-gateway/RECEIPT_ROUTING.md)에 기록했다.

## 중앙 API와 남은 통합 시험

원격 `main`에서 Gateway 명령 발급·조회·승인·자격 상태 경로와 TLS 1.3/mTLS principal 등록을 확인했다. 중앙 서버가 grant에서 `claimId`·`grantRevision`·`ownershipEpoch`를 결속한다. 통합 커밋에는 CORE UPDATE 연산, flexContainer/Group 유형, 주소 변환 및 ACK 결속 수정도 포함된다.

`main`의 Node API와 Python Gateway를 새 임시 인증서로 재시험했다. 명령 조회, canonical hash 승인, 잘못된 해시 거절, grant 회수, 범위 위조 및 인증서 미제출 차단 시험 1개가 통과했다. 다음 단계는 실제 Pi의 BLE 관측과 운영 등록·인증서로 전체 경로를 시험하는 것이다. raw CORE MQTT의 PUBACK은 broker 수신 확인으로 기록한다.

Gateway 0.2.5는 팀 main `715ef58`의 실제 mTLS API에서 명령을 받아 정상 worker로 처리한 뒤 격리 Mobius4의 native receipt까지 확인했다. GATT는 모의 장치를 썼다. 연결 전 grant를 회수하면 중앙의 현재 승인 응답으로 거절되고 쓰기가 발생하지 않았다. [명령 통합 증거](evidence/2026-11-10-central-dispatch/README.md)

중앙에서 HTTP로 발급한 명령을 CORE MQTT ACK 정산과 연결하려면 중앙 명령 레코드를 CORE의 ACK 검증에서 조회할 수 있어야 한다. 현재 main의 `GatewayBridge.handleAck`는 `pendingCommands` 또는 `commandPayloads`에서 기대 명령을 읽고, `sendCommand`가 그 맵을 채운다. 이번 시험의 native cin 확인과 CORE의 `ACK_RECORDED`는 별도 단계로 추적한다.

팀 main 원본을 대상으로 이 차이를 재현했다. HTTP 발급 명령의 ACK는 `REVIEW`로 남았고, CORE에 등록된 명령은 ACK의 payloadHash만 바꿔도 `ACK_RECORDED`가 됐다. 중앙 발급·승인 기록, 인증된 Gateway ID, CSE native receipt를 결속하는 KEYRING 후보는 정상 입력 2개와 거절 사례 7개를 검증했다. 운영에서의 원자적 정산과 ACK 수신기 연결은 팀 owner 경계다. [결속 후보](integration-candidate/README.md) · [실행 증거](evidence/2026-11-10-core-ack-binding/README.md)

handover 후에는 이전 epoch뿐 아니라 대상 Gateway도 확인해야 한다. 팀 원본 API는 이전 Gateway가 같은 장치에 등록된 상태에서 현재 epoch의 새 명령을 승인했다. 활성 Edge와 Gateway를 명시적으로 연결한 후보는 발급·조회·승인에서 이전 Gateway를 차단했다. 롤백 뒤 원래 Gateway 복구와 API 재기동 후 판정 유지도 확인했다. 운영 적용은 팀의 정본 Edge → Gateway 매핑과 drain 계약에 따른다. [후보와 입력](integration-candidate/README.md#handover-뒤-활성-gateway-검증) · [mTLS 시험](evidence/2026-11-10-handover-owner/README.md)

같은 장치의 순서가 맞아도 팀 CORE 브리지에서 CSE UPDATE가 동시에 실행되면 최신 상태가 옛 값으로 덮인다. 격리 Mobius4에서 옛 ON 요청을 지연시켜 최종 ON을 재현했다. [관측 순서 후보](integration-candidate/README.md#core-관측의-동시-갱신)를 거치면 최종 OFF를 확인했고, 소유권이 바뀐 뒤 이전 Gateway의 갱신과 적용 여부가 불명확한 자원의 후속 갱신은 차단됐다. 운영 연결에는 원래 발행 epoch를 보존하는 인증 수신 경로와 중앙 handover·중복 판정 연동이 남아 있다. [실행 기록](evidence/2026-11-10-core-concurrent-order/README.md)

Gateway 0.2.12와 KEYRING 수신 후보는 발행 시점의 epoch를 SQLite와 별도 MQTT 토픽에 보존한다. 중앙이 장치·epoch별 토픽의 쓰기 권한을 해당 Gateway 인증서에만 부여하면 수신 후보가 원래 소유권을 복원할 수 있다. 팀 CORE v1 본문은 유지한다. ACL, 중앙 라우팅, handover drain과 실제 CSE 적용 연결이 필요하다. [입력·ACL·전환 계약](integration-candidate/README.md#발행-당시-epoch를-보존하는-mqtt-수신-후보)

격리 프로필에 전용 브로커와 중앙 소비자를 연결했다. Gateway 0.2.13의 native HTTPS 설정을 사용하면 epoch MQTT와 분리할 수 있다. 이번에는 빈 자원 생성·재조회와 소비자 구독까지 확인했다. 실제 토픽 거절과 handover 후 SDT 적용은 별도 시험 범위다. [서버 준비 기록](evidence/2026-11-10-core-scoped-stack/README.md)

Gateway 0.2.14는 epoch 관측과 일치하는 CSE 적용 영수증을 받아야 해당 outbox 행을 완료한다. 중앙 소비자는 확인한 최신 cursor의 영수증을 재전송할 수 있다. Gateway, 소비자, 응답 ACL을 함께 적용해야 한다. [적용 영수증 계약](integration-candidate/README.md#epoch-관측의-적용-영수증)

KEYRING 전환 후보는 SDT UPDATE와 활성 Gateway 교체를 같은 자원 대기열에서 처리한다. 팀 handover가 새 epoch를 활성화하기 전에 이 경계에서 미확정 UPDATE를 보류하도록 연결할 수 있다. 격리 프로필에서 전환용 소비자가 구독했고 초기 A7 소유권을 조회했다. B8 전환과 A9 롤백 실행은 별도 시험 범위다. [전환 계약](integration-candidate/README.md#sdt-적용과-소유권-전환) · [배치 기록](evidence/2026-11-10-core-scoped-handover-rollout/README.md)

## 소유권

CORE: oneM2M resource/SDT/namespace, RVI, broker topic/ACL, native bridge/DB.
INTEGRATION: commands/authorize/credential API, grant·claim·epoch·handover.
KEYRING: firmware/GATT, BLE framing, 실제 관측, durable Gateway adapter, 장치 journal/readback.

임시 서버와 향후 서버 교체 절차는 [Mobius4 환경](dev/mobius4/README.md)에 있다.

## firmware0.6.0 센서 detail 확장

KEYRING의 sensorValues는 sensors/energy/health detail로 순환한다. INA219의 signed 정수 단위/오류/null/readUptimeMs는 `firmware/POWER_MONITOR.md`와 `contracts/keyring/ina219-reading.schema.json`에 정의했다. Gateway는 객체가 있는 프레임에서 필드·단위·시각·전력 계산을 runtime에서 판정하고 native observation cin에 원본을 보관한다. 이번 작업에서는 그 runtime을 실행하지 않았다.

기존 CORE v1 MQTT telemetry projection은 base battery/rssi/state/identity만 전달하므로 INA219·기타 센서 상세를 포함하지 않는다. CORE topic 확장은 owner의 canonical revision 합의 뒤 연결한다. 필드를 임의로 schemaVersion1.0.0 telemetry에 넣거나 중앙 정책·권한으로 변환하지 않았다. detail 누락을0으로 채우거나 서로 다른 boot/time의 측정을 합치지 않는다.
