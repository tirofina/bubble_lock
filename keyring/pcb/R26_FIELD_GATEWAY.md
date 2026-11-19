# 남호 r26 현장 수신기 등록 요청

등록할 장치는 현장의 Raspberry Pi Zero 2 W와 여분 r26 PCB다. 아래 값은 신규 등록 요청이며 서버 적용 전이다.

| 항목 | 값 |
|---|---|
| 신규 Gateway ID · MQTT 클라이언트 인증서 CN · oneM2M originator | `gateway-namho` |
| 실물 키링 deviceId | `keyring-d03e26858428` |
| 키링 BLE 주소 | `28:84:85:26:3E:D1` |
| 가구 | 보호자 포털에서 선택한 실제 householdId로 연결 |

배포 기준은 [final-integration 4f3899b](https://github.com/tirofina/bubble_lock/tree/4f3899b355aaf7a5c10ffc2196fba296ee9825ac/deployment)이다. `provision.mjs`는 `api.gateways` 전체를 단일 항목으로 대입한다. 두 번째 Pi를 추가할 때는 기존 항목을 보존하고 독립된 인증서 지문, Gateway 등록 행과 기기·가구 연결을 추가해야 한다. 프록시에도 새 지문과 해당 ID의 API·컨테이너 경로를 한 쌍으로 등록한다. 브로커 ACL, MQTT 브리지의 인증 주체 및 CSE 자원 접근 정책에도 이 ID를 반영한다.

Pi가 접속되면 기존 서비스의 전송을 중지하고 이전 자격으로 작성된 SQLite 대기열을 보존한다. 신규 인증서 발급과 서버 반영 후 새 상태 DB로 서비스를 시작한다. 보호자 포털에 같은 Gateway ID와 실물 deviceId를 등록하고, 새로 발생한 BLE 관측 한 건이 이 두 ID로 중앙 API에서 수락되는지 확인한다.
