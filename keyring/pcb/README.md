# 키링 r18 하드웨어 인수인계

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · source included / unverified.

기존 **r18-hand-solder** 프로젝트를 [r18](r18/README.md)에 인계용 snapshot으로 포함했다. 팀원이 clone으로 회로도·PCB·프로젝트·로컬 심볼/풋프린트·모델·기존 BOM·배선표를 받을 수 있다. 원래 작업공간의 파일과 제조 산출물은 보존했다. 회로·배치·패드를 새로 설계하거나 변경하지 않았다.

| 자료 | 경로 |
|---|---|
| 프로젝트 | [privacy_bubble.kicad_pro](r18/privacy_bubble.kicad_pro) |
| 회로도 | [privacy_bubble.kicad_sch](r18/privacy_bubble.kicad_sch) |
| PCB | [privacy_bubble.kicad_pcb](r18/privacy_bubble.kicad_pcb) |
| 인계 파일 출처·byte 수·SHA256 | [source-inventory.json](r18/source-inventory.json) |
| 원래 저자 설명·과거 검사 기록 | [UPSTREAM_README.md](r18/UPSTREAM_README.md) |
| 핀 정정·기능별 구현 상태 | [HARDWARE_FIRMWARE_MAP.md](HARDWARE_FIRMWARE_MAP.md) |
| 원본 네트 표 | [GPIO](r18/external_parts/GPIO_pinmap.csv) / [커넥터](r18/external_parts/Connector_pinout.csv) |
| 펌웨어 선언·요약 핀맵 | [board_r18.h](../firmware/include/board_r18.h) / [board_pinmap.csv](board_pinmap.csv) |

KiCad 10 형식이며 설치된 표준 라이브러리를 참조하는 모델도 있다. 인계 목록은 원본 복사222개 파일·16,312,470byte를 기록한다. hash는 파일 식별 정보이며 설계 검증 결과가 아니다. 새 안내 문서는 목록에 포함하지 않는다.

기존 BOM의 일부 GPIO prose는 오래됐으므로 배선표·펌웨어 선언을 우선한다. AUX_EN4/motor3/AMP_GATE16/backlight2/LCD reset43을 사용하며5/12/15/48은 NC,35/36/37은 octal PSRAM 예약이다. 스피커는 MAX98357A I2S BTL이며 GPIO 부저나 접지 단자로 취급하지 않는다. 상세 충돌은 연결 문서에 있다.

LED D2·BQ24074 충전·TLV6700 온도 gate·전원 제한/UVLO는 하드웨어 동작이다. 펌웨어는 USB100 기본을 유지한다. 실제 조립 revision·배터리 극성·LCD 모듈·소비전류·거리·출력 동작은 미확인이다. INA219 계측 소스는 keyring-0.6.0에 추가했고 [설정·단위·제약](../firmware/POWER_MONITOR.md)에 연결했다. MAX9850 헤드폰은 아직 미구현이다.

원래 README/stackup/BOM의 DRC/ERC/simulation·수량·가격·재고 기록은 과거 자료다. 이번 검증·제조 승인·현재 firmware release 증거로 재사용하지 않는다. KiCad 실행·DRC/ERC·분석기·시뮬레이션·거버 생성·발주·실장·전원 인가·flash·빌드·장비 시험은 수행하지 않았다.
