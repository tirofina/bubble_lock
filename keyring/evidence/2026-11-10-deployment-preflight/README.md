# Gateway 배포용 시작 검사

KEYRING 남호 · DOC-REV 2.0.0 · Gateway 0.2.6 · 2026-11-10.

배포용 systemd unit은 본 실행 전 `--check-config`를 호출한다. 이 검사는 운영과 같은 TLS context 구성 함수로 로컬 CA와 인증서·키를 로드한다. systemd의 상태 디렉터리가 설정되면 SQLite와 잠금 파일을 그 디렉터리 안으로 제한한다. 파일로 읽을 수 있는지와 인증서·키가 맞는지 확인하는 범위다. 서버와의 TLS 연결, 중앙 등록, 실제 명령은 다른 시험에서 검증한다.

| Ubuntu 24.04 WSL, systemd 255 | 예상 | 실제 |
|---|---|---|
| 정상 시험 인증서·키와 상태 경로 | 검사 통과 후 본 실행 | exit 0, 본 실행 표시 확인, 상태 파일 0 |
| 인증서와 다른 개인키 | 본 실행 전에 TLS 검사 실패 | exit 1, 본 실행 표시 없음, 상태 파일 0 |
| SQLite가 상태 디렉터리 밖 | 본 실행 전에 경로 검사 실패 | exit 1, 본 실행 표시 없음, 상태 파일 0 |

로컬 기본 시험은 67개가 통과했다. 새 구성 검증 4개와 기존 HTTPS/TLS·전송·저장소·dispatch 회귀시험을 포함한다. WSL 시험은 로컬에서 만든 wheel의 모듈 바이트와 console entry point를 대조하고, 배포 unit의 격리 옵션을 복사한 임시 systemd unit을 `nobody`로 실행했다. 본 실행 자리에는 확인 표시만 출력하는 명령을 사용했다. 첫 fixture 실행은 반복된 systemd `Environment` 지시어를 일반 INI의 중복 오류로 처리했고, 읽기 설정을 고쳐 재실행했다.

시험 종료 후 소유 unit·상태 디렉터리·시험 PKI를 정리했다. Pi의 실제 데몬 검증은 별도 0.2.5 기록이며, 0.2.6 운영 배포와 실물 명령은 남아 있다. [Pi 실제 실행](../2026-11-10-pi-full-daemon/README.md)

재현은 systemd가 실행되는 격리 Linux 환경에서 한다. 저장소의 배포 unit과 그 소스로 만든 wheel을 사용한다.

```sh
sudo python3 keyring/raspberry-pi-gateway/posix_integration_tests/systemd_preflight.py \
  --wheel <0.2.6-wheel> --output <새-출력-디렉터리>
```

[결과와 해시](receipt.json) · [기본 시험 로그](gateway-tests.log)
