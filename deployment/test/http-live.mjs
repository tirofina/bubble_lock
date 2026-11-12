import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:https';
import { get } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve(process.env.RUN_TMP ?? '.local/deployment');
const ca = await readFile(resolve(directory, 'pki/ca.pem'));
const port = Number(process.env.HTTPS_PORT ?? 443);
const host = process.env.PUBLIC_DOMAIN || 'bubble.localhost';
const call = (path, headers = {}) => new Promise((resolveResponse, reject) => {
  const req = request({ hostname: '127.0.0.1', port, servername: host, path, headers, ca, minVersion: 'TLSv1.3', agent: false, timeout: 10_000 }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString(), tls: response.socket.getProtocol() }));
  });
  req.on('timeout', () => req.destroy(new Error(`Request timed out: ${path}`)));
  req.on('error', reject); req.end();
});
const securityHeaders = (response) => {
  for (const [name, expected] of [['x-content-type-options', 'nosniff'], ['x-frame-options', 'DENY'], ['referrer-policy', 'strict-origin-when-cross-origin']]) assert.equal(response.headers[name], expected);
  assert.match(response.headers['strict-transport-security'], /max-age=/);
  assert.equal(response.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
};
const app = await call('/');
assert.equal(app.status, 200);
securityHeaders(app);
const appCsp = app.headers['content-security-policy'];
assert.match(appCsp, /(?:^|;)\s*script-src 'self'\s*(?:;|$)/);
assert.match(appCsp, /(?:^|;)\s*style-src 'self'\s*(?:;|$)/);
assert.doesNotMatch(appCsp, /'unsafe-eval'/);
const identity = await call('/identity/realms/bubble/.well-known/openid-configuration');
securityHeaders(identity);
const identityCsp = identity.headers['content-security-policy'];
assert.match(identityCsp, /(?:^|;)\s*script-src 'self' 'unsafe-inline'\s*(?:;|$)/);
assert.match(identityCsp, /(?:^|;)\s*style-src 'self'\s*(?:;|$)/);
assert.doesNotMatch(identityCsp, /'unsafe-eval'/);
const health = await call('/healthz');
assert.equal(health.status, 200);
assert.equal(health.tls, 'TLSv1.3');
securityHeaders(health);
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
// Use an authenticated session cookie in live mode; demo mode needs no cookie.
const eventHeaders = process.env.EVENTS_COOKIE ? { Cookie: process.env.EVENTS_COOKIE } : {};
const streams = [];
const openEventStream = (headers = eventHeaders, localAddress) => new Promise((resolveResponse, reject) => {
  const req = request({ hostname: '127.0.0.1', port, servername: host, path: '/events', headers, localAddress, ca, minVersion: 'TLSv1.3', agent: false }, (response) => {
    req.setTimeout(0);
    streams.push({ req, response });
    response.on('error', reject);
    resolveResponse(response);
  });
  req.setTimeout(10_000, () => req.destroy(new Error('Event stream did not open')));
  req.on('error', reject);
  req.end();
});
const eventStreamFromApiContainer = () => new Promise((resolveResponse, reject) => {
  const script = `
    const { request } = require('node:https');
    const { readFileSync } = require('node:fs');
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const req = request({
        hostname: 'proxy', port: Number(process.argv[1]), servername: process.argv[2],
        path: '/events', headers: { Cookie: Buffer.concat(chunks).toString() },
        ca: readFileSync('/run/bubble/pki/ca.pem'), minVersion: 'TLSv1.3', agent: false, timeout: 10_000,
      }, (response) => { console.log(response.statusCode); response.destroy(); });
      req.on('error', (error) => { console.error(error); process.exitCode = 1; });
      req.end();
    });
  `;
  const child = spawn('docker', ['compose', '-f', 'deployment/compose.yaml', 'exec', '-T', 'api', 'node', '-e', script, String(port), host], {
    env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let error = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { error += chunk; });
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? resolveResponse(Number(output.trim())) : reject(new Error(error)));
  child.stdin.end(process.env.EVENTS_COOKIE);
});
let eventLimit;
try {
  for (let index = 0; index < 4; index += 1) {
    const stream = await openEventStream();
    assert.equal(stream.statusCode, 200, 'Four event streams from one external IP must open');
    assert.match(stream.headers['content-type'], /^text\/event-stream/);
  }
  eventLimit = await openEventStream();
  assert.equal(eventLimit.statusCode, 429, 'The fifth event stream from one external IP must be refused');
  assert.equal((await openEventStream({ ...eventHeaders, 'X-Forwarded-For': '198.51.100.23' })).statusCode, 429, 'Client-supplied forwarded IPs must not bypass the edge cap');
  // Docker maps host-loopback source addresses to one bridge gateway; an app
  // container supplies a genuinely independent IP for the full Compose check.
  const independentStatus = process.env.EVENTS_SECOND_CLIENT_SOURCE === 'compose-api'
    ? await eventStreamFromApiContainer()
    : (await openEventStream(eventHeaders, process.env.EVENTS_SECOND_CLIENT_ADDRESS ?? '127.0.0.2')).statusCode;
  assert.equal(independentStatus, 200, 'A different external IP must retain its own event stream allowance');
} finally {
  for (const { req, response } of streams) { response.destroy(); req.destroy(); }
}
const burst = await Promise.all(Array.from({ length: 100 }, () => call('/api/auth/session')));
const throttled = burst.filter((response) => response.status === 429).length;
assert.ok(throttled > 0, 'A burst must trigger the live proxy limit');
console.log(JSON.stringify({ status: 'HTTP_TLS_POLICY_PASS', appCsp, identityCsp, eventConnectionCap: 4, eventRefusalStatus: eventLimit.statusCode, independentClientStatus: 200, forwardedIpBypass: false, tls: health.tls, health: health.status, unauthenticatedPortal: portal.status, denied, redirect, rateLimitedRequests: throttled, totalRequests: burst.length }, null, 2));
