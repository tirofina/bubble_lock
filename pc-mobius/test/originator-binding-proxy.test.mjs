import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent, request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_TABLE_VERSION, verifyAuditChain, writeBindingTable } from '../src/originator-binding.mjs';
import { startOriginatorBindingProxy } from '../src/originator-binding-proxy.mjs';
import { createTestPki } from './support/mini-pki.mjs';

const pki = createTestPki();
const certs = { guardian: pki.client('pb-guardian'), executor: pki.client('pb-executor'), stranger: pki.client('pb-stranger') };
const fingerprint = (pem) => new X509Certificate(pem).fingerprint256;
const bindings = (names, revision) => ({ version: BINDING_TABLE_VERSION, revision, bindings: names.map((name) => ({ bindingId: name, role: name, identity: { type: 'uri', value: `urn:privacy-bubble:test:pb-${name}` }, originator: `Cpb-${name}`, certificateSha256: fingerprint(certs[name].cert) })) });

function call(port, { identity, method = 'GET', path = '/Mobius/ae', headers = {}, body, agent = false, maxVersion }) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method, path, servername: 'localhost', ca: pki.ca.cert, agent, ...(identity ? { key: identity.key, cert: identity.cert } : {}), ...(maxVersion ? { maxVersion } : {}), headers: { 'x-m2m-ri': 'rq-test', ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, rsc: Number(res.headers['x-m2m-rsc']), ri: res.headers['x-m2m-ri'], body: text ? JSON.parse(text) : null, reusedSocket: req.reusedSocket }); });
    });
    req.on('error', (error) => resolve({ error: error.code ?? error.message }));
    req.end(body);
  });
}

test('mTLS front binds certificates to originators before Mobius4 sees the request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-front-'));
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ origin: req.headers['x-m2m-origin'], url: req.url, body: Buffer.concat(chunks).toString(), forged: Object.keys(req.headers).filter((name) => /^x-(ssl|forwarded|client)/.test(name)) });
    res.writeHead(200, { 'content-type': 'application/json', 'x-m2m-rsc': '2000', 'x-m2m-ri': req.headers['x-m2m-ri'] }); res.end('{"m2m:ae":{}}');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const tablePath = join(directory, 'bindings.json');
  await writeBindingTable(tablePath, bindings(['guardian', 'executor'], 1));
  const proxy = await startOriginatorBindingProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, bindingTablePath: tablePath, auditPath: join(directory, 'audit.jsonl'), tls: { key: pki.server.key, cert: pki.server.cert, ca: pki.ca.cert } });
  t.after(async () => { await proxy.close(); upstream.close(); await rm(directory, { recursive: true, force: true }); });
  const port = proxy.port;

  const matched = await call(port, { identity: certs.guardian, headers: { 'x-m2m-origin': 'Cpb-guardian' } });
  assert.deepEqual([matched.status, matched.rsc, matched.ri, seen.at(-1).origin], [200, 2000, 'rq-test', 'Cpb-guardian']);
  const injected = await call(port, { identity: certs.executor, method: 'POST', path: '/Mobius/ae/cnt?ty=4', headers: { 'content-type': 'application/json;ty=4', 'x-ssl-client-s-dn': 'CN=pb-guardian', 'x-forwarded-for': '10.0.0.1' }, body: '{"m2m:cin":{"con":"x"}}' });
  assert.equal(injected.status, 200);
  assert.deepEqual(seen.at(-1), { origin: 'Cpb-executor', url: '/Mobius/ae/cnt?ty=4', body: '{"m2m:cin":{"con":"x"}}', forged: [] });

  const before = seen.length;
  const spoofed = await call(port, { identity: certs.guardian, method: 'PUT', headers: { 'x-m2m-origin': 'Cpb-executor', 'content-type': 'application/json' }, body: '{"cod:binSh":{"state":true}}' });
  assert.deepEqual([spoofed.status, spoofed.rsc, spoofed.ri, spoofed.body['pb:originatorBinding'].code], [403, 4103, 'rq-test', 'ORIGINATOR_MISMATCH']);
  const duplicate = await call(port, { identity: certs.guardian, headers: { 'x-m2m-origin': ['Cpb-guardian', 'Cpb-executor'] } });
  assert.equal(duplicate.body['pb:originatorBinding'].code, 'ORIGINATOR_HEADER_DUPLICATE');
  const unbound = await call(port, { identity: certs.stranger });
  assert.deepEqual([unbound.status, unbound.body['pb:originatorBinding'].code], [403, 'ORIGINATOR_BINDING_NOT_FOUND']);
  const cloned = await call(port, { identity: pki.client('pb-guardian') });
  assert.equal(cloned.body['pb:originatorBinding'].code, 'ORIGINATOR_BINDING_CERTIFICATE_MISMATCH');
  const absolute = await call(port, { identity: certs.guardian, path: 'http://127.0.0.1:1/Mobius' });
  assert.equal(absolute.status, 400);
  const method = await call(port, { identity: certs.guardian, method: 'PATCH' });
  assert.equal(method.status, 405);
  assert.equal(seen.length, before, 'rejected requests never reach the CSE');

  for (const [label, options, expected] of [
    ['missing certificate', {}, null],
    ['expired certificate', { identity: pki.client('pb-guardian', { notBefore: new Date('2025-01-01'), notAfter: new Date('2025-01-02') }) }, 'CERT_HAS_EXPIRED'],
    ['unknown CA', { identity: createTestPki().client('pb-guardian') }, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['serverAuth-only certificate', { identity: pki.client('pb-guardian', { eku: ['serverAuth'] }) }, 'INVALID_PURPOSE'],
    ['TLS 1.2 client', { identity: certs.guardian, maxVersion: 'TLSv1.2' }, null],
  ]) {
    const failed = await call(port, options);
    assert.ok(failed.error, `${label} must fail before HTTP`);
    if (expected) { await proxy.audit.queue; const rows = (await verifyAuditChain(join(directory, 'audit.jsonl'))).rows; assert.equal(rows.at(-1).code, expected, label); }
  }
  assert.equal(seen.length, before);

  // Revocation without restart, on the same keep-alive TLS connection.
  const agent = new Agent({ keepAlive: true, maxSockets: 1, key: certs.guardian.key, cert: certs.guardian.cert, ca: pki.ca.cert, servername: 'localhost' });
  t.after(() => agent.destroy());
  assert.equal((await call(port, { agent })).status, 200);
  await writeBindingTable(tablePath, bindings(['executor'], 2));
  const revoked = await call(port, { agent });
  assert.deepEqual([revoked.status, revoked.rsc, revoked.reusedSocket, revoked.body['pb:originatorBinding'].code], [403, 4103, true, 'ORIGINATOR_BINDING_NOT_FOUND']);
  assert.equal((await call(port, { identity: certs.executor })).status, 200);
  await writeBindingTable(tablePath, bindings(['guardian', 'executor'], 3));
  assert.equal((await call(port, { agent })).status, 200);

  await proxy.audit.queue;
  const chain = await verifyAuditChain(join(directory, 'audit.jsonl'));
  assert.equal(chain.ok, true);
  const forwarded = chain.rows.filter((row) => row.decision === 'FORWARDED');
  assert.ok(forwarded.every((row) => row.tls.protocol === 'TLSv1.3' && /^[0-9a-f]{16}$/.test(row.originatorDigest)));
  assert.deepEqual(forwarded.find((row) => row.mode === 'INJECTED').strippedHeaders.sort(), ['x-forwarded-for', 'x-ssl-client-s-dn']);
  assert.ok(chain.rows.some((row) => row.event === 'TLS_HANDSHAKE_REJECTED' && row.code === 'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE'));
  assert.ok(chain.rows.filter((row) => row.code === 'ORIGINATOR_MISMATCH').every((row) => row.suppliedOriginatorDigest && !JSON.stringify(row).includes('Cpb-executor')));
  assert.deepEqual([...new Set(chain.rows.map((row) => row.tableRevision))].filter(Boolean).sort(), [1, 2, 3]);
});
