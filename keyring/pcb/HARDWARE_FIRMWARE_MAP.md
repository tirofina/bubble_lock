# r18 하드웨어와 펌웨어 연결

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · firmware keyring-0.5.0 · source mapping / unverified.

보관한 원본·배선표와 현재 소스의 연결 관계다. 회로 분석·DRC/ERC·build·장비 실행·전류 측정은 하지 않았다. 조립·전기적 동작 확인 결과가 아니다.

## GPIO 설명 충돌

원본을 보존한 `r18/working_data/BOM_by_reference.csv`의 U1 Assembly_notes와 U13 설명에 예전 GPIO가 남아 있다. 아래는 현재 [GPIO 표](r18/external_parts/GPIO_pinmap.csv), [커넥터 표](r18/external_parts/Connector_pinout.csv), [펌웨어 선언](../firmware/include/board_r18.h)에 따른 인계 정정이다. 원본 BOM은 덮어쓰지 않았다.

| 기능 | 오래된 BOM prose | 현재 사용하는 연결 |
|---|---|---|
| AUX_EN | U1/U13 GPIO12 | GPIO4, HIGH ON / boot LOW |
| LCD reset | U1 GPIO15 | GPIO43 UART_TX → R69 → LCD_RST. UART0 로그 금지 |
| AUX fault | U1 GPIO5 | GPIO5 NC. 별도 AUX fault GPIO를 가정하지 않음 |
| FUEL alert | U1 GPIO48 | GPIO48 NC. MAX17048 I2C polling |
| GPIO12·15 | AUX/LCD 용도 | 현재 표는 NC |
| PSRAM | GPIO35/36/37 | N16R8 octal PSRAM 예약 |

주 fault 입력은 GPIO1 MAIN_FAULT_N이다. 실제 전류 한계·단락/구속 보호 성능은 측정하지 않았다.

## 기능별 연결

| 하드웨어 | 연결 | 현재 소스 범위 |
|---|---|---|
| U1 ESP32-S3 N16R8 | 16MB flash/8MB PSRAM | PlatformIO·USB CDC 설정. build/flash 미실행 |
| U7 MAX17048 | SDA14/SCL21,0x36 | SOC/VCELL, 실패 null. 배터리 모델 보정 미완료 |
| U6 LIS2DW12 | 같은 I2C,0x19,INT1→17 | 축/motion·선택형 EXT0 wake. 낙상 판정 아님 |
| SW2 CONFIRM/SW1 PANIC | GPIO6/7 active-low | debounce·관측·화면 창. grant/승인 생성 없음 |
| Q1·J6 모터 | GPIO3,AUX_EN4 | 승인된 pulse·GPIO readback. 물리 진동 검출 아님 |
| U8 MAX98357A·J4 | LRCLK40/BCLK41/DOUT42,AMP_GATE16 | 선택형 cue. HIGH mute. BTL 두 단자 모두 GND 아님 |
| J3 LCD | CS18/DC8/MOSI38/SCK39/RESET43,BL2 | ST7789/JD9853 선택. write-only/실물 초기화 미확인 |
| J10 microSD | CS10/MISO11,MOSI38/SCK39 공유 | 선택형 평문 receipt. 감지 접점 미사용/자동format 없음 |
| U13 TPS2553 보조 전원 | GPIO4,모터·음향·백라이트 공유 | alert가 백라이트 선점. 실제 부하 미확인 |
| U3 BQ24074 | EN1 GPIO47/EN2 GPIO9 | USB100 기본. 충전 회로·온도 보호·LED는 하드웨어 |
| U10 TLV6700·D2 | 충전 온도 gate/충전 LED | 사용자 명령용 GPIO LED로 제어하지 않음 |
| U15 INA219B | 전원 모니터,I2C A0/A1 GND | 전류·전력 읽기 미구현. BOM calibration 설명을 실측값으로 쓰지 않음 |
| U16 MAX9850·J11 | I2C0x10/I2S,MCLK13,별도 analog return | 헤드폰 DAC 미구현. 스피커 드라이버와 구분 |
| U11/U12/U17 | 입력 제한·UVLO/supervisor/REG_READY | 하드웨어 경로 |

J3 pin1은 main +3V3, pin8은 LCD_BL_SUPPLY다. logic/backlight 공급을 구분한다. J2 pin1 VBAT/pin2 GND이며 mating housing의 실제 배터리 극성은 별도 확인이 필요하다. J6은 AUX3V3/VIB_LOW 공급·low-side 연결이다. 최신 커넥터 표를 배선 기준으로 사용한다.

[ST7789 외장 표](r18/external_parts/External_parts_st7789_154.csv)와 [JD9853 외장 표](r18/external_parts/External_parts_jd9853_201.csv)를 함께 보관했다. 동일 PCB에서 실장한 화면을 profile로 선택한다. JD9853 geometry/power/gamma 초기화와 주변장치 전류·실제 배선은 미확인이다. [주변장치](../firmware/PERIPHERALS.md)와 [저전력](../firmware/POWER_WAKE.md)에 제약이 있다.

과거 검사 통과 문구를 현재 조립본/펌웨어의 결과로 사용하지 않는다. 실제 조립·측정·통합 receipt 전까지 implemented/unverified를 유지한다.
