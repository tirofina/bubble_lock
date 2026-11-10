# 로컬 빌드·모의 단위 테스트 기록

2026-10-29 · KEYRING / 남호 · DOC-REV 2.0.0 · source commit `3c27f4d`.

사용자가 이번 작업에서 **로컬 펌웨어 3개 프로필 빌드·Gateway 모의 단위 테스트와 필요한 개발 의존성 설치**를 허가했다. 수행은 Codex가 보조했다. 이 자료는 로컬 검증 기록이며 독립 검토 승인·실물 시험·release receipt가 아니다. 원격 main/CORE는 작업 시작과 종료 준비 시 확인한 `91a281b`다.

## 실행 범위와 환경

- Windows, Python 3.12.14, PlatformIO Core 6.2.0. Python 의존성의 실제 버전은 [python-packages.json](python-packages.json)에 있다.
- espressif32 6.9.0, Arduino 2.0.17 (`framework-arduinoespressif32 3.20017.241212+sha.dcc1105b`), Xtensa ESP32-S3 toolchain 8.4.0+2021r2-patch5.
- ArduinoJson 6.21.5, Arduino_GFX v1.4.9 / `3cc08c4e9ab6d85807e49b657d73fae10871616e`.
- 컴파일 대상은 `keyring_compile_minimal`, `keyring_compile_st7789`, `keyring_compile_jd9853`. 모두 로컬 provisioning.h·jd9853_panel.h를 제외하고 invalid passkey0을 사용한다.
- 최종 빌드 출력 경로는 `C:/Users/NH/.cache/keyring-validation-20261029/build`다. 소스 저장소는 원래 한글 경로에 유지했다. 바이너리는 로컬에만 보관하고 [receipt.json](receipt.json)에 실제 크기·SHA256을 기록한다.

펌웨어 명령(프로젝트 디렉터리에서 개발 환경의 Python 사용):

```powershell
$env:PLATFORMIO_BUILD_DIR = 'C:/Users/NH/.cache/keyring-validation-20261029/build'
python -m platformio run -e keyring_compile_minimal -e keyring_compile_st7789 -e keyring_compile_jd9853
```

Gateway 명령(저장소 루트에서):

```powershell
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src')
python -m unittest discover -s keyring/raspberry-pi-gateway/tests -v
```

## 실제 결과와 수정

**기본/ST7789/JD9853 모두 SUCCESS, matrix exit0**이다. 프로필별 산출물 hash와 로그 hash는 [receipt.json](receipt.json), 빌드 출력은 [firmware-build.log](firmware-build.log)에 연결한다. Gateway는 **37개 / 0 failure / 0 error / OK**, 실행 시간은 로그상0.908초다([gateway-tests.log](gateway-tests.log), [테스트 범위](../../raspberry-pi-gateway/TESTING.md)).

처음 실행에서 발견한 오류는 보존했다.

1. [초기 빌드](firmware-build-initial.log): Arduino_GFX1.6.9가 Arduino3.x의 `esp32-hal-periman.h`를 요구해 실패했다. Arduino2.x 분기가 있는 upstream v1.4.9를 소스로 확인하고 정확한 commit으로 고정했다. 동시에 C++11에서 기본 멤버 초기화가 있는 `Button{pin}`을 사용할 수 없어 명시적 생성자를 추가했다. minimal/ST7789 실패 후 공통 원인 수정에 들어가며 실행 중인 JD9853 빌드를 중단했다. 초기 JD9853 결과는 확정하지 않는다.
2. [한글 출력 경로 빌드](firmware-build-unicode-path.log): 위 수정 후 minimal 링크 단계에서 `cannot open map file ... Invalid argument`로 실패했다. 실행 중인 ST7789 빌드를 중단하고 출력 경로만 영문으로 지정했다. 소스·기능·플랫폼 버전을 이 문제 때문에 바꾸지 않았다.

## 이 결과의 한계

테스트는 합성 명령·모의 BLE/MQTT/HTTP와 테스트 전용 임시 SQLite를 사용한다. 기존 DB·실제 passkey·인증서·장비에 접근하지 않았다. Windows의 상태 백업 테스트에서는 POSIX directory fsync를 모의 처리했다. 실제 SQLite WAL backup·transaction·quarantine·hash·임시 파일 처리는 수행했지만 Pi의 권한·lock·디스크 전원 손실 내구성을 입증하지 않는다.

flash·COM·실제 BLE/장비·Gateway daemon·운영 서비스·기존 DB snapshot/adoption·CSE end-to-end 시험·별도 lint는 실행하지 않았다. 두 패널의 전기적 동작/표시, JD9853 구매 모듈의 geometry·power/gamma init, 음향·전력·wake·실제 진동도 미검증이다. [전체 완료 조건](../../COMPLETION_GAPS.md)과 중앙 승인/settlement/recovery 계약·Pi 통합·실측·영상·release는 남아 있다.
