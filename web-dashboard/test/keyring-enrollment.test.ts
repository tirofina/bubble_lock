import assert from 'node:assert/strict';
import test from 'node:test';

test('operator keyring enrollment gates the guardian connection and keeps existing bindings', async () => {
  const moduleUrl = new URL('../../pc-mobius/integration/src/portal-demo.mjs', import.meta.url).href;
  const { createPortalDemo } = await import(moduleUrl);
  const { runtime, principals } = await createPortalDemo();
  const call = (role: string, method: string, path: string, body?: Record<string, unknown>) =>
    runtime.api.handle({ method, path: `/v1/portal/${path}`, principal: principals[role], ...(body ? { body } : {}) });

  // Before enrollment the guardian cannot connect an unknown keyring.
  const early = await call('guardian', 'POST', 'devices', { householdId: 'household-demo', deviceId: 'keyring-D', gatewayId: 'pi-01', label: 'Bag keyring', idempotencyKey: 'connect-early' });
  assert.notEqual(early.status, 200);

  // Only the operator scope device:enroll may read or change enrollments.
  assert.notEqual((await call('guardian', 'GET', 'enrollments')).status, 200);
  assert.notEqual((await call('guardian', 'POST', 'devices/enroll', { gatewayId: 'pi-01', householdId: 'household-demo', deviceId: 'keyring-D', idempotencyKey: 'guardian-enroll' })).status, 200);

  const enrolled = await call('operator', 'POST', 'devices/enroll', { gatewayId: 'pi-01', householdId: 'household-demo', deviceId: 'keyring-D', idempotencyKey: 'enroll-d' });
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  assert.equal(runtime.gatewayControl.gateway('pi-01').devices['keyring-D'], 'household-demo');
  // Same idempotency key and intent returns the same result.
  const repeated = await call('operator', 'POST', 'devices/enroll', { gatewayId: 'pi-01', householdId: 'household-demo', deviceId: 'keyring-D', idempotencyKey: 'enroll-d' });
  assert.deepEqual(repeated.body, enrolled.body);

  const view = await call('operator', 'GET', 'enrollments');
  assert.equal(view.status, 200);
  const entry = view.body.gateways.find((gateway: { gatewayId: string }) => gateway.gatewayId === 'pi-01').devices.find((device: { deviceId: string }) => device.deviceId === 'keyring-D');
  assert.deepEqual(entry, { deviceId: 'keyring-D', householdId: 'household-demo', connected: false, label: null });

  // The guardian is notified and can now connect it.
  const notices = runtime.portalService.snapshot(principals.guardian).notifications.filter((item: { type: string }) => item.type === 'DEVICE_ENROLLED');
  assert.equal(notices.length, 1);
  const connected = await call('guardian', 'POST', 'devices', { householdId: 'household-demo', deviceId: 'keyring-D', gatewayId: 'pi-01', label: 'Bag keyring', idempotencyKey: 'connect-late' });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));

  // An existing binding never moves to another household through enrollment, and unknown or inactive receivers fail.
  await runtime.portalService.provisionHousehold({ householdId: 'household-other', name: 'Other', ownerId: 'guardian-other' });
  assert.notEqual((await call('operator', 'POST', 'devices/enroll', { gatewayId: 'pi-01', householdId: 'household-other', deviceId: 'keyring-A', idempotencyKey: 'move-a' })).status, 200);
  assert.equal(runtime.gatewayControl.gateway('pi-01').devices['keyring-A'], 'household-demo');
  assert.notEqual((await call('operator', 'POST', 'devices/enroll', { gatewayId: 'pi-99', householdId: 'household-demo', deviceId: 'keyring-E', idempotencyKey: 'unknown-gw' })).status, 200);
  assert.notEqual((await call('operator', 'POST', 'devices/enroll', { gatewayId: 'pi-01', householdId: 'household-missing', deviceId: 'keyring-E', idempotencyKey: 'no-home' })).status, 200);
});
