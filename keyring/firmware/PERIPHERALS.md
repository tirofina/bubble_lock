# r18 화면·스피커·microSD 구현

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · firmware keyring-0.4.0 · implemented / unverified.

사용자가 ST7789와 JD9853 **두 화면 모두 지원**을 선택했다. 한 보드에 장착한 화면을 빌드 설정으로 선택한다. J3에는 LCD MISO가 없어 자동 식별을 시도하지 않는다. `begin()` 성공은 소프트웨어 초기화 결과이며 화면 식별·정상 표시 증거가 아니다. 이번 변경은 소스와 문서 작성만 수행했으며 검증·빌드·실행·flash·장비 시험은 미실행이다.

## 화면 선택

로컬 `include/provisioning.h`에서 설정한다. 장치별 passkey 설정도 필요하다. 기본 profile0은 화면 기능 비활성이다.

| 옵션 | 의미 |
|---|---|
| `KEYRING_DISPLAY_PROFILE=1` | ST7789 1.54인치, 240×240, Arduino_GFX ST7789 드라이버 |
| `KEYRING_DISPLAY_PROFILE=2` | JD9853 2.01인치 후보, 기본 240×296, 별도 JD9853 드라이버 |
| `KEYRING_LCD_ROTATION=0..3` | 장착 방향, 기본0 |
| `KEYRING_LCD_X_OFFSET`, `KEYRING_LCD_Y_OFFSET` | 기본0, 모듈별 RAM 표시 원점. 회전별 원점이 다르면 추가 조정 필요 |
| `KEYRING_LCD_SHOW_MS` | 기본5000, 허용1000~30000ms. 시작·확인/비상 버튼 눌림 때 백라이트 창 요청 |
| `KEYRING_LCD_SPI_HZ` | 기본10MHz. 1~20MHz 구성 범위이며 실물에서 확인된 최대 속도가 아님 |
| `KEYRING_JD9853_WIDTH`, `KEYRING_JD9853_HEIGHT` | 기본240/296. 판매 자료의 240×296·320×240 표기가 충돌하여 실물 확인 필요 |
| `KEYRING_JD9853_BGR`, `KEYRING_JD9853_INVERT` | 기본0/1. 실제 모듈의 색 순서·반전에 맞춰야 함 |

화면은 BLE 연결/인증, 실제 배터리 또는 `--`, 버튼, 모터 GPIO, motion event 수, journal/fault, SD 상태를 표시한다. grant 승인·물리적 진동 확인을 뜻하지 않는다. passkey·장치 ID·command ID·사용자 위치를 화면에 표시하지 않는다. 폰트는 라이브러리 기본 ASCII이며 한국어 폰트는 포함하지 않았다.

SPI GPIO는 MOSI38/SCK39, LCD CS18/DC8/RESET43이다. UART0 TX는 RESET43과 충돌하므로 USB CDC만 사용한다. LCD logic VDD는 main +3V3, 백라이트 공급은 별도 LCD_BL_SUPPLY다.

### JD9853 미확인 범위

기본 경로는 reset → SWRESET → sleep-out → COLMOD `0x05`(RGB565) → inversion → display-on과 JD9853 MADCTL/주소 창 처리다. ST7789 초기화표나 COLMOD `0x55`를 재사용하지 않는다. 이 경로가 구매한 2.01인치 패널의 power/gamma 설정까지 보장하지는 않는다.

모듈 초기화표가 확보되면 로컬 `include/jd9853_panel.h`에 `void keyringJd9853PanelInit(Arduino_DataBus &bus)`를 정의할 수 있다. reset 이후, DCS sleep-out 이전에 호출되며 자체 beginWrite/endWrite와 필요한 delay를 수행한다. 파일은 Git ignore된다. 공유할 모듈 초기화표는 출처와 함께 별도 추적 파일로 편입한다. 다른 크기 BOE/Waveshare 패널의 vendor register table은 넣지 않았다.

독립 드라이버 저자의 [jd9853-rs blocking 구현](https://github.com/drindr/jd9853-rs/blob/186e52d3c264c899d8910a63297e48a1d2a8d516/src/blocking.rs)과 [MADCTL 정의](https://github.com/drindr/jd9853-rs/blob/186e52d3c264c899d8910a63297e48a1d2a8d516/src/lib.rs)를 읽었다. 이는 구매 모듈 제조사의 확인 자료가 아니다. 제조사 데이터시트 제공 사이트 buydisplay가 HTTP403을 반환해 추가 요청을 중단했다. 제조사 문서를 읽었다고 표시하지 않는다.

그래픽은 [Arduino_GFX v1.4.9 / 3cc08c4](https://github.com/moononournation/Arduino_GFX/tree/3cc08c4e9ab6d85807e49b657d73fae10871616e)를 dependency로 고정했다. Arduino 2.0.17과 호환되는 버전으로 고정했다. 처음 선택한1.6.9는 esp32-hal-periman.h 부재로 컴파일에 실패했다. [빌드 기록](BUILD_PROFILES.md)에 실제 결과를 연결한다. [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)에 라이선스·참고 출처가 있다.

## 승인된 출력의 오디오

`KEYRING_ENABLE_AUDIO=1`은 MAX98357A 스피커 경로를 선택한다. 기본0이다. 유효한 중앙 명령을 NVS에 COMPLETED로 기록하고 GPIO ON readback을 얻은 뒤에만 cue를 요청한다. 중복 명령은 재생하지 않고, 버튼은 자체적으로 모터·음향을 실행하지 않는다. receipt의 state/readback은 모터 GPIO이며 음향 확인을 뜻하지 않는다.

I2S LRCLK40/BCLK41/DOUT42, 16kHz/16bit, 좌우 동일 PCM을 사용하는 별도 FreeRTOS worker다. 주파수 기본880Hz, PCM amplitude 기본512(허용0~2048)다. SPL·안전 음량·소비전류의 측정치가 아니다. 실제 청취 음량은 미확인이다. MAX9850 재생과 GPIO13 MCLK 생성은 구현하지 않았다.0.7.0에는 별도 [헤드폰 DAC 종료 요청·공유 I2S guard](HEADPHONE_STANDBY.md)를 추가했다.

연결·인증·generation·기한·motor/AUX GPIO·fault를 재확인한 후 Q4 mute를 해제한다. 취소는 generation을 바꾸고 GPIO16 HIGH로 즉시 mute한다. 모터 타이머와 BLE disconnect도 이를 호출하며 I2S 쓰기를 기다리지 않는다. worker는 mute 후 LRCLK/BCLK를 정지한다. 일반 파형 끝에는 ramp를 적용했지만 급한 취소·전원 차단의 click/pop은 미확인이다.

형식·clock·shutdown 근거는 로컬 [MAX98357A 제조사 데이터시트](https://www.analog.com/media/en/technical-documentation/data-sheets/max98357a-max98357b.pdf)와 [ESP-IDF4.4.7 ESP32-S3 I2S API](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32s3/api-reference/peripherals/i2s.html)다. 스피커 출력은 BTL이며 어느 단자도 GND에 연결하지 않는다.

## 공용 전원·SPI·절전

TPS2553 보조 전원에는 모터·스피커·백라이트가 연결된다. `aux_rail`은 alert와 display 소유자를 관리하며 alert 중 백라이트를 끈다. 모터가 끝나도 유효한 화면 창은 복구한다. 별도10ms ESP timer가 창 만료·fault를 처리하므로 SD/화면 I/O를 기다리지 않는다. 이는 설정 주기이며 실측 차단 지연이 아니다. 실제 돌입/구속/음향/백라이트 전류와 결합 부하는 미확인이다.

`peripherals` worker 하나가 LCD와 microSD I/O를 모두 소유한다. CS18/10은 초기 HIGH이며 SPI transaction이 mode/속도를 전환한다. SD MISO11도 공통 SPI에 연결한다. 다른 task에서 이 SPI나 SD API를 직접 호출하면 안 된다. 모터 타이머·BLE callback에는 SPI/filesystem 작업이 없다. 절전은 audio/보조 전원/I/O/로그 queue가 유휴일 때만 진행하고 예약 시 worker 신규 I/O를 막는다. 긴 카드 지연은 절전을 막을 수 있다.

## 선택형 SD receipt 복사

`KEYRING_ENABLE_SD_LOG=1`인 장치만 `/keyring-receipts.jsonl`에 receipt를 append한다. 기본0이며 관측/가속도/위치를 파일로 복제하지 않는다. 파일은 command ID/hash와 장치 ID 등을 포함하는 **평문**이다. 접근이 통제된 카드의 진단 용도로 선택한다. SD 암호화는 구현하지 않았다.

최대8행·행당1024byte RAM queue이며 실패/초과 행은 `sdDropped`로 집계한다. 기본 파일 상한1MiB(`KEYRING_SD_MAX_BYTES`)에 도달하면 `full`로 중지한다. mount/open/write 오류도 자동 재시도 없이 append를 중지한다. 초기 mount 중 receipt는 보장하지 않는다. SD 유실이 BLE receipt나 NVS 성공 여부를 변경하지 않는다.

[Arduino ESP32 2.0.17 SD API](https://github.com/espressif/arduino-esp32/blob/2.0.17/libraries/SD/src/SD.h)의 `format_if_empty=false`로 mount하며 자동 format·삭제·순환 덮어쓰기를 하지 않는다. 카드 감지 접점은 미사용이므로 hot-plug를 자동 처리하지 않는다. 동기 write/flush/close를 해도 FAT 전원 차단 원자성·완전 저장을 보장하지 않으며 부분 마지막 행이 남을 수 있다. NVS journal이 중복 실행 판단의 정본이다.

## 미실행 인수 항목

| ID | 남은 실물 확인 | 결과 |
|---|---|---|
| KR-LCD-01 | 각 화면 초기화·색·회전·해상도 경계·전압/백라이트 | 미실행 |
| KR-AUDIO-01 | 승인/중복/취소/단절/기한/fault의 mute·파형·clock·음량 | 미실행 |
| KR-AUX-01 | 부하 우선순위·전류·TPS2553 fault·타이머 지연 | 미실행 |
| KR-SD-01 | 카드 없음/포맷 불일치/full/쓰기 지연/전원 차단/공용 SPI | 미실행 |
| KR-SLEEP-09 | 화면·audio·SD I/O 중 절전 차단과 유휴 wake | 미실행 |
