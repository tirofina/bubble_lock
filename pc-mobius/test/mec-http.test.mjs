import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { MecAdapter, MecCallbackIngress, MecPolicyReconciler, MecSubscriptionManager, pointInGeofence } from '../integration/src/mec-adapter.mjs';
import { IntegrationApiGateway } from '../integration/src/api-gateway.mjs';

const providerIdentity = { verified: true, providerId: 'vendor-local-fixture', mtlsFingerprint: 'sha256:local-provider' };
async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function jsonBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; }
function reply(response, status, value, headers = {}) { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(value ? JSON.stringify(value) : undefined); }

async function fixture(t, { service = 'Location', createTimeout = false, deleteTimeout = false, autoCreate = true } = {}) {
  let instant = Date.parse('2026-11-10T00:00:00.000Z');
  const clock = () => new Date(instant).toISOString();
  const records = new Map(); const requests = [];
  const mode = { createTimeout, deleteTimeout };
  let counter = 0;
  const vendorUrl = await listen(t, async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture');
      requests.push({ method: request.method, path: url.pathname });
      if (url.pathname === '/mec_service_mgmt/v1/services') return reply(response, 200, [{ serName: url.searchParams.get('ser_name'), serInstanceId: 'fixture-instance', transportInfo: { endPoint: { uris: [vendorUrl] } } }]);
      if (url.pathname.includes('/queries/')) return reply(response, 200, { ueId: url.searchParams.get('address') ?? url.searchParams.get('ue_ipv4_address'), source: 'local-http-fixture' });
      const collection = url.pathname === '/location/v2/subscriptions/userTracking' || url.pathname === '/rni/v2/subscriptions';
      if (collection && request.method === 'POST') {
        const body = await jsonBody(request); const path = `${url.pathname}/sub-${++counter}`;
        records.set(path, { ...body, resourceURL: path });
        const send = () => reply(response, 201, { resourceURL: path }, { location: path });
        if (mode.createTimeout) setTimeout(send, 800); else send();
        return;
      }
      if (collection && request.method === 'GET') return reply(response, 200, [...records.entries()].filter(([key]) => key.startsWith(`${url.pathname}/`)).map(([, value]) => value));
      const record = records.get(url.pathname);
      if (request.method === 'GET') return reply(response, record ? 200 : 404, record);
      if (request.method === 'PUT' && record) { records.set(url.pathname, { ...await jsonBody(request), resourceURL: url.pathname }); return reply(response, 200, records.get(url.pathname)); }
      if (request.method === 'DELETE') {
        if (mode.deleteTimeout) { setTimeout(() => reply(response, 503, { status: 'fixture-timeout' }), 800); return; }
        records.delete(url.pathname); return reply(response, 204);
      }
      reply(response, 404);
    } catch (error) { reply(response, 500, { error: error.message }); }
  });
  const directory = await mkdtemp(join(tmpdir(), 'bubble-mec-'));
  const path = join(directory, 'state.json');
  const store = await new IntegrationStore(path).init();
  const policyService = new PolicyService({ store, clock });
  const principal = { principalId: 'guardian-fixture', scopes: ['consent:write', 'grant:write', 'grant:revoke', 'policy:approve', 'mec:manage'] };
  const consent = await policyService.createConsent({ principal, subjectId: 'household-fixture', purpose: 'local MEC verification', scopes: ['mec:location', 'mec:rnis'], ttlSec: 3600 });
  const grant = await policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['mec:location', 'mec:rnis'], ttlSec: 900 });
  const policy = await policyService.approvePolicy({ principal, idempotencyKey: 'mec-fixture', policy: { grantId: grant.grantId, ueId: '192.0.2.10', targetEdgeId: 'edge-b', geofence: { type: 'circle', lat: 37.5, lon: 127, radiusM: 100 } } });
  const adapters = Object.fromEntries(['Location', 'RNIS'].map((serviceName) => [serviceName, new MecAdapter({ serviceName, platformRoot: vendorUrl, providerId: providerIdentity.providerId, providerFingerprint: providerIdentity.mtlsFingerprint, timeoutMs: 250, simulation: true, clock, capabilities: { list: true, update: true, verifiedSourceTime: true } })]));
  let ingress;
  const callbackBaseUrl = await listen(t, async (request, response) => {
    const route = request.url.match(/^\/callbacks\/(Location|RNIS)\/([A-Za-z0-9_-]+)$/);
    if (!route) return reply(response, 404);
    const result = await ingress.ingestCallback({ service: route[1], token: route[2], providerIdentity, payload: await jsonBody(request) });
    reply(response, result.httpStatus, result);
  });
  const manager = new MecSubscriptionManager({ store, policyService, adapters, callbackBaseUrl, clock, random: () => 0 });
  const handovers = [];
  const reconciler = new MecPolicyReconciler({ store, policyService, clock, handoverCoordinator: { considerTrigger: async (input) => { handovers.push(input); return { handoverId: `handover-${handovers.length}` }; } } });
  ingress = new MecCallbackIngress({ store, policyService, subscriptions: manager, clock, locationAdapter: adapters.Location, rnisAdapter: adapters.RNIS });
  ingress.onEvent((event) => reconciler.reconcileApprovedIntent(event));
  const result = { path, clock, store, policyService, principal, grant, policy, manager, adapters, handovers, records, requests, mode, callbackBaseUrl, reconciler, get ingress() { return ingress; }, setIngress(value) { ingress = value; }, advance(ms) { instant += ms; } };
  result.create = (key = 'generation-1') => manager.create({ policyId: policy.policyId, service, idempotencyKey: key });
  result.callbackUrl = () => { const item = [...records.values()].at(-1); return item.userTrackingSubscription?.callbackReference.notifyURL ?? item.callbackReference; };
  result.token = () => result.callbackUrl().split('/').at(-1);
  result.payload = (patch = {}) => ({ service, eventId: 'event-1', ueId: '192.0.2.10', observedAt: clock(), location: { lat: 37.5, lon: 127 }, health: { status: 'HEALTHY' }, ...patch });
  result.send = async (payload, callbackUrl = result.callbackUrl()) => { const response = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); return response.json(); };
  if (autoCreate) result.subscription = await result.create();
  return result;
}

test('R15/R16: Location/RNIS discovery, query and subscription CRUD use real local HTTP', async (t) => {
  for (const service of ['Location', 'RNIS']) await t.test(service, async (t) => {
    const f = await fixture(t, { service });
    assert.equal(f.subscription.state, 'ACTIVE');
    assert.equal(f.store.list('mecDiscovery').length, 1);
    assert.equal((await f.ingress.query(service, { ueId: '192.0.2.10' })).response.source, 'local-http-fixture');
    assert.equal((await f.manager.read(f.subscription.key)).status, 200);
    assert.equal((await f.manager.update(f.subscription.key)).providerStatus, 200);
    assert.equal((await f.manager.cancel(f.subscription.key)).state, 'PROVIDER_DELETED');
    assert.deepEqual(new Set(f.requests.map((entry) => entry.method)), new Set(['GET', 'POST', 'PUT', 'DELETE']));
    assert.equal(f.records.size, 0);
  });
});

test('M01: service, UE and provider identity bind to the opaque route', async (t) => {
  const f = await fixture(t);
  for (const payload of [f.payload({ service: 'RNIS' }), f.payload({ ueId: 'other-ue' }), f.payload({ subscriptionType: 'CellChangeSubscription' })]) assert.equal((await f.send(payload)).status, 'BINDING_REVIEW');
  assert.equal((await f.ingress.ingestCallback({ service: 'Location', token: f.token(), providerIdentity: { ...providerIdentity, mtlsFingerprint: 'different' }, payload: f.payload() })).status, 'BINDING_REVIEW');
  assert.equal(f.store.list('mecPayloads').length, 0);
  assert.equal(f.store.list('mecOutbox').length, 0);
});

test('M02: old generation, expired route and revoked grant produce minimal receipts', async (t) => {
  const f = await fixture(t); const oldUrl = f.callbackUrl();
  const second = await f.create('generation-2');
  assert.equal(second.generation, 2);
  assert.equal((await f.send(f.payload(), oldUrl)).status, 'TOMBSTONE');
  f.advance(901000);
  assert.equal((await f.send(f.payload())).status, 'EXPIRED');
  const g = await fixture(t);
  await g.policyService.revokeGrant({ principal: g.principal, grantId: g.grant.grantId });
  assert.equal((await g.send(g.payload())).status, 'REVOKED');
  assert.equal(g.store.list('mecPayloads').length, 0);
});

test('M03: concurrent delivery and canonical payload coalescing commit one row/outbox', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.send(f.payload()), f.send(f.payload())]);
  assert.deepEqual(results.map((item) => item.status).sort(), ['ACCEPTED', 'DUPLICATE']);
  assert.equal(f.store.list('mecPayloads').length, 1);
  assert.equal(f.store.list('mecOutbox').length, 1);
  assert.equal((await f.send(f.payload({ location: { lat: 37.5001, lon: 127 } }))).status, 'IDENTITY_REVIEW');
  await f.ingress.drainOutbox(); await f.ingress.drainOutbox();
  assert.equal(f.handovers.length, 1);
  const g = await fixture(t);
  const payload = g.payload({ eventId: undefined });
  assert.equal((await g.send({ ...payload, receivedAt: 'transport-one' })).status, 'ACCEPTED');
  assert.equal((await g.send({ ...payload, receivedAt: 'transport-two' })).status, 'DUPLICATE');
  assert.equal(g.store.list('mecPayloads').length, 1);
});

test('M04: older, stale, future and unknown source time preserve watermark', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send(f.payload())).status, 'ACCEPTED');
  for (const [eventId, offset] of [['older', -1000], ['stale', -31000], ['future', 3000]]) assert.equal((await f.send(f.payload({ eventId, observedAt: new Date(Date.parse(f.clock()) + offset).toISOString() }))).status, 'TIME_REVIEW');
  assert.equal((await f.send(f.payload({ eventId: 'unknown', observedAt: undefined }))).status, 'TIME_UNKNOWN');
  assert.equal(f.store.list('mecPayloads').length, 1);
  assert.equal(f.store.list('mecWatermarks')[0].observedAt, f.clock());
});

test('M05: revocation commit wins over a queued callback transaction', async (t) => {
  const f = await fixture(t);
  let release; let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = f.store.transaction('fixture-barrier', async () => { entered(); await new Promise((resolve) => { release = resolve; }); });
  await ready;
  const revoked = f.policyService.revokeGrant({ principal: f.principal, grantId: f.grant.grantId });
  const pending = f.ingress.ingestCallback({ service: 'Location', token: f.token(), providerIdentity, payload: f.payload() });
  release(); await held; await revoked;
  assert.equal((await pending).status, 'REVOKED');
  assert.equal(f.store.list('mecPayloads').length, 0);
  assert.equal(f.store.list('mecOutbox').length, 0);
});

test('M06: ciphertext survives restart while current grant gates each decrypt and execution', async (t) => {
  const f = await fixture(t); const result = await f.send(f.payload({ privateFixLabel: 'sensitive-observation-fixture' }));
  const disk = await readFile(f.path, 'utf8');
  assert.equal(disk.includes('sensitive-observation-fixture'), false);
  assert.equal(disk.includes(f.token()), false);
  assert.equal((await f.ingress.readEvent(result.eventKey)).location.lat, 37.5);
  await f.policyService.revokeGrant({ principal: f.principal, grantId: f.grant.grantId });
  const store = await new IntegrationStore(f.path).init();
  const policyService = new PolicyService({ store, clock: f.clock });
  const ingress = new MecCallbackIngress({ store, policyService, clock: f.clock });
  assert.equal(await ingress.readEvent(result.eventKey), null);
  assert.equal(store.list('mecPayloads').length, 1);
  await f.ingress.drainOutbox();
  assert.equal(f.handovers.length, 0);
  assert.equal(f.store.list('mecOutbox')[0].state, 'REVOKED');
});

test('M07: POST timeout, late callback and list reconciliation retain one subscription', async (t) => {
  const f = await fixture(t, { createTimeout: true });
  assert.equal(f.subscription.state, 'CREATE_UNCERTAIN');
  assert.equal((await f.send(f.payload())).status, 'CORRELATION_PENDING');
  f.mode.createTimeout = false;
  const results = await f.manager.reconcile({ force: true });
  assert.equal(results[0].state, 'ACTIVE');
  assert.equal(f.records.size, 1);
  assert.equal(f.requests.filter((entry) => entry.method === 'POST').length, 1);
  assert.equal((await f.send(f.payload())).status, 'ACCEPTED');
  await f.ingress.drainOutbox(); assert.equal(f.handovers.length, 1);
});

test('M08: cancel timeout, restart, late callback and independent new generation', async (t) => {
  const f = await fixture(t, { deleteTimeout: true }); const oldUrl = f.callbackUrl();
  const cancelled = await f.manager.cancel(f.subscription.key);
  assert.equal(cancelled.state, 'DELETE_UNCERTAIN');
  const store = await new IntegrationStore(f.path).init();
  const policyService = new PolicyService({ store, clock: f.clock });
  const manager = new MecSubscriptionManager({ store, policyService, adapters: f.adapters, callbackBaseUrl: f.callbackBaseUrl, clock: f.clock });
  const ingress = new MecCallbackIngress({ store, policyService, subscriptions: manager, clock: f.clock, locationAdapter: f.adapters.Location }); f.setIngress(ingress);
  assert.equal((await f.send(f.payload(), oldUrl)).status, 'TOMBSTONE');
  const second = await manager.create({ policyId: f.policy.policyId, service: 'Location', idempotencyKey: 'generation-2' });
  assert.equal(second.state, 'ACTIVE'); assert.equal(second.generation, 2);
  assert.equal((await f.send(f.payload())).status, 'ACCEPTED');
  f.mode.deleteTimeout = false;
  await manager.reconcile({ force: true });
  assert.equal(store.get('mecSubscriptions', f.subscription.key).state, 'PROVIDER_DELETED');
  assert.equal(store.list('receipts').filter((entry) => entry.type === 'MEC_PROVIDER_CLEANUP').length, 1);
});

test('M09: relative links normalize; external links and oversized payloads stay in review', async (t) => {
  const f = await fixture(t);
  const relative = new URL(f.subscription.resourceUrl).pathname;
  assert.equal((await f.send(f.payload({ subscription: relative }))).status, 'ACCEPTED');
  assert.equal((await f.send(f.payload({ eventId: 'external', subscription: 'http://127.0.0.1:1/foreign' }))).status, 'BINDING_REVIEW');
  assert.equal((await f.send(f.payload({ eventId: 'large', padding: 'x'.repeat(65536) }))).status, 'SCHEMA_REVIEW');
  assert.equal(f.store.list('mecPayloads').length, 1);
});

test('approved policy owns target edge; coordinate, geofence and health gate handover', async (t) => {
  const f = await fixture(t);
  for (const [eventId, patch] of [['outside', { location: { lat: 38, lon: 128 } }], ['health', { health: { status: 'DEGRADED' } }], ['missing-health', { health: undefined }]]) assert.equal((await f.send(f.payload({ eventId, ...patch }))).status, 'ACCEPTED');
  assert.equal((await f.send(f.payload({ eventId: 'invalid', location: { lat: 100, lon: 127 } }))).status, 'SCHEMA_REVIEW');
  await f.ingress.drainOutbox(); assert.equal(f.handovers.length, 0);
  assert.equal((await f.send(f.payload({ eventId: 'valid', intent: { targetEdgeId: 'forged-edge', geofence: { type: 'anywhere' } } }))).status, 'ACCEPTED');
  await f.ingress.drainOutbox(); assert.equal(f.handovers.length, 1); assert.equal(f.handovers[0].targetEdgeId, 'edge-b');
  assert.equal(pointInGeofence(null, { type: 'circle', lat: 0, lon: 0, radiusM: 5 }), false);
  assert.equal(pointInGeofence({ lat: 0, lon: 0 }, { type: 'unknown' }), false);
});

test('sequence identity, retry budget and retention are durable', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send(f.payload({ sequence: 1 }))).status, 'ACCEPTED');
  assert.equal((await f.send(f.payload({ eventId: 'other-id', sequence: 1 }))).status, 'IDENTITY_REVIEW');
  await f.manager.requestCancel(f.subscription.key);
  for (let index = 0; index < 10; index++) await f.manager.retry(f.subscription.key, 'DELETE_UNCERTAIN', { code: 'fixture' });
  assert.equal(f.store.get('mecSubscriptions', f.subscription.key).followup.status, 'FOLLOWUP');
  f.advance(24 * 3600000 + 1); await f.ingress.prune();
  assert.equal(f.store.list('mecPayloads').length, 0);
  assert.equal(f.store.get('mecRoutes', f.subscription.routeHash).state, 'TOMBSTONED');
});

test('공급자 cleanup 완료 후 24시간에 구독 상세·tombstone을 정리하고 삭제 receipt를 기록한다',async(t)=>{
  const f=await fixture(t);await f.send(f.payload());
  await f.manager.cancel(f.subscription.key);
  assert.equal(f.store.get('mecSubscriptions',f.subscription.key).state,'PROVIDER_DELETED');
  assert.equal(f.store.get('mecSubscriptions',f.subscription.key).requestCipher,undefined);
  f.advance(86400001);const result=await f.ingress.prune();
  assert.ok(result.removed>0);assert.equal(f.store.get('mecSubscriptions',f.subscription.key),undefined);assert.equal(f.store.get('mecRoutes',f.subscription.routeHash),undefined);
  const receipt=f.store.list('receipts').find((entry)=>entry.type==='MEC_RETENTION_EXPIRED');assert.equal(receipt.counts.mecSubscriptions,1);assert.equal(receipt.deletedKeysHash.length,64);
});

test('API callback binds transport identity and masks token on authorization error', async (t) => {
  const f = await fixture(t);
  const api = new IntegrationApiGateway({ policyService: f.policyService, mecIngress: f.ingress, mecSubscriptions: f.manager });
  const path = new URL(f.callbackUrl()).pathname;
  const failed = await api.handle({ method: 'POST', path, body: f.payload() });
  assert.equal(failed.status, 403); assert.equal(JSON.stringify(failed).includes(f.token()), false);
  const response = await api.handle({ method: 'POST', path, principal: { principalId: providerIdentity.providerId, mtlsFingerprint: providerIdentity.mtlsFingerprint, scopes: ['mec:callback'] }, body: f.payload() });
  assert.equal(response.status, 202); assert.equal(response.body.status, 'ACCEPTED');
  assert.equal(f.handovers.length, 1);
  const managed = await api.handle({ method: 'GET', path: '/v1/mec/subscriptions', principal: f.principal });
  assert.equal(managed.body.length, 1); assert.equal(JSON.stringify(managed).includes(f.token()), false);
});

test('store transaction publishes one snapshot and rolls back failed work', async () => {
  const store = await new IntegrationStore().init();
  await assert.rejects(store.transaction('fixture', async () => { await store.put('events', 'one', { value: 1 }); await store.append('receipts', { type: 'fixture' }); throw new Error('rollback-fixture'); }), /rollback-fixture/);
  assert.equal(store.list('events').length, 0); assert.equal(store.list('receipts').length, 0);
});

test('complete provider inventory confirms missing subscription before fresh generation', async (t) => {
  const f = await fixture(t); const oldUrl = f.callbackUrl();
  f.adapters.Location.capabilities.listComplete = true;
  f.records.clear();
  const results = await f.manager.reconcile({ force: true });
  assert.equal(results[0].state, 'ACTIVE'); assert.equal(results[0].generation, 2);
  assert.equal(f.records.size, 1);
  assert.equal(f.store.get('mecSubscriptions', f.subscription.key).state, 'PROVIDER_DELETED');
  assert.equal((await f.send(f.payload(), oldUrl)).status, 'TOMBSTONE');
  assert.equal(f.store.list('receipts').filter((row) => row.type === 'MEC_ABSENCE_CONFIRMED').length, 1);
});

test('RNIS and Location source timestamps map to verified observedAt', async (t) => {
  for (const service of ['Location', 'RNIS']) await t.test(service, async (t) => {
    const f = await fixture(t, { service });
    const body = { ueId: '192.0.2.10', eventId: 'schema-event', location: { lat: 37.5, lon: 127 }, health: { status: 'HEALTHY' }, [service === 'RNIS' ? 'timeStamp' : 'timestamp']: { seconds: Date.parse(f.clock()) / 1000, nanoSeconds: 0 } };
    const payload = service === 'Location' ? { zonalPresenceNotification: body } : body;
    const response = await f.send(payload);
    assert.equal(response.status, 'ACCEPTED');
    assert.equal((await f.ingress.readEvent(response.eventKey)).observedAt, f.clock());
  });
});

test('live ingestion requires deployment schema validation and current consent', async (t) => {
  const f = await fixture(t);
  f.adapters.Location.simulation = false;
  assert.equal((await f.send(f.payload())).status, 'SCHEMA_REVIEW');
  f.adapters.Location.capabilities.deploymentVerified = true;
  f.adapters.Location.capabilities.validateCallback = (payload) => payload.eventId === 'accepted-by-schema';
  assert.equal((await f.send(f.payload())).status, 'SCHEMA_REVIEW');
  const accepted = await f.send(f.payload({ eventId: 'accepted-by-schema' }));
  assert.equal(accepted.status, 'ACCEPTED');
  const consent = f.store.get('consents', f.grant.consentId);
  await f.store.put('consents', consent.consentId, { ...consent, status: 'REVOKED', revision: consent.revision + 1 });
  assert.equal((await f.send(f.payload())).status, 'REVOKED');
  await f.ingress.drainOutbox(); assert.equal(f.handovers.length, 0);
});
