import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { HandoverCoordinator, DEFAULT_TRIGGER_POLICY, edgeScore } from '../integration/src/handover-coordinator.mjs';
import { HandoverAutomation, ObservationForwarder } from '../integration/src/handover-automation.mjs';
import { MecPolicyReconciler } from '../integration/src/mec-adapter.mjs';
import { encodeBinarySwitch } from '../src/sdt-adapter.mjs';

async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; }
async function server(t, handler) {
  const instance = createServer(handler); instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); return new Promise((resolve) => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}
async function grantFixture(clock) {
  const store = await new IntegrationStore().init();
  const policyService = new PolicyService({ store, clock });
  const principal = { principalId: 'guardian-auto', scopes: ['consent:write', 'grant:write', 'grant:revoke', 'policy:approve'] };
  const consent = await policyService.createConsent({ principal, subjectId: 'household-auto', purpose: 'automated handover', scopes: ['mec:location', 'mec:rnis'], ttlSec: 3600 });
  const grant = await policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['mec:location', 'mec:rnis'], ttlSec: 1800 });
  return { store, policyService, principal, grant };
}
/** handover-http.test.mjs와 같은 oneM2M HTTP fixture CSE 두 개에 지연과 partition 제어를 더한다. */
async function cseFixture(t, { triggerPolicy = {}, delays = {}, zones = {} } = {}) {
  let time = Date.parse('2026-11-19T00:00:00Z'); const clock = () => new Date(time).toISOString();
  const { store, policyService, principal, grant } = await grantFixture(clock);
  const coordinator = new HandoverCoordinator({ store, policyService, clock, drainBudgetMs: 15, attemptBudgetMs: 2000, triggerPolicy });
  const callback = await server(t, async (request, response) => { const payload = await body(request); const edgeId = new URL(request.url, 'http://fixture').pathname.slice(1); if (payload['m2m:sgn']?.sur) await coordinator.notification({ edgeId, subscriptionUri: payload['m2m:sgn'].sur, verified: true }); response.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? 'fixture' }); response.end(); });
  const vendors = {};
  for (const edgeId of ['edge-a', 'edge-b']) {
    const resources = new Map([['/Mobius', { 'm2m:cb': { rn: 'Mobius', ri: `cb-${edgeId}`, csi: `/${edgeId}` } }]]); let count = 0;
    const mode = { partition: false, delayMs: delays[edgeId] ?? 0 };
    const endpoint = await server(t, async (request, response) => {
      const send = (status, rsc, value) => { response.writeHead(status, { 'content-type': 'application/json', 'X-M2M-RSC': String(rsc), 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end(value ? JSON.stringify(value) : undefined); };
      if (mode.delayMs) await delay(mode.delayMs);
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
      if (ty === 23) await fetch(attrs.nu[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'm2m:sgn': { sur: nextPath, vrq: true } }) });
      send(201, 2001, stored);
    });
    const config = { edgeId, endpoint, cseBase: '/Mobius', cseId: `/${edgeId}`, originator: `admin-${edgeId}`, callbackUrl: `${callback}/${edgeId}`, simulation: true, zones: zones[edgeId] ?? [], timeoutMs: 1000 };
    coordinator.registerEdge(config); vendors[edgeId] = { resources, mode, config };
  }
  await coordinator.registerManifest('keyring-auto', { aeName: 'relay-auto', requireCallbackVerification: true, resources: [
    { logicalId: 'observations', ty: 3, body: { 'm2m:cnt': { rn: 'observations' } } },
    { logicalId: 'switch', ty: 28, body: encodeBinarySwitch({ rn: 'switch', state: true }, { operation: 'CREATE' }), verifyFields: ['state'] },
  ], subscriptions: [{ logicalId: 'state', rn: 'state-sub', parentLogicalId: 'switch' }] });
  const bootstrap = await coordinator.handover({ ueId: 'keyring-auto', targetEdgeId: 'edge-a', grantId: grant.grantId });
  assert.equal(bootstrap.state, 'ACTIVE', bootstrap.reviewReason);
  return { store, policyService, principal, grant, coordinator, vendors, clock, advance(ms) { time += ms; } };
}

test('기본 트리거 정책은 기존 zone, health 체류, cooldown, 실패 횟수 값을 유지한다', () => {
  assert.equal(DEFAULT_TRIGGER_POLICY.minResidenceMs, 30000); assert.equal(DEFAULT_TRIGGER_POLICY.cooldownMs, 60000);
  assert.equal(DEFAULT_TRIGGER_POLICY.zoneDwellMs, 10000); assert.equal(DEFAULT_TRIGGER_POLICY.minInsideM, 20);
  assert.equal(DEFAULT_TRIGGER_POLICY.healthFailures, 3); assert.equal(DEFAULT_TRIGGER_POLICY.healthFailureSpacingMs, 1000);
  assert.throws(() => new HandoverCoordinator({ store: new IntegrationStore(), triggerPolicy: { zoneDwellMs: -1 } }), /zoneDwellMs/);
});

test('selectEligibleEdge는 측정 RTT와 load를 함께 점수화하고 maxLatencyMs, exclude 조건을 적용한다', async () => {
  const store = await new IntegrationStore().init();
  const coordinator = new HandoverCoordinator({ store, triggerPolicy: { latencyBudgetMs: 100, latencyWeight: 1 } });
  for (const edgeId of ['edge-a', 'edge-b', 'edge-c']) coordinator.registerEdge({ edgeId, health: 'HEALTHY', load: 0, zones: ['street'] });
  assert.equal((await coordinator.selectEligibleEdge()).edgeId, 'edge-a', 'RTT가 없으면 기존 load, edgeId 순서를 유지한다');
  coordinator.recordProbe('edge-a', { ok: true, rttMs: 80 }); coordinator.recordProbe('edge-b', { ok: true, rttMs: 10 }); coordinator.recordProbe('edge-c', { ok: true, rttMs: 30 });
  assert.equal((await coordinator.selectEligibleEdge({ zone: 'street' })).edgeId, 'edge-b');
  assert.deepEqual(coordinator.rankEdges().map((edge) => edge.edgeId), ['edge-b', 'edge-c', 'edge-a']);
  coordinator.recordProbe('edge-b', { ok: true, rttMs: 10, load: 0.5 });
  assert.equal((await coordinator.selectEligibleEdge()).edgeId, 'edge-c', 'load 0.5가 RTT 20ms 차이보다 크다');
  assert.equal((await coordinator.selectEligibleEdge({ maxLatencyMs: 20 })).edgeId, 'edge-b');
  assert.equal(await coordinator.selectEligibleEdge({ maxLatencyMs: 5 }), null);
  assert.equal((await coordinator.selectEligibleEdge({ exclude: ['edge-c', 'edge-b'] })).edgeId, 'edge-a');
  assert.ok(Math.abs(edgeScore(coordinator.edges.get('edge-c'), { latencyBudgetMs: 100 }) - 0.3) < 1e-9);
});

test('recordProbe는 RTT EWMA, 연속 실패 DOWN, 지연 fence가 남은 Edge의 RECOVERING을 기록한다', async () => {
  const store = await new IntegrationStore().init();
  const coordinator = new HandoverCoordinator({ store, triggerPolicy: { latencyAlpha: 0.5, probeFailuresForDown: 3 } });
  coordinator.registerEdge({ edgeId: 'edge-a', health: 'HEALTHY', load: 0 });
  assert.equal(coordinator.recordProbe('edge-a', { ok: true, rttMs: 10 }).latencyMs, 10);
  assert.equal(coordinator.recordProbe('edge-a', { ok: true, rttMs: 30 }).latencyMs, 20);
  coordinator.recordProbe('edge-a', { ok: false }); assert.equal(coordinator.edges.get('edge-a').health, 'HEALTHY');
  coordinator.recordProbe('edge-a', { ok: false }); const down = coordinator.recordProbe('edge-a', { ok: false });
  assert.equal(down.health, 'DOWN'); assert.equal(down.probeFailures, 3);
  await store.put('handoverDeferredFences', 'ue:edge-a:h1', { key: 'ue:edge-a:h1', ueId: 'ue', edgeId: 'edge-a', state: 'PENDING' });
  assert.equal(coordinator.recordProbe('edge-a', { ok: true, rttMs: 12 }).health, 'RECOVERING');
  assert.equal((await coordinator.selectEligibleEdge()), null, 'RECOVERING Edge는 선택하지 않는다');
  coordinator.registerEdge({ edgeId: 'edge-b', health: 'HEALTHY', load: 0 });
  await store.put('handoverDeferredFences', 'ue:edge-b:h2', { key: 'ue:edge-b:h2', ueId: 'ue', edgeId: 'edge-b', state: 'PENDING' });
  assert.equal(coordinator.recordProbe('edge-b', { ok: true, rttMs: 5 }).health, 'RECOVERING', 'HEALTHY Edge도 남은 지연 fence를 먼저 정산한다');
});

test('출발 CSE probe 실패를 관측한 경우에만 failover 모드(지연 fence)로 이동한다', async (t) => {
  const f = await cseFixture(t);
  const moved = await f.coordinator.handover({ ueId: 'keyring-auto', targetEdgeId: 'edge-b', grantId: f.grant.grantId, sourceUnavailable: true });
  assert.equal(moved.state, 'ACTIVE', moved.reviewReason); assert.equal(moved.sourceUnavailable, false);
  assert.equal(moved.sourceFence.fenced, true); assert.equal(f.store.list('handoverDeferredFences').length, 0);
});

test('성능 트리거는 probe RTT 차이가 dwell 동안 이어질 때 더 빠른 CSE로 자동 이동한다', async (t) => {
  const f = await cseFixture(t, { delays: { 'edge-a': 60 }, zones: { 'edge-a': ['street'], 'edge-b': ['street'] }, triggerPolicy: { minResidenceMs: 0, cooldownMs: 0, performanceDwellMs: 1000, minScoreGain: 0.2, latencyBudgetMs: 100, latencyAlpha: 1 } });
  const events = [];
  const automation = new HandoverAutomation({ coordinator: f.coordinator, ueId: 'keyring-auto', grantId: f.grant.grantId, clock: f.clock, onEvent: (event) => events.push(event) });
  automation.zone = 'street';
  await automation.probeEdge('edge-a'); await automation.probeEdge('edge-b');
  assert.ok(f.coordinator.edges.get('edge-a').latencyMs >= 55, 'fixture 지연을 RTT로 측정한다');
  assert.equal((await automation.evaluatePerformance()).state, 'WAITING');
  f.advance(1000); await automation.probeEdge('edge-a'); await automation.probeEdge('edge-b');
  const moved = await automation.evaluatePerformance();
  assert.equal(moved.state, 'ACTIVE', moved.reviewReason); assert.equal(moved.edgeId, 'edge-b'); assert.equal(moved.reason, 'performance');
  assert.ok(moved.trigger.scoreGain >= 0.2); assert.equal(moved.epoch, 2);
  assert.ok(events.some((event) => event.type === 'trigger-fired' && event.kind === 'performance' && event.targetEdgeId === 'edge-b'));
  assert.equal(await automation.evaluatePerformance(), null, '현재 소유 Edge가 최선이면 트리거하지 않는다');
});

test('가용성 트리거는 소유 CSE probe 3회 실패에 cached checkpoint로 failover하고 복구 Edge에 지연 fence를 적용한다', async (t) => {
  const f = await cseFixture(t, { zones: { 'edge-a': ['street'], 'edge-b': ['street'] }, triggerPolicy: { availabilityFailures: 3, probeFailuresForDown: 3 } });
  const automation = new HandoverAutomation({ coordinator: f.coordinator, ueId: 'keyring-auto', grantId: f.grant.grantId, clock: f.clock });
  automation.zone = 'street';
  const before = f.store.get('logicalBindings', 'keyring-auto:edge-a');
  f.vendors['edge-a'].resources.get(before.resources.switch.path)['cod:binSh'].state = false;
  assert.equal((await automation.checkpoint()).snapshot.switch['cod:binSh'].state, false);
  await f.coordinator.acceptObservation({ ueId: 'keyring-auto', sequence: 0, payload: { sequence: 0, simulation: true } });
  f.vendors['edge-a'].mode.partition = true;
  await automation.probeEdge('edge-a'); f.advance(100); await automation.probeEdge('edge-a');
  assert.equal(f.coordinator.status('keyring-auto').edgeId, 'edge-a', '연속 실패 3회 전에는 이동하지 않는다');
  f.advance(100); await automation.probeEdge('edge-a');
  const moved = f.coordinator.status('keyring-auto');
  assert.equal(moved.state, 'ACTIVE', moved.reviewReason); assert.equal(moved.edgeId, 'edge-b'); assert.equal(moved.reason, 'availability');
  assert.equal(moved.sourceUnavailable, true); assert.equal(moved.checkpoint.source, 'cached-checkpoint');
  assert.equal(moved.sourceFence.deferred, true); assert.equal(moved.sourceCleanup.deferred, true); assert.equal(moved.replay.acceptedCount, 1);
  const after = f.store.get('logicalBindings', 'keyring-auto:edge-b');
  assert.equal(f.vendors['edge-b'].resources.get(after.resources.switch.path)['cod:binSh'].state, false, 'checkpoint 상태를 대상 CSE에 복원한다');
  assert.equal(f.coordinator.edges.get('edge-a').health, 'DOWN');
  f.vendors['edge-a'].mode.partition = false;
  await automation.probeEdge('edge-a');
  assert.equal(f.coordinator.edges.get('edge-a').health, 'HEALTHY');
  assert.equal(f.store.list('handoverDeferredFences')[0].state, 'APPLIED');
  assert.equal(f.vendors['edge-a'].resources.has(before.subscriptions[0].path), false, '복구 CSE의 이전 구독을 해제한다');
  const denied = await fetch(`${f.vendors['edge-a'].config.endpoint}${before.resources.switch.path}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-M2M-Origin': before.aeId, 'X-M2M-RI': 'stale-ae' }, body: JSON.stringify({ 'cod:binSh': { state: true } }) });
  assert.equal(denied.status, 403, '복구 CSE의 이전 AE UPDATE를 거부한다');
});

test('zone 트리거는 MEC 위치 보고를 승인 정책으로 reconcile하고 설정한 dwell 뒤 이동한다', async () => {
  let time = Date.parse('2026-11-19T00:00:00Z'); const clock = () => new Date(time).toISOString();
  const { store, policyService, principal, grant } = await grantFixture(clock);
  const coordinator = new HandoverCoordinator({ store, policyService, clock, triggerPolicy: { minResidenceMs: 0, cooldownMs: 0, zoneDwellMs: 1000 } });
  coordinator.registerEdge({ edgeId: 'edge-a', health: 'HEALTHY', load: 0, zones: ['home'] }); coordinator.registerEdge({ edgeId: 'edge-b', health: 'HEALTHY', load: 0, zones: ['outside'] });
  const zones = [{ zoneId: 'home', geofence: { type: 'circle', lat: 37.5, lon: 127, radiusM: 120 } }, { zoneId: 'outside', geofence: { type: 'circle', lat: 37.507, lon: 127, radiusM: 200 } }];
  const zonePolicies = [];
  for (const [zone, targetEdgeId] of [['home', 'edge-a'], ['outside', 'edge-b']]) {
    const policy = await policyService.approvePolicy({ principal, idempotencyKey: `zone-${zone}`, policy: { ueId: 'keyring-zone', grantId: grant.grantId, targetEdgeId, geofence: zones.find((item) => item.zoneId === zone).geofence, trigger: { kind: 'zone' } } });
    zonePolicies.push({ zoneId: zone, policyId: policy.policyId, policyRevision: policy.revision, targetEdgeId });
  }
  const reconciler = new MecPolicyReconciler({ store, policyService, handoverCoordinator: coordinator, clock });
  const automation = new HandoverAutomation({ coordinator, reconciler, ueId: 'keyring-zone', grantId: grant.grantId, zones, zonePolicies, clock });
  await automation.onLocation({ location: { lat: 37.5, lon: 127, accuracyM: 5 } });
  assert.equal(coordinator.status('keyring-zone').edgeId, 'edge-a', '첫 zone 보고가 승인 배치를 만든다');
  time += 1000; await automation.onLocation({ location: { lat: 37.507, lon: 127, accuracyM: 5 } });
  assert.equal(automation.zone, 'outside'); assert.equal(coordinator.status('keyring-zone').edgeId, 'edge-a');
  time += 500; await automation.onLocation({ location: { lat: 37.507, lon: 127, accuracyM: 5 } });
  assert.equal(coordinator.status('keyring-zone').edgeId, 'edge-a', 'dwell 1초 전에는 이동하지 않는다');
  time += 600; await automation.onLocation({ location: { lat: 37.507, lon: 127, accuracyM: 5 } });
  const moved = coordinator.status('keyring-zone');
  assert.equal(moved.edgeId, 'edge-b'); assert.equal(moved.reason, 'zone'); assert.equal(moved.trigger.kind, 'zone'); assert.equal(moved.epoch, 2);
});

test('관측 forwarder는 cutover 구간에 보관하고 재전송을 정리하며 이동 전후 sequence를 한 번씩 기록한다', async (t) => {
  const f = await cseFixture(t, { triggerPolicy: {} });
  const forwarder = new ObservationForwarder({ coordinator: f.coordinator, ueId: 'keyring-auto', concurrency: 2, retryMs: 5, holdMs: 5 }).start();
  t.after(() => forwarder.stop());
  const session = f.coordinator.status('keyring-auto');
  assert.equal(forwarder.route(), 'edge-a');
  for (const [phase, state, expected] of [['RESTORE', 'RESTORING', 'edge-a'], ['DRAIN', 'QUIESCING', null], ['CUTOVER', 'QUIESCING', null], ['VERIFY', 'VERIFYING', null], ['RESTORE', 'SETTLING', null]]) {
    await f.store.put('handovers', 'keyring-auto', { ...session, phase, state, previousEdgeId: 'edge-a', edgeId: 'edge-a', targetEdgeId: 'edge-b' });
    assert.equal(forwarder.route(), expected, `${phase}/${state}`);
  }
  await f.store.put('handovers', 'keyring-auto', session);
  const telemetry = (sequence) => ({ deviceId: 'keyring-auto', sequence, timestamp: new Date().toISOString(), state: true, batteryPct: 90, rssiDbm: -60, schemaVersion: '1.0.0' });
  for (let sequence = 0; sequence < 20; sequence++) forwarder.submit(telemetry(sequence));
  assert.equal(forwarder.submit(telemetry(3)).duplicate, true);
  const moving = f.coordinator.handover({ ueId: 'keyring-auto', targetEdgeId: 'edge-b', grantId: f.grant.grantId });
  for (let sequence = 20; sequence < 40; sequence++) { forwarder.submit(telemetry(sequence)); await delay(2); }
  assert.equal((await moving).state, 'ACTIVE');
  for (let index = 0; index < 200 && forwarder.pending(); index++) await delay(10);
  await forwarder.flushMarks();
  assert.equal(forwarder.pending(), 0); assert.equal(forwarder.counts.retransmissionsSuppressed, 1); assert.equal(forwarder.counts.accepted, 40);
  const binding = f.store.get('logicalBindings', 'keyring-auto:edge-b');
  const cins = [...f.vendors['edge-b'].resources.keys()].filter((path) => path.startsWith(`${binding.resources.observations.path}/obs-`));
  assert.equal(cins.length, 40); assert.equal(new Set(cins).size, 40);
  assert.ok([...forwarder.done.values()].every((item) => item.edgeId === 'edge-a' || item.edgeId === 'edge-b'));
});
