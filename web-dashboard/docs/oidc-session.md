# 사용자 OIDC 브라우저 세션

`server/oidc-session.ts`는 Authorization Code + PKCE S256 로그인, callback, 토큰 갱신, 로그아웃을 제공한다. [설정 예시](../config/oidc.example.json)는 등록된 issuer, clientId, API audience, callback, 사용자 subject와 최대 scope를 연결한다. 실제 설정과 clientSecret은 `.local/`의 운영 파일로 관리한다.

CLI의 `PORTAL_CONFIG_FILE`에 이 JSON 파일 경로를 지정한다. 파일 구조는 `{oidc: OidcSessionConfig, api: {baseUrl: HTTPS_URL, caFile?: CA_PATH}}`이며 `oidc` 객체가 세션 관리자에 전달된다. `api`는 `server/portal-upstream.ts`가 Bearer token을 보낼 중앙 integration API와 신뢰 CA를 지정한다.

## 연결 인터페이스

```ts
const auth = await createOidcSessionManager(config);
if (await auth.handle(request, response)) return;
const identity = await auth.authenticate(request);
if (identity === null) { /* 로그인 진입 응답 */ }
if (request.method === 'POST') auth.assertMutationOrigin(request);
// 동일 프로세스의 서버 내부 runtime 사용:
await runtime.api.handle({ method: request.method, path, body, principal: identity!.principal });
// 별도 integration HTTPS 서버 사용:
// Authorization: Bearer <identity.accessToken>
// 등록된 CA로 서버 인증서를 검증한 HTTPS 요청으로 전달한다.
```

`authenticate()`의 반환형은 `{principal, accessToken, expiresAt} | null`이다. `accessToken`은 서버 간 호출용이며, `GET /api/auth/session`은 `{mode:'live',authenticated,loginUrl,principal?,expiresAt?}`만 반환한다. 본문·URL의 role/principal은 서버 세션 identity에 의해 결정된다. demo 모드의 고정 identity와 운영 session store는 각각의 실행 인스턴스에서 분리한다.

| 경로 | 방법 | 결과 |
|---|---|---|
| `/api/auth/login?returnTo=/family` | GET | state·nonce·PKCE 생성, IdP redirect |
| `/api/auth/callback` | GET | 일회성 state/cookie 검사, code 교환, ID/access token 검증, 새 session cookie |
| `/api/auth/session` | GET | 로그인 여부·공개 principal·세션 만료 시각·로그인 URL |
| `/api/auth/logout` | POST | 동일 origin 검사, 서버 세션 삭제, session/login cookie 만료 |

callback은 `redirectUri`의 정확한 `/api/auth/callback` 경로에 등록한다. `returnTo`는 같은 origin의 상대 경로만 받는다. 쓰기 요청은 `Origin`이 callback origin과 일치해야 한다. 앞단 HTTPS 프록시를 사용하는 배포에서는 프록시와 브라우저의 공개 origin을 callback에 설정한다.

## 토큰과 세션 경계

Discovery는 고정한 HTTPS issuer URL에서 가져오며 issuer 값을 대조한다. authorization/token/JWKS endpoint는 issuer origin 또는 `trustedEndpointOrigins`에 등록된 HTTPS origin을 사용한다. 응답 제한은 1 MiB, timeout은 8초이며 redirect 응답은 검증 오류로 처리한다. code flow, S256, 등록한 client 인증 방식을 discovery metadata로 확인한다. 공개 client는 `none`, `clientSecret`을 설정한 client는 `client_secret_basic`으로 token endpoint에 연결한다.

ID token은 `clientId` audience, 서명, issuer, exp, iat, nonce, sub, azp와 제공된 at_hash를 검사한다. access token은 별도 API `audience`, 서명, issuer, exp, nbf와 서버에 등록한 subject를 확인한다. 실제 principal scope는 token scope와 등록 scope의 교집합이다. JWT 서명 검증에는 `pc-mobius/integration/src/oidc-verifier.mjs`의 RS256/ES256 검증기를 사용한다.

운영 cookie는 `__Host-bubble_session`, `__Host-bubble_login` 이름과 `Path=/; HttpOnly; SameSite=Lax; Secure` 속성을 사용한다. cookie에는 256-bit 무작위 ID를 넣고 access/refresh token은 서버 메모리에 보관한다. 세션은 기본 8시간 절대 만료, 30분 유휴 만료, 로그인 대기는 5분으로 제한하며 session 최대 1024개, 로그인 대기 최대 256개를 보관한다. 프로세스를 재시작하면 새 로그인으로 연결한다. 여러 서버 인스턴스를 사용하는 배포는 동일 session store 또는 세션 라우팅을 연결한다.

access token 만료 30초 전부터 refresh token을 교환한다. 같은 세션의 동시 요청은 하나의 refresh 작업을 공유하고 새 refresh token이 반환되면 교체한다. 갱신 시 subject 일치를 다시 검사하며 token 검증 오류가 발생하면 해당 세션을 종료한다. 로그아웃은 이 앱의 서버 세션과 cookie를 종료하며 IdP SSO 세션은 IdP의 별도 세션 정책을 따른다.

로컬 개발은 `allowLoopbackHttp:true`와 `http://127.0.0.1:<port>/api/auth/callback`을 명시한다. 이 모드의 cookie는 `bubble_session_dev`, `bubble_login_dev`를 사용한다. 기본 설정은 운영 HTTPS cookie이다.

## ZIP 요구와 실행 증거

ZIP의 OIDC 사용자 인증·승인과 Guardian/Visitor 앱 요구를 브라우저 code flow, 서버 principal binding, household 권한, current grant, 알림과 연결했다. 로컬 검증은 `test/oidc-session.test.ts`의 HTTP 요청과 가상 IdP의 생성 RSA 키/서명으로 수행한다. PKCE verifier 대조, state 재사용, nonce·audience·subject 검증, refresh rotation·동시 요청, 로그아웃·TTL, endpoint origin, 세션 제한, Secure cookie를 시험한다.

실제 API transport는 `tests/integration/test_oidc_api.py`가 Python httpx ↔ Node TLS 1.3에서 시험용 PKI와 서명 토큰으로 검증한다. 외부 IdP의 실제 사용자 계정·등록된 callback·배포 인증서는 운영 설정을 채운 후 로그인 receipt와 함께 확인하는 범위다. 실물 Gateway·키링 실행 결과는 canonical 명령의 ACK/readback receipt로 판정한다.

참고 규격: [OpenID Connect Authorization Code Flow](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth), [PKCE RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), [OIDC Refresh Tokens](https://openid.net/specs/openid-connect-core-1_0.html#RefreshTokens).
