# 빌드용 프로필과 미실행 범위

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · firmware keyring-0.7.0.

계획서의 build 산출물에 맞춰 세 프로필을 작성했다. 아직 dependency 설치·빌드·검증을 실행하지 않았다. 아래는 실행 결과가 아니라 사용자 명시 요청 뒤 사용할 명령이다. 실제 flash/COM·장비 시험은 별도 작업이다.

| environment | 선택 기능 |
|---|---|
| keyring_compile_minimal | LCD/audio/SD/sleep 기본값, INA219·DAC standby 포함 |
| keyring_compile_st7789 | ST7789, audio/SD/sleep을 컴파일에 포함 |
| keyring_compile_jd9853 | JD9853, audio/SD/sleep을 컴파일에 포함 |

세 compile profile은 KEYRING_IGNORE_PROVISIONING으로 로컬 provisioning.h와 jd9853_panel.h를 포함하지 않는다. 장치별 passkey는 기본 invalid0이며 이 결과물을 provisioned device firmware로 취급하지 않는다. local 실제 장치 환경 keyring_r18은 기존 provisioning 경로를 사용한다. bare pio run의 default는 keyring_r18으로 유지했다.

```sh
pio run -e keyring_compile_minimal -e keyring_compile_st7789 -e keyring_compile_jd9853
```

프로필의 extends/build_flags 상속은 [PlatformIO 공식 설명](https://docs.platformio.org/en/latest/projectconf/sections/env/options/advanced/extends.html)에 맞춰 기본 USB/PSRAM flags를 명시적으로 이어받는다. espressif32/ArduinoJson/Arduino_GFX dependency pin은 기존 설정을 사용한다. 빌드가 성공해도 두 패널의 실제 초기화·크기·색·전기적 동작, BLE pairing·command execution·전력·RTC wake·SD·음향·중앙 연동을 증명하지 않는다.

실제 요청 뒤 남길 자료는 환경별 실제 exit/result와 도구/dependency revision, 에러 로그, artifact hash이며 실행하지 않은 결과·통과 횟수·실물 receipt는 채우지 않는다. 이 문서는 현재 전체 목표의 verified/released 상태를 올리는 근거가 아니다.
