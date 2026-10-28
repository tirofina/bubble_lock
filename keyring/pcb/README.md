# 키링 기존 하드웨어 인수인계

ROLE: KEYRING · 담당: 남호 · DOC-REV: 1.0.0

이번 작업은 기존 PCB 자산을 펌웨어와 연결하는 작업이다. 회로도·PCB·BOM·제조 데이터를 새로 설계하거나 변경하지 않았다. 기존 문서의 DRC/ERC·조립 결과를 이번 변경의 검증 결과로 재사용하지 않는다.

현재 채택한 보드는 **r18-hand-solder**다. r18 README는 r17 공통 4층 보드의 부품·회로·네트와 배치를 유지한 손납땜 패드 변경본이라고 설명한다. 원본은 이 Git 저장소 밖의 작업공간에 있으며 저장소에는 복제하지 않았다.

| 기존 자산 | 작업공간 경로 |
|---|---|
| 최신 회로도 | `hardware/privacy_bubble_r18_hand_solder/privacy_bubble.kicad_sch` |
| 최신 PCB | `hardware/privacy_bubble_r18_hand_solder/privacy_bubble.kicad_pcb` |
| 최신 프로젝트 | `hardware/privacy_bubble_r18_hand_solder/privacy_bubble.kicad_pro` |
| 부품별 BOM | `hardware/privacy_bubble_r18_hand_solder/working_data/BOM_by_reference.csv` |
| 구매 BOM | `hardware/privacy_bubble_r18_hand_solder/working_data/BOM_purchase.csv` |
| 조립 변경 설명 | `hardware/privacy_bubble_r18_hand_solder/README.md` |
| 실제 GPIO 네트 표 | `hardware/privacy_bubble_r17/common_pcb/working_data/GPIO_pinmap.csv` |
| 커넥터 네트 표 | `hardware/privacy_bubble_r17/common_pcb/working_data/Connector_pinout.csv` |

위 경로의 기준 작업공간은 `C:/Users/NH/Documents/ChatGPT/mobius 해커톤`이다. 다른 개발자가 저장소를 clone하면 원본 KiCad 자산은 별도로 인수해야 한다. 기존 기준 설명은 [r18 README](../../../../hardware/privacy_bubble_r18_hand_solder/README.md), 핀 근거는 [공통 PCB 핀맵](../../../../hardware/privacy_bubble_r17/common_pcb/working_data/GPIO_pinmap.csv)에 있다.

펌웨어 핀 선언은 [board_r18.h](../firmware/include/board_r18.h)와 [핀 인수인계 표](board_pinmap.csv)에 있다. MCU는 ESP32-S3-WROOM-1-N16R8이며 GPIO35/36/37은 octal PSRAM용이다. r17 루트 GPIO 표와 BOM 일부 설명에는 이전 배치가 남아 있어 그대로 코드에 복사하지 않았다. AUX_EN은 GPIO4, 진동은 GPIO3, AMP_GATE는 GPIO16, 백라이트는 GPIO2다. GPIO5/12/15/48은 최신 보드에서 연결되지 않는다. LCD reset은 GPIO43 UART_TX에서 R69를 거치며 UART0 콘솔과 공유하면 안 된다.

버튼 두 개는 active-low다. 진동은 Q1 low-side 제어이며 LOW가 OFF다. Q3 백라이트는 active-low, Q4 AMP_GATE는 HIGH mute다. AUX_EN은 HIGH ON이고 부팅 때 LOW로 유지한다. 스피커는 MAX98357A I2S BTL 출력이며 일반 GPIO 부저로 취급하지 않는다. 스피커 단자 어느 쪽도 GND로 사용하지 않는다.

충전기 BQ24074, TLV6700 온도 창, 충전 LED D2는 하드웨어 기능이다. 펌웨어의 충전 관련 동작은 USB EN1/EN2의 기본 USB100 설정 유지다. LED를 사용자 명령용 GPIO 표시등으로 가정하지 않았다. 배터리 커넥터 극성, 실물 조립, 전류 한도, 전파 거리, 소비전류, GPIO readback과 실제 모터 동작의 일치는 아직 이번 코드로 확인하지 않았다.

부품 실장/PCB 제조/거버 출고/전원 인가/펌웨어 flash는 수행하지 않았다. 현재 릴리스 상태를 verified 또는 released로 올릴 근거는 없다.
