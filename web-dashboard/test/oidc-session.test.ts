import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import { createOidcSessionManager } from '../server/oidc-session.ts';
import { fixture, requestCookie, issuer, audience, clientId } from './oidc-fixture.ts';

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
  const logout = await fetch(`${f.origin}/api/auth/logout?returnTo=https://foreign.test`, { method: 'POST', headers: { Cookie: first.cookie, Origin: f.origin } });
  assert.equal(logout.status, 200); assert.match(logout.headers.getSetCookie().join(' '), /Max-Age=0/);
  assert.equal(logout.headers.get('cache-control'), 'no-store');
  const provider = new URL((await logout.json()).logoutUrl);
  assert.equal(provider.origin + provider.pathname, `${issuer}/logout`);
  assert.equal(provider.searchParams.get('client_id'), clientId);
  assert.equal(provider.searchParams.get('post_logout_redirect_uri'), `${f.origin}/`);
  const hint = provider.searchParams.get('id_token_hint');
  assert.ok(hint);
  const claims = JSON.parse(Buffer.from(hint.split('.')[1] ?? '', 'base64url').toString());
  assert.equal(claims.aud, clientId); assert.equal(claims.sub, 'guardian-sub');
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
