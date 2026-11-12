import assert from 'node:assert/strict';
import { request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const directory = resolve(process.env.RUN_TMP ?? '.local/deployment');
const bridge = JSON.parse(await readFile(resolve(directory, 'bridge.json'), 'utf8'));
const gatewayId = bridge.identities[0];
const ca = await readFile(resolve(directory, 'pki/ca.pem'));
const credentials = {};
for (const name of ['gateway-1', 'cse']) credentials[name] = { cert: await readFile(resolve(directory, `pki/${name}.pem`)), key: await readFile(resolve(directory, `pki/${name}.key`)) };
const call = (path, options = {}) => new Promise((resolveResponse, reject) => {
  const payload = options.body ? Buffer.from(JSON.stringify(options.body)) : undefined;
  const req = request({
    hostname: '127.0.0.1', servername: process.env.PUBLIC_DOMAIN || 'bubble.localhost',
    port: Number(process.env.HTTPS_PORT ?? 443), ca, minVersion: 'TLSv1.3', agent: false,
    ...(options.identity ? credentials[options.identity] : {}),
    path, method: options.method ?? 'GET',
    headers: { 'X-M2M-Origin': 'forged-admin', 'X-M2M-RI': `https-${Date.now()}`, 'X-M2M-RVI': '4', ...options.headers },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolveResponse({ status: response.statusCode, rsc: response.headers['x-m2m-rsc'], body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject); req.end(payload);
});
const api = `/api/v1/gateways/${gatewayId}/commands`;
const success = await call(api, { identity: 'gateway-1' });
assert.equal(success.status, 200, success.body);
assert.ok(Array.isArray(JSON.parse(success.body).commands));
const missing = await call(api);
assert.equal(missing.status, 403);
const wrong = await call(api, { identity: 'cse' });
assert.equal(wrong.status, 403);
const spoof = await call(api, { headers: { 'X-Forwarded-Client-Cert': 'trusted', 'X-SSL-CERT': credentials['gateway-1'].cert.toString().replaceAll('\n', ' ') } });
assert.equal(spoof.status, 403);
const foreign = await call('/api/v1/gateways/another-gateway/commands', { identity: 'gateway-1' });
assert.equal(foreign.status, 403);
const container = `/onem2m/Mobius/bubble-household-1/${gatewayId}/health`;
const read = await call(container, { identity: 'gateway-1' });
assert.equal(read.status, 200);
assert.equal(read.rsc, '2000');
const rn = `deploy-${Date.now()}`;
const created = await call(container, { identity: 'gateway-1', method: 'POST', headers: { 'Content-Type': 'application/json;ty=4' }, body: { 'm2m:cin': { rn, con: { simulation: true, source: 'local-mtls-deployment-qa' } } } });
assert.equal(created.status, 201, created.body);
assert.equal(created.rsc, '2001');
const stored = await call(`${container}/${rn}`, { identity: 'gateway-1' });
assert.equal(JSON.parse(stored.body)['m2m:cin'].con.source, 'local-mtls-deployment-qa');
const mutation = await call(container, { identity: 'gateway-1', method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { 'm2m:cnt': { lbl: ['forged-admin-update'] } } });
assert.equal(mutation.status, 403);
assert.equal(mutation.rsc, '4103');
for (const path of ['/onem2m/Mobius', '/onem2m/Mobius?fu=1', '/onem2m/Mobius/bubble-household-1/deployment-access']) assert.equal((await call(path, { identity: 'gateway-1' })).status, 403);
console.log(JSON.stringify({ status: 'GATEWAY_HTTPS_PASS', gatewayId, api: success.status, missingCertificate: missing.status, mismatchedCertificate: wrong.status, forgedCertificateHeaders: spoof.status, foreignGateway: foreign.status, actualCseRead: read.rsc, actualCseCreate: created.rsc, actualCseStoredRead: stored.rsc, forcedOriginatorMutationDenied: mutation.rsc }, null, 2));
