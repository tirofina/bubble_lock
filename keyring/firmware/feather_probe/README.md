# Feather V2 + ST7789 벤치 시험

기존 브레드보드 배선으로 ST7789 표시, A0/A1 버튼, Gateway의 CORE v1 BLE identity·observation을 시험한다. GIF·공룡게임 스케치는 별도 로컬 프로젝트 `hardware/feather_keyring_test`에 있다.

| 신호 | Feather V2 |
|---|---|
| ST7789 CLK / DIN | SCK GPIO5 / MOSI GPIO19 |
| CS / DC / RST | GPIO32 / GPIO33 / GPIO27 |
| 확인 / 비상 | A0 GPIO26 / A1 GPIO25. 스위치는 GND로 연결 |

화면은 240×240이며 준비·BLE 연결·버튼 상태를 표시한다. 두 버튼을 함께 누르면 비상 상태가 우선한다. 벤치에 연결된 화면 전원과 백라이트 배선을 사용한다.

```powershell
arduino-cli compile --fqbn esp32:esp32:adafruit_feather_esp32_v2 keyring/firmware/feather_probe
```

BLE 등록에는 이 스케치 폴더의 Git 제외 파일 `provisioning.h`에 시험용 6자리 숫자를 `KEYRING_FEATHER_PASSKEY`로 정의한다. 기본 빌드는 화면·버튼만 시작하고 `BLE LOCKED`를 표시한다. 비밀값은 등록하는 PC나 Pi에서 로컬로 관리한다.

BLE를 활성화한 후 시험 Gateway에 `keyring-feather-lab` 장치 ID와 실제 BLE 주소를 등록하고 `core-v1`을 선택한다. 펌웨어 허용 목록을 쓰는 설정에는 `feather-probe-0.1.0`을 넣는다. 격리된 시험 Gateway와 관측 컨테이너에서 A0의 `confirm`, A1의 `panic`, 떼었을 때 `released`를 확인한다. 배터리는 `null`이므로 native oneM2M 관측 경로에서 확인한다. 벤치 범위는 관측이며 모터나 명령 실행 시험은 실물 키링에서 진행한다.

Pi 연결 전에는 Gateway 의존성이 설치된 Windows Python으로 같은 BLE 수신기를 쓸 수 있다. 저장소 루트에서 실행한다.

```powershell
$env:PYTHONPATH = Join-Path $PWD 'keyring/raspberry-pi-gateway/src'
python keyring/firmware/feather_probe/observe.py --scan-only
python keyring/firmware/feather_probe/observe.py --seconds 90
```

첫 명령은 해당 광고만 검색한다. Windows에서는 `keyring-feather-lab`을 먼저 PIN으로 페어링한 뒤 두 번째 명령을 실행한다. 이번 벤치에서는 Windows의 PIN 페어링 API에서 암호화와 인증을 요구해 등록했다. 버튼을 뗀 상태, A0, A1을 차례로 확인하며 도구는 결과를 콘솔에 출력한다.
