# 실제 MQTT broker·TLS·ACL 시험

2026-10-30 · KEYRING / 남호 · DOC-REV2.0.0 · Gateway0.2.2 · 시험 source5dec2c0.

캐시된 Mosquitto2.1.2를 새 임시 Docker 컨테이너에서 실행해 Gateway/Paho의 실제 MQTT3.1.1·TLSv1.3·mTLS를 확인했다. 응답 peer는 합성 oneM2M 프레임을 보내는 시험 코드다. 실제 Mobius CSE·중앙 승인 정책을 구현하거나 접속하지 않았다. Gateway 런타임 source3dd2e20과 기존 wheel은 변경·재빌드하지 않았다.

| 실행 | 실제 결과 | 로그 |
|---|---|---|
| 소스 MQTT integration | exit0,6개 OK,17.845초 | [source](mqtt-source-tests.log) |
| 기존 설치 package MQTT integration | exit0,6개 OK,17.956초. import 경로·version·모든 Python module 소스 일치 확인 | [installed](mqtt-installed-tests.log) |
| 기본 suite·소스 | exit0,55개 OK,2.497초 | [default source](default-source-tests.log) |
| 기본 suite·설치 package | exit0,55개 OK,2.364초 | [default installed](default-installed-tests.log) |

모든 실행 skipped0. MQTT6개는 기본55개와 별도로 실행한다. broker-source/·broker-installed/에 각6개 실제 broker 로그가 있다. [receipt.json](receipt.json)에 로그·소스·기존 wheel hash와 이미지 ID·환경·범위를 기록했다.

## 확인한 경계

아래 ID는 KEYRING 제안 추적 ID다. R02/R03/R10의 로컬 부분 증거이며 실제 중앙 gate 승인·A01~A26 완료로 표시하지 않는다.

| ID | test_mqtt_tls.py | 실제 결과 |
|---|---|---|
| KR-MQTT-WIRE-01 | test_mqtt_tls_application_receipt_completes_without_https | 실제 MQTT/TLS, matching rqi/rsc2001 수신·HTTPS 요청0회 |
| KR-MQTT-WIRE-02 | test_puback_without_application_response_falls_back_with_same_cin | 실제 PUBACK을 받아도 application response가 없으면 같은 cin/rn으로 HTTPS fallback |
| KR-MQTT-WIRE-03 | test_wrong_response_rqi_cannot_settle_mqtt_request | 다른 rqi는 정산하지 않고 같은 cin으로 fallback |
| KR-MQTT-WIRE-04 | test_application_denial_does_not_bypass_through_https | rsc4103 거절 뒤 HTTPS 우회0회 |
| KR-MQTT-WIRE-05 | test_certificate_identity_acl_denies_other_originator_topic | CN=gw-test의 Other Originator topic PUBLISH를 broker가 거절. PUBACK과 실제 허용은 별개임을 확인 |
| KR-MQTT-WIRE-06 | test_broker_disconnect_fails_pending_and_uses_https | 실제 broker 종료 후 pending future가10초 timeout 대신 ConnectionError로 종료·HTTPS fallback |

## 환경과 재실행

Windows11/Python3.12.14·Docker29.4.0·Mosquitto2.1.2/Linux amd64. 사용한 캐시 이미지 ID는 `sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f`다. 새 이미지는 다운로드하지 않는다. OpenSSL 실행 파일과 기본 suite의 Python 의존성이 필요하다.

저장소 root의 PowerShell:

```powershell
$env:KEYRING_TEST_OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'
$env:KEYRING_TEST_MQTT_IMAGE = 'sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f'
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src') + [IO.Path]::PathSeparator + (Join-Path $PWD 'keyring/raspberry-pi-gateway/tests')
python -m unittest discover -s keyring/raspberry-pi-gateway/integration_tests -v
```

KEYRING_TEST_MQTT_LOG_DIR를 지정하면 broker 로그를 해당 로컬 경로에 저장한다. integration suite는 명시적으로 실행해야 하며 기본 tests/ 발견에는 포함되지 않는다. Docker·캐시 이미지·OpenSSL이 없으면 실패하고 skip하지 않는다.

각 시험은 생성한 PKI만 read-only로 마운트하고 loopback 임시 포트·고유 container/token을 사용한다. 중지·삭제 전에 token을 검사한다. 시험 컨테이너를 모두 삭제했고 현재 남은 시험 컨테이너는0개다. 기존 개발 서버4개는 관찰 전후 running이며 변경하지 않았다. 인증서·키는 종료 시 임시 폴더에서 삭제한다. 테스트 전용 container 사용자/ACL 구성을 운영 구성에 복사하지 않는다.

실제 Pi/BlueZ·키링·중앙 PKI/principal·AE/grant/ACP·CSE 저장/정산·영상/release는 미검증이다. 실제 Pi 접속 대상과 보드·화면 준비 상태의 기존 질문은 답변 대기 중이다.
