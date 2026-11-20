import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { TestContext } from 'node:test';
import { createOidcSessionManager } from '../server/oidc-session.ts';
import type { OidcSessionConfig, OidcSessionManager } from '../server/oidc-session.ts';

export const issuer = 'https://identity.example.test';
export const clientId = 'bubble-browser';
export const audience = 'privacy-bubble-api';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const signed = (claims: Record<string, unknown>) => {
  const data = [{ alg: 'RS256', kid: 'test-key' }, claims].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${data}.${sign('sha256', Buffer.from(data), rsa.privateKey).toString('base64url')}`;
};
export function requestCookie(value: string): IncomingMessage { return { headers: { cookie: value } } as IncomingMessage; }

export async function fixture(t: TestContext, options: Partial<OidcSessionConfig> = {}) {
  let now = Date.parse('2026-11-10T00:00:00.000Z');
  let currentNonce = ''; let tokenCalls = 0; let refreshCalls = 0;
  const grants = new Map<string, { nonce: string; challenge: string }>();
  let idChanges: Record<string, unknown> = {}; let accessChanges: Record<string, unknown> = {};
  let tokenFailure = false; let refreshSubject: string | null = null;
  let includeRefreshIdToken = true;
  let manager: OidcSessionManager;
  const server = createServer((request, response) => {
    void manager.handle(request, response).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] };
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
      ...(!refresh || includeRefreshIdToken ? { id_token: signed({ iss: issuer, aud: clientId, sub, iat: now / 1000, exp: now / 1000 + 120, nonce: currentNonce, at_hash: createHash('sha256').update(access).digest().subarray(0, 16).toString('base64url'), ...idChanges }) } : {}) });
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
    omitRefreshIdToken: () => { includeRefreshIdToken = false; },
    advance: (ms: number) => { now += ms; }, tokenCalls: () => tokenCalls, refreshCalls: () => refreshCalls,
    idChanges: (value: Record<string, unknown>) => { idChanges = value; }, accessChanges: (value: Record<string, unknown>) => { accessChanges = value; },
    tokenFailure: () => { tokenFailure = true; }, refreshSubject: (value: string) => { refreshSubject = value; } };
}
