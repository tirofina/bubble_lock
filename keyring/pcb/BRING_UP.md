# r18 제작 PCB 첫 구동

KEYRING / 남호 · DOC-REV 2.0.0 · 준비 소스만 반영.

`keyring_r18_bringup`은 r18의 첫 구동용 관측 프로필이다. 기존 [PCB 배선표](r18/external_parts/Connector_pinout.csv), [GPIO 인수인계](HARDWARE_FIRMWARE_MAP.md), [보드 핀 선언](../firmware/include/board_r18.h)을 사용한다.

## 조립 확인

1. 인수한 보드의 조립 revision과 실장 상태를 사진·조립 기록에 남긴다. 기존 r18 snapshot의 파일 해시와 실물의 조립 revision을 구분한다.
2. 전원 인가 전에 J2 배터리 하네스가 pin 1 VBAT, pin 2 GND에 맞는지 확인한다. J9 스위치 배선은 원본 커넥터 표를 따른다. 첫 단계에서는 외장 화면·스피커·모터와 SD를 분리한다.
3. 승인된 전원 조건에서 입력 전원과 보드의 +3V3 안정 여부를 실측한다. USB 연결 방식과 배터리 연결 유무를 기록한다. 반복 리셋이나 `MAIN_FAULT_N` 활성 상태면 출력 시험으로 넘어가지 않는다.

## 관측 펌웨어 올리기

로컬 `firmware/include/provisioning.h`에 장치별 passkey와 장치 ID를 설정한다. USB 데이터 연결은 J1을 사용한다. 원본 BOM의 내부 서비스 버튼은 SW3 RESET과 SW4 BOOT다. USB 포트가 잡히지 않으면 보드의 전원 상태와 이 두 버튼의 실장부터 확인한다. GPIO43은 LCD reset에 연결돼 있으므로 콘솔은 USB CDC를 사용한다.

아래 명령은 장비 작업 승인을 받은 뒤 `keyring/firmware`에서 실행할 절차다. `<COM_PORT>`에는 보드 연결 전후로 확인한 포트를 넣는다.

```text
pio run -e keyring_r18_bringup
pio run -e keyring_r18_bringup -t upload --upload-port <COM_PORT>
pio device monitor --port <COM_PORT> --baud 115200
```

USB 모니터를 열고 `?`를 보내면 현재 부팅의 `KEYRING bringup` 줄을 다시 출력한다. 이 줄을 포함한 UTF-8 로그를 로컬에 저장한다. 보드·펌웨어 revision, 부팅 ID, `motor`, `aux`, `fault`가 기록되며 기대값은 `motor=0 aux=0 fault=0`이다. motor·aux는 첫 구동 시의 GPIO readback이며 전압과 부하 상태는 계측한다. `fuel`, `accel`, `motion`은 첫 샘플과 인터럽트 설정 결과다. Pi에서 초기 구동을 기록할 때까지 보드 전원을 유지한다.

이 프로필은 로컬 설정이 켜져 있어도 LCD·오디오 재생·SD·deep sleep을 비활성화하고 USB100을 유지한다. 명령용 NVS와 BLE 명령·저널 특성을 열지 않는다. BLE bonding과 센서 초기화는 일반 경로를 사용하며, 장착된 MAX9850의 mute/shutdown 설정은 기존 설정을 따른다.

## Pi와 확인할 항목

[BlueZ 등록 절차](../raspberry-pi-gateway/README.md#bluez-등록)를 따라 장치별로 페어링한다. 격리 Gateway에서 `BLE_GATT_PROFILE=core-v1`, `FIRMWARE_REVISION_ALLOWLIST=keyring-0.7.15-bringup`과 시험 전용 DB를 사용한다. Gateway health에서 보드 `r18-hand-solder`, 새 부팅 ID, `connected:true`, `commandReady:false`를 확인한다. Gateway는 `-bringup` revision을 관측 전용으로 처리한다.

버튼·센서·전원과 Gateway의 명령 차단 상태는 Gateway 0.2.59의 [Pi 초기 구동 기록 모드](../raspberry-pi-gateway/TESTING.md#r18-초기-구동-기록)에서 기록한다. `--usb-boot-log`에 위 로그를 제공하면 BLE와 같은 부팅인지 대조하고 USB의 초기 센서 상태와 마지막 BLE 센서·INA219 상태를 기록한다. 로그에 첫 출력과 재출력이 모두 있으면 줄 전체가 일치해야 한다. 기록 시에는 같은 DB 경로를 사용하는 Gateway를 중지한다. 전원 레일의 실측은 별도로 남긴다.

| 확인 항목 | 증거 |
|---|---|
| 부팅·전원 | board revision, 빌드 산출물 해시, USB 로그 해시와 BLE 부팅 일치 결과, +3V3 실측, 입력 전원 조건 |
| 버튼 | 확인·비상을 각각 누르고 떼며 같은 부팅의 `buttonState`와 각 누름 누계를 기록 |
| 센서·전원 | `sensors`의 배터리·가속도·motion 상태, `energy`의 INA219 상태와 3.3V 부하 측 값, `health`의 `journal:disabled`를 같은 부팅에서 기록 |
| 재연결 | [Pi 재연결 전후 버튼 누계 기록](../raspberry-pi-gateway/TESTING.md#r18-재연결-전후-버튼-누계-기록)에서 링크 복구 시간, 동일 부팅, sequence·누계 연속성 확인 |
| 후속 시험 | 실장한 화면·배터리·외장 부하를 확인한 뒤 별도 승인으로 정식 `keyring_r18` 프로필의 명령·출력·충전·절전 시험 수행. [r18 실물 명령 한 건 대조](../JOURNAL_RETENTION.md#r18-실물-명령-한-건-대조)에 장치·Pi·Mobius4 증거를 연결 |

## 화면만 연결한 두 번째 구동

기본 첫 구동을 마친 뒤 전원을 끄고, [J3 커넥터 표](r18/external_parts/Connector_pinout.csv)에 맞춰 확인한 LCD 한 개를 연결한다. 모터·스피커·SD는 분리된 상태로 유지한다. 장착한 패널에 해당하는 프로필 하나를 선택한다. 빌드·업로드·USB 모니터 명령의 환경 이름만 바꾼다.

| 장착한 LCD | PlatformIO 환경 | Pi 펌웨어 revision |
|---|---|---|
| 1.54인치 ST7789 | `keyring_r18_bringup_st7789` | `keyring-0.7.15-st7789-bringup` |
| 2.01인치 JD9853 | `keyring_r18_bringup_jd9853` | `keyring-0.7.15-jd9853-bringup` |

USB 초기 구동 줄의 `panel`과 `motor=0 aux=0 fault=0`을 확인한다. 확인 버튼을 눌러 백라이트를 켜고 흰색 테두리의 네 변, 왼쪽부터 빨강·초록·파랑 막대, 패널 이름·가로×세로·`CONFIRM`을 기록한다. 비상 버튼을 누르면 `PANIC`을 표시한다. 버튼을 떼어도 마지막 표시는 백라이트가 켜져 있는 동안 유지된다. 새 누름이 없으면 설정된 창이 만료될 때 백라이트가 꺼진다. Pi 초기 구동 기록에는 표의 revision과 같은 부팅의 USB 로그를 지정한다. 사진이나 영상은 같은 시험의 비공개 기록에 둔다.

Pi JSON의 `bringup.usbBoot.displayProfile`은 USB 로그와 일치한 빌드 선택값이다. 테두리·색상·문구는 패널에서 관찰한 결과를 기록한다. JD9853은 기존 초기화 경로를 쓰며 구매한 패널의 전원·감마 설정과 실제 표시가 남아 있다. [패널 설정](../firmware/PERIPHERALS.md#jd9853-미확인-범위)

passkey·BLE 주소·원시 관측은 로컬 증거에 보관한다. 빌드·플래시·전원 인가·Pi 접속은 미실행이다.
