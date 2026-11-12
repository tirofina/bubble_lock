import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { X509Certificate } from 'node:crypto';
import { createMtlsFetch } from '../integration/src/fl-worker.mjs';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { HandoverCoordinator } from '../integration/src/handover-coordinator.mjs';
import { createExternalEdgeCallback } from '../scripts/external-edge-callback.mjs';

test('Edge callback verifies mTLS CSE identity, originator and subscription before recording notification', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'external-callback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certPath = join(directory, 'cert.pem'); const keyPath = join(directory, 'key.pem');
  const generated = spawnSync(process.env.KEYRING_TEST_OPENSSL ?? 'openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=external-local-test',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath,
  ], { encoding: 'utf8', timeout: 15000 });
  assert.equal(generated.status, 0, generated.stderr);
  const cert = await readFile(certPath); const key = await readFile(keyPath);
  const tls = { ca: cert, cert, key }; const fingerprint = new X509Certificate(cert).fingerprint256;
  const store = await new IntegrationStore().init();
  const coordinator = new HandoverCoordinator({ store, policyService: new PolicyService({ store }) });
  const edge = { edgeId: 'edge-A', endpoint: 'https://edge-a.invalid', cseBase: '/Mobius', cseId: '/edge-a',
    originator: 'admin', callbackUrl: 'https://callback.invalid/onem2m/edge-A', notificationFingerprint: fingerprint };
  coordinator.registerEdge(edge);
  const server = createExternalEdgeCallback({ handoverCoordinator: coordinator }, { server: { tls }, core: { handover: { edges: [edge] } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const transport = createMtlsFetch(tls);
  t.after(async () => { transport.close(); server.closeAllConnections(); await new Promise((close) => server.close(close)); });
  const subscription = '/Mobius/relay/switch/state-sub';
  const endpoint = `https://127.0.0.1:${server.address().port}/onem2m/edge-A?subscription=${encodeURIComponent(subscription)}`;
  const send = (originator, sur) => transport(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'X-M2M-Origin': originator, 'X-M2M-RI': 'test-rqi' }, body: JSON.stringify({ 'm2m:sgn': { sur, vrq: true } }) });
  assert.equal((await send('/foreign', subscription)).status, 403);
  assert.equal((await send('/edge-a', '/Mobius/other/state-sub')).status, 400);
  const accepted = await send('/edge-a', `edge-a${subscription}`);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get('X-M2M-RSC'), '2000');
  assert.deepEqual(store.list('handoverNotifications').map(({ edgeId, subscriptionUri, verified }) => ({ edgeId, subscriptionUri, verified })),
    [{ edgeId: 'edge-A', subscriptionUri: subscription, verified: true }]);
});
