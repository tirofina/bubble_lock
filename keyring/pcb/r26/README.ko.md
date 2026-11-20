# r26 · R71 삭제 / LCD DC 직접 배선

PCB5장 제작 / Standard Top only 2장 조립 / 4층1.0mm / 표준0.3mm 비아.
앞면47개, BOM25품목. 직접 연결할 점퍼선0가닥, 보드 부품 수작업 실장0개. 뒷면 선택 회로89개 미실장.
R71 심벌·풋프린트·실크를 삭제했다. GPIO8(U1.12)에서 J3.6까지 LCD_DC 신호를 직접 배선했다.
기존 R71 자리에는0.15mm 폭의 앞면 패턴을 연결했다. 이 변경에 추가 비아는0개다.
기존 부품 배치·전원 루프·디커플링·기판 외곽·케이스 장착홀·포트 위치를 유지했다.

## 우회 저항 유지 및 확장
R72~R75는 YAGEO RC0805JR-070RL, LCSC C96345,0805 0Ω이다. 보드당4개, 조립2장에8개.
R72: VBAT → SYS_LIMIT. U3 충전/전원 경로와 U11 메인 스위치를 우회.
R73: VBAT → PWR_SW(외장 슬라이드 ON). U10 저전압 제어를 우회.
R74: REG_EN(슬라이드 COM) → REG_READY(U4 EN). U17 전원 감시기를 우회.
R75: +3V3 → AUX3V3. U13 보조 전원 스위치를 우회.
뒷면 선택 회로를 추가할 때 해당 우회 저항을 먼저 제거한다. 전체 뒷면 회로 실장 시 R72~R75 모두 제거한다.

## 외부 연결·펌웨어
시연 배터리는 DTP803040 1000mAh이며 외부1셀 충전기로 충전한다.
이번 실장에서는 USB-C 충전·온도·저전압 제어 회로를 사용하지 않는다.
화면·배터리·케이스 슬라이드 스위치는 기존 외부 배선을 연결한다. J9.1=ON,J9.2=COM,J9.3=OFF/GND.
LCD MOSI GPIO38/SCK GPIO39/CS GPIO18/DC GPIO8/RESET GPIO43.
백라이트GPIO2 HIGH=OFF LOW=ON. 확인GPIO6/패닉GPIO7 LOW=눌림.
USB D− GPIO19/D+ GPIO20. USB콘솔을 사용하며 UART0 TX 로그는 LCD RESET과 충돌하므로 비활성화한다.
오디오·센서·SD·잔량계·MAIN/AUX FAULT 의존 로직은 이번 시연 펌웨어에서 비활성화한다.

## 파일
privacy_bubble_r26_4L_front_assembly_gerber_drill.zip:4개동박·양면마스크/실크·외곽·앞면페이스트·PTH/NPTH드릴.
Assembly/BOM_JLCPCB.csv + CPL_JLCPCB.csv:앞면47개 공장 조립용. Quantity는 기판1장 기준.
Assembly/BYPASS_CONFIGURATION.csv:유지한 우회 저항4개의 연결과 확장 시 제거 항목.
Assembly/DNP_LIST.csv:뒷면89개 미실장 목록. Views/:앞뒤3D 이미지.
Checks/validation_summary.json:DRC/ERC·미연결·회로도 대조·파일해시.
