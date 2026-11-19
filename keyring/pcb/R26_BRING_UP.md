# r26 앞면 조립판 첫 구동

1. 배터리와 USB를 뺀 상태에서 J2 극성을 확인한다. J9 전원 스위치의 COM은 J9.2, ON은 J9.1에 연결한다. 우회 저항 R73이 실장된 판에서는 스위치의 남은 접점을 비워 두고 OFF에서 J9.2를 끌어내릴 때 J9.3과 47 kΩ으로 연결한다.
2. 배터리로 전원을 공급하고 J3.1과 J3.2 사이에 약 3.3 V가 나오는지 확인한다. 이 조립판의 USB-C는 ESP32 데이터 연결에 사용한다. 배터리는 외부 1셀 충전기로 충전한다.
3. 전원을 끈 뒤 1.54인치 ST7789의 GND·VCC·SCL·SDA·RST·DC·CS·BL을 J3.2·1·4·3·7·6·5·8에 연결한다. 이후 배터리를 연결하고 USB 데이터 케이블을 PC에 꽂는다.
4. COM에서 응답하는 ESP32-S3가 대상인지 확인하고 장치별 BLE 설정으로 `keyring_r26_front_st7789`를 빌드한다. 기존 데모를 복구할 수 있게 덮어쓸 플래시 구간을 먼저 보관한다. r26은 기존 데모와 NVS 시작·크기를 공유한다.
5. USB 콘솔 115200 baud에서 `?`로 `r26-front-assembly`와 실행 이미지 해시를 확인한다. 확인·비상 버튼을 각각 눌렀다 떼고 `CONFIRM`·`PANIC`, USB 전환과 화면 그리기 누계를 비교한다.
6. Pi에서 BLE 페어링을 마친 뒤 Gateway에 장치 ID·BLE 주소·펌웨어 revision을 지정한다. `BLE_GATT_PROFILE=core-v1`, `BLE_BOARD_REVISION=r26-front-assembly`, `COMMANDS_ENABLED=false`로 해당 장치의 관측을 수집한다. 운영 프록시를 쓰는 환경의 CSE URL은 `https://bubblelock.iptime.org/onem2m`이며 Gateway별 mTLS와 운영 서버에 등록된 경로가 필요하다.

이 프로필은 LCD·버튼·BLE 관측용이다. 앞면 조립에서 빠진 잔량계·가속도계·INA219와 충전·보조 전원 제어는 실측 증거의 대상에서 제외된다. BLE 명령 및 모터 출력은 비활성화한다.

0.7.27의 r26 화면은 어두운 배경에 Privacy Bubble 로고와 `READY`를 표시한다. 버튼을 누르면 중앙 상태 카드에 `CONFIRM` 또는 `PANIC`을 색과 아이콘으로 표시하고, 버튼을 떼어도 마지막 상태를 유지한다. 전환할 때는 중앙 카드만 다시 그린다. 앞면 조립판의 배터리 영역에는 시연용 고정 다섯 칸을 표시한다.
