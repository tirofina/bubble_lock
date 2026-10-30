# Linux POSIX 상태 보관·잠금·디스크 부족 시험

KEYRING / 남호 · DOC-REV2.0.0 · Gateway0.2.3 · 2026-10-30.

실제 Linux에서 state operator CLI와 파일/SQLite 경계를 확인했다. 비특권 UID65532·network none·read-only root·새 tmpfs DB만 사용했다. 소스10개와 기존wheel을 격리 설치한10개가 통과했다. 재현용 run-posix.ps1을 추가한 뒤 다시 실행해 소스/설치10개씩 통과했다. [receipt.json](receipt.json)에 각 실행의 정확한 시간·환경·파일/hash를 기록한다.

## 실제 결과

| 제안 ID | 확인한 동작 |
|---|---|
| KR-POSIX-STATE-01 | committed WAL 데이터 snapshot 보존·source row 동일·output0700/SQLite0600/manifest0600·실제 directory fsync |
| KR-POSIX-STATE-02 | 별도 프로세스의 실제 flock 보유 중 snapshot CLI·daemon entry 모두BlockingIOError/exit1. serve 미진입·output 미생성 |
| KR-POSIX-STATE-03 | 새 합성 legacy DB의 명시적 CLI adopt, 원본 data row 보존·LIVE binding 추가·snapshot은QUARANTINED |
| KR-POSIX-STATE-04 | 다른 Gateway binding을 output 생성 전에 거절 |
| KR-POSIX-STATE-05 | QUARANTINED snapshot의 Store 시작·재보관을 거절하고 파일 byte 보존 |
| KR-POSIX-STATE-06 | 별도256KiB tmpfs를 실제로 채워 ENOSPC errno28 확인. CLI 실패 때 partial output 보존·완료manifest/adoption 없음·source row 보존 |
| KR-POSIX-STATE-07 | 이미 경과한 API copy deadline(timeout=-1)에서 partial output만 남기고 manifest 생성 차단 |
| KR-POSIX-STATE-08 | 기존 output 및 그 symlink는 CLI exit2·대상 byte 보존 |
| KR-POSIX-STATE-09 | 변조된 legacy command hash를 output/binding 생성 전에 거절 |
| KR-POSIX-STATE-10 | 실제 fsync 후 별도 프로세스의 SQLite 변경을 주입해 adoption 거절. source epoch3 유지·snapshot epoch2/QUARANTINED·source binding/adoption receipt 없음 |

10번은 _sync_directory wrapper가 실제 함수를 호출한 뒤 다른 프로세스 write를 넣는 장애 주입이다. fsync/flock/SQLite를 모의 대체하지 않았다. 7번은 API의 이미 경과한 deadline 시험이며 장시간 CLI 복사 지연을 재현한 결과가 아니다. daemon entry 시험은 lock 단계에서 중단하며 daemon serve·BLE·network를 시작하지 않았다.

## 준비와 재현

처음 캐시된 PostGIS 이미지의 Python 확인은 실행 파일 부재/exit127이었다. 전용 Dockerfile로 캐시된 개발 base image 위에 Python/pip 개발 의존성을 설치했다. base PKI entrypoint는 실행하지 않았다. image-build.log에 실제 apk package 다운로드/설치 기록이 있다. base image pull은 하지 않았고, 시험 실행은 --pull never/network none이다. build의 package 다운로드와 시험의 network 차단을 구분한다.

```powershell
docker build --pull=false -t privacy-bubble-keyring-posix-test:local -f keyring/raspberry-pi-gateway/posix_integration_tests/Dockerfile keyring/raspberry-pi-gateway/posix_integration_tests
& ./keyring/raspberry-pi-gateway/posix_integration_tests/run-posix.ps1 -Wheel '<기존 wheel 절대경로>' -LogFile '<새 로그 절대경로>'
```

runner는 source/wheel directory를 read-only로 mount하고 원격 의존성 설치 없이 wheel을/tmp에 설치한다. import/version/모든Python module의 LF 정규화 일치를 확인한 뒤 실제 설치 console script도 실행한다. log overwrite를 거절하며 종료 시 남은 container는 exact name과소유 token 일치를 확인한 경우만 정리한다. SQLite/env placeholder는 container tmpfs에만 만들고 종료 삭제한다. TLS 파일은 내용이 TEST PLACEHOLDER인 파일이며 인증서/키가 아니다. 기존 DB·실제 credential·Docker socket·host device를 mount하지 않았다.

## 범위

Linux x86_64·Alpine3.21.9·Python3.12.16·SQLite3.48.0·Docker Desktop WSL2 kernel6.6.87.2에서 수행했다. image ID와wheel hash는 receipt에 고정했다. runtime/DB schema/firmware는 변경하지 않았고 wheel을 재빌드하지 않았다. 기존 기본56/MQTT6/실제CSE10/firmware3개 시험은 이번에 변경·재실행하지 않고 이전 evidence를 유지한다.

R02·R10·R12의 로컬 부분 증거다. tmpfs에서 fsync syscall 성공과 권한/lock을 확인했으며 Pi ARM·SD카드 전원 손실 내구성 증거는 아니다. 운영 DB adoption/backup·중앙 checkpoint/복구 승인·실물 Pi/BLE/키링/앱/웹·영상/release는 남아 있다. 실제 DB·env·PKI·wheel/image binary는 commit하지 않았다. 종료 후 소유 container0개·기존 개발4개running을 확인했다.
