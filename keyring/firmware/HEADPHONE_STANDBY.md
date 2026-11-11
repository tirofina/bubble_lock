# MAX9850 PCM·부팅·절전 제어

ROLE KEYRING · DOC-REV 2.0.0 · 선택형 소스 구현. 실물 시험은 아래 TODO로 추적한다.

`KEYRING_ENABLE_AUDIO=1`, `KEYRING_AUDIO_OUTPUT=2`가 MAX9850 헤드폰 PCM을 선택한다. 기본 출력 1은 MAX98357A 스피커다. 하나의 I2S 송신기와 승인된 모터 pulse의 세대 번호·마감 시각을 공유한다. `KEYRING_HEADPHONE_VOLUME=0x20`은 증폭기 -45.5dB 감쇠 설정이며 PCM amplitude 기본값은 512다. 실제 음압·권장 청취량은 실물 계측 항목이다.

## 회로와 제조사 근거

[MAX9850 Rev4](https://www.analog.com/media/en/technical-documentation/data-sheets/max9850.pdf) p12 핀 표, p16 HPS, p18 Table5, p23~28 레지스터, p32~33 시작·종료 순서와 r18 회로·PCB U16 패드를 대조했다. 구조화 추출은 [MAX9850ETI+](../pcb/r18/datasheets/extracted/MAX9850ETI__07c924.json)에 있고 추출 완성도 점수는 9.5/10이다. 이 검토 범위는 펌웨어의 핀·클록·제어 계약이다.

| 연결 | r18 회로·PCB와 펌웨어 |
|---|---|
| U16 1/2/3 | LRCLK40/BCLK41/DOUT42, U8과 공유 |
| U16 5 | MCLK GPIO13 → 직렬 저항 → HP_MCLK |
| U16 27/28 | SCL21/SDA14, I2C 100kHz |
| U16 7 ADD | GND, 7-bit 주소 0x10 |
| U16 4/17/26 | main +3V3; AUX_EN과 별도 전원 |
| U16 18/19 | J11 오른쪽/왼쪽 출력 |
| U16 21 HPS | NC, 내부 100k pull-up; 자동 잭 감지는 별도 장비 기능 |
| U16 8 GPIO | NC; 출력 차단은 I2S 데이터 gate와 I2C 제어로 수행 |

16kHz·16-bit stereo I2S, BCLK512kHz, MCLK256fs=4.096MHz를 설정한다. Table5의 16kHz/IC=0 범위는 2.816~13MHz이고 integer 최소값은 2.560MHz다. INT=1, NLSB=16으로 클록 비율을 맞춘다. ESP32-S3의 I2S MCLK 배수·GPIO 설정은 [ESP-IDF 4.4.7 I2S](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32s3/api-reference/peripherals/i2s.html)를 따른다.

## 재생과 종료 순서

부팅 시 General=0, Volume=0xBF, 출력 비트 해제, Enable=0 순서로 쓰고 제어 레지스터를 readback한다. 대기 상태는 5초마다 확인한다. 재생은 이 상태에서만 시작하며 I2S 클록과 0 데이터가 먼저 흐른다.

DAC 제어는 General=0, Volume=0xBF, Enable=0, Clock=0, ChargePump=0(내부 667kHz), LRCLK MSB=0x80/LSB=0x10, DigitalAudio=0x08을 write/readback한다. 이어 Enable=0xFD로 DAC·라인 출력·헤드폰·charge pump를 켠다. 라인 입력 비트는 0이다. 최대 50ms 동안 PLL lock, HPS, SHP/SLO/SDAC 및 과전류 상태를 확인하고 선택한 volume을 적용한다. 상태 비트 극성은 p23 Status B 정의의 active-low를 사용한다. p32의 SHP 설명 문장과의 차이는 실물 상태 확인 TODO로 남겼다.

worker는 승인 세대·deadline·인증 연결·모터·전원 fault 상태를 매 블록 검사하고 20ms 간격으로 DAC 상태와 설정을 읽는다. 시작과 종료의 I2C 독점 소유권은 atomic 상태로 관리한다. 센서와 DAC가 쓰는 Wire 트랜잭션은 mutex로 직렬화하며 대기 5ms·Wire 20ms 상한을 적용한다.

`audio.stop()`은 짧은 critical section에서 세대를 증가시키고 GPIO16 speaker mute를 적용한다. 헤드폰 모드는 DOUT GPIO matrix를 LOW 출력으로 즉시 전환한다. 이전 DMA와 worker는 새 세대 검사를 통과해야 데이터를 다시 연결할 수 있다. worker가 DAC mute→출력 해제→global shutdown→readback을 끝낸 뒤 I2S 클록을 멈춘다. 데이터 차단과 실제 아날로그 settling 시간은 각각 소프트웨어 경계와 실물 계측 값으로 기록한다.

드라이버 오류는 audio error 상태로 유지한다. 정상 취소·deadline 종료 뒤 다음 새 승인 명령을 받을 수 있다. 절전은 audio idle과 DAC shutdown readback을 확인한다. health 값은 `configured_off`, `pcm_preparing`, `pcm_playing`, `i2c_error`, `register_mismatch`로 표시한다. 중앙 command receipt의 readback 대상은 모터 GPIO이며 음향 계측은 별도 receipt다.

## 재현과 실물 TODO

`python -m platformio run -e keyring_compile_minimal -e keyring_compile_st7789 -e keyring_compile_jd9853 -e keyring_compile_headphone`으로 4개 환경을 빌드한다. Windows 한글 경로에서는 `PLATFORMIO_BUILD_DIR`를 영문 로컬 cache 경로로 설정한다.

`pip install ziglang==0.13.0` 후 `python test/run_headphone_host.py --output <local-output>`은 실제 C++ 제어 코드를 모의 I2C·시계에 연결해 부팅, register sequence, 취소, 독점 제어, NACK, readback 불일치와 준비 timeout을 실행한다. 실행 로그와 바이너리 해시는 로컬 증거 receipt에 보관한다.

| TODO | 실물 receipt 내용 |
|---|---|
| HP-CLOCK | GPIO13/40/41/42 주파수·위상·I2S slot과 0 데이터 gate |
| HP-STATUS | 실제 SHP/SLO/SDAC 극성, PLL lock·HPS·과전류와 readback |
| HP-STOP | 취소·연결 종료·deadline 도중 data gate, mute·shutdown·클록 종료 순서 |
| HP-ANALOG | 출력 전압·음압·click/pop·부하·전류·MCU reset·sleep |

실물 flash·헤드폰 계측·외부 장비 검증은 장비 준비 후 이 TODO별로 수행한다.
