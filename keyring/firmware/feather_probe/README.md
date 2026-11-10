# Feather V2 + ST7789 벤치 시험

기존 브레드보드 배선으로 ST7789 표시, A0/A1 버튼, Gateway의 CORE v1 BLE identity·observation을 시험한다. GIF·공룡게임 스케치는 별도 로컬 프로젝트 `hardware/feather_keyring_test`에 있다.

| 신호 | Feather V2 |
|---|---|
| ST7789 CLK / DIN | SCK GPIO5 / MOSI GPIO19 |
| CS / DC / RST | GPIO32 / GPIO33 / GPIO27 |
| 확인 / 비상 | A0 GPIO26 / A1 GPIO25. 스위치는 GND로 연결 |

화면은 240×240이며 준비·BLE 연결·마지막 버튼 입력을 표시한다. A0를 누르면 `A0 CONFIRMED`, A1을 누르면 `A1 PANIC`으로 바뀌고, 버튼을 떼어도 다음 입력이나 재부팅 전까지 해당 화면을 유지한다. 두 버튼을 함께 누르면 비상 상태가 우선하며, A1을 누른 채 A0를 눌러도 비상 화면을 유지한다. BLE 연결 상태가 바뀌어도 마지막 입력 표시는 유지한다. BLE의 `buttonState`는 실제 누름·해제 상태를 계속 전달하므로 버튼을 떼면 `released`가 전송된다. 벤치에 연결된 화면 전원과 백라이트 배선을 사용한다.

```powershell
arduino-cli compile --fqbn esp32:esp32:adafruit_feather_esp32_v2 keyring/firmware/feather_probe
```

BLE 등록에는 이 스케치 폴더의 Git 제외 파일 `provisioning.h`에 시험용 6자리 숫자를 `KEYRING_FEATHER_PASSKEY`로 정의한다. 기본 빌드는 화면·버튼만 시작하고 `BLE LOCKED`를 표시한다. 비밀값은 등록하는 PC나 Pi에서 로컬로 관리한다.

BLE를 활성화한 후 시험 Gateway에 `keyring-feather-lab` 장치 ID와 실제 BLE 주소를 등록하고 `core-v1`을 선택한다. 펌웨어 허용 목록을 쓰는 설정에는 `feather-probe-0.1.1`을 넣는다. 격리된 시험 Gateway와 관측 컨테이너에서 A0의 `confirm`, A1의 `panic`, 떼었을 때 `released`를 확인한다. 배터리는 `null`이므로 native oneM2M 관측 경로에서 확인한다. 벤치 범위는 관측이며 모터나 명령 실행 시험은 실물 키링에서 진행한다.

Pi 연결 전에는 Gateway 의존성이 설치된 Windows Python으로 같은 BLE 수신기를 쓸 수 있다. 저장소 루트에서 실행한다.

```powershell
$env:PYTHONPATH = Join-Path $PWD 'keyring/raspberry-pi-gateway/src'
python keyring/firmware/feather_probe/observe.py --scan-only
python keyring/firmware/feather_probe/observe.py --seconds 90
```

첫 명령은 해당 광고만 검색한다. Windows에서는 `keyring-feather-lab`을 먼저 PIN으로 페어링한 뒤 두 번째 명령을 실행한다. 이번 벤치에서는 Windows의 PIN 페어링 API에서 암호화와 인증을 요구해 등록했다. 버튼을 뗀 상태, A0, A1을 차례로 확인하며 도구는 결과를 콘솔에 출력한다.

## Raspberry Pi에서 단독 BLE 관측

2026-11-10 Pi Zero 2 W Rev 1.0에서 Debian 13.7 aarch64, Python 3.13.5, BlueZ 5.82로 벤치 시험을 시작했다. Gateway 0.2.4와 Bleak 3.1.0에서 90초 연속 수신과 `released/confirm/panic` 버튼 관측을 확인했다. 사용자는 버튼을 뗀 뒤 화면 유지도 확인했다. [Pi 실행 증거](../../evidence/2026-11-10-pi-feather/README.md)에 단계별 결과를 기록한다.

이 단계는 화면·Feather·버튼 두 개와 Pi의 BLE 수신기를 사용한다. 전체 Gateway daemon, CSE 연결, SQLite 대기열, systemd 자동 시작을 설정하지 않는다. 기존 Windows 관측기는 종료해 Feather의 단일 BLE 연결을 비워 둔다.

Pi에서 Python 3.11 이상과 `python3-venv`, `bluez`, `dbus` 설치 여부를 먼저 확인한다. 이번 Pi에는 필요한 OS 패키지가 이미 설치되어 있어 apt 설치를 생략했다.

```sh
python3 --version
dpkg-query -W python3-venv bluez dbus
```

필요한 패키지가 없는 새 Pi에서만 다음을 실행한다.

```sh
sudo apt update
sudo apt install python3 python3-venv bluez dbus
```

해당 revision의 `keyring/raspberry-pi-gateway/`와 `keyring/firmware/feather_probe/`를 원래 상대 경로대로 `~/keyring-bench/`에 복사한다. 비밀값과 로컬 관측 로그는 복사본의 공개 소스에 포함하지 않는다. 새 가상환경을 만들고 패키지를 설치한다.

```sh
cd ~/keyring-bench
python3 -m venv .venv
.venv/bin/python -m pip install ./keyring/raspberry-pi-gateway
systemctl is-active bluetooth
/usr/sbin/rfkill list bluetooth
```

Bluetooth 서비스가 중지되어 있으면 `sudo systemctl start bluetooth`를 실행한다. rfkill에서 Bluetooth가 soft blocked이면 `sudo /usr/sbin/rfkill unblock bluetooth`로 해제한다. 일반 사용자 PATH에 `/usr/sbin`이 빠진 환경에서도 위 절대 경로를 사용한다.

첫 등록은 다음 대화형 도구에서 진행한다.

```sh
bluetoothctl --agent KeyboardOnly
```

아래 `<FEATHER_ADDRESS>`는 검색한 `keyring-feather-lab`의 실제 주소로 치환한다. PIN 요청에는 해당 보드에 설정한 로컬 6자리 PIN을 입력한다. 주소와 PIN을 소스·문서·공개 로그에 기록하지 않는다.

```text
power on
default-agent
scan on
pair <FEATHER_ADDRESS>
trust <FEATHER_ADDRESS>
info <FEATHER_ADDRESS>
scan off
disconnect <FEATHER_ADDRESS>
quit
```

이번 실행에서는 `bluetoothctl`의 PIN 입력 과정이 취소되어, 정확한 광고 이름·service UUID·장치 object path로 대상을 제한한 임시 `KeyboardOnly` D-Bus agent로 등록했다. 같은 로컬 PIN을 사용했고 `Paired`, `Bonded`, `Trusted`를 확인한 뒤 agent를 해제했다. 펌웨어의 Secure Connections·MITM·bonding 요구는 유지했다. 같은 취소 오류가 나면 PIN 입력과 연결 해제 원인을 확인하며 자동 승인 agent나 인증 해제로 우회하지 않는다.

등록 후 같은 가상환경에서 광고와 관측을 확인한다.

```sh
cd ~/keyring-bench
.venv/bin/python keyring/firmware/feather_probe/observe.py --scan-only
.venv/bin/python keyring/firmware/feather_probe/observe.py --seconds 300
```

관측기가 실행 중일 때 두 버튼을 뗀 뒤 A0를 1초 누르고 떼고, 이어서 A1을 1초 누르고 뗀다. 수신된 상태만 콘솔에 출력되며 `released`, `confirm`, `panic`을 모두 받으면 종료 코드 0으로 끝난다. 시간 초과 결과의 `missing`은 해당 관측 시간에 수신하지 못한 상태를 뜻한다. 화면은 마지막 입력을 유지하고 BLE는 실제 해제 상태를 보낸다.
