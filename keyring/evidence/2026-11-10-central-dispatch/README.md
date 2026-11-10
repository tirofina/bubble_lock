# 중앙 명령과 Mobius4 영수증 통합 시험

KEYRING 남호 · DOC-REV 2.0.0 · Gateway 0.2.5 · 2026-11-10.

팀 main `715ef58`의 Node 중앙 API와 Gateway 전체 worker를 연결했다. 명령 조회·현재 승인에는 실제 loopback mTLS를 썼고, 장치 구간은 모의 GATT로 응답했다. Gateway는 새 SQLite journal에 기록한 결과를 격리 Mobius4에 전송했다.

| 사례 | 기대 결과 | 실측 결과 |
|---|---|---|
| 연결 전에 승인 명령을 수신 | `RECEIVED`에 보존하고 쓰기 가능한 세션에서 승인 후 실행. 반복 poll은 한 번만 처리 | 연결 대기 중 쓰기와 dispatch intent 0. 연결 뒤 GATT 조각 13개로 명령 1개. `APPLIED`와 `state=true` 저장. 중복 poll 2회 이상에서 재실행 0 |
| 조회 뒤 연결 전에 grant 회수 | 연결 뒤 현재 승인에서 거절. GATT 쓰기 0 | `REJECTED / NOT_AUTHORIZED`, 쓰기 0, readback null |
| 두 사례의 전송·종료 | 새 receipt container에 1개씩 기록. CSE에서 읽은 내용과 SQLite journal 일치. 정상 종료 | 각각 cin 1개. HTTP 200 / RSC 2000과 전체 내용 일치. 두 Gateway 정상 종료 |

기본 회귀시험 63개가 통과했다. 연결 대기, 승인 도중 세션 교체, 대기 명령 16개 뒤의 준비된 장치 처리, 관측 전용 GATT, 이전 세션의 쓰기 차단을 추가로 확인했다. 수정 전 추가 dispatch 회귀시험 3개가 실패했다.

네트워크 없이 Gateway 0.2.5 wheel을 빌드했고, 패키지에 포함된 Python 파일이 시험 소스와 일치함을 확인했다. wheel은 로컬 시험 폴더에 보관했다.

첫 중앙 시험에서는 부분 추출에 팀 CORE 모듈이 빠져 Node가 시작하지 못했다. 팀 `pc-mobius` 전체를 같은 SHA에서 추출해 해결했다. 이어 정상 종료 시 worker와 stop waiter가 함께 완료되면 오류로 보고하는 경합을 재현했다. 정지 요청 중 정상 반환을 허용하되 worker 예외는 그대로 전달하도록 수정했고, 최종 통합 2개가 통과했다.

최종 실행은 캐시 이미지, fresh CA와 시험 자격, loopback 포트, 새 PostgreSQL과 SQLite를 사용했다. 종료 후 시험용 container와 network 잔여 0, 기존 개발 container 4개 실행 상태를 확인했다. Pi의 0.2.4 설치본과 관측용 Feather 0.1.1은 앞선 실물 증거에 해당한다. 실제 장치 명령·물리 출력 readback, 운영 등록, CORE ACK 정산과 앱/웹은 다음 통합 단계다.

재현 절차와 결과는 [시험 절차](../../raspberry-pi-gateway/TESTING.md#중앙-명령-통합-시험), [기본 63개 로그](gateway-tests.log), [중앙 통합 로그](central-dispatch.log), [증거 해시](receipt.json)에 있다.
