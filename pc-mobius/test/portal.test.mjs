import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortalDemo } from '../integration/src/portal-demo.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bubble-portal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = '2026-11-10T08:00:00.000Z';
  const options = { statePath: join(dir, 'state.json'), clock: () => now };
  const { runtime, principals } = await createPortalDemo(options);
  const api = (role, path, body = {}, method = 'POST') => runtime.api.handle({ method, path: `/v1/portal/${path}`, principal: principals[role], body });
  return { runtime, principals, api, options, setTime: (value) => { now = value; } };
}

async function grant(fixture) {
  const consent = await fixture.api('guardian', 'consents', { householdId: 'household-demo', purpose: '키링 보호', scopes: ['bubble:command', 'location:read'], ttlSec: 3600, idempotencyKey: 'consent-1' });
  assert.equal(consent.status, 200);
  const grant = await fixture.api('guardian', 'grants', { consentId: consent.body.consentId, scopes: ['bubble:command'], ttlSec: 900, idempotencyKey: 'grant-1' });
  assert.equal(grant.status, 200);
  return { consent: consent.body, grant: grant.body };
}

test('포털 조회는 가구 멤버 범위와 보호자/방문자 역할을 보존한다', async (t) => {
  const f = await fixture(t);
  const guardian = (await f.api('guardian', 'snapshot', {}, 'GET')).body;
  const visitor = (await f.api('visitor', 'snapshot', {}, 'GET')).body;
  assert.equal(guardian.principal.role, 'guardian');
  assert.equal(visitor.principal.role, 'visitor');
  assert.equal(visitor.devices.length, 3);
  const other = { principalId: 'outsider', scopes: ['portal:read', 'incident:write'] };
  assert.equal(f.runtime.portalService.snapshot(other).devices.length, 0);
  assert.throws(() => f.runtime.portalService.createIncident(other, { householdId: 'household-demo', kind: 'HELP', message: '도움', idempotencyKey: 'foreign' }));
  const forged = await f.runtime.api.handle({ method: 'POST', path: '/v1/portal/consents', principal: f.principals.visitor, body: { principal: f.principals.guardian, householdId: 'household-demo', idempotencyKey: 'forged' } });
  assert.equal(forged.status, 403);
  const direct = await f.runtime.api.handle({ method: 'POST', path: '/v1/consents', principal: { ...other, scopes: ['consent:write'] }, body: { subjectId: 'household-demo', purpose: 'foreign', scopes: ['bubble:command'] } });
  assert.equal(direct.status, 403);
  const unregistered = await f.runtime.api.handle({ method: 'POST', path: '/v1/consents', principal: f.principals.guardian, body: { subjectId: 'unregistered-household', purpose: '미등록 가구', scopes: ['bubble:command'] } });
  assert.equal(unregistered.status, 403);
  const registered = await f.runtime.api.handle({ method: 'POST', path: '/v1/consents', principal: f.principals.guardian, body: { subjectId: 'household-demo', purpose: '등록 가구', scopes: ['bubble:command'] } });
  assert.equal(registered.status, 201);
});

test('가구 생성과 기기 등록은 등록된 Gateway subject를 확인한다', async (t) => {
  const f = await fixture(t);
  const home = await f.api('guardian', 'households', { name: '새 가구', idempotencyKey: 'new-home' });
  assert.equal(home.status, 200);
  const wrong = await f.api('guardian', 'devices', { householdId: home.body.householdId, deviceId: 'keyring-A', gatewayId: 'pi-01', label: '기기', idempotencyKey: 'wrong-device' });
  assert.equal(wrong.status, 403);
  assert.equal(f.runtime.store.get('portalDevices', 'keyring-A').householdId, 'household-demo');
});

test('동의/권한의 동시 재전송은 원래 intent로 한 번 반영한다', async (t) => {
  const f = await fixture(t);
  const initialConsents=f.runtime.store.list('consents').length;
  const body = { householdId: 'household-demo', purpose: '위치', scopes: ['location:read'], idempotencyKey: 'same-consent' };
  const [first, second] = await Promise.all([f.api('guardian', 'consents', body), f.api('guardian', 'consents', body)]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, second.body);
  assert.equal(f.runtime.store.list('consents').length, initialConsents+1);
  assert.equal((await f.api('guardian', 'consents', { ...body, purpose: '다른 목적' })).status, 403);
  assert.equal((await f.api('guardian', 'consents', { ...body, idempotencyKey: 'wildcard', scopes: ['*'] })).status, 403);
});

test('방문자 요청을 보호자가 승인하면 현재 claim을 가진 명령이 Gateway 큐에 들어간다', async (t) => {
  const f = await fixture(t);
  const active = await grant(f);
  const requested = await f.api('visitor', 'commands/request', { householdId: 'household-demo', deviceIds: ['keyring-A', 'keyring-B'], desiredState: { state: true }, reason: '보호 모드 요청', idempotencyKey: 'request-1' });
  assert.equal(requested.body.status, 'PENDING');
  const input = { requestId: requested.body.requestId, grantId: active.grant.grantId, idempotencyKey: 'approve-1' };
  assert.equal((await f.api('visitor', 'commands/approve', input)).status, 403);
  const approved = await f.api('guardian', 'commands/approve', input);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'QUEUED');
  assert.equal(approved.body.commands.length, 2);
  assert.equal(approved.body.commands.every((command) => command.claimId && command.grantRevision === 1), true);
  assert.deepEqual((await f.api('guardian', 'commands/approve', input)).body, approved.body);
  assert.equal(f.runtime.store.list('gatewayCommands').length, 2);
  const peer = { principalId: 'gateway-demo', mtlsFingerprint: 'DEMO-ONLY-NO-TRANSPORT' };
  assert.equal(f.runtime.gatewayControl.poll('pi-01', peer).commands.length, 2);
  await f.api('guardian', 'consents/revoke', { consentId: active.consent.consentId, idempotencyKey: 'revoke-consent' });
  assert.equal(f.runtime.gatewayControl.poll('pi-01', peer).commands.length, 0);
  assert.equal((await f.api('guardian', 'snapshot', {}, 'GET')).body.grants.find((item)=>item.grantId===active.grant.grantId).effectiveStatus, 'INACTIVE');
});

test('권한 만료와 다른 가구 권한은 명령 승인에 반영한다', async (t) => {
  const f = await fixture(t);
  const active = await grant(f);
  const command = await f.api('visitor', 'commands/request', { householdId: 'household-demo', deviceIds: ['keyring-A'], desiredState: { state: false }, reason: '종료 요청', ttlSec: 900, idempotencyKey: 'request-expire' });
  const other = await f.api('guardian', 'households', { name: '다른 가구', idempotencyKey: 'other-home' });
  const consent = await f.api('guardian', 'consents', { householdId: other.body.householdId, purpose: '다른 가구', scopes: ['bubble:command'], idempotencyKey: 'other-consent' });
  const otherGrant = await f.api('guardian', 'grants', { consentId: consent.body.consentId, scopes: ['bubble:command'], idempotencyKey: 'other-grant' });
  assert.equal((await f.api('guardian', 'commands/approve', { requestId: command.body.requestId, grantId: otherGrant.body.grantId, idempotencyKey: 'wrong-household' })).status, 403);
  await assert.rejects(f.runtime.gatewayControl.issue({ principal: f.principals.guardian, gatewayId: 'pi-01', deviceId: 'keyring-A', commandId: 'wrong-household-direct', grantId: otherGrant.body.grantId, desiredState: { state: true }, deadline: '2026-11-10T08:01:00.000Z' }), /subject grant/);
  f.setTime('2026-11-10T08:16:00.000Z');
  const response = await f.api('guardian', 'commands/approve', { requestId: command.body.requestId, grantId: active.grant.grantId, idempotencyKey: 'after-expire' });
  assert.equal(response.status, 403);
  assert.equal(f.runtime.store.list('gatewayCommands').length, 0);
  const snapshot = (await f.api('guardian', 'snapshot', {}, 'GET')).body;
  assert.equal(snapshot.grants[0].effectiveStatus, 'EXPIRED');
  assert.equal(snapshot.commandRequests[0].effectiveStatus, 'EXPIRED');
});

test('방문자 위치는 현재 가구 위치 권한과 동의·회수·만료에 연결된다', async (t) => {
  const f = await fixture(t);
  const access = async (role) => (await f.api(role, 'location-access', {}, 'GET')).body;
  assert.equal((await access('guardian')).deviceIds.length, 3);
  assert.equal((await access('visitor')).deviceIds.length, 0);
  const active = await grant(f);
  assert.equal((await access('visitor')).deviceIds.length, 0);
  const input = { consentId: active.consent.consentId, scopes: ['location:read'], ttlSec: 60, idempotencyKey: 'location-grant' };
  const locationGrant = await f.api('guardian', 'grants', input);
  const incident=f.runtime.store.list('portalIncidents').find((item)=>item.status==='OPEN');
  const approveLocation=async(grant)=>f.api('guardian','location-leases',{grantId:grant.grantId,recipientId:'visitor-demo',deviceIds:['keyring-A','keyring-B','keyring-C'],purpose:grant.purpose,incidentId:incident.incidentId,ttlSec:60,idempotencyKey:`lease-${grant.grantId}`});
  assert.equal((await approveLocation(locationGrant.body)).status,200);
  assert.deepEqual((await access('visitor')).deviceIds, ['keyring-A', 'keyring-B', 'keyring-C']);
  await f.api('guardian', 'grants/revoke', { grantId: locationGrant.body.grantId, idempotencyKey: 'location-revoke' });
  assert.equal((await access('visitor')).deviceIds.length, 0);
  const expiring=await f.api('guardian', 'grants', { ...input, idempotencyKey: 'location-expiring' });await approveLocation(expiring.body);
  f.setTime('2026-11-10T08:01:01.000Z');
  assert.equal((await access('visitor')).deviceIds.length, 0);
  const renewed=await f.api('guardian', 'grants', { ...input, idempotencyKey: 'location-after-expiry' });await approveLocation(renewed.body);
  assert.equal((await access('visitor')).deviceIds.length, 3);
  await f.api('guardian', 'consents/revoke', { consentId: active.consent.consentId, idempotencyKey: 'location-consent-revoke' });
  assert.equal((await access('visitor')).deviceIds.length, 0);
  assert.equal(f.runtime.portalService.locationAccess({ principalId: 'outsider', scopes: ['portal:read'] }).deviceIds.length, 0);
});

test('안전 요청과 알림 확인은 본인/가구 권한을 유지하며 재시작 뒤 보존한다', async (t) => {
  const f = await fixture(t);
  const incident = await f.api('visitor', 'incidents', { householdId: 'household-demo', deviceId: 'keyring-A', kind: 'LOST', message: '키링 위치 확인 요청', idempotencyKey: 'incident-1' });
  assert.equal(incident.body.status, 'OPEN');
  assert.equal((await f.api('visitor', 'incidents/resolve', { incidentId: incident.body.incidentId, idempotencyKey: 'resolve-denied' })).status, 403);
  const notice = f.runtime.portalService.snapshot(f.principals.guardian).notifications.find((item) => item.type === 'INCIDENT_OPENED');
  assert.equal((await f.api('visitor', 'notifications/read', { notificationId: notice.notificationId, idempotencyKey: 'foreign-read' })).status, 403);
  assert.equal((await f.api('guardian', 'notifications/read', { notificationId: notice.notificationId, idempotencyKey: 'read-1' })).body.readAt, f.options.clock());
  await f.api('guardian', 'incidents/resolve', { incidentId: incident.body.incidentId, idempotencyKey: 'resolve-1' });
  const restored = await createPortalDemo(f.options);
  const snapshot = restored.runtime.portalService.snapshot(restored.principals.guardian);
  assert.equal(snapshot.incidents.find((item)=>item.incidentId===incident.body.incidentId).status, 'RESOLVED');
  assert.equal(snapshot.notifications.find((item) => item.notificationId === notice.notificationId).readAt, f.options.clock());
  assert.equal(snapshot.devices.length, 3);
});

test('일부 큐 등록 뒤 장애는 PARTIAL로 보존하고 동일 commandId로 복구한다', async (t) => {
  const f = await fixture(t);
  const active = await grant(f);
  const request = await f.api('visitor', 'commands/request', { householdId: 'household-demo', deviceIds: ['keyring-A', 'keyring-B'], desiredState: { state: true }, reason: '전체 보호', idempotencyKey: 'partial-request' });
  const original = f.runtime.gatewayControl.issue.bind(f.runtime.gatewayControl);
  f.runtime.gatewayControl.issue = (input) => input.deviceId === 'keyring-B' ? Promise.reject(new Error('test delivery fault')) : original(input);
  const input = { requestId: request.body.requestId, grantId: active.grant.grantId, idempotencyKey: 'partial-approve' };
  assert.equal((await f.api('guardian', 'commands/approve', input)).status, 403);
  const partial = f.runtime.store.get('portalCommandRequests', request.body.requestId);
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.commands.length, 1);
  f.runtime.gatewayControl.issue = original;
  const recovered = await f.api('guardian', 'commands/approve', input);
  assert.equal(recovered.body.status, 'QUEUED');
  assert.equal(recovered.body.commands[0].commandId, partial.commands[0].commandId);
  assert.equal(f.runtime.store.list('gatewayCommands').length, 2);
});

test('저장 장애는 동의와 idempotency를 함께 롤백하고 재시작 재전송을 복구한다', async (t) => {
  const f = await fixture(t);
  const initialConsents=f.runtime.store.list('consents').length;const initialReceipts=f.runtime.store.list('receipts').filter((entry)=>entry.type==='CONSENT_CREATED').length;
  const input = { householdId: 'household-demo', purpose: '원자 동의', scopes: ['location:read'], idempotencyKey: 'atomic-consent' };
  const original = f.runtime.store.flush.bind(f.runtime.store);
  f.runtime.store.flush = async () => { throw new Error('test persistence fault'); };
  assert.equal((await f.api('guardian', 'consents', input)).status, 403);
  assert.equal(f.runtime.store.list('consents').length, initialConsents);
  assert.equal(f.runtime.store.list('receipts').filter((entry) => entry.type === 'CONSENT_CREATED').length, initialReceipts);
  f.runtime.store.flush = original;
  const accepted = await f.api('guardian', 'consents', input);
  assert.equal(accepted.status, 200);
  const restored = await createPortalDemo(f.options);
  const repeated = await restored.runtime.api.handle({ method: 'POST', path: '/v1/portal/consents', principal: restored.principals.guardian, body: input });
  assert.deepEqual(repeated.body, accepted.body);
  assert.equal(restored.runtime.store.list('consents').length, initialConsents+1);
});
