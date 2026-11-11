# 실제 Pi에서 전체 Gateway 데몬 실행과 재전송

KEYRING 남호 · DOC-REV 2.0.0 · 2026-11-10.

Pi Zero 2 W의 별도 설치 폴더에 Gateway 0.2.5 wheel을 설치하고, 기존 Feather 0.1.1과 인증된 BlueZ 링크를 사용했다. `bubble_gateway` Linux 진입점을 임시 사용자 systemd 서비스로 두 차례 실행했다. PC에는 팀 main `715ef58`의 중앙 API와 새 Mobius4/PostgreSQL 시험 자원을 띄웠다. Pi는 각 PC 서비스에 별도의 SSH reverse tunnel을 통해 mTLS HTTPS로 접속했다.

| 항목 | 실제 결과 |
|---|---|
| Pi 패키지 | 기존 wheel SHA-256 확인, 0.2.5 가져오기 경로와 Python 모듈 13개 바이트 일치 |
| 데몬과 BlueZ | 첫 실행 BLE timeout 1회 뒤 연결 복구. 마지막 상태는 연결됨, 오류 없음 |
| Mobius4 | 관측 27개, Gateway 상태 16개. 마지막 관측의 장치·부팅 ID·시퀀스 2284가 Pi SQLite와 일치 |
| 중앙 API | Pi가 전송한 마지막 상태의 시험 credential은 `ACTIVE`. 중앙 명령 수, Pi 명령 행, CSE 명령 영수증은 모두 0 |
| 재시작 | 첫 종료 뒤 관측 시퀀스 2230 한 건이 SQLite에 남음. 서버 조회 HTTP 404/RSC 4004 → 같은 DB 재시작 뒤 200/2000. 원래 payload의 SHA-256이 일치하고 해당 outbox 행이 제거됨 |
| 종료 | 두 임시 unit exit 0, 종료 뒤 둘 다 `not-found`. 최종 outbox 0, 폴더 0700·DB 0600 |

시험용 API에는 Gateway 인증서만 등록하고 명령 발급 주체나 grant를 등록하지 않았다. 이 실행에서 실제 명령·출력 ACK는 시험하지 않았다. 임시 사용자 unit은 Linux 진입점과 종료 동작을 확인하며, 배포용 systemd unit의 서비스 계정·권한 정책은 별도 검증 범위다.

PC는 시험 전용 PKI와 캐시 이미지로 만든 격리 stack을 사용했다. 종료 뒤 시험 container와 network는 0개이고 기존 개발 container 4개는 실행 중이었다. Pi의 두 SSH 세션과 reverse tunnel을 닫고 이번 시험용 Pi 인증서·키 복사본을 제거했다. 공개 증거에는 BLE 주소, raw 관측, 원본 SQLite, 인증서·키를 제외했다.

## 재현 절차

캐시된 [CSE 시험 이미지와 의존성](../../raspberry-pi-gateway/TESTING.md#별도-실제-cse10개), Node, OpenSSL, 로컬에서 읽을 수 있는 팀 main commit을 사용한다. PC에서 새 출력 폴더로 fixture를 실행한다.

```powershell
$env:PYTHONPATH = ('src','tests','integration_tests' | ForEach-Object {
    Join-Path $PWD ('keyring/raspberry-pi-gateway/' + $_)
}) -join [IO.Path]::PathSeparator
python keyring/raspberry-pi-gateway/cse_integration_tests/pi_daemon_fixture.py --team-ref 715ef58 --output '<저장소 밖의 새 출력 폴더>' --seconds 600
```

`STACK_READY` 뒤 생성된 `endpoints.json`의 두 PC 포트를 Pi의 서로 다른 loopback 포트로 역방향 포워딩한다. Pi에는 `pi-client.tgz`의 시험 client bundle만 전달한다. Gateway wheel은 기존 가상환경의 의존성을 사용해 새 `--target` 폴더에 `--no-index --no-deps`로 설치한다. private env에 두 Pi loopback URL, 실제로 짝지은 Feather 주소, `feather-probe-0.1.1` allowlist, fixture가 만든 컨테이너 세 개, 새 SQLite 경로를 넣는다. 이번 실행은 `MQTT_ENABLED=false`와 `CORE_BRIDGE_ENABLED=false`를 사용했다.

```sh
systemd-run --user --wait --collect --pipe --unit=keyring-live-daemon-local \
  --property=TimeoutStopSec=6s /usr/bin/timeout --preserve-status --signal=TERM --kill-after=5s 48s \
  /usr/bin/env -i PATH=/usr/bin:/bin PYTHONPATH="<새 Gateway target 절대 경로>" \
  "<시험 가상환경 Python 절대 경로>" -m bubble_gateway --env-file "<private env 파일>"
```

서비스가 종료된 뒤 DB를 읽기 전용으로 열어 대기 행과 장치의 마지막 시퀀스를 확인한다. 대기 행이 있으면 rqi를 해시한 `gw-<SHA256(rqi)>`를 CSE에서 조회하고, 같은 시험 DB로 다시 실행한 뒤 그 이름의 cin과 outbox 행을 대조한다. Pi 종료 확인 후 PC fixture 출력 폴더에 `STOP` 파일을 만들면 CSE와 API가 조회 증거를 남기고 종료된다.

[통합 결과·해시](receipt.json) · [Pi 첫 실행](daemon.log) · [Pi 재시작](restart.log)
