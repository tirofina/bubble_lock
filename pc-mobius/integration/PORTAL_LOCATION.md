# 사용자 지도와 실제 관측 연결

`GET /v1/portal/locations`는 인증한 사용자의 가구 범위에서 Gateway 관측과 MEC 위치를 정규화한다. 반환형은 다음과 같다.

```json
{"observations":[{"deviceId":"keyring-1","gatewayId":"gateway-1","observedAt":"2026-11-10T10:00:00.000Z","simulation":false,"location":{"lat":37.5665,"lon":126.978,"source":"gps","accuracyM":6},"rssiDbm":-60}]}
```

`location`, `gatewayId`, `rssiDbm`, `accuracyM`은 해당 자료가 있는 관측에 포함된다. BLE RSSI 단독 관측은 `gatewayId`와 `rssiDbm`을 제공하고 지도는 등록된 수신기 좌표 중심의 추정 원을 그린다. MEC 좌표는 `service:'Location'`, `location.source:'mec'`로 전달된다. 관측 시각과 source simulation을 유지하므로 화면에서 최신성·출처를 표현할 수 있다.

보호자는 소속 가구의 기기를 조회한다. 방문자는 해당 가구 보호자의 현재 `location:read` grant가 활성인 동안 조회한다. MEC는 암호화된 `mecPayloads`를 `mecIngress.readEvent()`로 읽으며 source grant·revision·서비스 scope·retention을 재검사한다. source grant의 subjectId와 등록 기기의 householdId도 대조한다.

UE 식별자가 실제 등록 deviceId와 같으면 직접 연결한다. 별도 UE ID는 운영 설정 `core.locationDeviceBindings`에 등록한다. 예시는 `{"core":{"locationDeviceBindings":{"ue-provider-1":"keyring-1"}}}`이다. callback 본문의 임의 deviceId는 등록 mapping의 근거로 사용되는 대신 서비스 데이터로 보관된다.

Gateway의 `POST /api/v1/gateways/{id}/telemetry`는 [native observation 계약](../../contracts/keyring/observation.schema.json)을 받는다. TLS client certificate와 Gateway 등록, 기기·가구 연결, 시간, boot/sequence와 payload hash를 확인하고 `ACCEPTED`, `DUPLICATE`, `STALE` receipt를 반환한다. 본문의 추가 simulation flag는 계약 검증을 거치며, 데이터 모드는 서버에 등록된 Gateway principal의 `simulation` 설정으로 결정한다.

Python Gateway는 `CENTRAL_TELEMETRY_ENABLED=true`를 기본으로 native CSE 경로와 `@central/telemetry` 경로를 같은 SQLite transaction에 저장한다. 중앙 전송은 기존 TLS 1.3/mTLS TransportHub를 사용하며 원래 관측 식별자로 재시도한다. `core_bridge_enabled`는 별도 MQTT CORE 전송 설정이다. 중앙 수집은 재부팅 때 초기화되는 firmware sequence와 별도로 단조 sequence를 발급해 handover accepted-observation 경로에 연결한다.

위치 원문은 최대 24시간 보관한다. 조회와 1분 주기 정리에서 Gateway 만료 원문을 제거하고, MEC는 기존 암호화 payload 정리 경로를 사용한다. 만료 시각을 지난 자료는 지도 응답에서 정리된다.

검증은 `test/portal-location.test.mjs`, Gateway의 `test_central_telemetry.py`, `tests/integration/test_gateway_api.py`에 있다. 마지막 시험은 Python TransportHub→실제 Node TLS API→보호자 위치 조회를 연결하여 GPS/RSSI 보존과 중복 수신 처리를 확인한다. 시험 관측은 synthetic fixture이며 실물 장비 결과는 별도의 장비 receipt로 기록한다.
