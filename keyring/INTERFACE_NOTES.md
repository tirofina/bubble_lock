# KEYRING 구현 계약 0.1.0

DOC-REV: 1.0.0 · 담당: 남호 / KEYRING · 상태: implemented, unverified

중앙 PC의 canonical contract가 아직 제공되지 않아 아래 주소와 payload는 PC-MOBIUS에 전달할 **제안 계약**이다. 중앙 승인·Mobius capability probe·실물 시험을 마쳤다는 뜻이 아니다.

## BLE

- Service `8b8f0001-8e7a-4f36-a8c2-1c9b5d620001`
- Identity READ `8b8f0002-8e7a-4f36-a8c2-1c9b5d620001`
- Observation READ/NOTIFY `8b8f0003-8e7a-4f36-a8c2-1c9b5d620001`
- Command WRITE with response `8b8f0004-8e7a-4f36-a8c2-1c9b5d620001`
- Receipt READ/NOTIFY `8b8f0005-8e7a-4f36-a8c2-1c9b5d620001`
- UTF-8 JSON + LF. WRITE/NOTIFY는 기본 ATT MTU 23에서도 동작하도록 최대 20 byte fragment. 한 프레임 최대 4096 byte, 조각 사이 timeout 5초. READ는 마지막 전체 JSON(최대 512 byte identity/observation, receipt는 NOTIFY 우선). command write는 한 장치당 직렬화.
- Identity: `version:1, deviceId, firmwareRevision, boardRevision, bootId`.
- Observation: `version:1, deviceId, bootId, sequence, uptimeMs, battery`(0..100 또는 null), `buttonState`("released"|"confirm"|"panic"), `sensorValues`(객체), `state`(boolean). RSSI와 UTC observedAt은 Gateway 관측 시 부여한다. BLE RSSI는 실제 scan 값 또는 null이며 거리로 환산하지 않는다.
- Command: `version:1, type:"command", deviceId, commandId, desiredState:{state:boolean}, grantRevision`(양의 정수), `ownershipEpoch`(0 이상), `payloadHash`(원래 중앙 command의 canonical JSON SHA256), `remainingMs`(1..30000).
- Receipt: `version:1, deviceId, bootId, commandId, payloadHash, ackCode, acceptedUptimeMs, appliedUptimeMs`(null 가능), `readback:{state:boolean}`, `firmwareRevision`.
- ackCode: APPLIED, DUPLICATE, REJECTED_EPOCH, REJECTED_GRANT, EXPIRED, CONFLICT, INVALID, JOURNAL_FULL, STORAGE_ERROR, INDETERMINATE, READBACK_MISMATCH. 명령 ID의 같은 payload는 저장된 결과를 반환하고 다른 hash는 CONFLICT. 장치 journal은 bounded, 가득 차면 임의로 지우지 않고 JOURNAL_FULL. 저장 중 전원 차단은 재실행하지 않고 INDETERMINATE로 반환.
- 암호화·MITM·bonding과 명시적으로 설정한 장치별 passkey를 사용한다. 설정 없는 firmware는 명령을 허용하지 않는다. 보드는 passkey를 표시할 실제 UI가 없으므로 라벨/안전한 등록 경로로 배포해야 한다.
- binarySwitch의 `state`는 현재 GPIO 진동 출력의 on/off이다. ON은 최대 1000ms 또는 남은 기한 중 작은 값 후 자동 OFF되며 관측에 반영된다. readback은 적용 시점의 GPIO 수준 확인이며 모터의 물리적 작동을 측정했다는 뜻이 아니다. 배터리·센서 I2C 실패는 null/상태값으로 표시한다.
- remainingMs는 첫 fragment 수신부터 적용 직전까지의 조립·큐 대기·NVS 기록 시간을 포함한다. Gateway는 전송 전 경과시간과 250ms 여유를 차감한다. 양단 시계 동기화 또는 서명된 절대기한 방식이 아니므로 지연 상한이 보장되지 않는 환경의 엄격한 UTC deadline은 추가 계약이 필요하다.

## PC API (mTLS, 제안)

- `GET /api/v1/gateways/{gatewayId}/commands?limit=16`: `{commands:[command...]}`. 중앙은 receipt가 도착할 때까지 미정산 명령을 반복 반환해야 한다. fetch만으로 소비 처리하지 않는다.
- `POST /api/v1/gateways/{gatewayId}/authorize`: `{commandId,deviceId,claimId,grantRevision,ownershipEpoch,payloadHash}`. 응답은 `{allowed:boolean,commandId,deviceId,claimId,grantRevision,ownershipEpoch,payloadHash,expiresAt}`. allowed=true이고 모든 바인딩·revision·payloadHash가 일치하고 expiresAt이 미래일 때만 직전에 실행한다. 오류·오프라인·만료는 fail closed. 권한 판정 이후 발생하는 회수 race는 중앙 claim/dispatch 정책과 통합해야 한다.
- command: `version:1, gatewayId, deviceId, commandId, claimId, desiredState:{state:boolean}, issuedAt, deadline, grantRevision, ownershipEpoch`. 시간은 timezone이 있는 RFC3339. commandId는 전역 유일, revision은 양의 정수, epoch는 0 이상. PC에서 동일 commandId 내용을 바꾸지 않는다.
- `GET /api/v1/gateways/{gatewayId}/credentials/status`: `{gatewayId,credentialRevision,status:"ACTIVE"|"LOST"|"REVOKED"}`. 등록 및 인증서 발급/교체 자체는 중앙 PKI·운영 담당. Gateway는 상태를 receipt에 기록하며 LOST/REVOKED에서 새 실행을 막는다.
- 설정/인증서 파일 교체는 서비스 재시작 시 읽는다. 인증서/개인키 원문은 로그나 receipt에 기록하지 않는다.

## oneM2M

- 기존 AE와 container는 PC가 사전 생성한다. Gateway는 observation, receipts, health container 아래 `m2m:cin`을 CREATE한다.
- MQTT 3.1.1, QoS 1, retain=false, persistent session. `/oneM2M/req/{originator}/{cseId}/json` 요청과 `/oneM2M/resp/{originator}/{cseId}/json` 응답. MQTT Originator/CSE ID는 topic 단일 segment 설정값이다. 정확한 broker topic 규칙·지원 RVI는 capability probe로 고정해야 한다.
- request primitive: `{op:1,to,fr,rqi,ty:4,rvi,pc:{"m2m:cin":{rn,cnf:"application/json:0",con:payload}}}`. rn은 rqi에서 유도한 안정적 이름을 사용한다.
- 기본 JSON은 flat primitive다. PC capability probe에서 legacy wrapper가 필요하다고 확정하면 `MQTT_WRAPPED_PRIMITIVE=true`로 `{"m2m:rqp":primitive}`를 사용한다. 실패 시 임의 형식 전환은 없다. response의 fr은 설정한 CSE topic ID 또는 그 앞에 `/`를 붙인 정식 ID만 허용한다. 요청/응답 필드 근거: [oneM2M Recipes](https://recipes.onem2m.org/introduction/What-are-oneM2M-Requests/).
- HTTPS fallback: CSE container URI에 POST, 동일 rqi/rn, `X-M2M-Origin`, `X-M2M-RI`, `X-M2M-RVI`, `Content-Type:application/json;ty=4`.
- MQTT PUBACK만으로 완료 처리하지 않는다. matching rqi의 oneM2M 성공 rsc를 기다린다. 4105 충돌은 같은 rn을 GET하고 con이 일치할 때만 기존 성공으로 인정한다.
- 중앙 receipt는 acceptedAt/appliedAt에 실제 펌웨어 uptime을 Gateway 시간 anchor로 변환한 값과 `timestampSource:"gateway-estimated"`를 기록한다. 재부팅/중복 등으로 UTC를 확정할 수 없으면 null을 기록한다.
- PC가 Group/member 결과와 `cod:binSh/state`를 집계한다. Gateway는 중앙 정책·자원 owner를 대신하지 않는다.

## 구현 모듈 연결

- `bubble_gateway.ble.BleFleet(config)`: `async start(observation_callback)`, `async execute(command_dict, remaining_ms, payload_hash)->dict`, `async close()`, `snapshot()->list[dict]`. callback은 async callable. config는 아래 GatewayConfig의 속성을 사용한다.
- `bubble_gateway.transport.TransportHub(config)`: `async start()`, `async publish(rqi, container, payload)->None`, `async poll_commands()->list[dict]`, `async authorize(command_dict,payload_hash)->dict`, `async credential_status()->dict`, `async close()`. 실패는 예외. publish의 HTTP/MQTT 성공 판정은 실제 oneM2M 응답을 따른다.
- config 속성: gateway_id, originator, cse_id, cse_url, api_url, ca_file, cert_file, key_file, mqtt_host, mqtt_port, mqtt_enabled, mqtt_keepalive, request_timeout, rvi, observation_container, receipt_container, health_container, ble_devices(dict deviceId->address), ble_pair(bool), ble_scan_seconds, ble_command_timeout, firmware_revision_allowlist(tuple[str,...]). pathlib 경로는 httpx/SSL에 str로 전달한다.
- mqtt_wrapped_primitive는 선택한 MQTT primitive encoding을 나타내는 boolean이다.

검증·빌드·실행 및 실제 receipt 생성은 이번 작업에서 하지 않는다. 실제 동작·표준 적합성·전력·거리·공개 영상 evidence는 미확인이다.
