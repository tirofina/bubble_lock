# BLE·중앙 통신 구현 메모

상태: 코드 작성, 검증·빌드·실행 미실행.

- Gateway 시작 전 BlueZ에서 장치별 passkey로 bond를 등록한다. 데몬이 pairing을 시도하도록 설정하는 경우 BlueZ의 정당한 agent가 필요하다. 자동으로 모든 pairing을 수락하는 agent는 설치하지 않는다.
- 등록한 address를 스캔한 다음 암호화된 GATT identity의 deviceId가 설정과 일치하는지 확인한다. 펌웨어가 요구하는 encrypted/MITM characteristic을 읽고 쓸 수 있어야 한다. 빈 firmware revision allowlist는 revision 제한을 추가하지 않는다는 뜻이며, address/deviceId 등록을 생략할 수 있다는 뜻은 아니다.
- 스캐너는 전체 fleet에서 하나를 사용한다. 어댑터의 동시 scan/connection 지원은 실제 Raspberry Pi와 BlueZ에서 확인해야 한다. RSSI가 마지막 scan 이후 30초를 넘으면 null을 보낸다. 이 값은 거리 측정값이 아니다.
- 명령은 장치별 직렬 WRITE with response를 사용하고, 20 byte 조각에 LF 종결 JSON을 전송한다. fragment timeout/overflow, 잘못된 payload, 전송 중단 시 연결을 해제해 다음 명령과 이전 조각이 섞이지 않게 한다.
- commandId와 payloadHash가 일치하는 receipt만 해당 명령을 정산한다. 성공·거절 여부의 최종 해석은 Gateway service가 담당한다. BLE timeout은 성공으로 바꾸지 않는다.
- 같은 bootId의 60초 이내 uptime anchor만 acceptedAt/appliedAt으로 환산한다. UTC를 확정할 수 없으면 null과 timestampSource=unavailable을 남긴다. gateway-estimated 값은 BLE 수신 지연을 포함하는 추정값이다.
- 순간적인 관측 수신 버퍼는 장치별 128개다. durable queue에 전달하지 못한 현재 항목은 재시도한다. 버퍼 초과 시 명시적으로 drop counter를 늘리고 연결을 끊는다. 프로세스가 비정상 종료되기 전 SQLite에 아직 저장되지 않은 BLE 알림은 복구할 수 없다.
- api_url은 HTTPS base URL이다. 뒤에 `/api/v1/gateways/{gatewayId}`가 붙는다. cse_url은 HTTPS origin이며 container에는 `/Mobius/...`의 전체 resource path를 설정한다.
- HTTP와 MQTT는 같은 CA/client certificate/private key를 사용하고 TLS 1.3 이상을 요구한다. HTTP redirect와 환경 proxy 자동 사용은 꺼져 있다. 인증서 교체는 데몬 재시작으로 적용한다.
- MQTT 3.1.1 persistent session/QoS 1을 사용하고 응답 subscription SUBACK 이후 전송한다. Paho 메모리 큐는 32개로 제한하며 영속성은 service의 SQLite outbox가 담당한다. MQTT session만으로 프로세스 재시작 후 전송을 보장하지 않는다.
- MQTT topic의 CSE ID는 단일 segment다. 응답 `fr`은 그 설정값과 `/`를 앞에 하나 붙인 값 두 가지만 같은 identity로 허용한다. 다른 CSE ID를 별칭으로 받아들이지 않는다.
- [oneM2M 요청 예시](https://recipes.onem2m.org/introduction/What-are-oneM2M-Requests/)의 기본 형식에 맞춰 MQTT 요청 primitive를 flat JSON으로 보낸다. 배포 환경에서 wrapper 지원이 확인된 경우에만 `MQTT_WRAPPED_PRIMITIVE=true`로 `{"m2m:rqp": primitive}`를 선택한다. 이 선택은 PC-MOBIUS의 capability probe로 고정하며 응답 오류에 따라 형식을 자동 변경하거나 재시도하지 않는다.
- oneM2M CREATE의 rsc=2001과 같은 rqi 응답을 받아야 전송 완료다. 네트워크 실패 시 같은 rqi와 contentInstance 이름으로 HTTPS를 시도한다. rsc=4105 충돌은 같은 이름을 GET한 후 con 내용을 비교해 동일한 경우에만 완료 처리한다. 권한 거절 등 실제 CSE 오류는 HTTPS로 우회하지 않는다.
- broker ACL, topic 경로, 실제 CSE ID 표기, RVI, HTTP 응답 헤더, deterministic contentInstance 이름의 재전송 동작은 PC-MOBIUS와 capability probe로 확정해야 한다. 아직 실제 Mobius와 연동한 결과가 없다.

API 작성 참고: [Bleak GATT client](https://bleak.readthedocs.io/en/latest/api/client.html), [Paho MQTT client](https://eclipse.dev/paho/files/paho.mqtt.python/html/client.html). BLE bond 신뢰 정책과 oneM2M 배포 계약은 이 라이브러리 문서만으로 확정되지 않는다.
