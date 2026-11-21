import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { HandoverCoordinator } from '../integration/src/handover-coordinator.mjs';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { runExternalMec, runExternalEdge } from '../scripts/external-scenarios.mjs';
import { mockCse, localServer, body } from './helpers/external-mocks.mjs';

test('configured MEC discovers both services, queries, receives callbacks and deletes all created subscriptions', async (t) => {
  const records = new Map();
  const identity = { verified: true, providerId: 'mock-provider', mtlsFingerprint: 'mock-fingerprint' };
  let vendor;
  vendor = await localServer(t, async (request, response) => {
    const url = new URL(request.url, vendor);
    const send = (status, value, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(value ? JSON.stringify(value) : undefined); };
    if (url.pathname === '/mec_service_mgmt/v1/services') return send(200, [{ serName: url.searchParams.get('ser_name'), serInstanceId: 'mock', transportInfo: { endPoint: { uris: [vendor] } } }]);
    if (url.pathname.includes('/queries/')) return send(200, { ueId: '192.0.2.10' });
    switch (request.method) {
      case 'POST': {
        const value = await body(request); const path = `${url.pathname}/${records.size + 1}`;
        records.set(path, value); return send(201, { resourceURL: path }, { location: path });
      }
      case 'GET': return send(records.has(url.pathname) ? 200 : 404, records.get(url.pathname));
      case 'PUT': {
        const value = await body(request); records.set(url.pathname, value);
        const callback = value.userTrackingSubscription?.callbackReference.notifyURL ?? value.callbackReference;
        const service = url.pathname.startsWith('/location') ? 'Location' : 'RNIS';
        const result = await fetch(callback, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service, ueId: '192.0.2.10', eventId: `mock-${service}`, observedAt: new Date().toISOString(), location: { lat: 37.5, lon: 127 }, health: { status: 'HEALTHY' } }) });
        assert.equal(result.status, 202);
        return send(200, value);
      }
      case 'DELETE': records.delete(url.pathname); return send(204);
      default: return send(405);
    }
  });
  const options = { platformRoot: vendor, providerId: identity.providerId, providerFingerprint: identity.mtlsFingerprint,
    simulation: true, capabilities: { update: true, verifiedSourceTime: true } };
  const runtime = await createIntegrationRuntime({ core: { mec: { autoReconcile: false, Location: options, RNIS: options }, retention: { autoPrune: false } } });
  t.after(() => runtime.close());
  runtime.mecSubscriptions.callbackBaseUrl = await localServer(t, async (request, response) => {
    const [, service, token] = request.url.match(/^\/callbacks\/([^/]+)\/([^/]+)$/);
    const result = await runtime.mecIngress.ingestCallback({ service, token, providerIdentity: identity, payload: await body(request) });
    await runtime.mecIngress.drainOutbox(); response.writeHead(result.httpStatus); response.end(JSON.stringify(result));
  });
  const result = await runExternalMec(runtime, { ueId: '192.0.2.10', callbackTimeoutMs: 1000, geofence: { type: 'circle', lat: 37.5, lon: 127, radiusM: 100 } });
  assert.deepEqual(result.services.filter((entry) => entry.service).map((entry) => entry.service), ['Location', 'RNIS']);
  assert.equal(records.size, 0);
  assert.equal(runtime.store.list('grants')[0].status, 'REVOKED');
  assert.equal(runtime.store.list('mecPayloads').length, 2);
});

test('configured Edge runner retains 1000 observations on both CSEs across 30 transitions and rollback', async (t) => {
  const store = await new IntegrationStore().init();
  const policyService = new PolicyService({ store });
  const coordinator = new HandoverCoordinator({ store, policyService });
  const vendors = [await mockCse(t, 'edge-A'), await mockCse(t, 'edge-B')];
  for (const vendor of vendors) coordinator.registerEdge(vendor);
  await coordinator.registerManifest('rehearsal-keyring', { aeName: 'rehearsal', resources: [
    { logicalId: 'observations', ty: 3, body: { 'm2m:cnt': { rn: 'observations' } } },
  ], groups: [], subscriptions: [], requireCallbackVerification: false });
  const result = await runExternalEdge({ store, policyService, handoverCoordinator: coordinator }, { ueId: 'rehearsal-keyring' });
  assert.equal(result.transitions.length, 30);
  assert.deepEqual(result.readbacks.map((entry) => entry.distinctObservations), [1000, 1000]);
  assert.equal(result.rollback.state, 'ROLLED_BACK');
  for (const vendor of vendors) assert.equal([...vendor.resources.values()].filter((value) => value['m2m:cin']).length, 1000);
  t.diagnostic(JSON.stringify({ simulation: true, transitions: 30, acceptedObservations: 1000, lostObservations: 0, duplicateCins: 0, p95Ms: result.p95Ms, rollback: result.rollback.state }));
});
