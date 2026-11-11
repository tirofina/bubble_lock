# Gateway 등록·LOST 실제 TLS 시험

2026-11-10 `node --test pc-mobius/test/gateway-registration.test.mjs`의 6개 시험이 PASS다. [receipt.json](receipt.json)은 실행 환경·소스 SHA-256·프로토콜·검사 범위를 연결하고 [tests.log](tests.log)는 실행 결과를 보존한다.

로컬 oneM2M HTTP fixture, 실제 OpenSSL CA/CSR 서명, 실제 TLS1.3 API server/client를 사용했다. 새 인증서 runtime binding, bootstrap 전용 경로, LOST의 binding·credential·grant 회수, 활성 keep-alive socket 종료, 소유 Gateway 상태 polling을 검증했다. 증거 분류는 `LOCAL_REAL_PROTOCOL`이다.

운영 CSE 권한·CA·Gateway 인증서 설치와 실물 연결 종료 receipt는 배포 TODO topic이다. 등록 계약과 API는 [GATEWAY_REGISTRATION.md](../../GATEWAY_REGISTRATION.md)에 설명한다.
