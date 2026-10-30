# bubble_lock

Privacy Bubble Keyring 공동 개발 저장소입니다. 구현 기준은 [PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md](PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md)를 따릅니다.

## 남호 — 키링 담당 구현

[키링 개발 안내](keyring/README.md)에서 ESP32-S3 펌웨어, Raspberry Pi Gateway, 기존 r18 PCB 핀 연결과 중앙 인수인계 문서를 볼 수 있습니다.

- [펌웨어](keyring/firmware/README.md): 배터리·가속도·버튼 관측, 보안 BLE, 진동 출력, 장치 명령 기록.
- [Gateway](keyring/raspberry-pi-gateway/README.md): BLE 수집, SQLite 영속 큐, 중앙 권한 확인, MQTT/HTTPS oneM2M 전송, systemd 배포 설정.
- [계약](contracts/keyring/README.md): JSON Schema 2020-12 10종, 계약 후보 0.1.0.
- [PC 담당 인수인계](docs/keyring-handoff.md): 필요한 API·CSE·credential와 미실행 수용 항목.

Gateway0.2.3은 소스와 설치 패키지에서 단위시험56개·실제 MQTT6개·실제 Mobius4·영속 큐 복구10개를 각각 통과했습니다. 펌웨어는 기본/ST7789/JD9853 프로필3개가 빌드됐습니다. [최신 실행 증거](keyring/evidence/2026-10-30-outbox-cse/README.md)에 로그와 해시를 기록했습니다. 실물 Pi·BLE·장비 시험, 중앙 권한·앱/웹 통합, 영상·release는 미완료입니다.
