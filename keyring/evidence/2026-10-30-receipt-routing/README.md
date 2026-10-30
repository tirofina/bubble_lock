# 영수증 이중 경로 회귀 시험

KEYRING / 남호 · DOC-REV2.0.0 · 2026-10-30 · Gateway0.2.2 · source3dd2e20.

[처리 규칙·시험 ID](../../raspberry-pi-gateway/RECEIPT_ROUTING.md)에 ACK 재생성과 native retry backoff 문제, 최초 원자적 staging, 각 경로의 독립 전달 상태를 설명한다. CORE91a281b·wire·DB schema는 유지했다.

| 실행 | 실제 결과 | 로그 |
|---|---|---|
| 수정 전 회귀5개 | exit1,3 failures·2 pass. bounded worker에서 동일 ACK4회 송신 | [baseline.log](baseline.log) |
| 수정 후 전체 소스 시험 | exit0,47개 OK,1.073초 | [source-tests.log](source-tests.log) |
| offline wheel build·별도 경로 설치 | 각각 exit0,40491bytes | [build](wheel-build.log),[install](wheel-install.log) |
| 설치 패키지 전체 시험 | exit0,47개 OK,1.068초. import 경로·version0.2.2 확인 후 실행 | [installed-tests.log](installed-tests.log) |

Windows11/Python3.12.14에서 수행했다. `privacy_bubble_gateway-0.2.2-py3-none-any.whl` SHA256은 `88c5efa07fd2f376d005f2665478baa14cf44f055e57874ce3952ee0ebb1eca3`다. 로컬 `_local/keyring-gateway-022-wheel/`에 보관하며 [receipt.json](receipt.json)에 실제 로그·소스·산출물 hash를 기록했다.

소스 시험은 저장소 루트에서 PYTHONPATH를 `keyring/raspberry-pi-gateway/src`로 지정하고 `python -m unittest discover -s keyring/raspberry-pi-gateway/tests -v`를 실행한다. wheel은 Gateway 프로젝트에서 `python -m pip wheel --no-index --no-deps --no-build-isolation --wheel-dir ../../../_local/keyring-gateway-022-wheel .`로 빌드했다. `pip install --no-index --no-deps --target <새 임시 경로> <wheel>` 설치 후 PYTHONPATH를 그 경로로 바꾸고 같은 시험을 실행했다.

합성 명령·새 임시 SQLite와 모의 전송만 사용했다. 기존 DB·실제 broker/CSE·BLE·장비·Pi·daemon·운영 서비스는 실행하지 않았다. firmware는 수정·재빌드하지 않았다. 이전 [세 프로필 빌드](../2026-10-29-local-validation/README.md),[BLE 세션42개 시험](../2026-10-30-ble-sessions/README.md)은 원래 기록으로 보존한다. 전체 실물·중앙 통합·영상·release는 미완료다.
