# PC-MOBIUS-CORE 연동 메모

기준 DOC-REV 2.0.0, CORE `91a281b`, `pc-mobius/contracts/raspberrypi-gateway.v1.json` / contractVersion 1.0.0. 팀 원본을 역할 브랜치로 merge했고 해당 파일과 `pc-mobius/` 구현은 수정하지 않았다.

## 구현한 연결

- 펌웨어 `keyring-0.2.0`과 Gateway 기본 GATT profile `core-v1`은 팀 service `7f8a0001-4b6e-4f4e-9b0a-505249564255`, state `...0002...`, command `...0003...`, ack `...0004...`를 사용한다. 장치 식별을 위한 identity `...0005...`를 KEYRING extension으로 추가했다.
- 기존 펌웨어 profile은 `KEYRING_LEGACY_GATT=1`, Gateway는 `BLE_GATT_PROFILE=keyring-v01`로 명시 선택한다. 자동 downgrade하지 않는다. 이번 작업에서 실제 firmware flash는 하지 않았다.
- BLE 내부 프레임은 bootId·uptime·nullable battery와 sensorValues를 유지한다. UTC/RSSI는 Gateway가 관측하므로 CORE의 timestamp/batteryPct/rssiDbm으로 내보내는 변환을 별도로 둔다. UUID 일치만으로 팀의 BLE payload 전체와 동일하다고 주장하지 않는다. 이 확장·변환 계약은 CORE owner의 수용이 필요하다.
- `CORE_BRIDGE_ENABLED=true`는 telemetry와 성공 ACK를 SQLite outbox에 추가하고 팀 MQTT topic으로 보낸다. direct oneM2M cin 원본도 유지한다. CORE projection은 broker PUBACK까지만 확인하며 CORE UPDATE·subscription evidence와 구분한다.
- batteryPct는 실제 측정 SOC를 정수 반올림한다. battery 또는 RSSI가 없으면 CORE v1이 null을 허용하지 않으므로 projection을 보내지 않는다. 원본 nullable 관측은 cin에 보존한다. 0%나 -127 같은 가짜 측정값으로 채우지 않는다.
- CORE가 deviceId:sequence로 dedup하므로 device별 uint32 sequence를 SQLite에 따로 유지한다. 원래 bootId/firmwareSequence를 함께 남긴다. sequence 소진 시 오류로 보존하며 자동 wrap하지 않는다. DB를 삭제하면 이 연속성을 잃으므로 일반 복구로 사용하지 않는다.
- 성공 ACK만 READBACK_VERIFIED로 변환하고 measurementScope=gpio-at-application을 함께 보낸다. 실제 모터 작동을 센서로 검증한 값이 아니다. 실패/미확정 결과는 원래 상세 receipt cin에 기록한다.

Gateway0.2.2는 native 영수증과 CORE ACK를 최초 staging 때 한 트랜잭션에서 생성한다. ACK가 전달돼 삭제된 뒤 native 재시도 때문에 다시 생성하지 않는다. 경로별 기존 outbox는 독립 재시도하며 CORE projection 선택은 최초 staging 시 고정한다. 설정을 나중에 켜도 이미 대기 중인 native 영수증을 소급 backfill하지 않는다. [경로 수명·시험](raspberry-pi-gateway/RECEIPT_ROUTING.md)에 기록했다.

## 계약 공백과 연동 차단 조건

1. CORE `sendCommand()`는 desiredState:boolean/epoch를 보내지만 claimId·grantRevision이 없다. Gateway는 해당 필드를 임의 생성하지 않고 실행을 차단한다. INTEGRATION이 canonical command와 매 실행 직전 authorize 응답을 제공해야 한다. 승인 필드가 전부 있는 CORE 별칭 형식은 Gateway가 canonical 형식으로 변환한다.
2. CORE `handleAck()`는 모든 ackState에서 pending command를 제거하므로 중간 RECEIVED/FORWARDED나 실패를 성공 흐름으로 투영하지 않는다. 실패/timeout/member retry 정산 의미를 양측에서 확정해야 한다.
3. CORE `handleTelemetryMqtt()`의 state 변경 요청은 op=2지만 oneM2M UPDATE는 op=3이다. native CORE 파일은 수정하지 않았고 HTTP 모드 우선 검토가 필요하다.
4. CORE test contract의 flexContainer CREATE는 resourceType/ty=4지만 flexContainer의 ty는28이다. registry envelope `pb:binarySwitch`와 `state:boolean`은 최신 계획서 기준으로 맞추되 CREATE 계약은 CORE owner가 정정해야 한다.
5. CORE의 raw telemetry topic은 애플리케이션 처리 완료 응답 topic이 없다. MQTT PUBACK을 end-to-end 성공으로 기록하지 않는다. app-level receipt/durable ingress 계약이 추가로 필요하다.
6. 최종 통합 evidence는 실물 Pi 경로가 필요하다. 현재 코드 작성·upstream source 준비·로컬 서버 구성은 실물 BLE/Mobius 통합 증거가 아니다.

## 소유권

CORE: oneM2M resource/SDT/namespace, RVI, broker topic/ACL, native bridge/DB.
INTEGRATION: commands/authorize/credential API, grant·claim·epoch·handover.
KEYRING: firmware/GATT, BLE framing, 실제 관측, durable Gateway adapter, 장치 journal/readback.

임시 서버와 향후 서버 교체 절차는 [Mobius4 환경](dev/mobius4/README.md)에 있다. 테스트·빌드·장비 실행은 이번 checkpoint에서 수행하지 않았다.

## firmware0.6.0 센서 detail 확장

KEYRING의 sensorValues는 sensors/energy/health detail로 순환한다. INA219의 signed 정수 단위/오류/null/readUptimeMs는 `firmware/POWER_MONITOR.md`와 `contracts/keyring/ina219-reading.schema.json`에 정의했다. Gateway는 객체가 있는 프레임에서 필드·단위·시각·전력 계산을 runtime에서 판정하고 native observation cin에 원본을 보관한다. 이번 작업에서는 그 runtime을 실행하지 않았다.

기존 CORE v1 MQTT telemetry projection은 base battery/rssi/state/identity만 전달하므로 INA219·기타 센서 상세를 포함하지 않는다. CORE topic 확장은 owner의 canonical revision 합의 뒤 연결한다. 필드를 임의로 schemaVersion1.0.0 telemetry에 넣거나 중앙 정책·권한으로 변환하지 않았다. detail 누락을0으로 채우거나 서로 다른 boot/time의 측정을 합치지 않는다.
