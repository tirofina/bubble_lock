import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface OidcPrincipal {
  principalId: string; originator: string; scopes: string[]; authentication: 'oidc';
  issuer: string; subject: string; expiresAt: string;
}
export interface OidcEnrollment { principalId: string; oidcIssuer: string; oidcSubject: string; scopes: string[]; originator?: string }
export interface OidcSessionConfig {
  issuer: string; clientId: string; audience: string; redirectUri: string; principals: OidcEnrollment[];
  scopes?: string[]; clientSecret?: string; discoveryUrl?: string; trustedEndpointOrigins?: string[];
  allowLoopbackHttp?: boolean; sessionTtlSec?: number; idleTtlSec?: number; loginTtlSec?: number;
  maxSessions?: number; maxPendingLogins?: number; clock?: () => number; fetchImpl?: typeof fetch;
}
export interface OidcIdentity { principal: OidcPrincipal; accessToken: string; expiresAt: string }
export interface OidcSessionManager {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  authenticate(request: IncomingMessage): Promise<OidcIdentity | null>;
  assertMutationOrigin(request: IncomingMessage): void;
  close(): void;
}
interface Verifier {
  verify(authorization: string): Promise<Record<string, unknown>>;
  principal(authorization: string, enrollment: OidcEnrollment[]): Promise<OidcPrincipal>;
}
interface VerifierModule { OidcVerifier: new (config: Record<string, unknown>) => Verifier }
interface Login { state: string; nonce: string; verifier: string; returnTo: string; expiresAt: number }
interface Session {
  principal: OidcPrincipal; accessToken: string; refreshToken: string | null; nonce: string;
  expiresAt: number; idleExpiresAt: number; tokenExpiresAt: number;
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const random = () => randomBytes(32).toString('base64url');
const equal = (left: string, right: string) => {
  const leftBytes = Buffer.from(left); const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};
const bounded = (value: number | undefined, fallback: number, min: number, max: number) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error('OIDC 제한값을 확인하세요.');
  return result;
};
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(JSON.stringify(body));
}
function cookie(request: IncomingMessage, name: string): string | null {
  const values = String(request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** OIDC 토큰은 서버 메모리에 보관하고 브라우저에는 무작위 세션 ID를 전달합니다. */
export async function createOidcSessionManager(config: OidcSessionConfig): Promise<OidcSessionManager> {
  const clock = config.clock ?? Date.now;
  const fetchImpl = config.fetchImpl ?? fetch;
  const issuer = new URL(config.issuer);
  const callback = new URL(config.redirectUri);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname);
  const secure = callback.protocol === 'https:';
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash || issuer.search) throw new Error('등록된 HTTPS issuer를 확인하세요.');
  if (!secure && !(config.allowLoopbackHttp === true && loopback && callback.protocol === 'http:')) throw new Error('HTTPS callback 또는 명시적인 loopback 개발 설정을 사용하세요.');
  if (callback.pathname !== '/api/auth/callback' || callback.search || callback.hash || callback.username || callback.password) throw new Error('callback 경로는 /api/auth/callback으로 등록하세요.');
  if (!config.clientId || !config.audience || !Array.isArray(config.principals)) throw new Error('OIDC client·audience·principal 등록을 확인하세요.');
  const principals = structuredClone(config.principals);
  if (principals.some((entry) => entry.oidcIssuer !== config.issuer || !entry.oidcSubject || !entry.principalId || !Array.isArray(entry.scopes))
    || new Set(principals.map((entry) => entry.oidcSubject)).size !== principals.length) throw new Error('고유한 OIDC subject와 principal을 등록하세요.');
  const scopes = [...new Set(['openid', ...(config.scopes ?? ['portal:read'])])];
  if (scopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) throw new Error('OIDC scope 형식을 확인하세요.');
  const trustedOrigins = new Set([issuer.origin, ...(config.trustedEndpointOrigins ?? [])]);
  for (const origin of trustedOrigins) if (new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:') throw new Error('OIDC endpoint의 HTTPS origin을 등록하세요.');
  const endpoint = (value: unknown) => {
    if (typeof value !== 'string') throw new Error('OIDC endpoint를 확인하세요.');
    const url = new URL(value);
    if (url.protocol !== 'https:' || !trustedOrigins.has(url.origin) || url.username || url.password || url.hash) throw new Error('등록된 OIDC endpoint origin을 사용하세요.');
    return url.href;
  };
  const fetchJson = async (url: string, init: RequestInit = {}) => {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', ...init.headers } });
    if (!response.ok || !response.body) throw new Error('OIDC 응답을 확인하세요.');
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new Error('OIDC 응답 크기를 확인하세요.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(value)) throw new Error('OIDC JSON 응답을 확인하세요.');
    return value;
  };
  const discovery = await fetchJson(endpoint(config.discoveryUrl ?? `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`));
  if (discovery['issuer'] !== config.issuer) throw new Error('Discovery issuer 일치를 확인하세요.');
  const authorizationEndpoint = endpoint(discovery['authorization_endpoint']);
  const tokenEndpoint = endpoint(discovery['token_endpoint']);
  const jwksUri = endpoint(discovery['jwks_uri']);
  if (!Array.isArray(discovery['response_types_supported']) || !discovery['response_types_supported'].includes('code')
    || !Array.isArray(discovery['code_challenge_methods_supported']) || !discovery['code_challenge_methods_supported'].includes('S256')) throw new Error('Authorization Code와 PKCE S256을 지원하는 IdP를 사용하세요.');
  const authMethod = config.clientSecret ? 'client_secret_basic' : 'none';
  const supportedMethods = discovery['token_endpoint_auth_methods_supported'] ?? ['client_secret_basic'];
  if (!Array.isArray(supportedMethods) || !supportedMethods.includes(authMethod)) throw new Error('등록한 client 인증 방식과 IdP 설정을 맞추세요.');
  const module = await import(new URL('../../pc-mobius/integration/src/oidc-verifier.mjs', import.meta.url).href) as VerifierModule;
  const verification = { issuer: config.issuer, jwksUri, fetchImpl, clock, clockSkewSec: 0 };
  const accessVerifier = new module.OidcVerifier({ ...verification, audience: config.audience });
  const idVerifier = new module.OidcVerifier({ ...verification, audience: config.clientId });
  const sessionTtl = bounded(config.sessionTtlSec, 28800, 60, 86400) * 1000;
  const idleTtl = bounded(config.idleTtlSec, 1800, 30, 86400) * 1000;
  const loginTtl = bounded(config.loginTtlSec, 300, 30, 600) * 1000;
  const maxSessions = bounded(config.maxSessions, 1024, 1, 10000);
  const maxPending = bounded(config.maxPendingLogins, 256, 1, 10000);
  const sessionCookie = secure ? '__Host-bubble_session' : 'bubble_session_dev';
  const loginCookie = secure ? '__Host-bubble_login' : 'bubble_login_dev';
  const cookies = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}${secure ? '; Secure' : ''}`;
  const sessions = new Map<string, Session>();
  const logins = new Map<string, Login>();
  const refreshing = new Map<string, Promise<Session | null>>();
  let closed = false;
  const prune = () => {
    const now = clock();
    for (const [id, entry] of logins) if (entry.expiresAt <= now) logins.delete(id);
    for (const [id, entry] of sessions) if (entry.expiresAt <= now || entry.idleExpiresAt <= now) sessions.delete(id);
  };
  const exchange = async (fields: Record<string, string>) => {
    const body = new URLSearchParams({ ...fields, client_id: config.clientId });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (config.clientSecret) {
      const encode = (value: string) => new URLSearchParams({ key: value }).toString().slice(4);
      headers['Authorization'] = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString('base64')}`;
    }
    return fetchJson(tokenEndpoint, { method: 'POST', headers, body: body.toString() });
  };
  const verifyTokens = async (tokens: Record<string, unknown>, nonce: string, expected?: Session) => {
    const accessToken = tokens['access_token']; const refreshToken = tokens['refresh_token']; const idToken = tokens['id_token'];
    if (typeof accessToken !== 'string' || accessToken.length > 16384 || typeof tokens['token_type'] !== 'string' || tokens['token_type'].toLowerCase() !== 'bearer'
      || (refreshToken !== undefined && (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 16384))) throw new Error('OIDC token 응답을 확인하세요.');
    const principal = await accessVerifier.principal(`Bearer ${accessToken}`, principals);
    if (!expected || idToken !== undefined) {
      if (typeof idToken !== 'string') throw new Error('서명된 ID token을 확인하세요.');
      const claims = await idVerifier.verify(`Bearer ${idToken}`);
      if (claims['sub'] !== principal.subject || typeof claims['iat'] !== 'number'
        || (!expected && (typeof claims['nonce'] !== 'string' || !equal(claims['nonce'], nonce)))
        || (expected && claims['nonce'] !== undefined && (typeof claims['nonce'] !== 'string' || !equal(claims['nonce'], nonce)))
        || (Array.isArray(claims['aud']) && claims['aud'].length > 1 && claims['azp'] !== config.clientId)
        || (claims['azp'] !== undefined && claims['azp'] !== config.clientId)) throw new Error('ID token subject·nonce·client 결속을 확인하세요.');
      if (claims['at_hash'] !== undefined) {
        const hash = createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url');
        if (typeof claims['at_hash'] !== 'string' || !equal(claims['at_hash'], hash)) throw new Error('ID token access token 결속을 확인하세요.');
      }
    }
    if (expected && (principal.principalId !== expected.principal.principalId || principal.subject !== expected.principal.subject)) throw new Error('갱신 token의 subject 일치를 확인하세요.');
    let tokenExpiresAt = Date.parse(principal.expiresAt);
    if (tokens['expires_in'] !== undefined) {
      if (typeof tokens['expires_in'] !== 'number' || !Number.isFinite(tokens['expires_in']) || tokens['expires_in'] <= 0) throw new Error('Token 유효기간을 확인하세요.');
      tokenExpiresAt = Math.min(tokenExpiresAt, clock() + tokens['expires_in'] * 1000);
    }
    return { principal, accessToken, refreshToken: typeof refreshToken === 'string' ? refreshToken : expected?.refreshToken ?? null, tokenExpiresAt };
  };
  const refresh = (id: string, session: Session): Promise<Session | null> => {
    const pending = refreshing.get(id);
    if (pending) return pending;
    const next = (async () => {
      try {
        if (!session.refreshToken) throw new Error('로그인 갱신이 필요합니다.');
        const tokens = await exchange({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
        const updated = { ...session, ...await verifyTokens(tokens, session.nonce, session) };
        if (closed || sessions.get(id) !== session || updated.expiresAt <= clock() || updated.idleExpiresAt <= clock()) return null;
        sessions.set(id, updated);
        return updated;
      } catch { sessions.delete(id); return null; }
      finally { refreshing.delete(id); }
    })();
    refreshing.set(id, next);
    return next;
  };
  const assertMutationOrigin = (request: IncomingMessage) => {
    if (request.headers.origin !== callback.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new Error('로그인한 화면의 동일 origin에서 요청하세요.');
  };
  const authenticate = async (request: IncomingMessage): Promise<OidcIdentity | null> => {
    if (closed) return null;
    prune();
    const id = cookie(request, sessionCookie);
    let session = id ? sessions.get(id) : undefined;
    if (!id || !session) return null;
    if (session.tokenExpiresAt <= clock() + 30000 && session.refreshToken) session = await refresh(id, session) ?? undefined;
    if (!session || session.tokenExpiresAt <= clock()) { sessions.delete(id); return null; }
    try {
      session.principal = await accessVerifier.principal(`Bearer ${session.accessToken}`, principals);
      if (closed || sessions.get(id) !== session) return null;
      session.idleExpiresAt = Math.min(session.expiresAt, clock() + idleTtl);
      return { principal: structuredClone(session.principal), accessToken: session.accessToken, expiresAt: new Date(session.expiresAt).toISOString() };
    } catch { sessions.delete(id); return null; }
  };
  return {
    authenticate, assertMutationOrigin,
    close() { closed = true; logins.clear(); sessions.clear(); refreshing.clear(); },
    async handle(request, response) {
      const url = new URL(request.url ?? '/', callback.origin);
      if (!['/api/auth/login', '/api/auth/callback', '/api/auth/session', '/api/auth/logout'].includes(url.pathname)) return false;
      if (closed) { json(response, 503, { mode: 'live', message: '인증 서비스를 준비하고 있습니다.' }); return true; }
      prune();
      try {
        if (url.pathname === '/api/auth/session' && request.method === 'GET') {
          const identity = await authenticate(request);
          json(response, 200, { mode: 'live', authenticated: identity !== null, loginUrl: '/api/auth/login', ...(identity ? { principal: identity.principal, expiresAt: identity.expiresAt } : {}) });
          return true;
        }
        if (url.pathname === '/api/auth/login' && request.method === 'GET') {
          if (sessions.size >= maxSessions || logins.size >= maxPending) { json(response, 503, { mode: 'live', message: '진행 중인 로그인 처리가 완료된 뒤 다시 연결하세요.' }); return true; }
          const returnTo = url.searchParams.get('returnTo') ?? '/';
          if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\') || returnTo.length > 2048 || new URL(returnTo, callback.origin).origin !== callback.origin) throw new Error('로그인 후 이동 경로를 확인하세요.');
          const id = random(); const login = { state: random(), nonce: random(), verifier: random(), returnTo, expiresAt: clock() + loginTtl };
          const previous = cookie(request, loginCookie);
          if (previous) logins.delete(previous);
          logins.set(id, login);
          const authorize = new URL(authorizationEndpoint);
          for (const [name, value] of Object.entries({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: scopes.join(' '), state: login.state, nonce: login.nonce, code_challenge: createHash('sha256').update(login.verifier).digest('base64url'), code_challenge_method: 'S256' })) authorize.searchParams.set(name, value);
          response.writeHead(302, { Location: authorize.href, 'Set-Cookie': cookies(loginCookie, id, loginTtl / 1000), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
          response.end(); return true;
        }
        if (url.pathname === '/api/auth/callback' && request.method === 'GET') {
          const id = cookie(request, loginCookie); const login = id ? logins.get(id) : undefined;
          if (id) logins.delete(id);
          response.setHeader('Set-Cookie', cookies(loginCookie, '', 0));
          const state = url.searchParams.get('state'); const code = url.searchParams.get('code');
          if (!login || !state || !equal(state, login.state) || !code || code.length > 4096 || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')
            || (url.searchParams.has('iss') && url.searchParams.get('iss') !== config.issuer)) throw new Error('로그인 state와 code를 확인하세요.');
          const tokens = await exchange({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: login.verifier });
          const verified = await verifyTokens(tokens, login.nonce);
          if (closed || sessions.size >= maxSessions) throw new Error('로그인 세션을 확인하세요.');
          const previous = cookie(request, sessionCookie);
          if (previous) sessions.delete(previous);
          const sessionId = random();
          sessions.set(sessionId, { ...verified, nonce: login.nonce, expiresAt: clock() + sessionTtl, idleExpiresAt: clock() + Math.min(idleTtl, sessionTtl) });
          response.setHeader('Set-Cookie', [cookies(loginCookie, '', 0), cookies(sessionCookie, sessionId, sessionTtl / 1000)]);
          response.writeHead(303, { Location: login.returnTo, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
          response.end(); return true;
        }
        if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
          assertMutationOrigin(request);
          const id = cookie(request, sessionCookie); const loginId = cookie(request, loginCookie);
          if (id) sessions.delete(id);
          if (loginId) logins.delete(loginId);
          response.setHeader('Set-Cookie', [cookies(sessionCookie, '', 0), cookies(loginCookie, '', 0)]);
          json(response, 200, { mode: 'live', authenticated: false, loginUrl: '/api/auth/login' }); return true;
        }
        json(response, 405, { mode: 'live', message: '인증 경로의 요청 방식을 확인하세요.' }); return true;
      } catch {
        json(response, 403, { mode: 'live', authenticated: false, loginUrl: '/api/auth/login', message: '로그인을 새로 시작해 사용자 인증을 연결하세요.' });
        return true;
      }
    },
  };
}
