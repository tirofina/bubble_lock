# Feather 화면 유지와 실제 Pi BLE 시험

ROLE: KEYRING / 남호 · DOC-REV: 2.0.0 · RUBRIC: R02, R05, R10, R15.

2026-11-10 화면·Feather ESP32 V2·A0/A1 버튼 구성에 `feather-probe-0.1.1`을 올렸다. 버튼을 떼어도 마지막 입력 화면을 유지하고 BLE는 실제 `released/confirm/panic` 상태를 보낸다. 사용자가 두 버튼의 화면 전환과 해제 후 유지 동작을 확인했다.

## 실제 실행 결과

| 확인 항목 | 결과 | 증거 |
|---|---|---|
| Feather 빌드 | 프로그램 1,160,520 B / 전역 변수 44,480 B | `firmware-build.log` |
| COM12 업로드·부팅 | flash hash 검증 통과 / `FEATHER PROBE READY` | `firmware-flash.log`, `firmware-boot.log` |
| Pi SSH·환경 | Zero 2 W Rev 1.0 / Debian 13.7 aarch64 / Python 3.13.5 | `pi-runtime.json` |
| Pi 설치본 | Gateway 0.2.4 / Bleak 3.1.0 / 원본 Python 모듈과 일치 | `pi-installed.json`, `update-024.log` |
| PIN 등록 | Secure Connections·MITM 유지 / Paired·Bonded·Trusted yes | `bond-status.log` |
| BlueZ 오류 재현 | READ 전체 JSON이 알림 버퍼에 섞여 decode 실패 | `bluez-read-echo-repro.log`, `regression-before.log` |
| Gateway 회귀시험 | 수정 후 기본 58개 통과 | `gateway-tests.log` |
| 실제 Pi 연속 수신 | 90초간 45개 관측 / 주기 상태 18회 모두 연결 유지·오류 없음 | `diagnose-fixed-summary.log` |
| 실제 버튼 수신 | released seq340 / confirm seq346 / panic seq349 / exit 0 | `observe-fixed.log`, `observe-fixed.exit` |
| 실제 TFT | 사용자가 두 버튼 입력 후 화면 유지 확인 | 이번 사용자 응답, 화면 촬영 증거는 없음 |

## 원인과 수정

BlueZ가 `ReadValue` 결과를 `PropertiesChanged(Value)`로도 전달했다. 알림 구독 후 초기 READ를 실행하던 Gateway는 LF 없는 전체 JSON을 알림 조각으로 받아 다음 LF 메시지와 연결했고, 형식 검증이 실패해 스스로 연결을 해제했다. 실물 로그에서 seq213의 전체 READ 뒤 seq214 알림이 이어지며 `JSONDecodeError: Extra data`가 발생하는 것을 재현했다.

Gateway 0.2.4는 초기 observation READ·검증·큐 등록을 알림 구독보다 먼저 수행한다. 동일 현상을 재현하는 모의 시험이 수정 전 실패하고 수정 후 통과했다. 인증·세션 generation 검사와 JSON/LF 검증을 유지했다. Pi에 설치한 wheel의 Python 모듈은 현재 소스와 일치한다.

Pi의 Bluetooth soft block을 해제하고 전원을 켰다. 대화형 PIN 등록이 취소된 뒤, 정확한 이름·service UUID로 검색한 단일 Feather object path만 처리하는 일회용 KeyboardOnly D-Bus agent로 등록했다. 같은 로컬 PIN을 사용했으며 등록 후 agent를 해제했다. PIN·SSH 암호·MAC·비밀키는 이 evidence에 포함하지 않았다. 시험 종료 후 수신기와 SSH를 닫았으며, `Connected: no`는 시험 종료 후 상태다.

## 재현과 범위

실물 절차는 [Feather 안내](../../firmware/feather_probe/README.md#raspberry-pi에서-단독-ble-관측)를 따른다. Pi의 `~/keyring-bench`에 소스·가상환경·Gateway 0.2.4 wheel을 설치했다. 기존 GIF·공룡게임 복구 바이너리는 Windows의 저장소 밖 로컬 폴더에 보존했다.

```sh
cd ~/keyring-bench
.venv/bin/python keyring/firmware/feather_probe/observe.py --seconds 300
```

수신기가 실행된 뒤 두 버튼을 떼고 A0·A1을 각각 1초씩 눌렀다 뗀다. 이 시험은 실물 Feather→Pi BLE 관측이다. 전체 Gateway daemon, Pi→Mobius4 전달, 중앙 명령·앱·웹 통합, 배송 중인 키링 PCB와 센서·출력 부품 시험은 남아 있다. PC Docker API 조회는 엔진 named pipe 부재로 실패했으며 이번 checkpoint에서는 CSE를 실행하지 않았다.

`receipt.json`에 소스·바이너리·로그 SHA256과 실제 결과를 기록한다. 과거 evidence는 당시 상태 그대로 보존한다.
