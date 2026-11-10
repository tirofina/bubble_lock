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

기본 관측 프로필의 시험 Gateway에 `keyring-feather-lab` 장치 ID와 실제 BLE 주소를 등록하고 `core-v1`을 선택한다. 펌웨어 허용 목록에는 `feather-probe-0.1.1`을 넣는다. 격리된 시험 Gateway와 관측 컨테이너에서 A0의 `confirm`, A1의 `panic`, 떼었을 때 `released`를 확인한다. 배터리는 `null`이므로 native oneM2M 관측 경로에서 확인한다.

## 내장 LED를 쓰는 명령 프로필

`KEYRING_FEATHER_ENABLE_COMMANDS=1`로 컴파일하면 BLE identity가 `feather-probe-0.2.0`으로 바뀐다. 이 프로필의 `desiredState.state`는 보드의 빨간 내장 LED GPIO13을 제어한다. `true`는 다음 OFF 명령·연결 해제·재부팅까지 켜지고 `false`는 즉시 끈다. 영수증의 readback은 적용 시점의 GPIO 입력값, 관측의 state는 현재 입력값이다. A0/A1의 화면 표시는 별도로 유지한다. [Adafruit 보드 핀 설명](https://learn.adafruit.com/adafruit-esp32-feather-v2/pinouts)

명령과 영수증은 CORE v1 GATT의 `...0003...` WRITE와 `...0004...` NOTIFY를 쓴다. 기존 Secure Connections·MITM·bonding을 적용한다. 세션·영수증 구독·기한을 대조하고, 명령 ID·hash·epoch·grant를 별도 NVS journal에 먼저 저장한 후 GPIO를 변경한다. 같은 ID와 같은 내용은 저장한 결과를 반환한다. 저장 의도만 남은 명령은 `INDETERMINATE`로 응답한다. 16개를 보관하며 손상된 journal과 만석에는 각각 `STORAGE_ERROR`, `JOURNAL_FULL`을 반환한다. 자동 삭제는 하지 않는다.

명령 프로필의 빌드에는 ArduinoJson 6.21.5가 필요하다. 기존 로컬 `provisioning.h`에 등록용 PIN을 설정하고, 시험용 산출물에는 새 출력 경로를 지정한다. 실제 PIN은 명령줄·로그·Git 밖의 provisioning 파일에만 둔다.

```powershell
arduino-cli compile --fqbn esp32:esp32:adafruit_feather_esp32_v2 `
  --library '<ArduinoJson 6.21.5 라이브러리 폴더>' `
  --build-property 'compiler.cpp.extra_flags=-DKEYRING_FEATHER_ENABLE_COMMANDS=1' `
  --output-dir '<새 로컬 빌드 폴더>' keyring/firmware/feather_probe
```

실물 시험은 Gateway 0.2.7과 [Feather LED ON/OFF 절차](../../raspberry-pi-gateway/TESTING.md#feather-led-onoff-시험)를 사용한다. ON과 OFF를 별도 명령으로 발급하고 보드 LED를 직접 본다. Gateway SQLite와 Mobius4의 명령 해시·readback 대조는 별도 읽기 전용 도구가 수행한다. 재연결·재부팅 중복 방지와 제작 PCB의 모터 펄스·센서·전력은 각각 별도 실물 시험이다.

아래 단독 관측과 relay 도구는 기존 0.1.1 프로필용이다. 명령 프로필은 전체 Gateway로 실행한다. [명령 프로필 빌드·로컬 시험 기록](../../evidence/2026-11-10-feather-command/README.md)

Pi 연결 전에는 Gateway 의존성이 설치된 Windows Python으로 같은 BLE 수신기를 쓸 수 있다. 저장소 루트에서 실행한다.

```powershell
$env:PYTHONPATH = Join-Path $PWD 'keyring/raspberry-pi-gateway/src'
python keyring/firmware/feather_probe/observe.py --scan-only
python keyring/firmware/feather_probe/observe.py --seconds 90
```

첫 명령은 해당 광고만 검색한다. Windows에서는 `keyring-feather-lab`을 먼저 PIN으로 페어링한 뒤 두 번째 명령을 실행한다. 이번 벤치에서는 Windows의 PIN 페어링 API에서 암호화와 인증을 요구해 등록했다. 버튼을 뗀 상태, A0, A1을 차례로 확인하며 도구는 결과를 콘솔에 출력한다.

## Feather scoped 적용 영수증

Gateway 0.2.19와 [격리 Feather 설정](../../dev/mobius4/README.md#feather-벤치-경로)을 준비한 뒤, Pi에서 기존 관측기와 Gateway를 멈추고 시험을 실행한다. 벤치 환경 파일의 `GATEWAY_DATABASE`에는 존재하지 않는 시험 전용 경로를 지정한다. relay가 실제로 사용하는 DB는 `--scoped-state` 아래에 만든다.

```sh
.venv/bin/python keyring/firmware/feather_probe/relay.py \
  --env "$PRIVATE_BENCH/feather-scoped.env" \
  --scoped-state "$PRIVATE_BENCH/feather-scoped-state" \
  --output "$PRIVATE_BENCH/feather-scoped-run-01" --frames 5 --seconds 90
```

시작 안내가 나오면 버튼 해제, A0 확인, A1 비상을 차례로 관측시킨다. `--frames`는 최소 수집 개수다. 도구는 세 상태와 최소 개수를 모두 모을 때까지 기다리고 최대 100개를 수집한다. 각 native cin 전체와 관측 해시를 대조한다. 각 관측은 scoped MQTT 적용 영수증의 sequence와 본문 해시를 대조하며, 마지막 `featherState`를 HTTPS로 읽는다.

`receipt.json`의 `publishedCount`와 `deliveryChannels`는 native 전송 수다. `scopedReceiptCount`, `scopedReceipts`와 `sdtReadbackState`는 별도로 기록한다. 관측 전용 Feather의 버튼 상태는 cin으로 확인한다. SDT의 false는 펌웨어가 보고한 출력 상태다.

반복 실행 시 `--scoped-state`는 같은 격리 경로를 쓰고 출력 폴더는 새로 지정한다. 시험 전용 SQLite를 재사용해 wire sequence를 이어 간다. 이전 실행의 미전송 행이 남아 있거나 scope 정보가 맞지 않으면 중단한다. 그 DB를 보존한 채 원인을 확인한다. scope 또는 DB를 삭제해 sequence를 처음부터 다시 발급하는 방식은 쓰지 않는다. 이번에는 서버의 빈 SDT 조회까지만 확인했다. [준비 기록](../../evidence/2026-11-10-core-scoped-feather-readback/README.md)

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

고정 거리에서의 수신과 의도적으로 링크를 끊은 뒤 재연결 시간을 남길 때는 Gateway 0.2.16의 [실물 BLE 거리·재연결 기록](../../raspberry-pi-gateway/TESTING.md#실물-ble-거리재연결-기록)을 사용한다. 이 도구는 Feather의 보드 ID `feather-esp32-v2`를 확인한 뒤 벤치 결과로 기록한다.

등록 후 같은 가상환경에서 광고와 관측을 확인한다.

```sh
cd ~/keyring-bench
.venv/bin/python keyring/firmware/feather_probe/observe.py --scan-only
.venv/bin/python keyring/firmware/feather_probe/observe.py --seconds 300
```

관측기가 실행 중일 때 두 버튼을 뗀 뒤 A0를 1초 누르고 떼고, 이어서 A1을 1초 누르고 뗀다. 수신된 상태만 콘솔에 출력되며 `released`, `confirm`, `panic`을 모두 받으면 종료 코드 0으로 끝난다. 시간 초과 결과의 `missing`은 해당 관측 시간에 수신하지 못한 상태를 뜻한다. 화면은 마지막 입력을 유지하고 BLE는 실제 해제 상태를 보낸다.

## Pi에서 임시 CSE로 실제 관측 전달

`relay.py`는 명시적으로 실행하는 MQTT/HTTPS 벤치 도구다. 실제 Feather에서 받은 관측을 `Gateway.observation`으로 검증하고 새 SQLite outbox에 기록한 뒤, 기존 `_outbox_loop`와 `TransportHub`로 전송한다. 각 oneM2M contentInstance를 HTTPS로 다시 읽어 요청 ID·응답 코드·자원 이름·payload 전체가 일치하는지 확인한다. command·authorize·credential·health loop와 전체 Gateway daemon은 시작하지 않는다.

별도로 준비한 격리 CSE에 빈 관측 container와 새 시험 CA/client 인증서가 있어야 한다. 이 도구는 서버·자원·인증서를 생성하지 않는다. PC의 시험 CSE가 loopback에만 바인딩되어 있으면 별도 SSH reverse tunnel을 사용하며, Pi 쪽 HTTPS origin의 주소가 서버 인증서 SAN과 일치해야 한다. 인증서 검증을 해제하지 않는다.

Git 밖의 private 환경 파일에 `GatewayConfig`의 필수 값을 지정한다. 벤치 CLI는 `--env` 파일만 설정 정본으로 읽으며, 부모 프로세스의 환경변수는 설정을 읽는 동안 격리한 뒤 원복한다. `MQTT_ENABLED=false`, `CORE_BRIDGE_ENABLED=false`, `BLE_GATT_PROFILE=core-v1`, `BLE_PAIR=true`, `FIRMWARE_REVISION_ALLOWLIST=feather-probe-0.1.1`을 사용한다. `BLE_DEVICES`에는 등록한 `keyring-feather-lab` 한 대만 넣는다. `TLS_CA_FILE`, `TLS_CERT_FILE`, `TLS_KEY_FILE`은 Pi의 절대 경로를 사용한다. 실제 주소·credential은 소스나 공개 로그에 넣지 않는다.

MQTT 전송을 시험할 때는 같은 파일에서 `MQTT_ENABLED=true`와 실제 `MQTT_HOST`, `MQTT_PORT`를 지정한다. `CORE_BRIDGE_ENABLED=false`는 유지하며 broker의 client 인증서 CN·oneM2M 요청/응답 topic ACL을 시험 CSE와 맞춘다. MQTT 응답 구독이 준비된 후 BLE 수집을 시작하고 이 대기도 전체 제한시간에 포함한다. MQTT application 응답이 없으면 기존 전송기의 HTTPS fallback을 사용한다. receipt의 `deliveryChannels`는 성공한 전송만 `mqtt` 또는 `https`로 세며, MQTT 시도 후 HTTPS로 완료된 건은 `https`에 포함한다.

`PC_API_URL`은 HTTPS 설정값이 필요하지만 이 도구는 API에 요청하지 않는다. `GATEWAY_DATABASE`도 존재하지 않는 절대 경로여야 한다. 도구는 기존 DB를 거절하고 실제 DB 경로를 새 출력 폴더의 `gateway.sqlite3`로 제한한다. 부모 폴더만 먼저 준비하고 `--output`에는 아직 없는 디렉터리를 지정한다. 아래 환경 파일 경로는 준비한 파일의 실제 경로로 바꾼다.

```sh
cd ~/keyring-bench
.venv/bin/python keyring/firmware/feather_probe/relay.py \
  --env /home/pi/keyring-private/relay.env \
  --output /home/pi/keyring-private/relay-run-01 \
  --frames 5 --seconds 90
```

실행 중에는 다른 BLE 관측기를 종료한다. `--frames`는 1~100개의 실제 관측을 선택하며 기본값은 5다. `--seconds`는 연결·수집·outbox 비우기·readback 전체의 제한시간이며 5~600초, 기본값은 90초다. 모든 버튼 종류를 자동으로 요구하지 않으므로 receipt의 `buttonStates`를 실제 시험한 입력 범위로 해석한다.

출력 디렉터리는 0700, 내부 파일은 umask 077로 생성하고 DB의 lifetime `flock`을 유지한다. `observations.jsonl`과 SQLite는 private 원본이며 공개하지 않는다. `receipt.json`과 표준 출력에는 count·sequence·buttonState·SHA256·성공/실패 코드·TLS 검증 정책만 남는다. TLS 1.3 이상·서버 인증서/주소 검증·client 인증서 사용은 설정 정책이며, 도구가 handshake 버전을 실측했다고 표시하지 않는다. 수신·전송·readback 일부만 진행된 실패도 partial receipt와 0이 아닌 종료 코드를 남긴다. 같은 출력 디렉터리로 재실행하지 않는다.

벤치 harness의 회귀시험은 별도 네 개이며 환경 파일 격리·복원, BLE/HTTP 모의와 새 SQLite outbox를 통한 성공 readback·불일치 거절, MQTT application 응답으로 완료된 전송의 경로 집계를 확인한다. 실물 BLE·CSE 시험과 구분한다. 저장소 루트의 PowerShell에서:

```powershell
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/tests')
python -m unittest discover -s keyring/firmware/feather_probe/tests -v
python keyring/firmware/feather_probe/relay.py --help
```
