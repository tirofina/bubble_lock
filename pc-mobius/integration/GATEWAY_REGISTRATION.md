# Gateway AE 등록과 인증서 수명주기

`GatewayRegistrationService`는 신뢰 설정의 Gateway·principal·bootstrap 인증서·등록 기기·가구를 출발점으로 AE CREATE와 인증서 발급을 연결한다. [계약](../contracts/gateway-registration.v1.json)은 round03 `identity_binding.registration`의 AE-ID binding과 LOST 처리를 구체화한다.

운영 API 설정의 `core.registration`에 [예시](../config/gateway-registration.example.json)를 병합한다. CA 파일과 workload credential, 실제 bootstrap 설정은 `.local` 운영 설정에 둔다. bootstrap token은 32바이트 이상의 난수로 만들고 서버 설정에는 SHA256만 저장한다. Gateway는 bootstrap TLS 인증서·개인키와 원래 token을 보유한다. CSE 접근 제어는 bootstrap의 AE CREATE와 별도 workload의 등록 복구 GET 권한을 구분한다.

`POST /v1/gateway-registrations`는 `{bootstrapId,bootstrapToken,requestId,csrPem}`을 받는다. transport가 검증한 principal·인증서와 provisioning hash를 확인하고, 같은 bootstrap의 원래 요청·CSR hash를 고정한다. AE 생성은 `X-M2M-Origin:C`, `ty=2`, 고정된 `rn`과 등록 label을 사용한다. 응답의 RI/RSC/aei/ri/소유 label을 검사한다. 생성 응답이 중단되면 동일 CREATE의 conflict를 별도 workload GET으로 복구한다.

AE receipt와 `principalBindings`의 aei, bootstrap `CONSUMED`를 한 transaction으로 저장한다. 이어 서버 CA가 Gateway CSR을 서명한다. RSA2048 이상/P-256 공개키를 확인하고, 서버가 지정한 principal CN·aei URI SAN·CA:FALSE·clientAuth 용도로 발급한다. 응답은 인증서·CA chain·만료·revision이며 Gateway 개인키는 CSR을 만든 장치가 계속 보유한다. issuer 재시작 후에도 기록된 AE binding에서 발급을 이어간다.

`resolveCertificatePrincipal(fingerprint)`의 결과는 `ACTIVE`, `BOOTSTRAP`, `LOST`, `REVOKED`, `UNKNOWN`이다. API server는 UNKNOWN에서 신뢰한 기존 provisioning을 조회한다. BOOTSTRAP의 작업 경로는 등록 POST다. 활성 인증서는 현재 binding과 credential 만료를 확인한다.

`POST /v1/gateway-lifecycle/lost`는 `{gatewayId,reason,idempotencyKey}`를 받는다. `gateway:manage`와 모든 관련 가구의 Guardian membership을 검사하며 명시적인 `gateway:admin`은 운영 범위를 제공한다. Gateway LOST, binding revision 증가, credential 회수, 관련 가구의 현재 정본 grant 회수와 session 종료 intent를 한 transaction으로 기록한다. commit 뒤 `terminateSessions({fingerprint,gatewayId})`가 실제 Gateway TLS 연결을 종료한다. 중단 상태는 PENDING으로 보존하고 같은 요청에서 완료를 이어간다. 후속 요청은 소유 Gateway의 `/api/v1/gateways/{id}/credentials/status`로 LOST를 확인한다.

이 LOST의 단위는 **Gateway AE와 mTLS 인증서**다. 같은 Gateway에 속한 가구 권한에 영향을 준다. 포털의 개별 키링 분실 사건·CORE `deviceTrust` 격리는 기기 단위 작업으로 별도로 다룬다. Guardian 브라우저 OIDC 세션은 사용자 인증 수명주기를 유지한다.

`node --test test/gateway-registration.test.mjs`는 실제 로컬 HTTP CSE fixture, OpenSSL CA 서명, TLS1.3 server/client와 기존 keep-alive socket 종료를 실행한다. 원래 intent 재전송, 다른 인증서·token, AE 응답 손실, issuer 재시작, 저장 rollback과 LOST 재실행을 함께 검사한다. 이 증거는 `LOCAL_REAL_PROTOCOL`과 시험용 CA/서비스의 범위다.

2026-11-10 최종 시험 6개가 통과했다. [실행 receipt](evidence/2026-11-10-registration/receipt.json)에는 도구 버전·소스 SHA-256·검사 범위를, [TAP 로그](evidence/2026-11-10-registration/tests.log)에는 각 시험 결과와 실행 시간을 보관한다.

배포 TODO는 실제 CSE의 bootstrap·workload 권한 설정, 운영 CA 키 보관·신뢰 체인, Gateway의 CSR·인증서 설치와 BLE 자격 상태 polling, 실장비의 연결 종료 receipt다. 소프트웨어 증거와 배포·실물 receipt를 각각 연결한다.
