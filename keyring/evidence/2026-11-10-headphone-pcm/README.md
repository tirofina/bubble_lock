# MAX9850 PCM 소프트웨어 검증 증거

2026-11-10 최종 펌웨어 4개 환경과 실제 C++ DAC 드라이버의 host 시험을 실행했다. [receipt.json](receipt.json)은 실행 도구·소스 SHA-256·RAM/flash 크기·산출물 hash·실물 TODO를 연결한다.

- [compile.log](compile.log): minimal, ST7789, JD9853, headphone 환경 PASS. 최종 incremental 실행 21.320초.
- [host-test.log](host-test.log): 모의 I2C·clock에서 부팅, 설정 순서, 배타 제어, 취소, 재시도, readback, ready timeout, NACK, drift, 권한 경계 PASS.
- [BUILD_PROFILES.md](../../firmware/BUILD_PROFILES.md): 재현 명령과 환경별 크기.
- [HEADPHONE_STANDBY.md](../../firmware/HEADPHONE_STANDBY.md): 제조사 Rev4·r18 회로·핀·클럭·출력 제어 근거.

증거 분류는 `LOCAL_COMPILE_AND_MOCK_IO`다. 실물 flash, 파형, 아날로그 출력, 차단 정착 시간은 별도 TODO topic으로 관리한다.
