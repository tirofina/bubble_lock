import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createOidcSessionManager } from '../server/oidc-session.ts';
import type { OidcSessionConfig, OidcSessionManager } from '../server/oidc-session.ts';

const issuer = 'https://identity.example.test';
const clientId = 'bubble-browser';
const audience = 'privacy-bubble-api';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const signed = (claims: Record<string, unknown>) => {
  const data = [{ alg: 'RS256', kid: 'test-key' }, claims].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${data}.${sign('sha256', Buffer.from(data), rsa.privateKey).toString('base64url')}`;
};
function requestCookie(value: string): IncomingMessage { return { headers: { cookie: value } } as IncomingMessage; }

async function fixture(t: TestContext, options: Partial<OidcSessionConfig> = {}) {
  let now = Date.parse('2026-11-10T00:00:00.000Z');
  let currentNonce = ''; let tokenCalls = 0; let refreshCalls = 0;
  const grants = new Map<string, { nonce: string; challenge: string }>();
  let idChanges: Record<string, unknown> = {}; let accessChanges: Record<string, unknown> = {};
  let tokenFailure = false; let refreshSubject: string | null = null;
  let manager: OidcSessionManager;
  const server = createServer((request, response) => {
    void manager.handle(request, response).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, 'error');
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json(metadata);
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    assert.equal(url, `${issuer}/token`); tokenCalls += 1;
    if (tokenFailure) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    const fields = new URLSearchParams(String(init?.body));
    assert.equal(fields.get('client_id'), clientId);
    const refresh = fields.get('grant_type') === 'refresh_token';
    if (refresh) { refreshCalls += 1; assert.equal(fields.get('refresh_token'), `refresh-${refreshCalls}`); }
    else {
      const code = fields.get('code') ?? '';
      const grant = grants.get(code);
      if (!grant) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      grants.delete(code);
      currentNonce = grant.nonce;
      assert.equal(fields.get('redirect_uri'), `${origin}/api/auth/callback`);
      assert.equal(createHash('sha256').update(fields.get('code_verifier')!).digest('base64url'), grant.challenge);
    }
    const sub = refresh ? refreshSubject ?? 'guardian-sub' : 'guardian-sub';
    const access = signed({ iss: issuer, aud: audience, sub, iat: now / 1000, exp: now / 1000 + 120, scope: 'portal:read incident:write injected:scope', ...accessChanges });
    return Response.json({ token_type: 'Bearer', access_token: access, refresh_token: `refresh-${refreshCalls + 1}`, expires_in: 120,
      id_token: signed({ iss: issuer, aud: clientId, sub, iat: now / 1000, exp: now / 1000 + 120, nonce: currentNonce, at_hash: createHash('sha256').update(access).digest().subarray(0, 16).toString('base64url'), ...idChanges }) });
  };
  const config: OidcSessionConfig = { issuer, clientId, audience, redirectUri: `${origin}/api/auth/callback`, principals: [{ principalId: 'guardian-1', oidcIssuer: issuer, oidcSubject: 'guardian-sub', scopes: ['portal:read', 'incident:write'] }], allowLoopbackHttp: true, fetchImpl, clock: () => now, ...options };
  manager = await createOidcSessionManager(config);
  t.after(async () => { manager.close(); server.close(); server.closeAllConnections(); await once(server, 'close'); });
  const begin = async (returnTo = '/family') => {
    const response = await fetch(`${origin}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const authorization = new URL(response.headers.get('location')!);
    const nonce = authorization.searchParams.get('nonce');
    const challenge = authorization.searchParams.get('code_challenge');
    assert.ok(nonce && challenge);
    const code = randomUUID();
    grants.set(code, { nonce, challenge });
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('response_type'), 'code');
    assert.ok(authorization.searchParams.get('scope')!.split(' ').includes('openid'));
    return { authorization, code, cookie: response.headers.getSetCookie()[0]!.split(';')[0]!, response };
  };
  const finish = async (login: Awaited<ReturnType<typeof begin>>, changes: Record<string, string> = {}) => {
    const url = new URL(`${origin}/api/auth/callback`);
    url.search = new URLSearchParams({ state: login.authorization.searchParams.get('state')!, code: login.code, ...changes }).toString();
    return fetch(url, { headers: { Cookie: login.cookie }, redirect: 'manual' });
  };
  const login = async () => {
    const pending = await begin(); const response = await finish(pending); assert.equal(response.status, 303);
    return { response, cookie: response.headers.getSetCookie().find((value) => value.startsWith('bubble_session_dev='))!.split(';')[0]!, pending };
  };
  return { origin, manager, config, metadata, begin, finish, login,
    advance: (ms: number) => { now += ms; }, tokenCalls: () => tokenCalls, refreshCalls: () => refreshCalls,
    idChanges: (value: Record<string, unknown>) => { idChanges = value; }, accessChanges: (value: Record<string, unknown>) => { accessChanges = value; },
    tokenFailure: () => { tokenFailure = true; }, refreshSubject: (value: string) => { refreshSubject = value; } };
}

test('PKCE code callback은 HttpOnly 세션과 등록 principal을 생성하고 토큰을 서버에 보관한다', async (t) => {
  const f = await fixture(t);
  const { cookie, response, pending } = await f.login();
  assert.equal(response.headers.get('location'), '/family');
  assert.match(response.headers.getSetCookie().join(' '), /HttpOnly; SameSite=Lax/);
  const info = await fetch(`${f.origin}/api/auth/session`, { headers: { Cookie: cookie } });
  assert.equal(info.headers.get('cache-control'), 'no-store');
  const body = await info.json();
  assert.equal(body.mode, 'live'); assert.equal(body.authenticated, true);
  assert.equal(body.principal.principalId, 'guardian-1');
  assert.deepEqual(body.principal.scopes, ['portal:read', 'incident:write']);
  assert.equal(JSON.stringify(body).includes('access_token'), false);
  assert.equal(JSON.stringify(body).includes('refresh-'), false);
  const internal = await f.manager.authenticate(requestCookie(cookie));
  assert.ok(internal?.accessToken.includes('.'));
  assert.equal((await f.finish(pending)).status, 403);
  assert.equal(f.tokenCalls(), 1);
});

test('state·nonce·ID token audience와 access token subject 오류를 검증한다', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.finish(await f.begin(), { state: 'foreign-state' })).status, 403);
  assert.equal(f.tokenCalls(), 0);
  for (const change of [{ nonce: 'foreign-nonce' }, { aud: audience }, { sub: 'foreign-user' }, { at_hash: 'foreign-hash' }, { azp: 'foreign-client' }]) {
    f.idChanges(change);
    assert.equal((await f.finish(await f.begin())).status, 403);
  }
  f.idChanges({}); f.accessChanges({ sub: 'foreign-user' });
  assert.equal((await f.finish(await f.begin())).status, 403);
  const empty = await fetch(`${f.origin}/api/auth/session`);
  assert.equal((await empty.json()).authenticated, false);
});

test('동시 API 요청은 refresh token을 한 번 교환하고 교체된 토큰을 이어 사용한다', async (t) => {
  const f = await fixture(t); const { cookie } = await f.login();
  f.advance(95000);
  const results = await Promise.all([f.manager.authenticate(requestCookie(cookie)), f.manager.authenticate(requestCookie(cookie)), f.manager.authenticate(requestCookie(cookie))]);
  assert.equal(results.every((entry) => entry?.principal.principalId === 'guardian-1'), true);
  assert.equal(f.refreshCalls(), 1);
  f.advance(95000);
  assert.ok(await f.manager.authenticate(requestCookie(cookie)));
  assert.equal(f.refreshCalls(), 2);
  f.tokenFailure(); f.advance(95000);
  assert.equal(await f.manager.authenticate(requestCookie(cookie)), null);
  assert.equal(await f.manager.authenticate(requestCookie(cookie)), null);
});

test('세션은 동일 origin 로그아웃과 TTL을 적용하고 foreign subject 갱신을 종료한다', async (t) => {
  const f = await fixture(t, { sessionTtlSec: 300, idleTtlSec: 120 }); const first = await f.login();
  const wrong = await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: first.cookie, Origin: 'https://foreign.test' } });
  assert.equal(wrong.status, 403); assert.ok(await f.manager.authenticate(requestCookie(first.cookie)));
  const logout = await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: first.cookie, Origin: f.origin } });
  assert.equal(logout.status, 200); assert.match(logout.headers.getSetCookie().join(' '), /Max-Age=0/);
  assert.equal(await f.manager.authenticate(requestCookie(first.cookie)), null);
  const second = await f.login(); f.advance(121000);
  assert.equal(await f.manager.authenticate(requestCookie(second.cookie)), null);
  const third = await f.login(); f.refreshSubject('foreign-user'); f.advance(95000);
  assert.equal(await f.manager.authenticate(requestCookie(third.cookie)), null);
});

test('discovery origin·PKCE support·redirect와 무상태 로그인 만료를 검증한다', async (t) => {
  const f = await fixture(t, { maxPendingLogins: 1 });
  const invalidReturn = await fetch(`${f.origin}/api/auth/login?returnTo=https://foreign.test`, { redirect: 'manual' });
  assert.equal(invalidReturn.status, 403);
  const pending = await f.begin();
  // Legacy pending capacity no longer limits unauthenticated login starts.
  assert.equal((await fetch(`${f.origin}/api/auth/login`, { redirect: 'manual' })).status, 302);
  f.advance(301000); assert.equal((await f.finish(pending)).status, 403);
  await assert.rejects(createOidcSessionManager({ ...f.config, allowLoopbackHttp: false }), /HTTPS/);
  f.metadata.token_endpoint = 'https://foreign.test/token';
  await assert.rejects(createOidcSessionManager(f.config), /origin/);
  f.metadata.token_endpoint = `${issuer}/token`; f.metadata.code_challenge_methods_supported = ['plain'];
  await assert.rejects(createOidcSessionManager(f.config), /PKCE/);
});

test('256 unauthenticated starts cannot starve a new login or consume session capacity', async (t) => {
  const f = await fixture(t, { maxSessions: 2 });
  const existing = await f.login();
  for (let index = 0; index < 256; index += 1) {
    const start = await fetch(`${f.origin}/api/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302, `unauthenticated start ${index + 1}`);
  }
  const legitimate = await f.login();
  assert.ok(await f.manager.authenticate(requestCookie(existing.cookie)));
  assert.ok(await f.manager.authenticate(requestCookie(legitimate.cookie)));
  assert.equal(f.tokenCalls(), 2);
  assert.equal((await fetch(`${f.origin}/api/auth/login`, { redirect: 'manual' })).status, 503);
  await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: existing.cookie, Origin: f.origin } });
  await f.login();
});

test('a login issued before a start flood retains its state nonce PKCE and returnTo', async (t) => {
  const f = await fixture(t);
  const legitimate = await f.begin('/family?tab=devices');
  for (let index = 0; index < 300; index += 1) {
    assert.equal((await fetch(`${f.origin}/api/auth/login`, { redirect: 'manual' })).status, 302);
  }
  const response = await f.finish(legitimate);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/family?tab=devices');
});

test('malformed duplicate tampered and oversized login cookies fail before token exchange and are cleared', async (t) => {
  const f = await fixture(t);
  const login = await f.begin();
  const separator = login.cookie.indexOf('=');
  const name = login.cookie.slice(0, separator + 1);
  const value = login.cookie.slice(separator + 1);
  const bytes = Buffer.from(value, 'base64url');
  const corruptions = [0, 12, bytes.length - 1].map((index) => {
    const changed = Buffer.from(bytes);
    changed[index] = (changed[index] ?? 0) ^ 1;
    return name + changed.toString('base64url');
  });
  for (const invalid of ['', login.cookie + '; ' + login.cookie, name + '!', name + 'A'.repeat(3801), name + value.slice(0, -8), ...corruptions]) {
    const response = await f.finish({ ...login, cookie: invalid });
    assert.equal(response.status, 403);
    assert.match(response.headers.getSetCookie().join(' '), /bubble_login_dev=;.*Max-Age=0/);
    assert.equal(f.tokenCalls(), 0);
  }
  assert.equal((await f.finish(login)).status, 303);
});

test('login cookies are opaque bounded and expire at the exact TTL boundary', async (t) => {
  const f = await fixture(t, { loginTtlSec: 30 });
  const returnTo = '/' + 'a'.repeat(2047);
  const login = await f.begin(returnTo);
  assert.ok(Buffer.byteLength(login.response.headers.getSetCookie().join(' ')) < 4096);
  const decoded = Buffer.from(login.cookie.slice(login.cookie.indexOf('=') + 1), 'base64url').toString('utf8');
  assert.equal(decoded.includes(returnTo), false);
  assert.equal(decoded.includes(login.authorization.searchParams.get('state')!), false);
  assert.equal(decoded.includes(login.authorization.searchParams.get('nonce')!), false);
  f.advance(30000);
  const expired = await f.finish(login);
  assert.equal(expired.status, 403);
  assert.match(expired.headers.getSetCookie().join(' '), /Max-Age=0/);
  assert.equal(f.tokenCalls(), 0);
  const oversized = await fetch(`${f.origin}/api/auth/login?returnTo=${encodeURIComponent('/' + '한'.repeat(1100))}`, { redirect: 'manual' });
  assert.equal(oversized.status, 403);
  assert.equal(oversized.headers.getSetCookie().length, 0);
});

test('callback state code issuer and error validation clears the login cookie', async (t) => {
  const f = await fixture(t);
  for (const changes of [{ state: '' }, { code: '' }, { iss: 'https://foreign.test' }, { error: 'access_denied' }]) {
    const response = await f.finish(await f.begin(), changes);
    assert.equal(response.status, 403);
    assert.match(response.headers.getSetCookie().join(' '), /Max-Age=0/);
  }
  const login = await f.begin();
  for (const duplicate of ['state', 'code']) {
    const query = new URLSearchParams({ state: login.authorization.searchParams.get('state')!, code: login.code });
    query.append(duplicate, query.get(duplicate)!);
    const response = await fetch(`${f.origin}/api/auth/callback?${query}`, { headers: { Cookie: login.cookie }, redirect: 'manual' });
    assert.equal(response.status, 403);
    assert.match(response.headers.getSetCookie().join(' '), /Max-Age=0/);
  }
  assert.equal(f.tokenCalls(), 0);
});

test('concurrent and logged-out callback replay cannot create another session', async (t) => {
  const f = await fixture(t, { maxSessions: 1 });
  const pending = await f.begin();
  const results = await Promise.all([f.finish(pending), f.finish(pending)]);
  assert.deepEqual(results.map((response) => response.status).sort(), [303, 403]);
  const successful = results.find((response) => response.status === 303);
  assert.ok(successful);
  const cookie = successful.headers.getSetCookie().find((value) => value.startsWith('bubble_session_dev='));
  assert.ok(cookie);
  await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie.split(';')[0]!, Origin: f.origin } });
  assert.equal((await f.finish(pending)).status, 403);
  const next = await f.login();
  await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: next.cookie, Origin: f.origin } });
  // Even after a bounded replay cache evicts an entry, the IdP code is single-use.
  assert.equal((await f.finish(pending)).status, 403);
  assert.equal((await (await fetch(`${f.origin}/api/auth/session`)).json()).authenticated, false);
});

test('a cookie from another manager cannot authorize a callback', async (t) => {
  const first = await fixture(t); const second = await fixture(t);
  assert.equal((await second.finish(await first.begin())).status, 403);
  assert.equal(second.tokenCalls(), 0);
});

test('운영 HTTPS 세션 쿠키는 __Host Secure 속성을 적용한다', async (t) => {
  const f = await fixture(t);
  const manager = await createOidcSessionManager({ ...f.config, redirectUri: 'https://dashboard.example.test/api/auth/callback', allowLoopbackHttp: false });
  t.after(() => manager.close());
  const headers: Record<string, unknown> = {};
  const response = { writeHead: (_status: number, values: Record<string, unknown>) => Object.assign(headers, values), end: () => {} };
  await manager.handle({ url: '/api/auth/login', method: 'GET', headers: {} } as IncomingMessage, response as never);
  assert.match(String(headers['Set-Cookie']), /^__Host-bubble_login=/);
  assert.match(String(headers['Set-Cookie']), /; Secure$/);
});
