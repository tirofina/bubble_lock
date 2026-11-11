# Gateway 로컬 시험

Gateway 0.2.74의 격리 r18 위치 시험은 Mobius4 관측과 포털 응답을 병행 수집한다. 포털 조회 전후 중앙 관측 ID가 같은 경우에만 후보로 보관하고, 같은 시각·RSSI를 가진 다른 순번과 엇갈린 응답을 다루는 회귀시험 소스를 추가했다. 빌드·시험·서버 실행은 미실행이다.

Gateway 0.2.73의 격리 r18 위치 시험은 기존 팀 API의 단기 위치 승인으로 실제 조회 응답을 저장하고 종료 때 회수 여부를 대조한다. 회귀시험 소스는 수신자·기기 범위, 시험 경로, 회수 전후 조회를 다룬다. 빌드·시험·서버 실행은 미실행이다.

Gateway 0.2.72의 r18 관측 도구는 RSSI가 있는 샘플과 중앙 위치 API·LIVE 웹 응답을 대조한다. 권한 거절, 만료, 다른 RSSI와 출처 혼합을 다루는 회귀시험 소스를 추가했다. 빌드·시험·실제 위치 조회는 미실행이다.

Gateway 0.2.71의 r18 관측 대조 도구는 같은 USB 부팅의 Mobius4 관측·health, Pi SQLite 순번과 중앙 수용 이벤트를 연결한다. 중앙 수용 지연, 본문 해시 불일치와 다른 부팅·컨테이너를 다루는 회귀시험 소스를 추가했다. 빌드·시험·실제 관측 전달은 미실행이다.

Gateway 0.2.70은 r18 첫 구동의 Pi 관측 전용 세션을 제공한다. 기존 명령 영수증 보존, 관측 전송, 명령 목록을 조회하지 않는 사전 확인의 회귀시험 소스를 추가했다. 빌드·시험·Pi 실행은 미실행이다.

Gateway 0.2.69는 r18 첫 구동 중 같은 USB 부팅의 INA219 샘플 번호를 표시하고 외부 계측값을 오프라인에서 연결한다. 다른 캡처·다른 BLE 세션의 샘플과 측정 지점 혼용을 다루는 회귀시험 소스를 추가했다. 빌드·시험·Pi 실행은 미실행이다.

Gateway 0.2.68은 r18 화면 점검 펌웨어 두 종류의 USB 로그에서 패널 선택값과 revision을 대조한다. 같은 부팅의 Pi 기록에 `displayProfile`을 남긴다. 빌드·회귀시험·실물 화면 확인은 미실행이다. [r18 화면 점검](../pcb/BRING_UP.md#화면만-연결한-두-번째-구동)

Gateway 0.2.67은 펄스 시험에서 저장한 Mobius4 영수증을 장치 저널·Pi 보관본과 오프라인으로 대조한다. 사본의 부모나 자원 이름이 바뀐 경우, 본문이 Pi와 다른 경우의 회귀시험 소스를 추가했다. 빌드·시험·Pi 실행은 미실행이다.

Gateway 0.2.66의 r18 벤치는 펄스 뒤의 Mobius4 OFF 관측을 중앙 API의 수용 이벤트와 대조한다. 회귀시험 소스는 중앙 수용 지연, 본문 해시 불일치, grant 회수 뒤 대조를 다룬다. 빌드·시험·Pi 실행은 미실행이다.

Gateway 0.2.65의 r18 벤치는 관측·health·영수증의 컨테이너 ID를 고정한다. 교체된 health·영수증 경로에서 발급을 중단하고, 다른 부모에서 읽은 영수증과 Pi SQLite를 거절하는 회귀시험 소스를 추가했다. 빌드·시험·Pi 실행은 미실행이다.

Gateway 0.2.64는 r18 명령 발급 응답이 끊겼을 때 저장된 명령 ID로 [시험 증거를 대조](#중단된-r18-펄스-시험-대조)한다. 회귀시험은 응답 유실, 중앙 상태 사본에 없는 발급, 변조된 요청, CSE와 중앙 영수증 불일치를 다룬다.

Gateway 로컬 시험 190개, 격리 벤치 모의 시험 25개와 wheel 빌드가 통과했다. 합성 입력으로 r18 CLI의 발급 복구와 요청 해시 불일치 거부를 확인했다. Pi·BLE·실물 시험은 이번 변경에서 미실행이다.

Gateway 0.2.63의 회귀시험 소스는 Pi 세션의 환경 파일 내보내기, 기존 파일 보존, r18 저널 캡처의 시험 잠금과 장치 설정 전달을 다룬다. 빌드·시험·Pi 실행은 미실행이다.

r18 단일 펄스 벤치의 회귀시험 소스는 준비 신호 이후 한 건 발급, 같은 부팅의 후속 OFF 관측, 응답 유실 뒤 grant 회수와 중단 신호를 다룬다. 빌드·시험·실제 명령 발급은 미실행이다.

Gateway 0.2.62의 회귀시험 소스는 r18 Pi의 `gw-b` 인증서·전용 컨테이너·중앙 API 프로필 선택과 BLE 보드 revision 불일치 차단을 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.61은 r18 단일 명령을 최신 격리 중앙 API의 상태 사본과 대조하는 `--team-state`를 추가했다. 회귀시험 소스는 같은 영수증의 실행 시작·정산 확인과 잘못된 claim을 다룬다. [최신 중앙 API 상태 대조](../JOURNAL_RETENTION.md#최신-중앙-api-상태-대조). 빌드·시험·실물 연동은 미실행이다.

Gateway 0.2.60의 회귀시험 소스는 [r18 단일 명령 대조](../JOURNAL_RETENTION.md#r18-실물-명령-한-건-대조)에서 같은 부팅의 기록 선택, 이전 부팅·장치 revision·영수증 펌웨어 불일치를 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.59의 r18 회귀시험 소스는 초기 USB 센서 상태 보존, 이후 BLE 복구, 정상 관측 뒤 센서·INA219 상태 악화, 마지막 필드 누락을 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.58의 r18 회귀시험 소스는 USB 로그에서 동일한 부팅 기록의 반복 출력, 다른 부팅 ID, 변경된 GPIO 상태와 잘린 기록을 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.57의 회귀시험 소스는 SQLite를 닫고 다시 열었을 때 서버별 `Retry-After`의 남은 시간, 다른 포트의 전송, 기한 만료와 새 Linux 부팅을 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.56의 회귀시험 소스는 중앙 API `Retry-After` 동안 전송 시도 횟수 보존, 중앙 관측 만료, Mobius4 전송 지속과 중앙 보류 해제 후 재개를 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.55의 회귀시험 소스는 관측 컨테이너 이름이 재사용될 때 CREATE 차단, 고정 ID의 MQTT→HTTPS 전환과 저장본 대조, 로컬 DB·사전 검사 및 HTTPS 보류를 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.54의 회귀시험 소스는 중앙 배포 ID가 다른 SQLite로 시작하는 경우, 같은 배포에서 API 주소만 바뀌는 경우, 격리 보관본의 배포 ID 보존과 사전 검사에서의 네트워크 호출 차단을 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.53의 회귀시험 소스는 일반 상태 보고가 재시도 중인 상태에서 Pi 데몬을 재시작하는 경우, 기존 본문·재시도 시각 보존, 공용 컨테이너의 관측과 자격 전환 영수증을 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.52의 회귀시험 소스는 SQLite에 두 자리만 남은 경우의 Mobius4·CORE 등록, 한 자리만 남은 경우의 중앙 등록, 재시작 뒤 기존 전달을 중복 등록하지 않는 경로를 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.51의 회귀시험 소스는 중앙 명령 영수증 응답을 보류한 상태에서 Mobius4 영수증의 전달 완료와 중앙 대기열 보존을 다룬다. CSE 보류·재시작 후 중앙 영수증 재시도도 전용 작업을 사용한다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.50의 회귀시험 소스는 재시도 대기 중인 중앙 관측의 만료, 팀 서버와 같은 단축 보관 기간, UTC 오프셋·기한 경계, Mobius4 복제본 유지와 시계를 신뢰할 수 없을 때의 보존을 다룬다. 빌드·시험·실제 Pi 연동은 미실행이다.

Gateway 0.2.49의 회귀시험 소스는 중앙 관측 응답을 보류하는 동안 Mobius4 관측과 명령 영수증을 전송하고, 중앙 확인이 올 때까지 해당 SQLite 행을 유지하는 경로를 다룬다. 장치별 중앙 관측 순서와 재시작 회귀도 같은 전용 조회 경로를 사용한다. 빌드·시험·Pi 연동은 미실행이다.

Gateway 0.2.47의 회귀시험 소스는 중앙 관측과 Mobius4 항목의 동시 저장, 재시작과 장치별 전송 순서, 중앙 응답 ID, `STALE`과 보관 기한 초과 처리를 다룬다. 빌드·시험·실제 중앙 API 연결은 미실행이다.

Gateway 0.2.46의 회귀시험 소스는 중앙 영수증의 대기열 등록·용량 부족, 기존 DB에서 과거 영수증 등록, 재시작 후 동일 전송, CSE 보류 중 중앙 정산, 중앙 응답 바인딩을 다룬다. 빌드·시험·실제 중앙 API 연결은 미실행이다.

Gateway 0.2.45의 회귀시험 소스는 `dispatch-start` 요청의 claim 바인딩, SQLite 실행 의도 기록 순서, 더 짧아진 기한, 세션 교체, 요청 취소와 미지원 API 차단을 다룬다. 빌드·시험·중앙 API 연결·Pi 확인은 미실행이다.

Gateway 0.2.44의 회귀시험 소스는 전송 시도 기록 후 취소와 DB 재개, 기존 영수증 확인 시 CREATE 생략, CSE가 자원 부재를 확인한 뒤 동일 요청 ID로 CREATE, 본문·부모 불일치와 조회 거절을 다룬다. 이번 빌드·시험·Pi 및 CSE 확인은 미실행이다.

Gateway 0.2.43은 Windows Python 3.11에서 wheel을 빌드하고 해당 설치본으로 기본 suite 153개를 통과했다. 모의 GATT가 마지막 쓰기 응답을 보류하는 동안 별도 SQLite 연결에서 커밋된 영수증을 읽었다. 이후 작업 취소로 결과가 덮이지 않는 경우와 일시적인 SQLite 저장 오류를 재시도하는 경우도 확인했다. Pi·BlueZ에서 이 버전을 실행하는 시험은 남아 있다.

Gateway 0.2.42의 회귀시험 소스는 일치 영수증 이후 연결 종료·GATT 응답 오류·내부 타임아웃, 이른 영수증과 기한 이후 영수증의 차단, 외부 취소 전파, SQLite 최종 상태를 다룬다. 이번 빌드·시험·Pi 확인은 미실행이다.

Gateway 0.2.41의 회귀시험 소스는 영수증 알림 뒤 늦게 반환한 쓰기 응답과 새 관측, 수신 이후·전송 이전으로 추정된 시각, UTC 이동, 과거 중복 결과, SQLite에 보관한 실제 알림 수신 시각을 다룬다. 이번 빌드·시험·Pi 확인은 미실행이다.

Gateway 0.2.40의 회귀시험 소스는 재연결의 이전 READ·알림, 같은 부팅의 uptime 역행, 새 부팅의 번호 초기화, 큐 포화, SQLite 커서 복구와 영수증 시각 추정을 다룬다. 이번 빌드·시험·실물 확인은 미실행이다.

Gateway 0.2.37의 회귀시험 소스는 BlueZ가 쓰기 특성을 캐시한 상황에서 r18 관측 전용 revision의 관측은 받고 명령·저널 쓰기는 거절하는지 다룬다. [PCB 초기 구동](../pcb/BRING_UP.md)의 실물 실행은 미수행이다.

## r18 초기 구동 기록

Gateway의 `--mode bringup`은 페어링된 r18과 `-bringup` 펌웨어에서 인증된 BLE 알림을 수집한다. 기존 Gateway를 중지하고 그 서비스와 같은 `--database` 경로를 지정한다. 기록 도구는 그 경로에서 잠금 이름만 얻는다. Mobius나 중앙 API에 연결하지 않고 새 로컬 JSON을 기록한다. 0.7.15-bringup의 USB 모니터에서 `?`를 보내 초기 구동 기록을 요청하고 UTF-8 로그로 저장한다. `--usb-boot-log`는 이 로그와 BLE 부팅을 대조한다. 한 로그에 같은 줄이 반복되면 허용하고 다른 부팅 ID나 다른 값이 섞이면 거절한다. 아래 명령을 실행할 때까지 같은 보드 전원을 유지한다.

```sh
bubble-keyring-ble-characterize --mode bringup --hardware r18-pcb \
  --gateway-id "$GATEWAY_ID" --device-id "$KEYRING_ID" --address "$KEYRING_ADDRESS" \
  --firmware-revision keyring-0.7.15-bringup --distance-cm "$MEASURED_DISTANCE_CM" --seconds 90 \
  --usb-boot-log "$PRIVATE_EVIDENCE/r18-usb.log" \
  --database "$GATEWAY_DATABASE" --output "$PRIVATE_EVIDENCE/r18-bringup.json"
```

첫 알림 안내까지 두 버튼을 뗀 채 기다린다. 이후 확인 버튼을 약 2초 누르고 떼고, 약 2초 뒤 비상 버튼을 같은 방식으로 한 번 누르고 뗀다. 최초 알림부터 같은 BLE 세션에서 각 눌림과 떼기, 해당 누계 증가, 배터리·3축·움직임 설정, INA219 정상 샘플, 장치 저널·절전 비활성, `commandReady:false`와 출력·fault 상태를 대조한다. 재연결 뒤 받은 관측으로 빠진 단계를 채우지 않는다. 수집된 출력 또는 fault가 활성화됐거나 명령이 준비됐으면 `MISMATCH`를 기록한다. 필요한 관측이 빠지면 `INSUFFICIENT`다.

`RECORDED`는 위 항목을 한 세션에서 수신했고 마지막 BLE 센서·INA219 상태가 정상이라는 뜻이다. Gateway 0.2.59는 첫 정상 순번과 마지막 센서·INA219 상태를 기록한다. 정상 관측 후 마지막에 센서가 `unavailable`이거나 INA219 오류가 오면 `MISMATCH`다. 마지막 프레임에 필요한 값이 없으면 `INSUFFICIENT`다. USB 로그를 공급하면 `bringup.usbBoot`에 파일 SHA-256, GPIO, 초기 센서 상태와 부팅 일치 여부가 추가된다. USB와 BLE의 부팅이 다르거나 수집 중 새 부팅의 알림이 들어오거나 USB 출력·fault가 활성 상태이면 `MISMATCH`다. INA219는 3.3V 부하 측 계측이며 입력·충전 전류는 별도 실측으로 남긴다. JSON은 BLE 주소와 원래 부팅 ID를 내보내지 않는다. 빌드·회귀시험·실물 캡처는 미실행이다.

Gateway 0.2.36의 자격 전환 영수증 회귀시험 소스는 MQTT·HTTPS 생성 후 조회, 중복, 인스턴스·부모·본문 불일치, 조회 시간 초과, HTTPS 보류 중 일반 heartbeat의 독립 전송을 다룬다. 격리 Mobius4 시험 소스는 두 전송 경로에서 실제 저장 조회가 발생하는지 확인한다. 이번 빌드·시험·Pi 배포·CSE 연결은 미실행이다.

Gateway 0.2.35의 회귀시험 소스는 자격 전환을 기록한 뒤 일반 큐 포화와 DB 재개를 거쳐도 순서·요청 ID·본문이 유지되는지 다룬다. 기존 DB에 새 테이블 추가, 보관본 포함, 완료 이력 상한, 기록 실패 시 실행 차단, LED 벤치의 이력 제외도 포함한다. 이번 빌드·시험·Pi/CSE 전송은 미실행이다.

Gateway 0.2.34의 `test_dispatch.py` 회귀시험 소스는 중앙 승인 응답 대기 및 BLE 조각 전송 중의 동일 credential revision 복구, TTL 단절, 단절 없는 갱신, 느린 조회 응답의 freshness를 다룬다. 이번 버전의 시험과 실물 실행은 미수행이다.

Gateway 0.2.27의 고정 컨테이너 회귀시험 소스는 HTTPS fallback 후 저장 확인, 다른 자원 ID와 본문 불일치, MQTT CREATE 성공 후 조회 timeout, 최초 생성·중복 요청에 대한 격리 CSE의 GET 횟수를 다룬다. 이 버전의 빌드와 시험은 미실행이다.

Gateway 0.2.26에는 HTTPS `Retry-After` 회귀시험 소스를 추가했다. 모의 CSE 503 응답 이후 같은 origin의 추가 조회가 보류되고 별도 origin의 중앙 API 요청은 유지되는지, 원래 `rqi`로 재전송하는지, SQLite 재시작 뒤에도 개별 전송의 대기 시각이 남는지를 다룬다. 이 버전의 시험과 빌드는 미실행이다.

Gateway 0.2.11의 CORE 재시도 순서는 기본 75개, 격리 Mobius4 11개, 별도 팀 CORE → SDT 통합 1개에서 검증했다. [실행 기록](../evidence/2026-11-10-core-retry-order/README.md)

`cse_integration_tests/core_retry_order.py`를 별도로 실행하면 팀 CORE → SDT 재시도 순서와 중앙 동시 갱신 후보를 함께 시험한다. `KEYRING_TEST_CENTRAL_TREE`는 팀 main `715ef58`의 `pc-mobius`가 들어 있는 디렉터리로 지정한다. 브리지 메시지 핸들러에 직접 전달한 뒤 격리 Mobius4에서 실제 SDT 상태를 읽는다. [동시 갱신·handover 기록](../evidence/2026-11-10-core-concurrent-order/README.md)

Gateway 0.2.10의 부팅별 버튼 누계는 기본 74개, 실제 격리 Mobius4 통합 11개를 통과했다. [버튼 관측 시험](../evidence/2026-11-10-button-presses/README.md)

Gateway 0.2.9의 읽기 전용 journal 대조는 최종 wheel에서 기본 73개와 격리 Mobius4 통합 시험을 통과했다. [시험과 재현 명령](../evidence/2026-11-10-journal-reconcile/README.md)

Gateway 0.2.8은 기본 73개와 중앙 명령 통합 5개 시험이 통과했다. 현재 부팅과 다른 `APPLIED`를 미확정으로 처리하고 과거 `DUPLICATE` readback은 보존한다. [부팅 ID 시험](../evidence/2026-11-10-receipt-boot/README.md)

Gateway 0.2.7은 기본 71개, 중앙 명령 통합 4개, 별도 MQTT 6개 시험이 통과했다. 중앙 명령 통합은 실제 Mosquitto의 명령·ACK 전송과 Mobius4 영수증 대조를 포함한다. [수신 시험](../evidence/2026-11-10-command-ingress/README.md) · [브로커 시험](../evidence/2026-11-10-mqtt-command-wire/README.md)

Gateway 0.2.6은 로컬 기본 시험 67개와 실제 Ubuntu systemd의 시작 전 검사 3개가 통과했다. systemd 시험은 배포 unit의 격리 설정을 복사한 임시 unit에서 wheel의 `--check-config`를 실행하고, 성공한 경우에만 본 실행 표시를 남긴다. [실행 범위와 재현 절차](../evidence/2026-11-10-deployment-preflight/README.md)

Gateway 0.2.5 소스에서 기본 63개와 [중앙 명령 통합 2개](../evidence/2026-11-10-central-dispatch/README.md)가 통과했다. 후자는 팀 Node mTLS API, Gateway 전체 worker, 모의 GATT, 실제 격리 Mobius4를 실행한다.

## 중앙 명령 통합 시험

위 증거에 기록된 팀 main SHA에서 `pc-mobius` 전체와 `tests/integration/gateway-server.mjs`를 새 임시 경로에 추출한다. `KEYRING_TEST_CENTRAL_TREE`는 두 경로를 포함한 추출 루트다. 아래 명령은 앞선 [실제 CSE 시험](#별도-실제-cse10개)과 같은 Python 경로, OpenSSL, 캐시된 Docker 이미지를 사용한다. Node도 필요하다.

```powershell
$env:KEYRING_TEST_CENTRAL_TREE = '<팀 main을 추출한 절대 경로>'
$env:PYTHONPATH = ('src','tests','integration_tests' | ForEach-Object {
    Join-Path $PWD ('keyring/raspberry-pi-gateway/' + $_)
}) -join [IO.Path]::PathSeparator
python keyring/raspberry-pi-gateway/cse_integration_tests/central_dispatch.py -v
```

실행마다 새 시험 PKI·중앙 등록·Gateway SQLite와 격리 CSE 자원을 쓴다. 정상 명령의 중복 poll, 연결 전 grant 회수, receipt의 CSE readback, 정상 종료를 검증한다. 하드웨어는 모의 GATT 경계다.

MQTT 단독 수신 시험은 목록 조회에만 503 오류를 주입한다. 대기열에 직접 넣는 사례와 실제 Mosquitto의 QoS 1 토픽으로 보내는 사례가 있다. 두 사례에서 팀 Node API의 mTLS 승인을 실제로 요청한다. 브로커 사례는 인증서별 명령 발행 권한, 승인 전후 처리, 모의 GATT 프레임, CORE ACK와 CSE 영수증 일치를 확인한다.

정상 명령 사례는 CSE에서 읽은 영수증과 실행 직전 중앙 승인 응답을 Node의 ACK 결속 검사에도 전달한다. 이 재현은 팀 main `715ef58`의 CORE 동작을 기준으로 한다. [재현 결과](../evidence/2026-11-10-core-ack-binding/README.md)

## 실물 BLE 거리·재연결 기록

Gateway 0.2.16의 `bubble-keyring-ble-characterize`는 Pi의 BlueZ와 기존 Gateway GATT 수신기를 사용하는 현장 기록 도구다. 등록된 장치와 펌웨어를 지정하고 `feather-bench` 또는 `r18-pcb`를 선택한다. 각 선택은 펌웨어 identity의 보드 revision과 대조된다. Gateway와 같은 DB 경로의 프로세스 lock을 사용하므로, 시험 전에 해당 Gateway 서비스와 별도 BLE 관측기를 중지한다. 주소와 DB 경로는 실제 로컬 설정을 사용한다.

```sh
bubble-keyring-ble-characterize --mode range --hardware feather-bench \
  --gateway-id gw-feather-bench --device-id keyring-feather-lab --address "$FEATHER_ADDRESS" \
  --firmware-revision feather-probe-0.1.1 --distance-cm 100 --seconds 90 \
  --database "$GATEWAY_DATABASE" --output "$PRIVATE_EVIDENCE/feather-range-100cm.json"
```

거리는 실제 측정값을 입력한다. 거리별로 Pi·장치 위치, 장애물, 방향, 펌웨어와 시간 조건을 맞춘 뒤 새 파일로 기록한다. `--mode reconnect`에서는 첫 알림 표시를 확인한 후 연결을 끊고 복구한다. 도구가 BLE 연결 종료를 감지한 시점에서 새 세션의 첫 알림까지 걸린 시간을 기록한다. 복구 시간에는 실험자가 링크를 복구하는 데 걸린 시간도 포함된다.

JSON에는 최초 READ와 구독 준비 전 데이터가 제외된 알림 수, 세션별 sequence 간격, 새 세션까지의 경과 시간, 같은 부팅인지 여부가 남는다. RSSI는 접속 준비 시점에 남아 있던 광고 RSSI와 그 나이를 기록하고 측정값이 없으면 `null`이다. sequence 간격은 펌웨어 내부 생략과 무선 전달 손실을 따로 식별하지 못한다. 기본 출력에는 BLE 주소, 원래 boot ID, 센서 payload나 비밀값을 담지 않는다. `RECORDED`는 요청한 측정 종류의 관측이 남았음을 나타낸다. CSE 수신이나 생산 합격 판정은 별도 증거로 기록한다.

제작 PCB의 sleep·wake·배터리 입력 전력은 외부 계측과 [전력 측정 지점 설명](../firmware/POWER_MONITOR.md)을 함께 사용한다. 이 도구는 소스와 회귀시험 코드만 준비했다.

### r18 재연결 전후 버튼 누계 기록

Gateway 0.2.39의 `--verify-button-continuity`는 첫 알림이 있던 연결의 마지막 알림과, 연결을 잃은 뒤 처음 알림이 온 세션의 첫 알림을 대조한다. 중간에 연결만 됐다가 알림 없이 끝난 세션도 `sessions`에 남는다. 복구 시간의 끝은 실제로 첫 알림을 받은 시점이다.

```sh
bubble-keyring-ble-characterize --mode reconnect --hardware r18-pcb --verify-button-continuity \
  --gateway-id "$GATEWAY_ID" --device-id "$KEYRING_ID" --address "$KEYRING_ADDRESS" \
  --firmware-revision keyring-0.7.15-bringup --distance-cm "$MEASURED_DISTANCE_CM" --seconds 90 \
  --database "$GATEWAY_DATABASE" --output "$PRIVATE_EVIDENCE/r18-reconnect.json"
```

첫 알림 뒤 확인·비상 버튼을 각각 누르고 뗀다. 두 누계가 모두 기록됐다는 안내를 확인한 뒤 키링 전원을 유지한 채 BLE 링크를 끊었다가 복구한다. 이미 두 누계가 0보다 크고 버튼을 뗀 상태면 안내가 바로 나온다.

같은 부팅에서 sequence가 증가하고 uptime과 두 버튼 누계가 줄지 않아야 `RECORDED`다. 중간 세션을 포함해 다른 부팅을 확인하거나 수용된 알림 사이에서 sequence·uptime·누계가 역행하면 `MISMATCH`다. 경계 알림, 이전의 유효한 누계 또는 복구 누계가 빠지면 `INSUFFICIENT`다. 0.2.40부터 이 판정에는 Gateway가 [수신 단계에서 수용한 알림](BLE_SESSIONS.md#재연결과-관측-시각-기준)을 사용한다. 결과는 `buttonContinuity`에 두 알림의 위치와 누계 차이를 남긴다. 수신하지 못한 구간 안에서 버튼이 눌린 정확한 시각은 별도 기록으로 확인한다. 빌드·회귀시험·실물 재연결 기록은 미실행이다.

### r18 wake 기록

Gateway 0.2.17의 `--mode wake`는 r18 전용이다. 로컬 provisioning에서 sleep을 켠 keyring-0.7.4를 대상으로 한다. 먼저 연결해서 알림을 받은 뒤 BLE를 닫고 `--idle-seconds` 동안 기다린다. 다른 BLE 클라이언트가 붙어 있거나 움직임이 감지되면 실제 절전 진입이 늦어질 수 있다. 도구의 wake 안내가 나오면 해당 자극을 가한다. 버튼·움직임 시험은 장치가 실제로 절전한 뒤 타이머로 먼저 깨기 전에 진행한다. 타이머 시험은 안내 후 장치를 움직이지 않는다.

```sh
bubble-keyring-ble-characterize --mode wake --hardware r18-pcb \
  --gateway-id "$GATEWAY_ID" --device-id "$KEYRING_ID" --address "$KEYRING_ADDRESS" \
  --firmware-revision keyring-0.7.4 --distance-cm "$MEASURED_DISTANCE_CM" \
  --idle-seconds "$IDLE_SECONDS" --expect-wake confirm --seconds 90 \
  --database "$GATEWAY_DATABASE" --output "$PRIVATE_EVIDENCE/r18-wake-confirm.json"
```

`--expect-wake`는 `confirm`, `panic`, `motion`, `timer`를 선택한다. 최초 복구 알림의 부팅이 이전과 달라야 하고, 같은 부팅의 health 알림에 기대 원인과 핀 마스크가 있어야 한다. 확인 GPIO6은 64, 비상 GPIO7은 128이며 두 핀이 함께 보고되면 개별 버튼 항목에 맞지 않는다. 나중에 다른 부팅에서 받은 원인은 첫 복구 기록에 합치지 않는다. 초기 연결과 복구 수신에 각각 최대 `--seconds`를 사용한다. BLE 해제 후 첫 알림까지의 값에는 의도한 유휴 대기 시간이 포함된다. 실제 절전 진입 시각·소비전류는 외부 계측으로 기록한다.

### r18 BLE 시험의 전원 샘플

Gateway 0.2.25에서 `--hardware r18-pcb --include-power`를 거리·재연결·wake 시험에 사용할 수 있다. JSON의 이벤트에는 검증 형식을 통과한 INA219의 상태와 계측값, 알림 시점의 장치 uptime이 남는다. 이벤트의 세션 번호로 `sessions`의 부팅 번호를 확인한다. `readUptimeMs`는 펌웨어가 계측값을 읽은 시각이다. 같은 부팅과 `readUptimeMs`가 재연결 이후 다시 보고되면 `newPowerSample`이 `false`로 남는다. `power`는 고유 샘플, 반복, `stale` 등 비정상 상태, INA219 객체가 생략된 energy 프레임을 나누어 센다.

wake 모드에서는 BLE를 해제하기 전에 유효 계측값을 최대 `--seconds` 동안 기다린다. wake 판정과 함께 기록을 인정하려면 baseline과 복구 양쪽의 첫 알림 부팅에서 유효 계측값이 있어야 한다. 이후 별도 재부팅에서 온 샘플도 로그에는 남지만 누락된 부팅을 대신하지 못한다. 거리·재연결 시험은 전체 기록에 유효 샘플이 하나 이상 있어야 한다. 부족한 구간은 `power.missingPhases`와 `INSUFFICIENT`로 표시된다.

이 계측은 BLE가 연결된 동안 보드의 3.3V 부하 측을 관측한다. BLE를 해제한 동안의 sleep 소비전류, 배터리 입력 및 충전 전류는 외부 계측으로 기록한다. [전력 측정 지점 설명](../firmware/POWER_MONITOR.md)

### r18 첫 구동의 외부 계측값 연결

[r18 초기 구동 기록](#r18-초기-구동-기록)에 `--print-power-markers`를 추가한다. USB 로그와 일치하는 첫 BLE 세션에서 유효한 INA219 샘플이 새로 기록되면 `R18_POWER_SAMPLE` 줄에 `sequence`와 `readUptimeMs`가 표시된다. 같은 안정 구간에서 읽은 계측기 값에 두 값을 붙이고, 캡처가 끝나면 최종 출력의 SHA-256을 아래 입력에 적는다.

```json
{
  "version": 1,
  "captureSha256": "<Pi 캡처의 SHA-256>",
  "readings": [
    {"sequence": 8, "readUptimeMs": 700, "point": "load-3v3", "voltageMv": 3290, "currentUa": null}
  ]
}
```

위 숫자는 입력 형식 예시다. 측정한 전압은 mV, 전류는 µA 정수로 기록하고 읽지 않은 값은 `null`을 쓴다. `load-3v3`은 INA219와 같은 3.3V 부하 측 지점이며 `usb-input`과 `battery-terminal`은 해당 입력 지점이다. 원본 계측 기록은 같은 시험 폴더에 보관한다.

```sh
bubble-keyring-power-evidence --capture "$PRIVATE_EVIDENCE/r18-bringup.json" \
  --meter "$PRIVATE_EVIDENCE/r18-meter.json" --output "$PRIVATE_EVIDENCE/r18-power-paired.json"
```

도구는 USB 부팅 일치, Pi 캡처 해시, 첫 세션의 순번과 계측 uptime을 대조한다. `meterMinusIna219`는 `load-3v3`의 계측기 값에서 INA219 값을 뺀 값이다. USB 입력과 배터리 단자 측정값은 해당 지점으로 기록한다. 연결 시각은 운영자가 대응시킨 샘플 번호를 근거로 하며, 동시 계측과 허용 오차는 실물 시험에서 확인한다.

### r18 배터리 경보 기록

Gateway 0.2.33의 `--mode battery`는 Pi에서 인증된 r18 GATT 알림만 기록한다. r18 경보가 있는 펌웨어와 보드에 맞는 기존 등록 정보를 사용한다. 입력 조건은 실제 팩을 사용했으면 `physical-pack`, 계측 IC 응답을 시험 장치에서 재현했으면 `gauge-fixture`로 표시한다. 시험 전 시작 잔량을 해제 임계값 근처에서 준비하고 보드의 정격 동작 범위 안에서 낮췄다가 올린다.

```sh
bubble-keyring-ble-characterize --mode battery --hardware r18-pcb \
  --gateway-id "$GATEWAY_ID" --device-id "$KEYRING_ID" --address "$KEYRING_ADDRESS" \
  --firmware-revision keyring-0.7.12 --distance-cm "$MEASURED_DISTANCE_CM" \
  --battery-source physical-pack --battery-thresholds 20 25 --seconds 3600 \
  --database "$GATEWAY_DATABASE" --output "$PRIVATE_EVIDENCE/r18-battery-alert.json"
```

기본 임계값은 20%와 25%다. 로컬 펌웨어에서 임계값을 바꿨으면 같은 값으로 실행한다. 기본값 기준으로 다음 다섯 상태가 **한 BLE 연결**에서 순서대로 수신돼야 `RECORDED`가 된다.

1. 25% 이상에서 경보 꺼짐
2. 방전 중 20% 초과·25% 미만에서 꺼짐 유지
3. 20% 이하에서 경보 켜짐
4. 충전 중 20% 초과·25% 미만에서 켜짐 유지
5. 25% 이상에서 경보 해제

단계마다 Pi에 알림이 도착할 시간을 둔다. 각 단계의 sequence, Pi 기준 경과 시간, 잔량 및 경보 상태는 `battery.matchedCycle`에 남는다. 잔량을 읽지 못한 프레임은 `unknownFrames`에 따로 세고 단계를 진행시키지 않는다. 임계 범위 밖에서 반대 경보 상태가 하나라도 들어오면 `MISMATCH`다. 필요한 단계나 경보 필드가 빠지면 `INSUFFICIENT`다. 기록 상한을 넘으면 `TRUNCATED`다. 최대 측정 시간은 7,200초다.

LCD의 `LOW` 표시와 해제, 실제 충전 표시는 측정 단계의 시각과 함께 별도로 기록한다. Mobius 수신은 Gateway를 가동한 별도 실행에서 Gateway가 저장한 관측과 CSE 원본의 sequence를 대조한다. 현재 도구의 기록 범위는 Pi의 BLE 수신이며, 소스의 시험과 실물 실행은 미수행이다.

## Feather LED ON/OFF 시험

2026-11-11에 Feather 0.2.0과 실제 Pi의 ON/OFF 두 건을 같은 부팅에서 실행했다. GPIO readback·Pi SQLite·Mobius4 원본·인증 콜백·격리 PostgreSQL 정산을 대조했다. 실제 LED 육안 확인은 증거에서 별도로 관리한다. [실행 결과와 해시](../evidence/2026-11-11-scoped-feather-led/receipt.json)

같은 날 Pi Gateway 0.2.43으로 다시 시험했다. ON과 OFF 모두 `APPLIED`였고 GPIO readback, 후속 관측, Mobius4 원본과 중앙 정산이 일치했다. 운영자는 보드에서 빨간 LED를 식별하지 못했고 두 명령에서 눈에 보이는 변화를 관찰하지 못했다. [재시험 결과와 해시](../evidence/2026-11-11-feather-visual/receipt.json)

Feather 명령 펌웨어 0.2.0과 [Pi 벤치 연결 절차](../evidence/2026-11-10-pi-full-daemon/README.md#재현-절차)를 사용한다. PC의 시험 fixture는 새 CA·Mobius4 컨테이너·팀 중앙 API를 열고, Gateway와 Guardian에 별도 인증서를 발급한다. Guardian은 PC에만 두고 Pi에는 Gateway bundle을 전달한다. 현재 PC 시험 도구에는 Gateway 0.2.29 이상과 `HEARTBEAT_INTERVAL=5`가 필요하다. 새 SQLite, `FIRMWARE_REVISION_ALLOWLIST=feather-probe-0.2.0`, `MQTT_ENABLED=false`, `CORE_BRIDGE_ENABLED=false`로 시작한다.

관측 펌웨어에서 명령 펌웨어로 바꾼 직후에는 Pi에서 명령 특성 `7f8a0003-4b6e-4f4e-9b0a-505249564255`에 `write`가 표시되는지 확인한다. 새 identity와 관측이 들어와도 BlueZ가 이전 GATT 목록을 유지할 수 있다. 특성이 빠져 있으면 Pi 시험 데몬을 멈추고 해당 Feather만 등록 해제한 뒤, 필요하면 Feather를 재부팅하고 기존 PIN으로 다시 등록한다. 새 서비스 목록에서 `write`를 확인한 뒤 새 명령 ID로 시험한다.

Gateway 0.2.29의 health는 장치별 `commandReady`를 보고한다. PC 도구는 같은 Feather 부팅의 최신 관측과 `ACTIVE` 자격, `commandReady:true`인 최신 health가 있어야 `LED_ON_READY` 또는 `LED_OFF_READY`를 출력한다. 각 단계의 trigger 파일을 본 뒤 새 health를 기다리고, grant를 받은 뒤에는 같은 Pi 부팅의 준비 상태를 다시 확인한다. 상태가 달라지면 명령을 보내기 전에 중단하고 해당 grant를 회수한다. Gateway의 실행 직전 중앙 승인 검사는 별도로 적용된다. 이번 버전의 회귀시험과 실물 시험은 미실행이다.

```powershell
$bench = '<저장소 밖의 새 절대 경로>'
python keyring/raspberry-pi-gateway/cse_integration_tests/pi_daemon_fixture.py --team-ref 715ef58 --output $bench --led-cycle
```

1. `STACK_READY` 이후 SSH 터널과 Pi 시험 데몬을 시작한다. 내장 빨간 LED가 꺼져 있는지 확인한다.
2. `LED_ON_READY`가 나오면 다른 터미널에서 같은 출력 폴더에 `LED_ON` 빈 파일을 만든다. `LED_ON_RECORDED`가 나오고 빨간 LED가 켜졌는지 직접 확인한다.
3. `LED_OFF_READY`가 나온 뒤 같은 폴더에 `LED_OFF` 빈 파일을 만든다. `LED_OFF_RECORDED` 뒤 실제 LED 소등을 확인한다.
4. Pi 시험 데몬을 종료하고 이번 시험 SQLite의 일관된 사본을 가져온다. 닫힌 DB에 WAL이 남아 있으면 SQLite backup으로 사본을 만든다. PC 시험 폴더의 `STOP` 파일로 격리 stack을 종료한다.

중간에 중단하면 Pi 시험 데몬을 먼저 종료해 BLE를 끊고 실제 LED 소등을 확인한다. 증거 파일은 두 단계의 발급과 readback을 따로 저장한다. 완주하면 `led-cycle.json`을 출력한다. 아래 도구는 로컬 DB 사본을 읽기 전용으로 열어 명령 해시, CSE readback, 영수증 전송 완료를 비교한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/pi_led_cycle.py `
    --evidence (Join-Path $bench 'led-cycle.json') --database '<Pi 시험 DB 사본>'
```

출력의 `dataBindingsVerified`는 데이터 대조 결과다. `physicalLedObserved`는 비워 두며 실제 LED 확인 기록은 따로 남긴다. [로컬 리허설 기록](../evidence/2026-11-10-pi-led-rehearsal/README.md)

### 기존 Scoped Mobius4에서 Feather LED 시험

[격리 명령 API와 Pi 설정](../dev/mobius4/README.md#feather-벤치-명령-api)을 사용한다. Feather 명령 프로필과 실제 Pi 데몬이 준비되면 PC에서 기존 Gateway 가상환경으로 아래 도구를 실행한다. `$bench`는 아직 없는 로컬 비공개 디렉터리이며, 부모 디렉터리는 먼저 준비한다.

```powershell
$env:PYTHONPATH = Join-Path $PWD 'keyring/raspberry-pi-gateway/src'
python keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_led_cycle.py --output $bench
```

보드에서 LED 변화를 볼 수 없었던 Feather는 1.54인치 화면으로 확인한다. `feather-probe-0.2.1`을 올린 뒤 Pi의 `scoped_feather_pi.py prepare`와 PC의 `scoped_feather_led_cycle.py`에 모두 `--firmware-revision feather-probe-0.2.1`을 지정한다. 시작 시 `CMD OFF`를 확인한다. `LED_ON_RECORDED`와 `LED_OFF_RECORDED`가 각각 나온 뒤, 다음 명령을 보내거나 Pi 시험을 끝내기 전에 눈으로 본 화면을 기록한다. 기본 옵션은 기존 `feather-probe-0.2.0` 절차에 맞춰져 있다.

`LED_ON_READY`, `LED_OFF_READY`가 각각 출력된 뒤에만 `$bench`에 해당 이름의 `LED_ON`, `LED_OFF` 파일을 만든다. 각 단계는 같은 부팅 세션의 명령 전 관측을 읽고, 팀 API에서 60초 grant를 받은 뒤 25초 기한의 명령을 발급한다. 실제 LED를 눈으로 확인한 결과는 따로 기록한다. 도구는 Mobius4 원본 영수증과 명령 후 관측을 확인하고 단계별 grant 회수 응답을 로컬에 저장한다.

명령 발급 요청 전의 `led-*-intent.json`에 command ID와 CSE 자원명이 있다. 응답을 받기 전에 중단되면 새 명령을 보내기 전에 이 ID로 팀 상태와 원본 영수증을 대조한다. [격리 PostgreSQL 정산 작업자](../dev/mobius4/README.md#격리-postgresql-정산-실행)가 원본을 처리한 뒤 아래 절차로 증거를 묶는다. 중간에 중단하려면 `STOP` 파일을 만들고 실제 LED 상태를 확인한다.

시험이 중단돼 `led-cycle.json`이 없으면 중단 뒤에 확보한 팀 상태와 Pi DB 사본으로 각 단계를 대조한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_evidence.py `
  --interrupted-output $bench --team-state $teamState --database $piDatabaseCopy
```

Pi 사본이 없으면 `--database`를 생략한다. 발급 요청의 응답 파일이 없어도 팀 상태에 저장된 intent hash와 command hash가 맞으면 발급 기록을 표시한다. Pi에 남은 명령·영수증 상태, 보존된 CSE 읽기 기록과 grant 회수 응답은 따로 표시한다. 명령 ID와 `nativeRef`로 원래 정산을 이어서 확인할 수 있다. 물리 LED와 중앙 정산 확인은 완료 시험 절차의 별도 항목이다.

#### 실물 명령 증거 대조

두 명령이 끝나면 Pi SQLite 사본을 준비하고 `led-cycle.json`의 각 command ID로 [읽기 전용 정산 조회](../dev/mobius4/README.md#명령별-영수증-증거-조회)를 저장한다. `$teamState`는 같은 시험에서 팀 명령 API가 저장한 `runtime.json`의 사본이다. 운영자가 실제 LED를 확인한 경우에만 `--operator-observations`로 ON/OFF 순서의 JSON 배열을 공급한다. 각 항목은 `commandId`, `ledOn` 불리언, 시간대가 있는 `observedAt`을 포함한다.

화면을 확인한 경우 `--display-observations`에 ON/OFF 순서의 JSON 배열을 공급한다. 각 행의 `commandId`는 `led-on-readback.json` 또는 `led-off-readback.json`의 `command.commandId`에서 가져온다. `observedAt`에는 실제로 본 시각과 시간대를, `screenText`에는 눈으로 읽은 `CMD ON`, `CMD OFF`, `CMD GPIO ERROR` 중 하나를 넣는다. 문구가 보이지 않았으면 `null`을 기록한다. 도구는 0.2.1로 실행한 두 명령의 후속 관측 시각 및 다음 명령 발급 시각과 대조한다. `commandDisplayMatched`는 두 문구의 일치 여부이며 화면 기록 파일을 생략하면 `null`이다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_evidence.py `
  --cycle (Join-Path $bench 'led-cycle.json') --database $piDatabaseCopy `
  --on-inspection $onInspection --off-inspection $offInspection --team-state $teamState
```

도구는 Pi SQLite의 명령·영수증 해시와 CSE 원본의 `ri`·`ct`를 팀 발급·승인 기록과 PostgreSQL 정산에 대조한다. 정산 행에는 격리 CSE 키와 원본 경로도 필요하므로 시험 전에 최신 격리 작업자를 준비한다. `centralSettlementVerified`, `cseCallbackRecorded`, `physicalLedMatched`를 분리한다. 운영자가 실제 LED를 기록하지 않으면 물리 항목은 `null`이다. 승인과 CSE 보관 순서를 판정할 수 없어 정산이 `REVIEW`라면 원래 검토 상태를 보고한다.

같은 Pi DB에서 재시도한 경우 이전 기한 만료 명령의 정확한 ID를 `--prior-expired-command`로 명시한다. 비교 도구는 성공한 ON/OFF 두 건과 명시한 이전 거절만 허용한다. 이전 거절의 명령 해시와 영수증, 기한 만료 순서, 전달 완료, 장치 ACK 및 readback 필드가 비어 있는지를 확인한다.

#### 최신 중앙 API의 시험 결과 대조

PC의 `scoped_feather_led_cycle.py`를 `--api-mode integration`으로 실행하면 각 단계에서 Mobius4의 영수증·관측과 중앙의 `APPLIED_VERIFIED` 기록을 확인한 뒤 완료를 표시한다. ON의 중앙 정산을 확인한 뒤 OFF 준비를 시작한다. OFF 기록과 단계 grant 회수를 마치면 `led-cycle.json`을 저장하고, 두 관측의 중앙 수용 이벤트를 최대 35초 기다린다. 두 해시와 수용 순번이 일치하면 `central-telemetry.json`을 저장하고 `LED_CYCLE_CENTRAL_TELEMETRY_VERIFIED`를 표시한다. 수용 이벤트 대기가 중단되거나 기한을 넘기면 `led-cycle.json`은 후속 대조에 사용할 수 있다.

중앙 관측까지 전달된 뒤 같은 시험의 Pi SQLite와 `.local/scoped/command-api-integration/runtime.json` 사본을 준비한다. Pi 세션은 `--receipt-container-ri`로 고정한 컨테이너를 사용해야 한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_evidence.py `
  --api-mode integration --cycle (Join-Path $bench 'led-cycle.json') `
  --database $piDatabaseCopy --team-state $teamState
```

보고서는 명령별 중앙 실행 시작·정산·관측 수용 이벤트 ID를 반환한다. Pi의 컨테이너 ID와 중앙 영수증 대기열, 중앙 영수증 해시와 읽어 온 장치 상태, 중앙 관측의 부팅 ID·순번·시각을 대조한다. 직접 본 LED 상태에는 `--operator-observations`를, 0.2.1 화면 문구에는 `--display-observations`를 사용한다. 현재 도구의 실행과 실제 Pi 연동 시험은 남아 있다.

새 실행에서는 명령 전·후 관측의 Mobius4 인스턴스 유형, 이름, 자원 ID와 부모 ID를 `led-cycle.json`에 기록한다. Pi DB에 `observationContainerRi`가 있으면 관측마다 부모 ID와 장치·부팅·순번에서 만든 자원 이름을 대조하고 해당 요청이 Pi outbox에 남아 있는지 확인한다. 모두 일치하면 `observationContainerVerified`가 `true`다. 관측 ID를 고정하지 않은 이전 세션에서는 이 필드가 `null`이다.

PC 시험 도구는 Node.js로 준비된 팀 소스의 `approvalHash`를 불러와 각 명령 후의 Mobius4 관측 본문을 해시한다. 기록에는 본문 대신 해시를 저장한다. ON과 OFF의 해시가 모두 중앙 `GATEWAY_TELEMETRY_ACCEPTED` 이벤트와 일치하면 `centralTelemetryPayloadVerified`가 `true`다. 해시를 저장하지 않은 이전 기록은 `null`이고, 한쪽 해시가 빠지거나 값이 불일치하면 대조가 실패한다.

#### Pi 명령 세션

Pi의 일반 계정에서 저장소 루트로 이동한다. 짝지은 Feather 주소 한 줄을 소유자 전용 파일에 기록한다. `--address-file`에는 그 파일을, `--tls-dir`에는 `ca.pem`, `gateway-a.pem`, `gateway-a.key`가 있는 소유자 전용 폴더를 지정한다. Gateway 의존성이 설치된 기존 시험 가상환경의 Python을 사용한다.

```sh
tool=keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_pi.py
"$pi_python" "$tool" prepare --session "$bench_session" \
  --address-file "$paired_address_file" --tls-dir "$scoped_gateway_tls"
```

`prepare`는 로컬 TLS 파일을 읽고 `~/.local/state/privacy-bubble-feather-command/<세션>/profile.json`을 만든다. 포워딩 포트를 바꿀 때는 `--cse-port` 또는 `--api-port`를 지정한다. 실행 환경은 저장한 프로필에서 구성한다.

최신 팀 API를 쓰는 새 세션에는 `--api-mode integration`을 지정한다. 기본 포워딩 포트는 CSE `8760`, API `8788`이며, PC의 `scoped_feather_led_cycle.py`에도 같은 모드를 지정한다. 기존 세션은 프로필의 기본 모드 `legacy`로 실행된다. [최신 중앙 벤치](../dev/mobius4/README.md#최신-integration-api-벤치)

격리 TLS 프록시에 컨테이너 권한을 준비한 경우, 새 세션의 `prepare`에 `--receipt-container-ri "$gw_a_receipt_ri"`를 추가한다. 이 값에는 PC 준비 도구의 `SCOPED_RECEIPT_PIN gw-a` 출력에서 읽은 ID를 넣는다.

관측 ID를 고정하려면 PC의 `-PinObservationRoute` 출력에서 `SCOPED_OBSERVATION_PIN gw-a` 뒤의 값을 읽어 같은 `prepare`에 `--observation-container-ri "$gw_a_observation_ri"`를 추가한다. 중앙 저장소를 새로 구분할 때는 `--pc-api-deployment-id "$central_datastore_id"`도 넣는다. 이 ID는 운영자가 배정하고 중앙 팀 소스 커밋은 `--api-team-revision`에서 별도로 대조한다. 기존 세션의 DB와 다른 고정값을 쓰려면 새 세션을 준비한다. [PC 관측 권한 준비](../dev/mobius4/README.md#feather-벤치-명령-api)

핀을 지정한 세션은 두 SSH 포워딩이 열린 상태에서 아래 명령으로 전송 경로를 점검한다.

```sh
"$pi_python" "$tool" preflight --session "$bench_session"
```

Pi 인증서로 HTTPS GET만 보내 컨테이너 ID 일치, 중앙 자격 `ACTIVE`, 중앙 API의 활성 명령 0건을 확인한다. 성공하면 세 항목과 확인 시각을 JSON 한 줄로 출력한다. SQLite를 열거나 Gateway·BLE를 시작하는 단계는 다음 `run`이다. 실제 장치 준비 여부는 PC 명령 도구에서 같은 Feather 부팅의 최신 관측을 다시 확인한다.

통합 모드는 `preflight`와 `run`에서 Pi 인증서로 `bench-capabilities`를 먼저 읽는다. 모드, 고정 팀 커밋, Gateway·장치 ID 및 `dispatch-start`·`receipts`·`telemetry`가 프로필과 모두 일치해야 진행한다. 기존 통합 세션의 기본 커밋은 `bc2a45d`다. 팀 커밋을 바꾸는 배포에서는 새 세션을 준비할 때 `--api-team-revision`에 전체 SHA를 넣는다.

Feather 명령 프로필 `0.2.0`과 두 SSH 포워딩이 준비되면 같은 Feather를 쓰는 관측 프로세스를 종료한 뒤 아래 명령을 실행한다. 실행한 Gateway는 해당 세션의 `gateway.sqlite3`를 사용한다. Pi 사용자당 명령 벤치 한 개가 실행되며, 기본 Gateway의 SQLite 잠금도 유지한다.

```sh
"$pi_python" "$tool" run --session "$bench_session"
```

재시작할 때는 같은 세션명을 사용한다. 시험 종료 뒤 Gateway를 정상 종료하고 SQLite backup으로 사본을 만든다. 미전송 행이 있으면 원래 세션과 CSE 자원에서 대조한다.

#### r18 Pi 관측 전용 세션

첫 구동 보드의 BLE 관측을 Pi에서 격리 Mobius4와 중앙 API에 전달한다. `gw-b` 인증서, 중앙 등록 장치 ID `keyring-r18-lab`, 같은 배치에서 고정한 관측·영수증 ID를 사용한다. 새 세션 이름을 지정하고 장착한 관측 펌웨어 revision 하나를 선택한다. 기본값은 `keyring-0.7.15-bringup`이며, 화면 점검 중에는 `keyring-0.7.15-st7789-bringup` 또는 `keyring-0.7.15-jd9853-bringup`을 명시한다.

```sh
tool=keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_pi.py
"$pi_python" "$tool" prepare --session "$r18_observation_session" --api-mode r18 --observe-only \
  --address-file "$r18_address_file" --tls-dir "$scoped_gateway_b_tls" \
  --receipt-container-ri "$gw_b_receipt_ri" --observation-container-ri "$gw_b_observation_ri"
"$pi_python" "$tool" preflight --session "$r18_observation_session"
"$pi_python" "$tool" run --session "$r18_observation_session"
```

사전 확인은 컨테이너 ID 두 개와 중앙 자격을 대조해 `commandsEnabled:false`를 보고한다. 실행 중에는 BLE 관측·health와 중앙 텔레메트리를 전송하며, 명령 조회·실행·장치 명령 영수증 전송은 중지 상태다. 같은 BLE 장치를 쓰는 초기 구동 기록 도구와 Gateway는 순차적으로 실행한다. 실제 연결은 `command-health-b`에서 `commandReady:false`를, 전송은 `command-observations-b`와 중앙 `GATEWAY_TELEMETRY_ACCEPTED`에서 같은 관측을 확인한다. 명령 시험에는 별도의 [r18 Pi 명령 세션](#r18-pi-명령-세션)을 준비한다.

##### 관측 전달 증거 대조

Pi 관측 전용 세션이 실행 중일 때 PC에서 같은 부팅의 USB 로그와 준비한 관측·health ID를 지정한다. PC와 Pi 시계를 맞춘 상태에서 실행한다. `capture`는 시험을 시작한 뒤 들어온 Mobius4 관측과 상태를 HTTPS GET으로 읽는다. 같은 부팅과 펌웨어, 출력 OFF·fault 해제, `commandReady:false`를 확인한 뒤 비공개 JSON을 쓴다.

```powershell
$tool = 'keyring/raspberry-pi-gateway/cse_integration_tests/scoped_r18_observation.py'
python $tool capture --firmware-revision $r18BringupFirmware --usb-boot-log $r18UsbLog `
  --observation-container-ri $gwBObservationRi --health-container-ri $gwBHealthRi `
  --output $r18ObservationCapture
```

Gateway를 정상 종료한 뒤 같은 세션의 SQLite 사본과 격리 r18 API의 `runtime.json` 사본을 확보한다. Pi DB는 [시험 증거 보관](#r18-pi-시험-증거-보관)의 `export-env`와 `state_archive snapshot`으로 확보할 수 있다.

```powershell
python $tool compare --firmware-revision $r18BringupFirmware --usb-boot-log $r18UsbLog `
  --capture $r18ObservationCapture --database $piDatabaseCopy --team-state $teamStateCopy
```

`compare`는 Pi의 같은 부팅에서 관측 순번이 저장됐는지 확인한다. 해당 전송이 아직 큐에 있으면 Pi 본문도 대조한다. 중앙은 고정 팀 소스의 해시 함수로 Mobius4 본문을 계산해 수용 이벤트와 비교한다. 상태 사본에 중앙 이벤트가 아직 없으면 `centralTelemetryAccepted:false`와 종료 코드 1을 출력한다. 최신 중앙 사본으로 같은 기록을 다시 대조할 수 있다.

##### 중앙 위치 API와 웹 응답 대조

위치 화면까지 확인할 때는 새 BLE 연결 직전에 `capture --require-rssi`를 시작한다. Pi의 광고 RSSI 보존 시간 안에 같은 부팅의 관측을 확보하면 `R18_LOCATION_SAMPLE`에 관측 시각이 출력된다. 위치 API와 웹은 최신 관측을 제공하므로 두 응답에서 그 시각의 자료를 확보한다.

격리 PC에서 중앙 응답을 수집하려면 r18 API를 [위치 시험 옵션](../dev/mobius4/README.md#r18-격리-위치-시험)으로 시작한다. 아래 도구를 먼저 실행하고 `R18_LOCATION_LEASE_READY`가 표시되면 같은 부팅의 Pi 관측 전용 세션을 시작한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/scoped_r18_portal_capture.py `
  --live-observation --firmware-revision $r18BringupFirmware --usb-boot-log $r18UsbLog `
  --observation-container-ri $gwBObservationRi --health-container-ri $gwBHealthRi `
  --output $privateLocationTrial
```

도구는 포털 조회 전후 중앙 상태의 관측 ID를 확인하며, 두 경로의 최근 후보에서 동일한 관측을 찾는다. 일치한 `observation.json`과 `portal-response.json`을 위 `compare`의 `--capture`와 `--portal-response`에 지정한다. 회수 뒤의 응답은 `portal-after-revocation.json`에, lease·grant·consent 회수 및 사건 종료는 `location-trial.json`에 보관한다. 기한 내에 일치한 관측이 없으면 종료 코드 1을 반환한다. 이미 확보한 관측 파일은 기존 `--observation-capture` 옵션으로 사용할 수 있다.

팀 포털을 사용하는 시험은 승인된 사용자 세션과 유효한 위치 grant·lease에서 `GET /v1/portal/locations`와 LIVE 웹의 `GET /api/portal/locations`를 확보한다. 수동 사본에는 인증 헤더·쿠키 없이 `path`, 숫자 `status`, UTC 조회 시각 `capturedAt`, JSON `body`를 기록한다.

위 `compare` 명령에 `--portal-response $portalResponseCopy`와 `--web-response $webResponseCopy` 중 확보한 파일을 추가한다. 결과는 수용 이벤트와 기기·Gateway·관측 시각·RSSI·모의 표시가 일치하면 `matched`를 반환한다. 웹 출처는 `live`의 `portal-api`여야 한다. `combined`는 파일 입력도 섞이므로 출처 미확인으로 남긴다. 화면 표시와 별도 앱의 실물 연동은 각각 화면 증거를 남긴다.

#### r18 Pi 명령 세션

[r18 격리 명령 API](../dev/mobius4/README.md#r18-격리-명령-api)의 `gw-b` 인증서와 컨테이너 ID를 사용한다. 정식 r18 시험 펌웨어의 로컬 provisioning에서 장치 ID를 `keyring-r18-lab`으로 설정한다. 짝지은 r18 주소와 `ca.pem`, `gateway-b.pem`, `gateway-b.key`를 기존 Pi 세션과 같은 방식으로 소유자 전용 위치에 둔다.

```sh
tool=keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_pi.py
"$pi_python" "$tool" prepare --session "$r18_session" --api-mode r18 \
  --address-file "$r18_address_file" --tls-dir "$scoped_gateway_b_tls" \
  --receipt-container-ri "$gw_b_receipt_ri" --observation-container-ri "$gw_b_observation_ri"
"$pi_python" "$tool" preflight --session "$r18_session"
```

r18 모드는 중앙 API 포트 `8789`와 `gw-b` 전용 경로를 사용한다. Pi Gateway는 BLE 장치 ID, `r18-hand-solder` 보드, `keyring-0.7.14` 명령 펌웨어가 일치할 때 연결을 준비한다. 관측 또는 영수증 ID가 없는 이전 r18 세션은 검증된 두 ID로 새 세션을 만든다. `preflight` 후 승인된 시험에서만 `run`으로 해당 세션을 시작한다. Feather 명령 시험과 r18 명령 시험은 Pi 사용자당 같은 실행 잠금을 사용한다. r18의 모터 펄스는 [실물 명령 대조](../JOURNAL_RETENTION.md#r18-실물-명령-한-건-대조)의 절차에 연결한다.

#### r18 단일 펄스 시험

격리 r18 API와 Pi 세션을 시작하고, 출력 계측기를 준비한 뒤 PC에서 새 비공개 폴더를 출력 경로로 지정한다. 관측·영수증은 Pi `preflight`에서 일치한 ID를, health는 같은 [Mobius4 배치](../dev/mobius4/README.md#r18-격리-명령-api)의 확인값을 쓴다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/scoped_r18_pulse.py --output $privatePulseEvidence `
  --observation-container-ri $gwBObservationRi --receipt-container-ri $gwBReceiptRi `
  --health-container-ri $gwBHealthRi
```

`R18_PULSE_READY`가 나오면 실제 시험을 시작할 때 다른 터미널에서 같은 폴더에 빈 `PULSE` 파일을 만든다. 도구는 같은 부팅에서 출력 OFF·fault 없음·Pi 명령 준비를 다시 읽고, 영수증 경로의 고정 ID를 재확인한 뒤 기한이 있는 명령 한 건을 발급한다. `STOP` 파일이 감지되면 발급 전에는 멈추고, grant가 생성됐으면 회수를 시도한다.

발급 전에 `pulse-intent.json`을 저장한다. `R18_PULSE_RECORDED`는 장치 ACK의 적용 당시 ON, 중앙 실행 시작·정산, 같은 부팅의 더 새 OFF 관측과 grant 회수가 확인된 경우에 출력된다. 응답이 끊기면 `pulse-intent.json`의 command ID로 원래 명령을 조회한다. 시험 도구는 그 명령을 자동으로 다시 발급하지 않는다. 펄스 길이와 종료 시점은 계측기로 기록하고 같은 command ID로 [장치 저널 대조](../JOURNAL_RETENTION.md#r18-실물-명령-한-건-대조)에 연결한다.

권한 회수 뒤, 고정된 팀 소스의 Node 해시 함수로 Mobius4의 OFF 관측 본문 해시를 계산해 `pulse-observation.json`에 저장한다. 중앙 이벤트와 관측 ID·해시·시각이 일치하면 `pulse-central-telemetry.json`을 쓰고 `R18_PULSE_CENTRAL_TELEMETRY_VERIFIED`를 출력한다. 중앙 이벤트 대기는 최대 35초이며 세션 전체 기한의 적용을 받는다. 중앙 대기가 끝나도 이미 저장한 `pulse-result.json`과 `pulse-observation.json`으로 뒤늦게 받은 중앙 상태 사본을 대조할 수 있다.

#### 중단된 r18 펄스 시험 대조

PC 시험 폴더와 격리 r18 API의 `runtime.json` 사본을 준비한다. Pi SQLite 사본을 확보했으면 `--database`에 지정한다. 도구는 로컬 사본을 읽어 기존 명령의 발급·실행·정산을 조회한다.

```powershell
python keyring/raspberry-pi-gateway/cse_integration_tests/scoped_r18_evidence.py `
  --output-directory $privatePulseEvidence --team-state $teamStateCopy `
  --database $piDatabaseCopy
```

`issuanceInTeamSnapshot`이 `false`면 제공한 상태 사본에 발급 기록이 없다. `centralApplicationVerified`가 `true`면 같은 명령의 적용 영수증과 중앙 실행·정산 기록이 일치한다. `pulse-scope.json`이 있으면 저장된 관측·health·영수증의 부모와 선택한 Pi DB의 관측·영수증 ID를 대조한다. 이전 기록은 `cseContainerPinsCaptured: false`로 표시한다. `postPulseCentralTelemetryVerified`가 `true`면 해당 명령 뒤의 OFF 관측 해시가 중앙 상태 사본의 이벤트와 일치한다. `physicalPulseMeasured`는 비워 두며 펄스 길이와 종료 시점은 계측 기록에 남긴다.

#### r18 Pi 시험 증거 보관

시험 Gateway를 정상 종료한 뒤 r18 전원을 유지한다. `$private_r18_evidence`는 Pi에서 이미 만든 소유자 전용 폴더다. `$team_state_copy`와 `$pulse_receipt_copy`는 PC에서 같은 시험의 `runtime.json`과 `pulse-receipt.json`을 복사한 경로다. `$pulse_command_id`에는 PC의 `pulse-intent.json`에 저장된 명령 ID를 지정한다.

```sh
tool=keyring/raspberry-pi-gateway/cse_integration_tests/scoped_feather_pi.py
"$pi_python" "$tool" export-env --session "$r18_session"
"$pi_python" "$tool" capture-r18 --session "$r18_session" --output "$private_r18_evidence/device"

gateway_env="$HOME/.local/state/privacy-bubble-feather-command/$r18_session/gateway.env"
source_path="$PWD/keyring/raspberry-pi-gateway/src"
env -i PATH=/usr/bin:/bin PYTHONPATH="$source_path" "$pi_python" -m bubble_gateway.state_archive snapshot \
  --env-file "$gateway_env" --output "$private_r18_evidence/gateway"
env -i PATH=/usr/bin:/bin PYTHONPATH="$source_path" "$pi_python" -m bubble_gateway.journal_reconcile \
  --env-file "$gateway_env" --device-archive "$private_r18_evidence/device" \
  --gateway-archive "$private_r18_evidence/gateway" --same-boot-command "$pulse_command_id" \
  --board-revision r18-hand-solder --firmware-revision keyring-0.7.14 \
  --team-state "$team_state_copy" --native-receipt "$pulse_receipt_copy"
```

`export-env`는 세션의 DB·인증서 파일 경로와 컨테이너 ID를 `gateway.env`에 저장한다. 장치 주소도 포함하므로 시험 폴더 안에 둔다. 기존 환경 파일은 다시 사용한다. `capture-r18`은 같은 시험 잠금과 DB 잠금을 사용하며, 지정한 장치·보드·펌웨어가 맞을 때 저널을 보관한다. `--native-receipt`를 쓰는 마지막 대조는 Pi의 Mobius4 loopback 전달을 닫은 뒤에도 실행할 수 있다. 이전 버전의 영수증을 사용할 때는 이 옵션을 빼고 loopback 전달을 유지한다.

## 이전 시험 기록

2026-11-10 Gateway 0.2.4의 기본 시험은 **58개 통과**다. BlueZ가 READ 값을 구독 callback에도 전달하는 회귀시험을 추가했고, 수정 전 실패와 수정 후 통과를 확인했다. 실제 Pi Zero 2 W에서도 90초 연속 관측과 A0/A1 입력 수신이 통과했다. [Pi 실행 기록](../evidence/2026-11-10-pi-feather/README.md)을 따른다. 아래 이전 날짜의 실행 수와 CSE·POSIX 결과는 당시 기록이다.

DOC-REV2.0.0 · KEYRING / 남호 · 2026-10-30 · Gateway0.2.3.

현재 실제 CSE suite10개와 별도 Linux POSIX suite10개가 소스·기존0.2.3 설치 wheel에서 각각 통과했다. [영속 큐·프로세스 중단 복구 증거](../evidence/2026-10-30-outbox-cse/README.md)에 로그와 hash를 보존한다. 기본56개·별도 MQTT6개와 firmware0.7.0의3개 프로필 빌드는 변경하지 않았으며 [직전 실행 기록](../evidence/2026-10-30-real-cse/README.md)을 유지한다. skipped0이다.

## 준비

Python3.11+와 pyproject.toml 의존성, OpenSSL 실행 파일, Python TLS1.3 지원이 필요하다. OpenSSL을 찾지 못하면 KEYRING_TEST_OPENSSL을 지정한다. 필수 환경이 없을 때 skip하지 않고 실패한다. 설치본 시험은 네트워크 없이 새 target에 설치한 후 import 경로·version·Python module의 LF 정규화 일치를 확인했다.

## 기본56개

모의 BLE/MQTT/HTTP·합성 명령·새 임시 SQLite48개와 실제 loopback HTTPS/TLS8개다. 기본 suite는 Docker container를 시작하지 않는다.

```powershell
$env:KEYRING_TEST_OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src')
python -m unittest discover -s keyring/raspberry-pi-gateway/tests -v
```

| 파일 | 확인한 동작 |
|---|---|
| test_protocol.py | claim/grant/hash·기한, JSON framing, INA219 단위·부호·계산, BLE20byte 송신 실패 |
| test_ble_sessions.py | 이전 callback 무시, 새 연결 정상 수신, 중단 WRITE의 새 연결 전송 차단, handshake 실패 ready 차단 |
| test_receipt_outbox.py | ACK 재생성 차단·재시작·독립 재시도·용량 오류 원자성·busy loop 방지 |
| test_store.py | command/dedup/fence/outbox·CORE sequence·WAL backup/quarantine/명시적 adoption |
| test_dispatch.py | 승인·credential·기한 실패 시 미송신, intent 선기록, 미확정 실행 자동 재시도 차단 |
| test_transport.py | oneM2M application response, fallback cin 동일성, 거절 우회 차단, RI/충돌 비교, MQTT To3가지 범위 변환 |
| test_journal.py | prepared 보존·잘못된 readback/중복 ID 거절·capture 닫기 |
| test_https_tls.py | 실제 TLS1.3/mTLS·HTTP, CA/client/서버 이름·무인증·TLS1.2 거절, redirect/proxy 차단 |

인증서·키·HTTPS server/socket은 시험이 생성하고 종료 시 정리한다. POSIX directory fsync는 Windows에서 모의 처리한다. 기존 DB·실제 BLE·Gateway daemon은 실행하지 않는다.

## 별도 MQTT6개

integration_tests/는 실제 Mosquitto/Paho TLS1.3·mTLS·CN별 ACL을 사용한다. oneM2M 응답 peer는 합성 fixture다. application response, PUBACK만 있을 때 HTTPS fallback, wrong-rqi 무시, CSE 거절 우회 차단, 다른 Originator ACL 거절, broker 종료 시 pending request 실패를 확인한다.

```powershell
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/tests')
python -m unittest discover -s keyring/raspberry-pi-gateway/integration_tests -v
```

Docker daemon과 캐시된 eclipse-mosquitto:2가 필요하다. --pull never와127.0.0.1 임시 포트, fresh test PKI, 소유 token을 사용한다.

## 별도 실제 CSE10개

cse_integration_tests/는 실제 Mobius4와 새 PostgreSQL/PostGIS를 실행한다. 기존5개는 HTTPS/MQTT3가지 주소·저장/조회, 중복 방지, 충돌 거절, CSE 재시작 후 조회다. 추가5개는 실제 Store/Gateway 송신 loop를 연결해 SQLite 다시 열기/observation dedup, native receipt 확인 플래그, CSE 중단/backoff/복구, 원격 저장 직후 송신 프로세스 강제 종료/동일 요청 복구, 충돌한 outbox행 보존을 확인한다.

delivery_child.py는 새 시험 DB와 test PKI로 송신 loop만 실행하고 원격 확인 직후 로컬 확인 전에 exit73으로 종료한다. parent는 같은 SQLite를 열고 동일 요청을 재전송해 cin1개를 확인한다. Gateway 전체 daemon·BLE·credential/poll/dispatch/health loop는 실행하지 않는다. 시험 child의 exit73과 전체 unittest의 성공 exit0을 구분한다.

```powershell
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/tests') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/integration_tests')
python -m unittest discover -s keyring/raspberry-pi-gateway/cse_integration_tests -v
```

캐시 이미지 privacy-bubble-keyring-mobius4:local, postgis/postgis:17-3.5, eclipse-mosquitto:2, nginx:1.28-alpine과 keyring/dev/mobius4/의 개발 template이 필요하다. 새 network와 tmpfs DB만 사용한다. 기존 개발 stack/DB는 사용하지 않는다. 종료 전 label/token을 확인한 소유 resource만 제거한다. 로그 수집은 KEYRING_TEST_CSE_LOG_DIR 또는 KEYRING_TEST_MQTT_LOG_DIR을 새 경로로 지정한다. image 자동 다운로드는 없다.

CSE 테스트 principal은 합성 admin mapping이다. 중앙 PKI/principal→AE/Originator·ACP/grant, INTEGRATION API·Group/SDT 명령·실물 Pi/BlueZ·키링·앱/웹·전력/거리·영상/release는 미완료다. 로컬 시험은 중앙 gate 승인을 뜻하지 않는다.

과거 [TLS55개](../evidence/2026-10-30-https-tls/README.md), [MQTT6개](../evidence/2026-10-30-mqtt-wire/README.md), [영수증47개](../evidence/2026-10-30-receipt-routing/README.md), [BLE42개](../evidence/2026-10-30-ble-sessions/README.md), [firmware3개](../evidence/2026-10-29-local-validation/README.md)는 당시 기록으로 유지한다.

## 별도 Linux POSIX10개

[실행 증거](../evidence/2026-10-30-posix-state/README.md)에 source/installed console CLI10개와 실제 flock·directory fsync·권한0700/0600·WAL snapshot·명시적 legacy adoption·ENOSPC·partial output·quarantine·concurrent write 결과를 보존했다. Windows 기본 tests/가 대체한 directory fsync를 이 suite에서는 실제 Linux syscall로 실행한다. 별도 프로세스 write 주입 wrapper도 실제 fsync를 먼저 호출한다.

Docker daemon, 캐시된 privacy-bubble-keyring-dev-certificates:local base, 기존 Gateway wheel과 PowerShell7이 필요하다. 새 시험 image build에서만 Python/pip 개발 package를 다운로드한다. 기존 개발 PKI entrypoint는 실행하지 않는다.

```powershell
docker build --pull=false -t privacy-bubble-keyring-posix-test:local -f keyring/raspberry-pi-gateway/posix_integration_tests/Dockerfile keyring/raspberry-pi-gateway/posix_integration_tests
& ./keyring/raspberry-pi-gateway/posix_integration_tests/run-posix.ps1 -Wheel '<기존 wheel 절대경로>' -LogFile '<새 로그 절대경로>'
```

runner는 --pull never/network none/UID65532/read-only root로 실행하며 source/wheel만 read-only mount한다. wheel 설치는 --no-index --no-deps다. 새/tmp SQLite와256KiB/limited tmpfs만 사용한다. 새 log path를 요구하며 label/token 일치 자원만 정리한다. 시험 종료 후 host source/wheel은 그대로다.

TLS/env는 시험용 placeholder 파일이다. snapshot/adopt는 새 합성 DB에만 실행한다. daemon entry는 다른 프로세스 lock 때문에 serve 전에 중단되므로 BLE·network·전체 daemon은 실행하지 않는다. API timeout=-1은 이미 경과한 deadline 확인이다. fsync는 tmpfs에서 실행했으며 Pi ARM/SD카드 전원 손실·운영 DB·중앙 복구 승인·실물 시험은 남아 있다. 기본56/MQTT6/CSE10/firmware3은 이번 POSIX checkpoint에서 변경·재실행하지 않았다.

## Docker ARM64 Gateway 실행

2026-11-10 Docker Desktop에서 `python:3.12-slim-bookworm`의 `linux/arm64` 이미지를 실행했다. ARM64 Debian 사용자 공간에 현재 Gateway wheel을 빌드·설치한 뒤 기본 57개 시험이 통과했다. Docker는 Pi Zero 2 W의 SD 부팅, Wi-Fi 및 Bluetooth 어댑터 시험을 별도 실물 단계로 남긴다.

재현할 때 임시 입력 폴더에 이 Gateway의 `pyproject.toml`, `src`, `tests`를 복사한다. PowerShell에서 `$inputDir`를 해당 절대경로로 설정한 후 실행한다.

```powershell
docker pull --platform linux/arm64 python:3.12-slim-bookworm
docker run --rm --platform linux/arm64 --mount "type=bind,source=$inputDir,target=/input,readonly" python:3.12-slim-bookworm sh -ec 'uname -m && cp -a /input /tmp/gateway && pip install /tmp/gateway && python -m unittest discover -s /input/tests -v'
```

빌드와 설치에 Python 공개 패키지 저장소를 사용한다. 시험은 모의 BLE와 테스트용 loopback TLS·SQLite를 사용한다.
