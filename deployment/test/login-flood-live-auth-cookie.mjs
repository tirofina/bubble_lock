import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createOidcSessionManager } from '../../web-dashboard/server/oidc-session.ts';

// Run with Node >=22.19.0. Pass 503 only when recording the vulnerable baseline.
const expected = Number(process.argv[2] ?? 302);
assert.ok([302, 503].includes(expected));
const issuer = 'https://identity.example.test';
let manager;
const server = createServer((request, response) => {
  void manager.handle(request, response).then((handled) => {
    if (!handled) { response.writeHead(404); response.end(); }
  });
});
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  let idpCalls = 0;
  manager = await createOidcSessionManager({
    issuer, clientId: 'flood-proof', audience: 'privacy-bubble-api',
    redirectUri: `${origin}/api/auth/callback`, principals: [], allowLoopbackHttp: true,
    fetchImpl: async (input) => {
      assert.equal(String(input), `${issuer}/.well-known/openid-configuration`);
      idpCalls += 1;
      return Response.json({
        issuer, authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    },
  });
  for (let index = 0; index < 256; index += 1) {
    const response = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' });
    await response.arrayBuffer();
    assert.equal(response.status, 302, `unauthenticated start ${index + 1}`);
  }
  const legitimate = await fetch(`${origin}/api/auth/login?returnTo=%2Ffamily`, { redirect: 'manual' });
  const body = await legitimate.text();
  console.log(JSON.stringify({
    origin, anonymousStarts: 256, legitimateStatus: legitimate.status,
    cacheControl: legitimate.headers.get('cache-control'),
    locationOrigin: legitimate.headers.has('location') ? new URL(legitimate.headers.get('location')).origin : null,
    body, idpCalls,
  }));
  assert.equal(legitimate.status, expected);
  assert.equal(idpCalls, 1, 'login starts must not call the token endpoint');
} finally {
  manager?.close();
  const closed = once(server, 'close');
  server.close(); server.closeAllConnections(); await closed;
  console.log('CLEANUP: owned loopback HTTP server closed; no shared services used');
}
