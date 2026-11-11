# 남호 · KEYRING 펌웨어

ROLE: KEYRING · DOC-REV: 2.0.0 · 구현 계약: 0.1.0 · 상태: implemented, unverified

<<<<<<< HEAD
ESP32-S3-WROOM-1-N16R8 / r18-hand-solder 보드를 대상으로 작성한 소스다. keyring-0.7.0에서 BLE 관측·버튼·배터리·가속도 수집과 진동 명령/receipt, 선택형 ST7789·JD9853 상태 화면·스피커 cue·SD receipt 복사를 구현한다. INA219 공급 전원 계측과 sensorValues detail별 전송도 추가했다. [POWER_MONITOR.md](POWER_MONITOR.md)에 전원 측정 영역·정수 단위·오류/null·전송 구분을 설명한다. [MAX9850 PCM과 대기 상태](HEADPHONE_STANDBY.md)는 선택형 헤드폰 재생·MCLK·공유 I2S·승인 generation·mute 경계를 설명한다. 2026-11-10 [4개 compile profile과 host 시험](BUILD_PROFILES.md)을 통과했고, [실행 receipt](../evidence/2026-11-10-headphone-pcm/README.md)에 로그와 SHA-256을 보존했다. r18 실물 flash·파형·음향·전류 검증은 별도 TODO topic으로 관리한다.
=======
ESP32-S3-WROOM-1-N16R8 / r18-hand-solder 보드를 대상으로 작성한 소스다. keyring-0.7.7은 BLE 관측·버튼·배터리·가속도와 진동 명령/receipt, 선택형 ST7789·JD9853 상태 화면·스피커 cue·SD receipt 복사를 포함한다. 축약된 health 프레임에도 wake 원인과 핀 마스크를 담는다. [저전력·wake](POWER_WAKE.md), [전원 계측](POWER_MONITOR.md), [프로필과 빌드 기록](BUILD_PROFILES.md)을 함께 본다. 제작 PCB에서의 flash·실물 실행은 수용 시험 단계다.
>>>>>>> origin/codex/keyring-namho

배송 대기 중에는 Adafruit Feather ESP32 V2와 1.54인치 ST7789에서 화면·버튼·BLE 관측을 [별도 벤치 스케치](feather_probe/README.md)로 시험한다.

r18 제작 PCB의 첫 구동에는 `keyring_r18_bringup`을 사용한다. 별도 BLE revision `keyring-0.7.13-bringup`으로 버튼·센서·전원 관측을 제공하고 출력 명령과 장치 저널은 비활성화한다. [초기 구동 절차](../pcb/BRING_UP.md)

## 구성과 준비

`platformio.ini`는 espressif32 6.9.0, Arduino framework, ArduinoJson 6.21.5를 고정한다. 내장 ESP32 BLE 라이브러리를 사용한다. 그래픽 dependency Arduino_GFX는 commit 3cc08c4e9ab6d85807e49b657d73fae10871616e으로 고정했다. 2026-10-29 사용자 허가로 개발 dependency 설치와 로컬 compile profile 빌드를 진행했다. 실제 결과는 [BUILD_PROFILES](BUILD_PROFILES.md)에 기록한다. 보드 프로필의 개발보드 이름은 빌드 타깃 선택이며 실제 대상은 커스텀 N16R8 보드다. 16MB flash, octal PSRAM, USB CDC를 설정했다. `partitions.csv`는 factory 앱 하나와 NVS를 할당하며 OTA는 구현하지 않았다.

1. `include/provisioning.example.h`를 로컬 `include/provisioning.h`로 복사한다.
2. 각 실물별로 다른 100000~999999 범위의 passkey를 설정한다. 예시 값 0이면 BLE가 시작되지 않는다.
3. 선택적으로 `KEYRING_DEVICE_ID`에 재고 관리 ID를 설정한다. 미설정 시 eFuse MAC 기반 `keyring-...`를 사용한다. ID는 ASCII `[A-Za-z0-9][A-Za-z0-9._:-]*`, 최대 64자다.
4. Gateway의 `ble_devices`와 firmware revision 허용 목록에 이 기기를 등록하고 BlueZ 등록 과정에서 해당 passkey를 사용한다.

passkey는 소스 저장소·로그에 넣지 않는다. 선택형 상태 화면은 passkey를 표시하지 않는다. 담당자가 장치 라벨 또는 별도 등록 경로로 전달해야 한다. 설정만 바꾸어도 기존 Bluetooth bond가 철회되는 것은 아니다. 기기 분실·재등록에는 Gateway 권한 회수와 기존 bond 폐기 절차가 별도로 필요하다.

아래는 실제 장치 설정을 사용하는 작업 명령이다. 이번 로컬 빌드는 provisioning을 제외한 별도 compile profile로 수행했다. upload·device monitor는 이번 작업에서 실행하지 않았다.

```powershell
cd "C:\Users\NH\Documents\ChatGPT\mobius 해커톤\github_upload\bubble_lock\keyring\firmware"
pio run -e keyring_r18
pio run -e keyring_r18 -t upload --upload-port COM번호
pio device monitor --port COM번호 --baud 115200
```

GPIO43은 LCD reset에 연결돼 있으므로 UART0 콘솔을 사용하지 않는다. USB CDC/JTAG를 사용한다. PCB·배터리·핀의 기준은 [하드웨어 인수인계](../pcb/README.md)에 있다.

## BLE와 출력 의미

UUID와 payload는 [공통 인터페이스](../INTERFACE_NOTES.md)를 따른다. WRITE/NOTIFY는 UTF-8 JSON+LF, 조각당 최대 20byte, 최대 프레임 4096byte다. 조각 간 5초 timeout을 적용하며 송신 알림은 15ms 간격으로 나눈다. Gateway는 명령을 직렬 처리한다. 명령 큐는 4개이며 가득 찼거나 식별할 수 없는 malformed 프레임은 실행하지 않고 버린다. Gateway는 dispatch 이후 TIMEOUT/INDETERMINATE 결과에서 자동 재실행하지 않고 결과 정산 또는 수동 복구로 넘긴다. 펌웨어의 동일 commandId 중복 응답은 다른 Gateway로의 handover나 명시적인 복구 과정에서 사용한다. 수신 callback에서는 조립과 큐 삽입만 수행하고 GPIO·NVS 처리는 주 loop에서 수행한다.

keyring-0.7.2는 원본 명령에 중복 키, 이스케이프된 NUL, JSON 객체 뒤의 추가 데이터가 있는지 검사한 뒤 journal과 출력을 처리한다. 정상 객체의 키 순서, ASCII 이스케이프와 프레임 안의 JSON 공백은 허용한다. [호스트 시험](../evidence/2026-11-10-command-wire/README.md)

Observation은 LF를 포함해 512byte 이하일 때만 게시한다. 초과하면 선택적인 accelerationG·voltage·중복 상태 설명을 먼저 생략하고 truncated=true를 표시한다. 그래도 초과하면 sensorValues를 `{"status":"payload_too_large"}`로 바꾼 최소 관측을 사용하며 실제 battery는 유지한다. 최소 관측도 한도를 넘거나 JSON 저장 공간이 부족하면 게시하지 않는다. Receipt는 NOTIFY의 전체 프레임을 조립해야 한다. 512byte를 넘는 receipt의 READ 값은 빈 값이다.

암호화된 Secure Connections + MITM + bonding을 요구한다. 읽기·쓰기와 알림 구독 descriptor에도 MITM 접근 권한을 설정한다. 인증 완료되지 않은 연결에서 명령을 처리하지 않는다. passkey를 가진 등록 Gateway를 신뢰하는 구조이며 장치가 중앙 OIDC/grant를 독립 검증하는 구조는 아니다.

keyring-0.7.6은 현재 인증된 연결 ID에서 온 명령·저널 쓰기와 구독만 처리한다. 명령 쓰기에는 영수증 알림 구독과 write-with-response가 필요하다. 관측·영수증 알림은 해당 연결 ID로만 전송하고, 전송 API가 오류를 반환하면 같은 조각부터 다시 보낸다. 현재 피어가 끊기면 이전 영수증 READ 값·알림과 부분 명령을 정리하고 새 관측을 준비한 뒤 광고를 재개한다. 다른 연결의 종료는 현재 세션과 모터에 영향을 주지 않는다. [호스트 회귀시험 소스](tests/run_motor_gate_host.py)

keyring-0.7.7은 identity·관측·영수증·저널의 READ와 후속 Read Blob 요청을 현재 인증된 연결에만 제공한다. 첫 읽기에서 최대 512바이트의 사본을 만들고 같은 연결의 후속 offset에 사용한다. 읽는 도중 새 관측이 생겨도 기존 조각과 섞이지 않으며, 재연결 뒤 이전 offset은 거절한다. Arduino GATT 등록을 감싸 이 네 특성의 READ를 기본 처리기보다 먼저 받는다. 펌웨어 링크와 실제 BlueZ의 긴 읽기는 수용 시험에서 확인한다.

keyring-0.7.10은 완성된 명령과 BLE 영수증도 수신 당시의 영수증 알림 구독에 묶는다. 같은 연결에서 구독을 껐다 켜도 이전에 대기 중이던 명령은 모터를 시작할 수 없다. 이전 구독에서 대기하던 영수증 조각과 READ 사본은 폐기하며, 이미 NVS에 기록한 결과는 저널에 남긴다. 무선 스택에 제출된 조각과 이미 시작한 모터 펄스에는 기존 전송·종료 조건을 적용한다. 호스트 회귀시험 소스를 추가했고 빌드와 실물 시험은 미실행이다.

`desiredState.state=true`는 진동 GPIO를 켠다. keyring-0.7.1은 **1000ms와 명령에 남은 시간 중 작은 값**으로 ESP 차단 타이머를 먼저 시작한다. AUX 준비 전후 기한·인증 세션·전원 이상을 확인한 뒤 GPIO를 켠다. BLE 종료 콜백은 GPIO를 즉시 내리고, 타이머 만료 콜백은 GPIO와 AUX의 경보 소유권을 정리한다. ESP timer의 task 콜백에는 지연이 생길 수 있어 실물에서 차단 시간과 출력 파형을 측정해야 한다. [Espressif 타이머 동작](https://docs.espressif.com/projects/esp-idf/en/v4.4.8/esp32s3/api-reference/system/esp_timer.html)

자동 해제 이후 observation에 현재 `state=false`를 보낸다. `APPLIED`의 readback은 적용 순간 GPIO pad에서 읽은 값이다. 실제 모터 회전과 진동은 별도로 측정한다. 동일 명령 재수신으로 진동 시간을 늘리지 않는다.

`acceptedUptimeMs`는 LF로 프레임 수신이 완료된 시점이다. 기한은 **첫 fragment부터** 계산하므로 조립·큐 대기·NVS 기록에 소요된 시간도 포함한다. uptime은 부팅별 64bit millisecond이고 UTC가 아니다. UTC 환산은 Gateway가 같은 bootId의 관측 anchor가 있을 때만 수행한다.

## 명령 journal과 권한 경계

명령 ID, 중앙 payloadHash, desired state, grantRevision, ownershipEpoch, bootId, 수락·적용 uptime, 결과와 readback을 NVS `keyring-v1` namespace에 보관한다. 중앙 원본 전체가 BLE로 전송되지 않으므로 장치는 payloadHash를 재계산하지 못한다. 같은 ID의 재전송에서 hash뿐 아니라 state/grant/epoch도 비교해 다르면 CONFLICT를 반환한다.

출력 변경 전에 PREPARED record를 먼저 저장하고 적용 후 COMPLETED record를 저장한다. PREPARED만 남으면 재실행하지 않고 INDETERMINATE를 반환한다. 완료된 성공 재전송은 DUPLICATE와 과거 적용 당시 bootId/uptime/readback을 반환한다. 과거 적용 readback은 재부팅 후 현재 출력 상태를 뜻하지 않는다. 완료 저장 실패는 출력을 즉시 끄고 INDETERMINATE를 반환하며 저장 오류 이후 신규 실행을 막는다.

최대 32개 record를 보존하며 자동 삭제·순환 덮어쓰기를 하지 않는다. 가득 차면 JOURNAL_FULL이다. CRC·형식·NVS 쓰기 오류도 신규 실행을 차단한다. 가장 큰 수락 epoch와 grantRevision을 journal에서 복구해 오래된 신규 명령을 거절한다. 기록 삭제나 자동 epoch reset API는 없다. keyring-0.5.0은 NVS를 수정하지 않는 BLE journal snapshot과 Gateway 수동 보관 도구를 추가했다. [읽기·보관·정산 경계](../JOURNAL_RETENTION.md)를 따른다. 장기 운영의 실제 공간 회수에는 중앙 영속 정산 후 승인된 crash-safe checkpoint/reclaim 계약이 추가로 필요하다. flash/NVS 전체를 지우면 journal과 fencing 이력이 사라지므로 일반 복구 방식으로 사용해서는 안 된다.

keyring-0.7.5는 Arduino 코어의 `nvs_flash_init` 호출을 감싼다. `ESP_ERR_NVS_NO_FREE_PAGES` 또는 `ESP_ERR_NVS_NEW_VERSION_FOUND`에서 자동 포맷 경로를 막고, 출력을 안전 상태로 둔 채 BLE 시작 전에 잠근다. USB 직렬 로그에 `default NVS needs recovery`가 남는다. 초기화에 성공하면 기존 `keyring-v1` namespace와 record format 1을 읽는다. 명시적 `ESP_ERR_NVS_NOT_FOUND`만 빈 슬롯으로 취급하며, 읽기 오류·중복 명령 ID·모순된 record가 있으면 정상 영수증 재발행과 신규 실행을 차단한다. [호스트 오류 주입 시험 소스](tests/run_journal_nvs_host.py)는 추가됐으며 링크·실물 전원 장애 검증은 남아 있다.

keyring-0.7.8은 부팅 시 빈 슬롯 뒤에 기록이 있거나 저장 순서에서 epoch 또는 grantRevision이 낮아지면 `storage_error`로 처리한다. `keyring-v1`의 슬롯 형식은 유지한다. PREPARED와 COMPLETED는 commit 뒤 같은 키의 blob을 다시 읽어 원래 바이트와 맞아야 RAM에 반영한다. PREPARED 확인 실패는 출력 시작을 차단하고, COMPLETED 확인 실패는 출력을 끄고 `INDETERMINATE`를 반환한다. 이번 빌드와 호스트·실물 장애 시험은 미실행이다.

keyring-0.7.9는 기존 슬롯을 읽고 첫 새 명령부터 `journal-tail`에 슬롯 개수를 기록한다. 새 PREPARED 슬롯과 개수를 모두 commit하고 다시 읽은 뒤에만 출력을 변경할 수 있다. 부팅 시 기록 개수가 줄었거나 체크포인트가 손상되면 새 실행을 잠근다. 체크포인트보다 PREPARED 슬롯 하나만 앞선 경우에는 개수만 복구하고 그 명령은 `INDETERMINATE`로 보존한다. 기존 NVS 레코드 형식 1을 읽으며 새 레코드는 같은 레이아웃의 형식 2를 쓴다. BLE 내보내기 계약은 버전 1이다. 이번 빌드·호스트 시험·실물 시험은 미실행이다.

현재 grant의 회수/만료 여부는 Gateway가 매 실행 직전에 중앙 authorize API로 확인한다. 펌웨어의 숫자 fencing은 이미 본 revision보다 오래된 명령을 막는 기능이다. 더 최신의 중앙 권한 상태를 장치가 추측하지 않는다. Secure Boot·flash encryption·attestation·서명 검증·OTA·원격 인증서 발급은 이 구현의 범위에 포함되지 않는다.

## 센서·버튼·저전력

MAX17048의 SOC와 VCELL을 읽고 실패 시 battery/voltage를 null로 보낸다. 전압·SOC 레지스터 형식은 [MAX17048 제조사 데이터시트](https://www.analog.com/media/en/technical-documentation/data-sheets/MAX17048-MAX17049.pdf)를 따른다. 배터리별 모델 보정과 실측 잔량 정확도는 미확인이다.

keyring-0.7.12의 잔량 경보는 기본 20% 이하에서 켜지고 25% 이상에서 해제된다. `KEYRING_BATTERY_WARN_PERCENT`, `KEYRING_BATTERY_RECOVER_PERCENT`는 로컬 설정으로 조정할 수 있다. `sensorValues.batteryAlert`는 저잔량 `true`, 정상 `false`, 센서 미확인 `null`을 전송한다. 읽기 실패 뒤에도 마지막 정상 샘플의 경보 상태를 보존해 다음 정상 샘플에 같은 경계값을 적용한다. LCD가 켜져 있으면 낮은 잔량을 빨간색과 `LOW`로 표시한다. 이 경보는 표시·관측용이다. 호스트 회귀시험 소스를 추가했고 빌드와 실물 확인은 미실행이다.

LIS2DW12 WHO_AM_I를 확인하고 12.5Hz·low-power mode1·±2g·BDU·주소 증가를 설정해 3축을 g 단위로 보낸다. 레지스터와 감도 근거는 [LIS2DW12 제조사 데이터시트](https://www.st.com/resource/en/datasheet/lis2dw12.pdf)다. 초기화/읽기 실패는 accelStatus=unavailable이다. 낙상 판정이나 위치 추정은 구현하지 않았다.

keyring-0.7.11은 가속도계 초기화나 축 읽기가 실패하면 약 5초 간격으로 기존 센서 설정을 다시 적용한다. 축 읽기는 정상이고 움직임 인터럽트만 실패하면 인터럽트 설정을 별도로 복구한다. 축 읽기 실패 시 관측은 `unavailable`로 바뀌고 절전 진입을 보류한다. 인터럽트와 새 축 샘플이 모두 확인된 뒤 절전을 검토한다. [호스트 시험 소스](tests/run_sensor_recovery_host.py)를 추가했으며 이번 빌드·시험·실물 검증은 미실행이다.

확인/비상 버튼은 active-low, debounce35ms이며 panic을 우선한다. 관측 의도를 전송하며 자체적으로 grant나 보호자 승인을 생성하지 않는다. 관측은2초 주기 또는 버튼/출력/움직임 변화 때 갱신한다. radio controller sleep 요청과 idle yield 외에 선택형 deep sleep·motion/버튼/timer wake 경로를 작성했다. `KEYRING_ENABLE_SLEEP` 기본값은0이며 연결 중에는 절전하지 않는다. 상세 설정·제약·미실행 인수 항목은 [POWER_WAKE.md](POWER_WAKE.md)에 있다. 화면·오디오·microSD는 기본 비활성 옵션으로 소스를 추가했으며 [PERIPHERALS.md](PERIPHERALS.md)에 두 화면 선택, JD9853 패널 초기화 미확인, 공용 전원·SPI와 SD 평문 기록 제약을 설명한다. 실물 주변장치 동작과 배터리 수명·소비전류·깨우기 동작은 미확인이다.

keyring-0.7.3은 `sensorValues.buttonPresses`에 부팅별 확인·비상 누름을 순서대로 담는다. 버튼을 뗀 뒤에도 다음 관측에서 횟수를 읽을 수 있다. 동시에 눌리거나 비상 버튼이 눌린 동안 확인 버튼을 눌렀다면 비상을 우선한다. 누계는 uint32 최댓값에서 유지되며 재부팅하면 새 bootId와 함께 0부터 시작한다. [버튼 프레임 시험](../evidence/2026-11-10-button-presses/README.md)

충전 전류 모드는 USB100 기본값을 유지한다. 충전기·온도 보호·충전 LED는 하드웨어 회로이며 펌웨어가 충전 LED를 제어했다고 표시하지 않는다.
