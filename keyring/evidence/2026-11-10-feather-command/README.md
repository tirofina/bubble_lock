# Feather 내장 LED 명령 프로필

KEYRING 남호 · DOC-REV 2.0.0 · 2026-11-10.

기존 Feather 관측 프로필 0.1.1과 별도로 명령 프로필 0.2.0을 추가했다. 명령 프로필은 시험 Gateway의 BLE 명령을 받아 내장 빨간 LED의 GPIO13을 제어하고 적용 시점의 핀 읽기값을 영수증에 담는다. 명령 프로필의 ON은 OFF 명령·연결 해제·재부팅까지 유지된다. 제작 PCB의 모터 펄스 시험은 해당 PCB에서 진행한다. [Adafruit 핀 설명](https://learn.adafruit.com/adafruit-esp32-feather-v2/pinouts)

| 시험 | 확인 범위 |
|---|---|
| 관측·명령 빌드 | Arduino CLI 1.4.1, ESP32 Arduino 3.3.11, Feather V2 FQBN. 임시 복사본에 합성 PIN으로 BLE 코드를 포함해 두 프로필을 컴파일한다. |
| 호스트 명령 시험 | 실제 명령 parser와 journal 코드를 ArduinoJson 6.21.5로 실행한다. NVS·시간·RTOS 큐·GPIO는 모의 객체다. |
| 실물 승인 명령 | Pi와 팀 중앙 API, 임시 Mobius4에 연결하고 LED와 CSE 영수증을 비교한다. 장비 업로드와 이 실물 시험은 대기 상태다. |

호스트 시험은 ON/OFF, 동일 ID의 재부팅 후 중복 방지, 충돌, 낮은 epoch/grant, 중복 JSON 필드, 이전 세션과 연결 해제 프레임, 적용 전 기한 만료, NVS intent/completion 실패, 16개 journal 포화와 손상을 확인했다. 부팅 뒤 중복 영수증은 과거 적용 시점의 readback을 반환하며 현재 LED는 꺼진 상태로 유지된다.

재현 시 Visual Studio 개발자 PowerShell에서 저장소 루트로 이동한다. 출력 폴더와 ArduinoJson 경로를 로컬 절대 경로로 지정한다.

```powershell
$native = Join-Path $PWD 'keyring/firmware/feather_probe/tests/native'
$json = '<ArduinoJson 6.21.5의 src 절대 경로>'
$out = '<새 로컬 출력 디렉터리>'
cl /nologo /utf-8 /std:c++17 /EHsc /I"$native/stubs" /I"$json" /Fo"$out/feather-native.obj" /Fe"$out/feather-native.exe" "$native/feather_commands_test.cpp"
if ($LASTEXITCODE -eq 0) { & "$out/feather-native.exe" }
```

하드웨어 프로필과 Pi 실행 절차는 [Feather README](../../firmware/feather_probe/README.md#내장-led를-쓰는-명령-프로필)에 있다. 컴파일 출력과 호스트 결과는 [receipt.json](receipt.json)에 소스와 함께 해시로 연결한다.
