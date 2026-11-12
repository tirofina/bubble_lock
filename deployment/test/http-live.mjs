import assert from 'node:assert/strict';
import { request } from 'node:https';
import { get } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve(process.env.RUN_TMP ?? '.local/deployment');
const ca = await readFile(resolve(directory, 'pki/ca.pem'));
const port = Number(process.env.HTTPS_PORT ?? 443);
const host = process.env.PUBLIC_DOMAIN || 'bubble.localhost';
const call = (path) => new Promise((resolveResponse, reject) => {
  const req = request({ hostname: '127.0.0.1', port, servername: host, path, ca, minVersion: 'TLSv1.3', agent: false }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString(), tls: response.socket.getProtocol() }));
  });
  req.on('error', reject); req.end();
});
const health = await call('/healthz');
assert.equal(health.status, 200);
assert.equal(health.tls, 'TLSv1.3');
for (const [name, expected] of [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'strict-origin-when-cross-origin']]) assert.equal(health.headers[name], expected);
assert.match(health.headers['strict-transport-security'], /max-age=/);
assert.match(health.headers['content-security-policy'], /frame-ancestors 'none'/);
const session = await call('/api/auth/session');
assert.equal(JSON.parse(session.body).authenticated, false);
const portal = await call('/api/portal/snapshot');
assert.equal(portal.status, 401);
const denied = {};
for (const path of ['/identity/admin/', '/identity/admin;x/master/console/', '/identity/management/', '/identity/realms/master/.well-known/openid-configuration', '/Mobius', '/v1/portal/snapshot', '/admin', '/metrics']) {
  denied[path] = (await call(path)).status;
  assert.equal(denied[path], 403);
}
const redirect = await new Promise((resolveResponse, reject) => {
  get({ hostname: '127.0.0.1', port: Number(process.env.HTTP_PORT ?? 80), headers: { Host: host }, path: '/sample' }, (response) => {
    response.resume(); resolveResponse({ status: response.statusCode, location: response.headers.location });
  }).on('error', reject);
});
assert.equal(redirect.status, 308);
assert.equal(redirect.location, `${new URL(`https://${host}:${port}`).origin}/sample`);
const burst = await Promise.all(Array.from({ length: 100 }, () => call('/api/auth/session')));
const throttled = burst.filter((response) => response.status === 429).length;
assert.ok(throttled > 0, 'A burst must trigger the live proxy limit');
console.log(JSON.stringify({ status: 'HTTP_TLS_POLICY_PASS', tls: health.tls, health: health.status, unauthenticatedPortal: portal.status, denied, redirect, rateLimitedRequests: throttled, totalRequests: burst.length }, null, 2));
