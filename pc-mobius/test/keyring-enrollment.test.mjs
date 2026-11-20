import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bubble-enrollment-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = '2026-11-19T13:00:00.000Z';
  const options = { statePath: join(dir, 'runtime.json'), clock: () => now };
  const runtime = await createIntegrationRuntime(options);
  const guardian = { principalId: 'guardian-1', scopes: ['portal:read', 'device:write'] };
  const visitor = { principalId: 'visitor-1', scopes: ['portal:read'] };
  const gateway = { principalId: 'gateway-1', mtlsFingerprint: 'gateway-cert', scopes: [] };
  await runtime.portalService.provisionHousehold({ householdId: 'home-1', name: '가족', ownerId: guardian.principalId, members: [{ principalId: visitor.principalId, role: 'visitor' }] });
  await runtime.gatewayControl.enroll({ gatewayId: 'gateway-1', principalId: gateway.principalId, fingerprint: gateway.mtlsFingerprint, credentialRevision: '1', devices: { 'keyring-A': 'home-1' } });
  await runtime.portalService.registerDevice(guardian, { householdId: 'home-1', gatewayId: 'gateway-1', deviceId: 'keyring-A', label: '기존 키링', idempotencyKey: 'seed-A' });
  const api = (principal, method, path, body = {}) => runtime.api.handle({ principal, method, path, body });
  const input = (deviceId = 'keyring-new', extra = {}) => ({ householdId: 'home-1', gatewayId: 'gateway-1', deviceId, label: '새 키링', idempotencyKey: `start-${deviceId}`, ...extra });
  const request = (body = input(), principal = guardian) => api(principal, 'POST', '/v1/portal/keyring-enrollments', body);
  const observation = (buttonState, sequence, extra = {}) => ({ version: 1, gatewayId: 'gateway-1', deviceId: 'keyring-new', bootId: 'boot-new', sequence,
    observedAt: now, receivedAt: now, rssi: -65, battery: 80, buttonState, sensorValues: {}, state: false,
    firmwareRevision: 'test-1', timestampSource: 'gateway-received', ...extra });
  const press = (buttonState, sequence, extra = {}, peer = gateway, id = 'gateway-1') =>
    api(peer, 'POST', `/api/v1/gateways/${id}/telemetry`, observation(buttonState, sequence, extra));
  return { runtime, options, guardian, visitor, gateway, api, input, request, observation, press, setTime: (value) => { now = value; } };
}

test('보호자의 새 키링은 기존 가족 Gateway의 새 버튼 누름 뒤 등록되고 재시작 후에도 유지된다', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api(f.guardian, 'POST', '/v1/portal/devices', { ...f.input(), idempotencyKey: 'direct' })).status, 403);
  const started = await f.request();
  assert.equal(started.status, 200);
  assert.equal(started.body.status, 'PENDING');
  assert.equal((await f.press('released', 1)).body.enrollmentStatus, 'PENDING');
  assert.equal((await f.press('confirm', 2)).body.enrollmentStatus, 'COMPLETED');
  assert.equal(f.runtime.store.get('portalDevices', 'keyring-new').householdId, 'home-1');
  assert.equal(f.runtime.gatewayControl.gateway('gateway-1').devices['keyring-new'], 'home-1');
  assert.equal((await f.press('confirm', 2)).body.status, 'DUPLICATE');
  assert.equal((await f.press('confirm', 2, { rssi: -70 })).status, 403);
  assert.equal(f.runtime.store.list('receipts').filter((item) => item.type === 'KEYRING_BUTTON_ENROLLED').length, 1);
  assert.equal(f.runtime.store.list('portalNotifications').filter((item) => item.title.includes('새 키링')).length, 2);
  const restored = await createIntegrationRuntime(f.options);
  await restored.gatewayControl.enroll({ gatewayId: 'gateway-1', principalId: f.gateway.principalId, fingerprint: f.gateway.mtlsFingerprint, credentialRevision: '1', devices: { 'keyring-A': 'home-1' } });
  assert.equal(restored.gatewayControl.gateway('gateway-1').devices['keyring-new'], 'home-1');
  assert.equal(restored.portalService.snapshot(f.guardian).devices.some((device) => device.deviceId === 'keyring-new'), true);
  await restored.close();
});

test('요청 없는 버튼과 오래된 확인, 다른 수신기 확인은 등록되지 않는다', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.press('confirm', 1)).status, 403);
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.press('confirm', 1)).body.enrollmentStatus, 'PENDING');
  assert.equal(f.runtime.store.get('portalDevices', 'keyring-new'), undefined);
  await f.runtime.gatewayControl.enroll({ gatewayId: 'gateway-2', principalId: 'gateway-2', fingerprint: 'other-cert', credentialRevision: '1', devices: { 'keyring-B': 'home-1' } });
  assert.equal((await f.press('released', 2, { gatewayId: 'gateway-2' }, { principalId: 'gateway-2', mtlsFingerprint: 'other-cert' }, 'gateway-2')).status, 403);
  assert.equal((await f.press('released', 2)).body.status, 'ACCEPTED');
  f.setTime('2026-11-19T13:05:00.000Z');
  assert.equal((await f.press('confirm', 3)).status, 403);
  assert.equal(f.runtime.store.get('keyringBindings', 'keyring-new'), undefined);
});

test('방문자, 타 가족·공용·상실 Gateway 및 이미 소유한 키링을 거절한다', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request(f.input(), f.visitor)).status, 403);
  await f.runtime.portalService.provisionHousehold({ householdId: 'home-2', name: '다른 가족', ownerId: 'guardian-2' });
  await f.runtime.gatewayControl.enroll({ gatewayId: 'gateway-2', principalId: 'gateway-2', fingerprint: 'other-cert', credentialRevision: '1', devices: { 'keyring-B': 'home-2' } });
  assert.equal((await f.request(f.input('keyring-new', { gatewayId: 'gateway-2', idempotencyKey: 'foreign-gateway' }))).status, 403);
  assert.equal((await f.request(f.input('keyring-B', { idempotencyKey: 'foreign-keyring' }))).status, 403);
  assert.equal((await f.request(f.input('keyring-A', { idempotencyKey: 'existing-keyring' }))).status, 403);
  const current = f.runtime.gatewayControl.gateway('gateway-1');
  await f.runtime.store.put('gateways', 'gateway-1', { ...current, devices: { ...current.devices, 'keyring-foreign': 'home-2' } });
  assert.equal((await f.request(f.input())).status, 403);
  for (const status of ['LOST', 'REVOKED']) {
    await f.runtime.store.put('gateways', 'gateway-1', { ...current, status });
    assert.equal((await f.request(f.input())).status, 403);
  }
});

test('대기 중 Gateway 상실·회수와 잘못된 관측은 버튼 소유권을 확정하지 못한다', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.press('released', 1)).status, 200);
  assert.equal((await f.press('confirm', 2, { buttonState: 'invalid' })).status, 403);
  const gateway = f.runtime.gatewayControl.gateway('gateway-1');
  for (const status of ['LOST', 'REVOKED']) {
    await f.runtime.store.put('gateways', 'gateway-1', { ...gateway, status });
    assert.equal((await f.press('confirm', 2)).status, 403);
    assert.equal(f.runtime.store.get('keyringBindings', 'keyring-new'), undefined);
  }
});

test('취소·만료·재전송과 요청 폭주가 대기 등록을 연장하거나 확정하지 못한다', async (t) => {
  const f = await fixture(t);
  const initial = await f.request();
  assert.equal((await f.request()).body.enrollmentId, initial.body.enrollmentId);
  assert.equal((await f.api(f.visitor, 'POST', '/v1/portal/keyring-enrollments/cancel', { enrollmentId: initial.body.enrollmentId, idempotencyKey: 'foreign-cancel' })).status, 403);
  assert.equal((await f.api(f.guardian, 'POST', '/v1/portal/keyring-enrollments/cancel', { enrollmentId: initial.body.enrollmentId, idempotencyKey: 'cancel' })).body.status, 'CANCELLED');
  assert.equal((await f.press('released', 1)).status, 403);
  for (let i = 0; i < 4; i++) assert.equal((await f.request(f.input(`keyring-${i}`))).status, 200);
  assert.equal((await f.request(f.input('keyring-overflow'))).status, 403);
  f.setTime('2026-11-19T13:06:00.000Z');
  assert.equal((await f.request()).body.expiresAt, initial.body.expiresAt);
  assert.equal((await f.press('confirm', 2, { deviceId: 'keyring-0' })).status, 403);
  assert.equal(f.runtime.portalService.snapshot(f.guardian).keyringEnrollments.find((item) => item.deviceId === 'keyring-0').effectiveStatus, 'EXPIRED');
});
