import assert from 'node:assert/strict';
import test from 'node:test';
import { createOidcSessionManager } from '../server/oidc-session.ts';
import { fixture, issuer, clientId, requestCookie } from './oidc-fixture.ts';

test('logout discovery rejects missing and untrusted provider endpoints', async (t) => {
  const f = await fixture(t);
  for (const endpoint of [undefined, 'http://identity.example.test/logout', 'https://foreign.test/logout', 'https://user@identity.example.test/logout', `${issuer}/logout#fragment`]) {
    Reflect.set(f.metadata, 'end_session_endpoint', endpoint);
    await assert.rejects(createOidcSessionManager(f.config), /endpoint/);
  }
});

for (const omitIdToken of [false, true]) {
  test(`logout uses the verified ${omitIdToken ? 'original' : 'refreshed'} ID token after refresh`, async (t) => {
    const f = await fixture(t);
    const { cookie } = await f.login();
    if (omitIdToken) f.omitRefreshIdToken();
    f.idChanges({ sid: 'refreshed-session' });
    f.advance(95000);
    assert.ok(await f.manager.authenticate(requestCookie(cookie)));

    const response = await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: f.origin } });

    assert.equal(response.status, 200);
    const provider = new URL((await response.json()).logoutUrl);
    const hint = provider.searchParams.get('id_token_hint');
    assert.ok(hint);
    const claims = JSON.parse(Buffer.from(hint.split('.')[1] ?? '', 'base64url').toString());
    assert.equal(claims.sid, omitIdToken ? undefined : 'refreshed-session');
    assert.equal(claims.aud, clientId);
    assert.equal(await f.manager.authenticate(requestCookie(cookie)), null);
  });
}

test('logout without a BFF session still reaches provider confirmation and GET cannot log out', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.origin}/api/auth/logout`, { method: 'POST', headers: { Origin: f.origin } });
  assert.equal(response.status, 200);
  const provider = new URL((await response.json()).logoutUrl);
  assert.equal(provider.origin + provider.pathname, `${issuer}/logout`);
  assert.equal(provider.searchParams.get('client_id'), clientId);
  assert.equal(provider.searchParams.get('post_logout_redirect_uri'), `${f.origin}/`);
  assert.equal(provider.searchParams.has('id_token_hint'), false);
  assert.equal((await fetch(`${f.origin}/api/auth/logout`)).status, 405);
});
