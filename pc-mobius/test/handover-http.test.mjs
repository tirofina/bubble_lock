import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { HandoverCoordinator } from '../integration/src/handover-coordinator.mjs';
import { encodeBinarySwitch } from '../src/sdt-adapter.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';

async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; }
async function server(t, handler) {
  const instance = createServer(handler); instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); return new Promise((resolve) => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}
async function fixture(t, { persisted = false, metrics = false } = {}) {
  let now = Date.parse('2026-11-10T00:00:00Z'); const clock = () => new Date(now).toISOString();
  const path = persisted ? join(await mkdtemp(join(tmpdir(), 'bubble-handover-')), 'state.json') : null;
  const store = await new IntegrationStore(path).init();
  const policyService = new PolicyService({ store, clock });
  const principal = { principalId: 'guardian', scopes: ['consent:write', 'grant:write', 'grant:revoke'] };
  const consent = await policyService.createConsent({ principal, subjectId: 'household', purpose: 'handover-fixture', scopes: ['mec:location'], ttlSec: 3600 });
  const grant = await policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['mec:location'], ttlSec: 1800 });
  let coordinator = new HandoverCoordinator({ store, policyService, clock, drainBudgetMs: 15, attemptBudgetMs: 40 });
  const callback = await server(t, async (request, response) => { const payload = await body(request); const edgeId = new URL(request.url, 'http://fixture').pathname.slice(1); await coordinator.notification({ edgeId, subscriptionUri: payload['m2m:sgn'].sur, verified: true }); response.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? 'fixture' }); response.end(); });
  const vendors = {};
  for (const edgeId of ['edge-a', 'edge-b']) {
    const resources = new Map([['/Mobius', { 'm2m:cb': { rn: 'Mobius', ri: `cb-${edgeId}`, csi: `/${edgeId}` } }]]); let count = 0;
    const mode = { partition: false, callback: true };
    const endpoint = await server(t, async (request, response) => {
      const send = (status, rsc, value) => { response.writeHead(status, { 'content-type': 'application/json', 'X-M2M-RSC': String(rsc), 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end(value ? JSON.stringify(value) : undefined); };
      if (mode.partition) return send(503, 5000, { error: 'partition-fixture' });
      const path = request.url; const resource = resources.get(path);
      const originator = request.headers['x-m2m-origin'];
      if (originator !== `admin-${edgeId}` && originator !== 'C' && request.method !== 'GET') {
        const attrs = resource && Object.values(resource)[0]; const acp = [...resources.values()].find((item) => Object.values(item)[0].ri === attrs?.acpi?.[0]);
        if (!acp?.['m2m:acp'].pv.acr.some((rule) => rule.acor.includes(originator) && (rule.acop & 4))) return send(403, 4103);
      }
      if (request.method === 'GET') return send(resource ? 200 : 404, resource ? 2000 : 4004, resource);
      if (request.method === 'DELETE') { resources.delete(path); return send(200, 2002); }
      const payload = await body(request); const tag = Object.keys(payload)[0]; const attrs = payload[tag];
      if (request.method === 'PUT') { if (!resource) return send(404, 4004); Object.assign(Object.values(resource)[0], attrs); return send(200, 2004, resource); }
      const nextPath = `${path}/${attrs.rn}`;
      if (!resource) return send(404, 4004);
      if (resources.has(nextPath)) return send(409, 4105);
      const ty = Number(request.headers['content-type']?.match(/ty=(\d+)/)?.[1]);
      const stored = { [tag]: { ...attrs, ri: `${edgeId}-${++count}`, ty, ...(ty === 2 ? { aei: `C-${edgeId}-${count}` } : {}) } };
      resources.set(nextPath, stored);
      if (ty === 23 && mode.callback) await fetch(attrs.nu[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'm2m:sgn': { sur: nextPath, vrq: true } }) });
      send(201, 2001, stored);
    });
    const config = { edgeId, endpoint, cseBase: '/Mobius', cseId: `/${edgeId}`, originator: `admin-${edgeId}`, callbackUrl: `${callback}/${edgeId}`, simulation: true, securityContext: { credentialRevision: `credential-${edgeId}` } };
    coordinator.registerEdge(config); vendors[edgeId] = { resources, mode, config };
  }
  const manifest = { aeName: 'relay-fixture', requireCallbackVerification: !metrics, resources: [
    { logicalId: 'observations', ty: 3, body: { 'm2m:cnt': { rn: 'observations' } } },
    { logicalId: 'switch', ty: 28, body: encodeBinarySwitch({ rn: 'switch', state: false, cnd: 'org.onem2m.common.moduleclass.binarySwitch' }, { operation: 'CREATE' }), verifyFields: ['state'] },
  ], groups: [{ logicalId: 'switches', rn: 'switches', memberLogicalIds: ['switch'], memberType: 28 }], subscriptions: metrics ? [] : [{ logicalId: 'state', rn: 'state-sub', parentLogicalId: 'switch' }] };
  await coordinator.registerManifest('keyring-1', manifest);
  const options = { ueId: 'keyring-1', targetEdgeId: 'edge-a', grantId: grant.grantId };
  const bootstrap = await coordinator.handover(options); assert.equal(bootstrap.state, 'ACTIVE', bootstrap.reviewReason);
  return { path, store, clock, policyService, principal, grant, vendors, manifest, options, get coordinator() { return coordinator; }, advance(ms) { now += ms; }, async restart() { const next = await new IntegrationStore(path).init(); const policy = new PolicyService({ store: next, clock }); coordinator = new HandoverCoordinator({ store: next, policyService: policy, clock, drainBudgetMs: 15 }); for (const vendor of Object.values(vendors)) coordinator.registerEdge(vendor.config); return next; } };
}

test('A12: two HTTP CSEs restore distinct AE IDs, ACP, canonical SDT, group and subscriptions', async (t) => {
  const f = await fixture(t);
  const before = f.store.get('logicalBindings', 'keyring-1:edge-a');
  f.vendors['edge-a'].resources.get(before.resources.switch.path)['cod:binSh'].state = true;
  await f.coordinator.acceptObservation({ ueId: 'keyring-1', sequence: 1, payload: { state: true, observed: true } });
  const moved = await f.coordinator.handover({ ...f.options, targetEdgeId: 'edge-b' });
  assert.equal(moved.state, 'ACTIVE', moved.reviewReason); assert.equal(moved.epoch, 2); assert.equal(moved.phase, 'COMPLETE');
  const after = f.store.get('logicalBindings', 'keyring-1:edge-b');
  assert.notEqual(before.aeId, after.aeId); assert.notEqual(before.aeRi, after.aeRi);
  assert.equal(f.vendors['edge-b'].resources.get(after.resources.switch.path)['cod:binSh'].state, true);
  assert.deepEqual(after.groups[0].memberUris, [after.resources.switch.path.replace(/^\//, '')]);
  assert.equal(moved.replay.acceptedCount, 1); assert.equal(moved.sourceFence.fenced, true);
  assert.equal(f.vendors['edge-a'].resources.has(before.subscriptions[0].path), false);
  const denied = await fetch(`${f.vendors['edge-a'].config.endpoint}${before.resources.switch.path}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-M2M-Origin': before.aeId, 'X-M2M-RI': 'old-ae' }, body: JSON.stringify({ 'cod:binSh': { state: false } }) });
  assert.equal(denied.status, 403);
});

test('A11/D07: admitted command blocks cutover until exact claim readback settles', async (t) => {
  const f = await fixture(t);
  const lane = { ueId: 'keyring-1', commandId: 'command-1', claimId: 'claim-1', epoch: 1, payloadHash: 'hash-1', desiredState: { state: true } };
  await f.coordinator.admitDispatch(lane);
  const held = await f.coordinator.handover({ ...f.options, targetEdgeId: 'edge-b' });
  assert.equal(held.state, 'SETTLING'); assert.equal(held.phase, 'DRAIN'); assert.equal(held.epoch, 1);
  await assert.rejects(f.coordinator.admitDispatch({ ...lane, commandId: 'command-2', claimId: 'claim-2' }), /ACTIVE/);
  await assert.rejects(f.coordinator.settleDispatch({ ...lane, ackState: 'READBACK_VERIFIED', readback: { state: false } }), /readback/);
  await f.coordinator.settleDispatch({ ...lane, ackState: 'READBACK_VERIFIED', readback: { state: true } });
  const active = await f.coordinator.resume('keyring-1'); assert.equal(active.state, 'ACTIVE'); assert.equal(active.epoch, 2);
  await assert.rejects(f.coordinator.admitDispatch({ ...lane, claimId: 'stale-claim' }), /epoch/);
  assert.equal(f.store.list('dispatchLanes').length, 1);
});

test('이전 관측 원문을 암호화하고 CSE CIN의 RI·hash를 확인하여 참조 형태로 복원한다',async(t)=>{
  const f=await fixture(t);const binding=f.store.get('logicalBindings','keyring-1:edge-a');
  const raw={location:{lat:37.543210987,lon:127.012345678},sequence:4};const path=`${binding.resources.observations.path}/obs-4`;
  f.vendors['edge-a'].resources.set(path,{'m2m:cin':{ri:'legacy-4',ty:4,con:raw}});
  await f.store.put('handoverObservations','keyring-1:4',{key:'keyring-1:4',ueId:'keyring-1',sequence:4,payload:raw,payloadHash:approvalHash(raw),acceptedAt:f.clock(),applied:{'edge-a':{path,ri:'legacy-4',payloadHash:approvalHash(raw)}}});
  assert.equal((await f.coordinator.migrateObservations()).count,1);
  const protectedRow=f.store.get('handoverObservations','keyring-1:4');assert.equal(protectedRow.payload.type,'encrypted-observation-reference');assert.equal(JSON.stringify(protectedRow).includes('37.543210987'),false);
  await f.coordinator.purgeLegacyCse();assert.equal(f.vendors['edge-a'].resources.has(path),false);assert.equal(f.store.list('locationCsePurge')[0].state,'PURGED');
  const moved=await f.coordinator.handover({...f.options,targetEdgeId:'edge-b'});assert.equal(moved.state,'ACTIVE',moved.reviewReason);
  const target=f.store.get('logicalBindings','keyring-1:edge-b');const cin=f.vendors['edge-b'].resources.get(`${target.resources.observations.path}/obs-4`);
  assert.deepEqual(cin['m2m:cin'].con,protectedRow.payload);
});

test('source partition and target callback review preserve resumable transition', async (t) => {
  const f = await fixture(t);
  f.vendors['edge-a'].mode.partition = true;
  const held = await f.coordinator.handover({ ...f.options, targetEdgeId: 'edge-b' });
  assert.equal(held.state, 'SETTLING'); assert.equal(held.phase, 'CHECKPOINT'); assert.equal(held.epoch, 1);
  f.vendors['edge-a'].mode.partition = false;
  f.vendors['edge-b'].mode.callback = false;
  const verify = await f.coordinator.resume('keyring-1'); assert.equal(verify.state, 'SETTLING'); assert.equal(verify.phase, 'VERIFY');
  const binding = f.store.get('logicalBindings', 'keyring-1:edge-b');
  await f.coordinator.notification({ edgeId: 'edge-b', subscriptionUri: binding.subscriptions[0].path, verified: true });
  assert.equal((await f.coordinator.resume('keyring-1')).state, 'ACTIVE');
});

test('restart and rollback rebuild resources with a new epoch and preserved logical registry', async (t) => {
  const f = await fixture(t, { persisted: true });
  const moved = await f.coordinator.handover({ ...f.options, targetEdgeId: 'edge-b' }); assert.equal(moved.state, 'ACTIVE');
  const store = await f.restart();
  const rolled = await f.coordinator.rollback('keyring-1'); assert.equal(rolled.state, 'ROLLED_BACK', rolled.reviewReason); assert.equal(rolled.epoch, 3); assert.equal(rolled.edgeId, 'edge-a');
  assert.equal(store.list('logicalBindings').length, 2);
  assert.equal(store.list('receipts').filter((receipt) => receipt.type === 'HANDOVER_ROLLBACK').length, 1);
});

test('grant revoke before resumed cutover preserves the source ownership epoch', async (t) => {
  const f = await fixture(t);
  f.vendors['edge-b'].mode.partition = true;
  const pending = await f.coordinator.handover({ ...f.options, targetEdgeId: 'edge-b' }); assert.equal(pending.state, 'SETTLING');
  await f.policyService.revokeGrant({ principal: f.principal, grantId: f.grant.grantId });
  f.vendors['edge-b'].mode.partition = false;
  const reviewed = await f.coordinator.resume('keyring-1'); assert.equal(reviewed.state, 'SETTLING'); assert.equal(reviewed.epoch, 1); assert.equal(reviewed.reviewReason, 'GRANT_REVIEW');
});

test('Edge 배치 readiness와 현재 grant를 확인하고 source release를 cutover 뒤 실행한다', async (t) => {
  const f = await fixture(t); const calls = [];
  f.coordinator.deployers.set('edge-b', { async ensure(intent) { calls.push(['deploy', intent]); return { healthy: true, pid: 123, instanceId: 'instance-B' }; } });
  f.coordinator.deployers.set('edge-a', { async release(intent) { calls.push(['release', intent]); assert.equal(f.coordinator.status(intent.ueId).state, 'ACTIVE'); return { released: true }; } });
  const moved = await f.coordinator.handover({ ...f.options, targetEdgeId: 'edge-b' });
  assert.equal(moved.state, 'ACTIVE', moved.reviewReason); assert.equal(moved.deployment.instanceId, 'instance-B');
  assert.deepEqual(calls.map(([name]) => name), ['deploy', 'release']);
  assert.equal(calls[0][1].epoch, 2); assert.equal(calls[1][1].epoch, 1);
});

test('Edge 배치 직후 grant 회수는 대상 lease를 해제하고 source epoch를 유지한다', async (t) => {
  const f = await fixture(t); const released = [];
  f.coordinator.deployers.set('edge-b', {
    async ensure() { await f.policyService.revokeGrant({ principal: f.principal, grantId: f.grant.grantId }); return { healthy: true }; },
    async release(intent) { released.push(intent); return { released: true }; },
  });
  const result = await f.coordinator.handover({ ...f.options, targetEdgeId: 'edge-b' });
  assert.equal(result.state, 'SETTLING'); assert.equal(result.epoch, 1); assert.equal(result.reviewReason, 'EDGE_DEPLOYMENT_CURRENT_GRANT');
  assert.deepEqual(released, [{ ueId: 'keyring-1', epoch: 2 }]);
  assert.equal(f.store.get('logicalBindings', 'keyring-1:edge-b'), undefined);
});

test('A11: 30 local HTTP transitions retain all 1000 accepted observations and one CIN per sequence', async (t) => {
  const f = await fixture(t, { metrics: true });
  await f.store.transaction('observation-batch', async () => { for (let sequence = 0; sequence < 1000; sequence++) await f.coordinator.acceptObservation({ ueId: 'keyring-1', sequence, payload: { sequence, source: 'local-observation-fixture' } }); });
  const durations = [];
  for (let index = 0; index < 30; index++) { const moved = await f.coordinator.handover({ ...f.options, targetEdgeId: index % 2 ? 'edge-a' : 'edge-b' }); assert.equal(moved.state, 'ACTIVE', moved.reviewReason); assert.equal(moved.replay.acceptedCount, 1000); durations.push(moved.durationMs); }
  assert.equal(f.store.list('handoverObservations').length, 1000);
  for (const vendor of Object.values(f.vendors)) assert.equal([...vendor.resources.values()].filter((item) => item['m2m:cin']).length, 1000);
  const sorted = [...durations].sort((a, b) => a - b); assert.ok(sorted[Math.ceil(sorted.length * 0.95) - 1] <= 5000);
  t.diagnostic(JSON.stringify({ transitions: 30, acceptedObservations: 1000, lostObservations: 0, duplicateCins: 0, p95Ms: sorted[28], maximumMs: sorted[29], simulation: true, transport: 'local-http' }));
});
