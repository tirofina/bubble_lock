# 남호 · KEYRING 펌웨어

ROLE: KEYRING · DOC-REV: 2.0.0 · 구현 계약: 0.1.0 · 상태: implemented, unverified

ESP32-S3-WROOM-1-N16R8 / r18-hand-solder 보드를 대상으로 작성한 소스다. keyring-0.5.0에서 BLE 관측·버튼·배터리·가속도 수집과 진동 명령/receipt, 선택형 ST7789·JD9853 상태 화면·스피커 cue·SD receipt 복사를 구현한다. 테스트·린트·컴파일·빌드·플래시·실물 실행은 이번 작업에서 수행하지 않았다.

## 구성과 준비

`platformio.ini`는 espressif32 6.9.0, Arduino framework, ArduinoJson 6.21.5를 고정한다. 내장 ESP32 BLE 라이브러리를 사용한다. 그래픽 dependency Arduino_GFX는 commit f71dbf6532b277401d70442f43a8fa9b61c6a7e3으로 고정했다. 이번에 dependency 설치·빌드는 실행하지 않았다. 보드 프로필의 개발보드 이름은 빌드 타깃 선택이며 실제 대상은 커스텀 N16R8 보드다. 16MB flash, octal PSRAM, USB CDC를 설정했다. `partitions.csv`는 factory 앱 하나와 NVS를 할당하며 OTA는 구현하지 않았다.

1. `include/provisioning.example.h`를 로컬 `include/provisioning.h`로 복사한다.
2. 각 실물별로 다른 100000~999999 범위의 passkey를 설정한다. 예시 값 0이면 BLE가 시작되지 않는다.
3. 선택적으로 `KEYRING_DEVICE_ID`에 재고 관리 ID를 설정한다. 미설정 시 eFuse MAC 기반 `keyring-...`를 사용한다. ID는 ASCII `[A-Za-z0-9][A-Za-z0-9._:-]*`, 최대 64자다.
4. Gateway의 `ble_devices`와 firmware revision 허용 목록에 이 기기를 등록하고 BlueZ 등록 과정에서 해당 passkey를 사용한다.

passkey는 소스 저장소·로그에 넣지 않는다. 이 보드의 화면 드라이버는 아직 없어 passkey를 화면에 표시하지 않는다. 담당자가 장치 라벨 또는 별도 등록 경로로 전달해야 한다. 설정만 바꾸어도 기존 Bluetooth bond가 철회되는 것은 아니다. 기기 분실·재등록에는 Gateway 권한 회수와 기존 bond 폐기 절차가 별도로 필요하다.

아래는 사용자가 명시적으로 빌드·업로드를 요청할 때 사용할 명령이다. 현재 실행 결과는 없다.

```powershell
cd "C:\Users\NH\Documents\ChatGPT\mobius 해커톤\github_upload\bubble_lock\keyring\firmware"
pio run -e keyring_r18
pio run -e keyring_r18 -t upload --upload-port COM번호
pio device monitor --port COM번호 --baud 115200
```

GPIO43은 LCD reset에 연결돼 있으므로 UART0 콘솔을 사용하지 않는다. USB CDC/JTAG를 사용한다. PCB·배터리·핀의 기준은 [하드웨어 인수인계](../pcb/README.md)에 있다.

## BLE와 출력 의미

UUID와 payload는 [공통 인터페이스](../INTERFACE_NOTES.md)를 따른다. WRITE/NOTIFY는 UTF-8 JSON+LF, 조각당 최대 20byte, 최대 프레임 4096byte다. 조각 간 5초 timeout을 적용하며 송신 알림은 15ms 간격으로 나눈다. Gateway는 명령을 직렬 처리한다. 명령 큐는 4개이며 가득 찼거나 식별할 수 없는 malformed 프레임은 실행하지 않고 버린다. Gateway는 dispatch 이후 TIMEOUT/INDETERMINATE 결과에서 자동 재실행하지 않고 결과 정산 또는 수동 복구로 넘긴다. 펌웨어의 동일 commandId 중복 응답은 다른 Gateway로의 handover나 명시적인 복구 과정에서 사용한다. 수신 callback에서는 조립과 큐 삽입만 수행하고 GPIO·NVS 처리는 주 loop에서 수행한다.

Observation은 LF를 포함해 512byte 이하일 때만 게시한다. 초과하면 선택적인 accelerationG·voltage·중복 상태 설명을 먼저 생략하고 truncated=true를 표시한다. 그래도 초과하면 sensorValues를 `{"status":"payload_too_large"}`로 바꾼 최소 관측을 사용하며 실제 battery는 유지한다. 최소 관측도 한도를 넘거나 JSON 저장 공간이 부족하면 게시하지 않는다. Receipt는 NOTIFY의 전체 프레임을 조립해야 한다. 512byte를 넘는 receipt의 READ 값은 빈 값이다.

암호화된 Secure Connections + MITM + bonding을 요구한다. 읽기·쓰기와 알림 구독 descriptor에도 MITM 접근 권한을 설정한다. 인증 완료되지 않은 연결에서 명령을 처리하지 않는다. passkey를 가진 등록 Gateway를 신뢰하는 구조이며 장치가 중앙 OIDC/grant를 독립 검증하는 구조는 아니다.

`desiredState.state=true`는 진동 GPIO를 켠다. 최대 ON 시간은 **1000ms 또는 명령에 남은 시간 중 작은 값**이다. 별도 ESP timer가 GPIO와 AUX 전원을 끈다. 기한·연결 해제·fault도 OFF로 처리한다. 자동 해제 이후 observation에 현재 `state=false`를 보낸다. APPLIED receipt의 readback은 적용 시점의 GPIO input-enabled pad 수준이고 실제 모터 회전·진동을 측정한 값이 아니다. 동일 명령 재수신으로 진동 시간을 늘리지 않는다.

`acceptedUptimeMs`는 LF로 프레임 수신이 완료된 시점이다. 기한은 **첫 fragment부터** 계산하므로 조립·큐 대기·NVS 기록에 소요된 시간도 포함한다. uptime은 부팅별 64bit millisecond이고 UTC가 아니다. UTC 환산은 Gateway가 같은 bootId의 관측 anchor가 있을 때만 수행한다.

## 명령 journal과 권한 경계

명령 ID, 중앙 payloadHash, desired state, grantRevision, ownershipEpoch, bootId, 수락·적용 uptime, 결과와 readback을 NVS `keyring-v1` namespace에 보관한다. 중앙 원본 전체가 BLE로 전송되지 않으므로 장치는 payloadHash를 재계산하지 못한다. 같은 ID의 재전송에서 hash뿐 아니라 state/grant/epoch도 비교해 다르면 CONFLICT를 반환한다.

출력 변경 전에 PREPARED record를 먼저 저장하고 적용 후 COMPLETED record를 저장한다. PREPARED만 남으면 재실행하지 않고 INDETERMINATE를 반환한다. 완료된 성공 재전송은 DUPLICATE와 과거 적용 당시 bootId/uptime/readback을 반환한다. 과거 적용 readback은 재부팅 후 현재 출력 상태를 뜻하지 않는다. 완료 저장 실패는 출력을 즉시 끄고 INDETERMINATE를 반환하며 저장 오류 이후 신규 실행을 막는다.

최대 32개 record를 보존하며 자동 삭제·순환 덮어쓰기를 하지 않는다. 가득 차면 JOURNAL_FULL이다. CRC·형식·NVS 쓰기 오류도 신규 실행을 차단한다. 가장 큰 수락 epoch와 grantRevision을 journal에서 복구해 오래된 신규 명령을 거절한다. 기록 삭제나 자동 epoch reset API는 없다. keyring-0.5.0은 NVS를 수정하지 않는 BLE journal snapshot과 Gateway 수동 보관 도구를 추가했다. [읽기·보관·정산 경계](../JOURNAL_RETENTION.md)를 따른다. 장기 운영의 실제 공간 회수에는 중앙 영속 정산 후 승인된 crash-safe checkpoint/reclaim 계약이 추가로 필요하다. flash/NVS 전체를 지우면 journal과 fencing 이력이 사라지므로 일반 복구 방식으로 사용해서는 안 된다.

현재 grant의 회수/만료 여부는 Gateway가 매 실행 직전에 중앙 authorize API로 확인한다. 펌웨어의 숫자 fencing은 이미 본 revision보다 오래된 명령을 막는 기능이다. 더 최신의 중앙 권한 상태를 장치가 추측하지 않는다. Secure Boot·flash encryption·attestation·서명 검증·OTA·원격 인증서 발급은 이 구현의 범위에 포함되지 않는다.

## 센서·버튼·저전력

MAX17048의 SOC와 VCELL을 읽고 실패 시 battery/voltage를 null로 보낸다. 전압·SOC 레지스터 형식은 [MAX17048 제조사 데이터시트](https://www.analog.com/media/en/technical-documentation/data-sheets/MAX17048-MAX17049.pdf)를 따른다. 배터리별 모델 보정과 실측 잔량 정확도는 미확인이다.

LIS2DW12 WHO_AM_I를 확인하고 12.5Hz·low-power mode1·±2g·BDU·주소 증가를 설정해 3축을 g 단위로 보낸다. 레지스터와 감도 근거는 [LIS2DW12 제조사 데이터시트](https://www.st.com/resource/en/datasheet/lis2dw12.pdf)다. 초기화/읽기 실패는 accelStatus=unavailable이다. 낙상 판정이나 위치 추정은 구현하지 않았다.

확인/비상 버튼은 active-low, debounce35ms이며 panic을 우선한다. 관측 의도를 전송하며 자체적으로 grant나 보호자 승인을 생성하지 않는다. 관측은2초 주기 또는 버튼/출력/움직임 변화 때 갱신한다. radio controller sleep 요청과 idle yield 외에 선택형 deep sleep·motion/버튼/timer wake 경로를 작성했다. `KEYRING_ENABLE_SLEEP` 기본값은0이며 연결 중에는 절전하지 않는다. 상세 설정·제약·미실행 인수 항목은 [POWER_WAKE.md](POWER_WAKE.md)에 있다. 화면·오디오·microSD는 기본 비활성 옵션으로 소스를 추가했으며 [PERIPHERALS.md](PERIPHERALS.md)에 두 화면 선택, JD9853 패널 초기화 미확인, 공용 전원·SPI와 SD 평문 기록 제약을 설명한다. 실물 주변장치 동작과 배터리 수명·소비전류·깨우기 동작은 미확인이다.

충전 전류 모드는 USB100 기본값을 유지한다. 충전기·온도 보호·충전 LED는 하드웨어 회로이며 펌웨어가 충전 LED를 제어했다고 표시하지 않는다.
