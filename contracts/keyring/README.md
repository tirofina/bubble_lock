# KEYRING 계약 후보 0.1.0

담당: 남호 / KEYRING · 기준 문서: `PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md` · DOC-REV: `2.0.0`

이 디렉터리는 키링 펌웨어와 Raspberry Pi Gateway가 공유하는 JSON Schema 2020-12를 담는다. CORE v1 canonical contract를 인수했으며 KEYRING 확장과 INTEGRATION API는 여전히 중앙 합의가 필요한 **통합 제안**이다. API 주소, MQTT topic, oneM2M RVI와 receipt 수용 규칙은 중앙 담당자와 같은 revision으로 확정해야 한다.

| 파일 | 보내는 쪽 → 받는 쪽 | 내용 |
|---|---|---|
| [command.schema.json](command.schema.json) | PC → Gateway | claim, grant, ownership epoch, deadline을 가진 명령 |
| [authorization.schema.json](authorization.schema.json) | PC → Gateway | 실행 직전 명령·payload hash에 바인딩된 승인 응답 |
| [credential-status.schema.json](credential-status.schema.json) | PC → Gateway | 현재 인증서 revision 및 ACTIVE/LOST/REVOKED |
| [ble-identity.schema.json](ble-identity.schema.json) | 키링 → Gateway | 장치 ID, 펌웨어·보드 revision, boot ID |
| [ble-observation.schema.json](ble-observation.schema.json) | 키링 → Gateway | sequence, uptime, 배터리, 버튼, 센서, 출력 상태 |
| [ble-command.schema.json](ble-command.schema.json) | Gateway → 키링 | 중앙 명령을 제한된 실행 시간으로 변환한 BLE 명령 |
| [ble-receipt.schema.json](ble-receipt.schema.json) | 키링 → Gateway | ACK, uptime, GPIO readback |
| [observation.schema.json](observation.schema.json) | Gateway → CSE | Gateway 시각·실측 RSSI를 결합한 관측 |
| [receipt.schema.json](receipt.schema.json) | Gateway → CSE | 정산 상태, 명령 hash, 시각의 근거, 장치 결과 |
| [health.schema.json](health.schema.json) | Gateway → CSE | 실행 프로세스, credential, queue 및 연결 상태 |
| [ble-journal-manifest.schema.json](ble-journal-manifest.schema.json) | 장치 → Gateway | frozen NVS journal manifest, KEYRING 확장 |
| [ble-journal-record-part.schema.json](ble-journal-record-part.schema.json) | 장치 → Gateway | snapshot에 묶인 READ record 조각 |
| [journal-record.schema.json](journal-record.schema.json) | Gateway 보관 | 조립한 PREPARED/COMPLETED record |
| [journal-archive.schema.json](journal-archive.schema.json) | Gateway 보관 | JSONL byte 수·hash·미정산 상태 manifest |
| [ina219-reading.schema.json](ina219-reading.schema.json) | 장치 → Gateway/native cin | sensorValues.ina219의 signed 정수 단위·null·read uptime,0.6.0 확장 |

각 파일은 외부 `$ref` 없이 사용할 수 있다. top-level 속성은 모두 필수이며, 미확인 값에는 스키마에서 허용하는 `null`을 사용한다. `additionalProperties:false`를 기본으로 두되 센서 값과 장치별 health 확장 필드는 별도로 허용한다. JSON Schema 라이브러리에서 `format` 검사를 기본적으로 생략하는 경우에는 `date-time` 검사기를 함께 설정해야 한다.

## 식별자와 시간

- 식별자는 `[A-Za-z0-9][A-Za-z0-9._:-]*`, 최대 64자다. 중앙은 commandId를 전역 유일하게 발급하고 동일 ID의 내용을 바꾸지 않는다.
- `grantRevision`은 1..2147483647, `ownershipEpoch`는 0..2147483647이다. 단조 증가 관계와 현재 권한 여부는 스키마가 아닌 실행 정책에서 판정한다.
- UTC 시각 필드는 timezone을 포함한 RFC3339 문자열이다. `deadline > issuedAt`, 미래 시각 오차, 승인 만료와 실행 시간 예산은 Gateway에서 추가로 판정한다.
- 펌웨어 uptime은 boot별 밀리초이며 JSON 정수의 안전 범위 0..9007199254740991을 사용한다. uptime은 UTC 시각이 아니다.
- `sequence`는 0..4294967295다. 관측 dedup 키는 `deviceId + bootId + sequence`를 함께 사용해야 한다.

## Hash와 중복 처리

`payloadHash`는 **중앙 command 전체**를 키 이름 오름차순, 공백 없는 JSON, UTF-8로 직렬화한 SHA256의 소문자 64자리다. 원본 command에는 payloadHash 자체를 넣지 않는다. Gateway가 BLE용 `remainingMs`를 줄이더라도 원본 명령 hash는 유지한다. 이 hash는 전자서명이 아니며 신원과 권한은 mTLS·ACL·BLE 보안 및 중앙 승인으로 따로 확인한다.

동일 commandId와 hash의 재수신은 저장된 처리 결과와 연결한다. 같은 commandId에 다른 hash가 오면 충돌로 거절한다. 전송 ACK와 실제 적용 receipt는 구분한다. MQTT PUBACK만으로 장치 실행이나 oneM2M CREATE 성공을 주장하지 않는다.

## 관측과 receipt의 해석

- `observation.observedAt`은 Gateway가 BLE 값을 수신한 시각이다. `timestampSource`는 `gateway-received`이며 장치에서 정확한 UTC를 측정했다는 뜻이 아니다.
- `battery:null`은 배터리 값 미확인, `rssi:null`은 scan RSSI 미확인이다. RSSI로 물리적 거리를 계산하거나 예시 측정값을 채우지 않는다.
- `sensorValues`의 필드 의미는 [펌웨어 문서](../../keyring/firmware/README.md)와 함께 확정한다. 센서 오류를 정상 측정값 0으로 대체하지 않는다.
- Gateway receipt의 `acceptedAt`과 `appliedAt`은 동일 boot의 시간 anchor가 있을 때만 계산한다. 이때 `timestampSource`는 `gateway-estimated`다. 근거가 없으면 두 필드를 `null`, source를 `unavailable`로 설정한다.
- `readback.state`는 GPIO 출력 수준이다. 모터 회전이나 진동 강도를 측정한 결과로 해석하지 않는다.
- `APPLIED`는 명령 처리 상태다. 모터 자동 OFF 같은 이후 상태 변화는 새로운 관측에서 확인한다. 과거 APPLIED receipt를 현재 출력 상태로 사용하지 않는다.
- Gateway `ackCode`는 대문자 코드 문자열이며 firmware ACK 외에도 권한·시간·저장소·연결 오류를 표현한다. `INDETERMINATE`와 `TIMEOUT`은 성공으로 집계하지 않는다.

## 전송 및 중앙 인수 조건

BLE UUID, fragmentation, REST 경로, oneM2M envelope와 모듈 인터페이스는 [구현 계약](../../keyring/INTERFACE_NOTES.md)에 정의했다. PC는 AE·container·ACP 및 broker ACL을 생성하고, receipt 수신 전까지 명령을 pending 상태로 유지해야 한다. 중앙 credential 발급·회전과 claim/dispatch 동기화는 PC-MOBIUS 담당과 연결해야 한다.

스키마 파일 작성과 실제 payload 호환성 검증은 별개다. 이번 작업에서는 검증·빌드·실행, fixture 및 실측 receipt 생성을 하지 않았다.
