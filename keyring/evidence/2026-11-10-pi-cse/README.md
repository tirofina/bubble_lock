# 실물 Feather → Pi → 임시 Mobius4 전송

ROLE KEYRING / 남호 · DOC-REV 2.0.0 · 2026-11-10. 이번 시험은 **실제 BLE 관측 35개를 Pi의 SQLite outbox에서 전송하고 CSE 저장값을 다시 읽어 모두 일치함을 확인**했다. Gateway 전체 daemon·중앙 승인 명령·앱/웹 통합은 이번 실행 범위에 포함하지 않았다.

## 실행 구성

- Feather ESP32 V2, 1.54인치 ST7789, A0/A1 두 버튼, `feather-probe-0.1.1`. 이전 [실물 버튼·화면 유지·BlueZ 기록](../2026-11-10-pi-feather/README.md)에 연결한다.
- Pi Zero 2 W Rev1.0, Debian 13.7 aarch64, Python 3.13.5, BlueZ 5.82, Gateway 0.2.4. 등록한 단일 Feather에 PIN 인증·bonding을 유지했다.
- PC의 새 disposable Mobius4·tmpfs PostgreSQL/PostGIS·nginx·Mosquitto. upstream은 `e8f75b1d6ee13a0e034379ec8dab26a6ef4fe8f8`; 실제 이미지 digest는 [stack-state.json](stack-state.json)에 있다. 기존 개발 DB와 container 네 개를 재사용하지 않았다.
- Pi의 loopback HTTPS `28759`, MQTT `28883`에서 Windows loopback으로 SSH reverse tunnel 두 개를 사용했다. 방화벽/LAN bind는 변경하지 않았다. 시험 서버 주소와 자원 경로는 private 환경 파일에 두었다.
- 새 test CA·client/server 인증서를 사용했다. Pi에는 CA 인증서·client 인증서·client 개인키만 전달했다. 서버 mount에는 CA 개인키와 client 개인키가 없다. `gw-test` 인증서를 합성 `Skeyring-fixture` principal로 매핑한 fixture다. 운영 AE/ACP/grant 등록 증거는 아니다.

## 결과

| 실행 | 실물 관측 / 전송 / 일치한 readback | 실제 경로·결과 |
|---|---:|---|
| [HTTPS 최초](https-initial.json) | 5 / 5 / 5 | sequence 737–741, 초기 harness |
| [HTTPS 설정 격리 후](https-normal.json) | 5 / 5 / 5 | sequence 814–818 |
| [CSE 중단·복구](https-outage.json) | 5 / 5 / 5 | sequence 826–830, 중단 중 pending 5 → 복구 후 0 |
| [MQTT 정상](mqtt-normal.json) | 5 / 5 / 5 | sequence 1039–1043, MQTT 5 / HTTPS 0 |
| [MQTT 장애 우회](mqtt-fallback.json) | 15 / 15 / 15 | sequence 1060–1074, MQTT 0 / HTTPS 15 |

모든 입력은 실제 보드의 주기적 `released` 관측이다. 이번 서버 시험에서 `confirm`/`panic` 입력을 새로 수행했다고 표시하지 않는다. 버튼 두 종류의 실물 수신은 앞선 pi-feather 기록에 있다.

각 관측의 `deviceId:bootId:sequence`로 고정 rqi와 cin 이름을 계산하고 HTTP GET의 status 200 / oneM2M RSC 2000 / cin 이름 / canonical payload를 확인했다. 각 receipt의 `payloadSha256`와 `readbackSha256` 배열이 전부 일치한다. 마지막 [all-final-checks.json](all-final-checks.json)의 CSE `cni`는 **35**, 다섯 SQLite outbox의 잔여 행은 각각 **0**이다. 디렉터리 0700·DB 0600도 Pi에서 확인했다.

CSE 장애는 token으로 소유권을 확인한 시험 CSE 하나만 stop/start했다. [outage-control.json](outage-control.json)의 중단 구간 안에서 [pending 5 / 재시도 1](https-outage-pending.json)을 확인했고, 같은 Pi 송신 프로세스가 복구 후 다섯 건을 완료했다. Pi 재부팅·SD 전원 손실 시험은 아니다.

MQTT 장애는 응답 구독 준비 후 시험 broker만 중단했다. 이후 15개 모두 제품 `TransportHub.publish`의 HTTPS 경로로 완료했다. [중단 시각](mqtt-fallback-control.json)은 09:28:01.309 UTC, [관측 2개 확인](mqtt-fallback-capture-check.json)은 09:28:01.969 UTC다. 확인 파일은 중단 **뒤**에 생성됐으므로 중단 전 MQTT 성공 건수로 사용하지 않는다. 정상 MQTT 5건은 별도 실행으로 입증했다. [broker/proxy 요약](server-log-facts.json)은 실제 QoS 1 MQTT publish 5건을 교차 확인한다.

[HTTPS TLS probe](tls-probe.json)와 [MQTT TLS probe](mqtt-tls-probe.json)에서 TLS 1.3 / TLS_AES_256_GCM_SHA384를 실측했다. MQTT probe 자체는 TLS handshake만 검사했고, MQTT application 응답은 `mqtt-normal.json`의 실제 전송 결과로 확인한다. relay receipt의 TLS 항목은 정책 정보이며 각 publish의 handshake를 직접 계측한 값으로 취급하지 않는다.

## 구현과 회귀시험

[relay.py](../../firmware/feather_probe/relay.py)는 opt-in 벤치 도구다. 실제 `BleFleet`·`Gateway.observation`·`Store`·`Gateway._outbox_loop`·`TransportHub.publish`를 사용하고 전체 daemon의 credential/poll/dispatch/health loop는 실행하지 않는다. 새 private 출력 경로와 DB만 허용하며 명시한 환경 파일을 격리해 읽고 부모 환경을 복원한다. 실패 시 부분 receipt와 0이 아닌 종료 코드를 남긴다.

`RelayTransport`는 성공한 publish에서 실제 HTTP POST가 실행됐는지 추적해 MQTT/HTTPS를 구분한다. MQTT timeout 뒤 HTTPS 완료는 HTTPS로 집계하며 readback GET은 전송 경로 집계에 영향을 주지 않는다. MQTT를 켜면 응답 구독 준비를 기다린 뒤 BLE 수집을 시작한다.

[회귀시험 로그](relay-mqtt-channel-tests.log): 모의 BLE/HTTP·실제 임시 SQLite를 사용한 네 시험이 1.741초에 모두 통과했다. 환경 격리/복원, HTTPS readback 일치, 불일치 실패, 실제 제품 MQTT publish 분기의 application 응답과 경로 집계를 확인했다. 실물 시험과 별도로 기록한다. 실행 명령은 [벤치 README](../../firmware/feather_probe/README.md)에 있다.

실행 순서에서 첫 HTTPS run은 환경 격리 수정 전 소스이고 다음 HTTPS 두 run은 격리 수정 후 소스다. 당시 Pi의 상속 Gateway 설정 키는 [빈 배열](inherited-env.json)이었다. 각 소스 hash는 `initial-source.sha256`, `env-isolated-source.sha256`, `mqtt-source.sha256`로 구분한다. MQTT 두 run은 최종 harness와 Pi 파일의 byte hash 일치를 확인했다. 제품 Gateway 0.2.4와 Feather 0.1.1 코드는 이번 서버 시험에서 바꾸지 않았다.

## 실행 오류와 정리

최초 host runner는 fixture config의 `request_timeout` 누락으로 초기화에 실패했고 해당 stack을 정리했다. 수정 후 별도 `-02` 작업 폴더에서 위 시험을 실행했다. 최초 CSE stop 제어는 Windows CP949로 Docker inspect의 한국어 mount 경로를 디코딩하다 실패했으며 CSE를 중단하지 않았다. 그때의 Pi 출력 폴더 이름 `outage`는 정상 HTTPS run이므로 공개 파일명을 `https-normal.json`으로 정정했다. 실제 장애 run은 `outage-02`다.

[host-runner.py](host-runner.py)는 성공한 실행의 원본 snapshot이다. 저장소 root에서 fixture 디렉터리를 PYTHONPATH에 추가하고 실행했으며 기존 출력 폴더를 거부한다. 독립 제품 daemon이나 자동 설치 스크립트가 아니다. fresh stack을 최대 30분 또는 private `STOP` 파일까지 유지하고 `finally`에서 소유 자원만 정리한다.

[cleanup.json](cleanup.json): runner exit 0, 시험 container·broker·network 잔여 0, SSH tunnel 두 세션 종료, 기존 개발 container 네 개 running을 확인했다. 개인키·PIN·SSH 암호·BLE 주소·raw 관측·SQLite는 저장소에 포함하지 않았다. 공개 artifact 목록과 LF 정규화 SHA256은 [artifact-sha256.json](artifact-sha256.json)에 있다.

전체 목표는 진행 중이다. 실제 PCB, 전체 daemon의 중앙 승인 명령·장치 ACK, pb:binarySwitch/Group·앱/웹 연계, 운영 principal/AE/ACP/grant, 전력·거리·SD 전원 손실과 release 증거가 남아 있다.
