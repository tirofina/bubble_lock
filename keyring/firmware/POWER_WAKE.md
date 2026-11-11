# r18 저전력·깨우기 구현

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · firmware keyring-0.7.20-sleep · 상태 implemented / unverified.

## 설정과 가용성

장치의 로컬 `provisioning.h`에서 `KEYRING_ENABLE_SLEEP=1`을 선택한 빌드는 `keyring-0.7.20-sleep`으로 보고한다. 기본값 0은 BLE 가용성을 유지한다. 절전을 켜기 전에 배포 정책과 통신 지연 허용 범위를 정한다. Gateway 또는 Pi wake 기록 도구에 실제 설치한 revision을 지정한다.

깨운 뒤 명령·영수증 경로를 확인할 때는 임시 r18 API와 Pi 명령 세션에도 `keyring-0.7.20-sleep`을 지정한다. [r18 Pi 명령 세션](../raspberry-pi-gateway/TESTING.md#r18-pi-명령-세션)

- `KEYRING_IDLE_SLEEP_MS`: 기본60000, 허용10000~3600000. 연결·버튼·움직임이 마지막으로 관측된 후의 유휴 시간이다.
- `KEYRING_SLEEP_POLL_MS`: 기본30000, 허용1000~300000. 새 연결 기회를 제공하는 RTC timer다. 타이머로 깨면 다시 유휴 대기 시간 동안 광고한다.
- `KEYRING_WAKE_THRESHOLD`: 기본8, 허용1~63. 센서 임계값 설정 코드이며 검증된 낙상·위험 기준이 아니다.
- `KEYRING_WAKE_DURATION`: 기본1, 허용0~3. 센서 duration 설정 코드다. 기본 센서 설정은12.5Hz/±2g/LP1이다.

이 수치는 구성 기본값이고 측정 결과·배터리 수명 목표가 아니다. 프로그램을 빌드·장비에서 실행하지 않았으므로 소비전류와 실제 깨우기 동작은 미확인이다.

## 레지스터와 보드 근거

아래 설정은 [ST LIS2DW12 DS11811 Rev9](https://www.st.com/resource/en/datasheet/lis2dw12.pdf)의 8.6·8.7·8.24·8.25·8.28·8.31·8.35를 읽고 작성했다. 다른 비트는 read-modify-write로 보존하고 실제 runtime의 I2C 읽기/쓰기 실패는 motion=unavailable로 처리한다.

| 주소 | 사용 내용 |
|---|---|
| CTRL3 0x22 | mask0x38, 값0x10: push-pull/active-high/latched |
| CTRL4 0x23 | bit5: wake-up을 INT1에 연결 |
| WAKE_UP_THS 0x34 | threshold6bit와 SLEEP_ON 비활성 |
| WAKE_UP_DUR 0x35 | bit6:5의 duration |
| CTRL7 0x3f | bit5 INTERRUPTS_ENABLE |
| WAKE_UP_SRC 0x38 | bit3 WU_IA를 읽어 움직임 원인을 구분 |
| ALL_INT_SRC 0x3b | 읽어서 latched interrupt를 정리 |

출처에서 threshold 단위는 FS/64다. 코드에서는 움직임 사건을 낙상이나 위치로 해석하지 않는다. r18 PCB의 U6 pad12(INT1)는 /ACCEL_INT, pad11(INT2)는 미연결이며 GPIO17은 최신 공통 핀맵의 /ACCEL_INT다. 예전 BOM의 MCU GPIO 설명보다 실제 PCB 네트와 common_pcb 핀맵을 우선한다.

## 절전 상태 전환

가속도계 인터럽트가 정상 구성되고 저장소가 정상이며, 연결·대기 명령·전송 중 receipt·출력·하드웨어 fault가 없을 때만 진입을 검토한다. keyring-0.4.0은 audio worker·보조 전원 화면 창·LCD/SD I/O·SD queue도 유휴여야 하며 절전 예약 후 peripheral worker의 신규 I/O를 막는다. 기존 interrupt를 지우는 순간 새 움직임이 발견되면 진입을 취소한다. 연결 callback과 절전 예약은 같은 link lock으로 조정하고 절전 예약 후 새 연결을 수락하지 않는다.

keyring-0.7.11은 센서 또는 움직임 인터럽트 설정 오류가 나면 awake 상태에서 재시도한다. 축 읽기 실패 뒤에는 새 샘플을 받은 뒤에만 절전 조건을 평가한다. 복구 시 부팅 중 누적한 움직임 카운트는 보존하며, 장애 구간에 계측하지 못한 움직임은 복원할 수 없다.

EXT0는 motion GPIO17의 HIGH, EXT1 ANY_LOW는 확인/비상 GPIO6·7, timer는 재광고 기회를 담당한다. RTC 버튼 pull-up, 안전 출력 쓰기, 핀별 hold를 설정하고 모터·AUX의 LOW 읽기값을 확인한다. 버튼·가속도 인터럽트·메인 fault 입력이 유휴 상태인 것을 다시 확인한 뒤 BLE stack을 종료하고 deep sleep을 호출한다. [ESP-IDF 4.4.7 sleep](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32s3/api-reference/system/sleep_modes.html) · [ESP-IDF GPIO hold](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32s3/api-reference/peripherals/gpio.html)

준비 중 실패하면 wake source와 이미 적용한 hold를 해제하고 버튼 pull-up·가속도 입력을 복구한다. BLE 광고를 이어가며 관측의 `power`에 출력 실패는 `output_error`, hold 실패는 `hold_error`, 마지막 입력 확인에서 발생한 취소는 `active`를 남긴다.

GPIO 출력은 진동/AUX/충전모드 EN을 LOW, amp mute/백라이트 OFF/CS를 HIGH로 유지한다. USB 충전은 기존 USB100 설정이다. flash·PSRAM 핀을 임의로 isolate하거나 별도 절전 전압으로 바꾸지 않는다. deep wake는 setup부터 다시 시작하며 safe output latch를 준비한 뒤 hold를 해제한다. NVS 명령 journal은 유지되고 RAM queue·연결·sequence·bootId는 새 부팅 상태가 된다. Gateway의 bootId/CORE sequence 변환은 이를 구분한다.

## 관측과 개인정보

`sensorValues`에 motion 상태·부팅 중 누적 motionEvents·wake(cold/motion/button/timer/other)·wakePins·power 상태를 추가했다. 버튼으로 부팅했지만 debounce 전에 손을 떼는 경우에도 RTC wakePins는 별도로 남는다. 이 값은 사용자 승인·보호자 grant를 생성하지 않는다. 외부 서버나 파일에 추가 원시 기록을 자동 생성하지 않는다.

keyring-0.6.0은 detail별로 센서/INA219/health를 순환한다. INA219 변환 중에는 절전하지 않고 진입 전 power-down readback을 요구한다.0.7.0은 MAX9850의 mute/shutdown control readback도 요구하며 확인되지 않으면 절전을 취소한다. [계측/전송 정책](POWER_MONITOR.md)을 함께 따른다. 512byte를 넘는 일반 관측은 accelerationG·voltage·중복 상태 설명을 우선 생략하고 truncated=true를 표시한다. 측정 가능한 배터리 값은 유지한다. 그래도 한도를 넘으면 기존 최소 sensorValues 상태만 사용한다. mandatory top-level 필드·framing·버전1은 유지한다.

keyring-0.7.4는 health 프레임을 축약할 때도 `wake`·`wakePins`·`power`를 남긴다. 일반 축약과 최소 프레임 경로 모두 512바이트 검사 뒤 발행한다. Gateway 0.2.17의 [Pi wake 기록 절차](../raspberry-pi-gateway/TESTING.md#r18-wake-기록)는 BLE를 비운 뒤 새 부팅의 알림에서 원인과 핀을 대조한다. 이번 변경의 빌드와 장비 실행은 미실행이다.

## 인수 항목 — 전부 미실행

| 로컬 항목 ID | 기대 동작 / 수집할 근거 |
|---|---|
| KR-SLEEP-01 | 기본 sleep 비활성에서 광고·관측 유지; 실제 장치 trace |
| KR-SLEEP-02 | 연결·명령·receipt·출력 중 절전 금지; BLE와 GPIO trace |
| KR-SLEEP-03 | 확인/비상 버튼 각각 깨우기와 wakePins 기록 |
| KR-SLEEP-04 | 실제 움직임 INT1과 CPU motion wake의 연결 확인 |
| KR-SLEEP-05 | timer wake 후 재광고·재연결·새 bootId 확인 |
| KR-SLEEP-06 | 절전 전후 NVS journal dedup과 epoch/grant 유지 |
| KR-SLEEP-07 | I2C/RTC arming 실패에서 절전 차단·가용성 회복 |
| KR-SLEEP-08 | AUX/amp/motor/백라이트 hold 수준과 실제 전류 측정 |

위 ID는 KEYRING 내부 인수 제안이며 A01~A26 또는 팀 gate 통과를 뜻하지 않는다. 실제 값·로그·hash·영상은 장비와 명시적 실행 요청이 확보된 후 기록한다.
