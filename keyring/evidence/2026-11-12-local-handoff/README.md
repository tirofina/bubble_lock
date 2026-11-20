# KEYRING 로컬 검증과 조립 이후 인계

남호 · DOC-REV 2.0.0 · `codex/keyring-namho` · 2026-11-12

검증한 소스는 Gateway 0.2.122의 `27a2313dc6969778f4f43fb77c24f7be70e49f70`다. r18 펌웨어는 0.7.25 계열, Feather는 관측 0.1.1과 명령 0.2.1이다.

## 구현 상태

- r18은 기본 관측과 ST7789·JD9853 두 LCD 프로필을 지원한다. Pi 보고서에서 같은 부팅의 USB·BLE와 조립 기록을 연결하고, 버튼 해제 이후 화면 상태와 작업자의 화면 기록을 대조한다. 전력 보고서에서도 같은 조립 기록을 찾을 수 있다.
- Gateway는 BLE 관측을 SQLite에 저장하고 Mobius4로 전달한다. 명령 영수증의 원본·중앙 정산을 대조하며, 전송 전에 로컬 기록을 쓰고 실패 뒤 대기열을 유지한다.
- 새 Mobius로 바꿀 때 활성 컨테이너 ID를 독립적으로 확인할 수 있다. Gateway ID가 바뀌어도 같은 장치의 CORE 순번을 이어받는다. 중앙 API가 별도 PKI를 쓰면 해당 HTTPS 연결에 CA와 클라이언트 인증서를 따로 지정할 수 있다.

## 로컬 검증

| 대상 | 실행 결과 |
|---|---|
| ESP32-S3 r18 | 기본·ST7789·JD9853 compile 프로필과 ST7789·JD9853 첫 구동 프로필 5개 빌드 성공 |
| Feather ESP32 | 관측 0.1.1과 명령 0.2.1 프로필 2개 빌드 성공 |
| r18 C++ 호스트 | GPIO·타이머·BLE 세션·절전 등 18개 시나리오 통과 |
| Feather C++ 호스트 | 명령·중복·journal 등 4개 시나리오 통과 |
| Gateway Python | 소스 263건 통과. 같은 263건을 별도 경로에 설치한 wheel로 다시 통과 |
| 격리 Gateway 도구 | 55건 통과. 실제 Pi와 Mobius4 연결을 대신하는 모의 시험 |
| Ubuntu 24.04 WSL POSIX | 13건 통과. 전용 256 KiB tmpfs에서 ENOSPC를 재현하고 파일 잠금·DB 보관·새 Gateway ID의 순번 전환을 확인 |

Gateway 시험에는 두 로컬 HTTPS 서버가 서로 다른 CA와 클라이언트 인증서를 사용한 TLS 1.3 사례가 포함된다. r18과 Feather 빌드는 장치별 provisioning을 제외했다. POSIX의 첫 실행은 ENOSPC용 파일시스템 변수가 없어서 해당 사례가 중단됐으며, 전용 환경을 마련한 전체 재실행에서 통과했다. wheel과 로컬 로그의 SHA-256을 보관했다. [검증 영수증](receipt.json)

## 조립 이후 확인

1. 실제 PCB 조립 revision과 배선·패널을 기록하고 첫 전원·USB 부팅과 3.3V를 확인한다. [PCB 첫 구동](../../pcb/BRING_UP.md)
2. 제작 PCB에서 버튼·LCD·센서·충전·전력·BLE 거리와 재연결을 기록한다. Feather 0.2.1의 `CMD ON`·`CMD OFF`도 실물 화면 확인이 남아 있다. [Pi와 장치 시험](../../raspberry-pi-gateway/TESTING.md)
3. 실제 Pi와 제작 PCB에서 명령 ACK·readback·중앙 정산을 대조한다. 서버 교체, 운영 자격·권한, 앱·웹 연동 및 제출 영상·release 증거를 확인한다. [완료 조건](../../COMPLETION_GAPS.md)

이전 Feather 0.2.0 시험에서는 GPIO 읽기값·Pi·Mobius4·중앙 정산이 일치했고, 작업자는 LED 점등 변화를 보지 못했다. [이전 실물 시험](../2026-11-11-feather-visual/receipt.json)
