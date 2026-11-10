# 로컬 HTTPS·TLS 시험 기록

2026-10-30 · KEYRING / 남호 · DOC-REV2.0.0 · Gateway0.2.2 · 시험 source76253ce.

HTTPS 전송을 모의 응답으로 대체하던 범위를 넘어 Python SSL/httpx와 실제 loopback TCP·HTTP를 사용했다. 런타임 코드는3dd2e20에서 변경하지 않았으며 기존0.2.2 wheel을 재사용했다. 운영 CSE·인증서·DB에 접근하지 않았다.

| 실행 | 실제 결과 | 로그 |
|---|---|---|
| TLS 전용8개 | exit0,8개 OK,1.765초 | [TLS log](https-tls-tests.log) |
| 전체 소스 | exit0,55개 OK,2.450초 | [source log](source-tests.log) |
| 기존 설치 wheel | exit0,55개 OK,2.481초. import 경로·version과 모든 Python 모듈의 소스 일치를 확인 | [installed log](installed-tests.log) |

모든 실행은 skipped0이다. Windows11/Python3.12.14, Python SSL OpenSSL3.5.8, 인증서 생성 도구 OpenSSL3.5.5에서 수행했다. 로그·시험 코드 hash와 전체 환경은 [receipt.json](receipt.json)에 있다. 기존 wheel SHA256은 `88c5efa07fd2f376d005f2665478baa14cf44f055e57874ce3952ee0ebb1eca3`이며 [원래 build/install 기록](../2026-10-30-receipt-routing/README.md)을 유지한다. 이번에는 패키지·펌웨어를 수정하거나 재빌드하지 않았다.

## 확인한 경계

아래는 KEYRING 제안 추적 ID이며 G-SEC의 로컬 부분 증거다. 중앙 gate 승인이나 원래 A01~A26 완료로 표시하지 않는다.

| ID | test_https_tls.py | 실제 결과 |
|---|---|---|
| KR-HTTPS-TLS-01 | test_publish_uses_tls13_mtls_and_actual_onem2m_headers | TLSv1.3·test client CN=gw-test, X-M2M-Origin/RI/RVI·ty4·UTF8 con·안정적 rn 확인 |
| KR-HTTPS-TLS-02 | test_untrusted_server_ca_is_rejected_before_http | 신뢰하지 않는 서버 CA 거절·HTTP 수락0회 |
| KR-HTTPS-TLS-03 | test_untrusted_client_is_rejected_before_http | 다른 CA의 client 인증서 거절·HTTP 수락0회 |
| KR-HTTPS-TLS-04 | test_missing_client_certificate_is_rejected_before_http | client 인증서 없는 대조군 거절·HTTP 수락0회 |
| KR-HTTPS-TLS-05 | test_tls12_only_peer_is_rejected_without_downgrade | TLS1.2 전용 server 거절·HTTP 수락0회 |
| KR-HTTPS-TLS-06 | test_server_ip_identity_mismatch_is_rejected_before_http | 신뢰 CA가 서명했어도 SAN/IP 불일치 거절·HTTP 수락0회 |
| KR-HTTPS-TLS-07 | test_redirect_is_not_followed | HTTP302 거절·후속 redirect 요청0회 |
| KR-HTTPS-TLS-08 | test_proxy_and_ca_environment_do_not_override_configured_tls | 주입한 proxy 접속0회·설정한 CA로 직접 TLS 전송 성공 |

인증서와 키는 suite 실행마다 새 임시 폴더에서 생성해8개 TLS 시험에서 사용하고 종료 후 삭제한다. 모든 서버는127.0.0.1의 OS 할당 포트에 바인딩한다. proxy 대조군도 시험이 직접 소유한 socket이다. 개인키·인증서 파일은 Git에 올리지 않는다.

## 재실행

OpenSSL 실행 파일과 Python TLS1.3 지원이 필요하다. 없으면 시험은 실패하며 skip으로 숨기지 않는다. 저장소 root의 PowerShell 예:

```powershell
$env:KEYRING_TEST_OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'
$env:PYTHONPATH = (Join-Path $PWD 'keyring/raspberry-pi-gateway/src')
python -m unittest discover -s keyring/raspberry-pi-gateway/tests -v
```

Linux 등에서는 openssl이 PATH에 있으면 별도 실행 파일 지정이 필요 없다. 설치 package 시험은 PYTHONPATH를 원래0.2.2 wheel의 격리 설치 경로로 지정한 뒤 같은 suite를 실행했다.

중앙 principal→AE Originator binding·grant/ACP, 실제 MQTT TLS/ACL·broker·CSE, Pi/BlueZ/키링 실물, 전력·거리·영상·release는 미검증이다. 이번 시험 서버는 이 중앙 정책을 구현하거나 운영 자원을 대체하지 않는다.
