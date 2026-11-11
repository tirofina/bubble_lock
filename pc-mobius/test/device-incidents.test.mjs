import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { DeviceIncidentService } from '../integration/src/device-incidents.mjs';

async function fixture(t) {
  let now = Date.parse('2026-11-10T10:00:00Z'); const clock = () => new Date(now).toISOString();
  const runtime = await createIntegrationRuntime({ clock }); t.after(runtime.close);
  const guardian = { principalId: 'guardian', scopes: ['portal:read', 'policy:approve', 'consent:write', 'grant:write', 'grant:revoke', 'bubble:command'] };
  const principal = { principalId: 'pi-1', mtlsFingerprint: 'fingerprint', scopes: [], simulation: true };
  await runtime.portalService.provisionHousehold({ householdId: 'home', name: '가족', ownerId: guardian.principalId, members: [{ principalId: 'visitor', role: 'visitor' }] });
  await runtime.gatewayControl.enroll({ gatewayId: 'pi-1', principalId: 'pi-1', fingerprint: 'fingerprint', status: 'ACTIVE', devices: { 'keyring-1': 'home' }, ownershipEpoch: 0, credentialRevision: '1' });
  await runtime.store.put('portalDevices', 'keyring-1', { deviceId: 'keyring-1', householdId: 'home', gatewayId: 'pi-1', label: '키링 1', registeredAt: clock() });
  const consent = await runtime.policyService.createConsent({ principal: guardian, subjectId: 'home', purpose: '긴급 보호', scopes: ['bubble:command'], ttlSec: 3600 });
  const grant = await runtime.policyService.createGrant({ principal: guardian, consentId: consent.consentId, scopes: ['bubble:command'], ttlSec: 900 });
  await runtime.policyService.approvePolicy({ principal: guardian, idempotencyKey: 'panic-policy', policy: { trigger: 'PANIC', householdId: 'home', deviceId: 'keyring-1', grantId: grant.grantId, desiredState: { state: true } } });
  const service = new DeviceIncidentService({ ...runtime, clock });
  const observe = (sequence, buttonState = 'panic', extra = {}) => service.ingest({ gatewayId: 'pi-1', principal,
    observationId: `observation-${sequence}`, observation: { gatewayId: 'pi-1', deviceId: 'keyring-1', bootId: 'boot-1', sequence, observedAt: clock(), buttonState, ...extra } });
  return { runtime, guardian, principal, grant, service, observe, clock, advance: (ms) => { now += ms; } };
}

test('PANIC→가구 사건·보호자 알림·현재 정책 승인 요청→중앙 명령 큐', async (t) => {
  const f = await fixture(t); const result = await f.observe(1);
  assert.equal(result.status, 'INCIDENT_OPENED'); assert.equal(result.requestIds.length, 1);
  assert.equal(f.runtime.store.list('gatewayCommands').length, 0);
  const notices = f.runtime.store.list('portalNotifications'); assert.equal(notices.length, 1); assert.equal(notices[0].principalId, 'guardian');
  const snapshot = f.runtime.portalService.snapshot(f.guardian); assert.equal(snapshot.incidents[0].deviceId, 'keyring-1');
  const approved = await f.runtime.portalService.approveCommand(f.guardian, { requestId: result.requestIds[0], grantId: f.grant.grantId, idempotencyKey: 'panic-approve' });
  assert.equal(approved.status, 'QUEUED'); assert.equal(f.runtime.store.list('gatewayCommands').length, 1);
});

test('중복·길게 누름·재시작·기존 OPEN 사건은 한 사건과 알림으로 수렴', async (t) => {
  const f = await fixture(t); await f.observe(1); await f.observe(1); await f.observe(2);
  const restarted = new DeviceIncidentService({ ...f.runtime, clock: f.clock });
  await restarted.ingest({ gatewayId: 'pi-1', principal: f.principal, observationId: 'restart', observation: { gatewayId: 'pi-1', deviceId: 'keyring-1', bootId: 'boot-2', sequence: 1, observedAt: f.clock(), buttonState: 'panic' } });
  await f.observe(3, 'released'); await f.observe(4);
  assert.equal(f.runtime.store.list('portalIncidents').length, 1); assert.equal(f.runtime.store.list('portalCommandRequests').length, 1);
  assert.equal(f.runtime.store.list('portalNotifications').length, 1);
});

test('회수된 정책·오래된 관측·Gateway 위조 경계를 유지', async (t) => {
  const f = await fixture(t); await f.runtime.policyService.revokeGrant({ principal: f.guardian, grantId: f.grant.grantId });
  const result = await f.observe(1); assert.equal(result.requestIds.length, 0); assert.equal(result.status, 'INCIDENT_OPENED');
  f.advance(31000); assert.equal((await f.observe(2, 'panic', { observedAt: '2026-11-10T10:00:00Z' })).status, 'STALE');
  await assert.rejects(f.service.ingest({ gatewayId: 'pi-1', principal: { principalId: 'foreign', fingerprint: 'fingerprint', scopes: [] }, observation: { deviceId: 'keyring-1' }, observationId: 'foreign' }));
});
