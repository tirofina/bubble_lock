# 빌드용 프로필과 실제 로컬 결과

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · firmware keyring-0.7.0.

2026-10-29 사용자 명시 허가로 개발 dependency 설치와 세 프로필의 로컬 빌드를 수행했고 모두 통과했다. 실제 flash/COM·장비 시험은 실행하지 않았다. source commit은3c27f4d이며 [원본 로그·receipt·SHA256](../evidence/2026-10-29-local-validation/README.md)에 실제 환경과 실패·수정 이력도 보존했다.

| environment | 선택 기능 |
|---|---|
| keyring_compile_minimal | LCD/audio/SD/sleep 기본값, INA219·DAC standby 포함 |
| keyring_compile_st7789 | ST7789, audio/SD/sleep을 컴파일에 포함 |
| keyring_compile_jd9853 | JD9853, audio/SD/sleep을 컴파일에 포함 |

세 compile profile은 KEYRING_IGNORE_PROVISIONING으로 로컬 provisioning.h와 jd9853_panel.h를 포함하지 않는다. 장치별 passkey는 기본 invalid0이며 이 결과물을 provisioned device firmware로 취급하지 않는다. local 실제 장치 환경 keyring_r18은 기존 provisioning 경로를 사용한다. bare pio run의 default는 keyring_r18으로 유지했다.

```sh
pio run -e keyring_compile_minimal -e keyring_compile_st7789 -e keyring_compile_jd9853
```

Windows에서 한글 출력 경로는 Xtensa 링커가 map 파일을 열지 못했다. 저장소를 옮기지 않고 영문 경로를 지정해 해결했다. 이번 실행의 명령은 다음과 같다. 이 환경변수는 해당 shell의 출력 위치만 바꾼다.

```powershell
$env:PLATFORMIO_BUILD_DIR = 'C:/Users/NH/.cache/keyring-validation-20261029/build'
python -m platformio run -e keyring_compile_minimal -e keyring_compile_st7789 -e keyring_compile_jd9853
```

| environment | 실제 결과 | RAM 사용 bytes | flash 사용 bytes | firmware.bin bytes |
|---|---|---:|---:|---:|
| keyring_compile_minimal | SUCCESS | 58160 | 807093 | 807456 |
| keyring_compile_st7789 | SUCCESS | 59484 | 889965 | 890384 |
| keyring_compile_jd9853 | SUCCESS | 59484 | 889581 | 890000 |

최종 matrix exit0,3 succeeded,총5분59.074초다. 사용한 도구는 PlatformIO Core6.2.0/espressif32 6.9.0/Arduino2.0.17/Xtensa8.4.0+2021r2-patch5다. ArduinoJson6.21.5는 유지했다. 처음의 Arduino_GFX1.6.9는 core3.x 헤더 부재로 실패해 Arduino2.x 분기가 있는 v1.4.9 commit3cc08c4e9ab6d85807e49b657d73fae10871616e로 바꿨다. Button에는 C++11 호환 명시적 생성자를 추가했다.

프로필의 extends/build_flags 상속은 [PlatformIO 공식 설명](https://docs.platformio.org/en/latest/projectconf/sections/env/options/advanced/extends.html)에 맞춰 기본 USB/PSRAM flags를 명시적으로 이어받는다. 빌드 성공은 두 패널의 실제 초기화·크기·색·전기적 동작, BLE pairing·command execution·전력·RTC wake·SD·음향·중앙 연동을 증명하지 않는다.

각 바이너리·ELF·map·bootloader·partition의 실제 크기/hash는 receipt.json에 있다. 바이너리는 로컬 build directory에 보관하며 Git에는 소스와 로그·hash만 올린다. 전체 목표의 verified/released 상태는 올리지 않는다.
