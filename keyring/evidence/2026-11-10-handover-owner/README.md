# Handover 뒤 이전 Gateway 명령 승인 재현

KEYRING 남호 · DOC-REV 2.0.0 · R12, R10 · 팀 main `715ef58df6c901480eb71fb3b9278e8df6547d93` · 2026-11-10.

팀 원본의 Node API와 handover coordinator를 별도 프로세스에서 실행했다. loopback TLS 1.3/mTLS에서 Gateway A·B와 Guardian의 인증서를 구분했다. 두 Gateway에 같은 합성 장치를 등록했다. 임시 파일에 handover·명령을 저장했으며 결과를 비교할 때 후보 검사는 테스트 런타임의 `GatewayControl.active`에만 연결했다.

| 시험 | 실제 결과 |
|---|---|
| A에서 B로 전환 | 전환 전 A 명령은 기존 API도 거절 |
| 전환 후 A로 신규 발급 | 기존 API의 발급 HTTP 201, 실행 승인 `allowed=true` |
| 후보 검사 연결 후 A | 신규 발급 HTTP 403, 목록 0건, 이미 발급된 동일 epoch 명령도 `allowed=false` |
| 현재 소유 B | 현재 epoch로 발급·조회·실행 승인 통과 |
| A로 롤백 및 런타임 재기동 | B의 기존·신규 실행 권한 차단. A의 복구 후 명령은 재기동 뒤에도 승인 |
| 후보의 잘못된 입력 5개 | 기록 없음, DRAINING, 다른 장치, 매핑 없음, 낮은 epoch 모두 거절 |

Node v24.22.1에서 실제 API에 요청해 결과를 확인했다. 장치, Pi, 운영 Mobius4 및 팀 원본 소스에 변경을 적용하는 작업은 별도다. 전환 중 이미 나간 GATT 명령까지 차단하려면 중앙 승인과 drain을 원자적으로 결속해야 한다.

저장소 루트에서 위 팀 커밋의 `pc-mobius`를 새 임시 경로에 추출한 뒤 실행한다.

```powershell
$env:KEYRING_TEST_CENTRAL_TREE = '<팀 커밋을 추출한 루트 절대 경로>'
$env:KEYRING_TEST_OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'
$env:PYTHONPATH = Join-Path $PWD 'keyring/raspberry-pi-gateway/tests'
python keyring/raspberry-pi-gateway/cse_integration_tests/handover_owner.py
```

`handover.log` SHA-256 `797bae1d229df77b7fd9ef3335ae8333791e79bc9694b4bf94351e44ddac627f`.
