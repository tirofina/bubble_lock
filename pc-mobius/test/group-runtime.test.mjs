import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalDemo } from '../integration/src/portal-demo.mjs';
import { GroupRuntime } from '../integration/src/group-runtime.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';

async function fixture(t) {
  const clock = () => '2026-11-19T10:00:00.000Z';
  const { runtime, principals } = await createPortalDemo({ clock });
  t.after(() => runtime.close());
  const resources = new Map([['/Mobius/groups/switch-A', { 'cod:binSh': {
    rn: 'switch-A', ri: 'static-switch', cnd: 'org.onem2m.common.moduleclass.binarySwitch', state: false,
  } }]]);
  const fanouts = [];
  const hooks = {};
  const options = { store: runtime.store, gatewayControl: runtime.gatewayControl, clock,
    cse: { endpoint: 'http://127.0.0.1:7579', originator: 'Cgroup', parentPath: '/Mobius/groups' },
    members: { 'keyring-A': { deviceId: 'keyring-A', gatewayId: 'pi-01', groupId: 'household-demo', resourcePath: '/Mobius/groups/switch-A' } },
    fetchImpl: async (url, init) => {
      assert.equal(runtime.store.transactionContext.getStore(), undefined, 'CSE effects must follow the approval transaction');
      const path = new URL(url).pathname;
      const body = init.body && JSON.parse(init.body);
      let payload;
      let rsc = 2000;
      let status = 200;
      if (init.method === 'POST') {
        const attributes = Object.values(body)[0];
        const target = `${path}/${attributes.rn}`;
        if (resources.has(target)) { status = 409; rsc = 4105; }
        else {
          payload = { [Object.keys(body)[0]]: { ...attributes, ri: `ri-${resources.size}` } };
          resources.set(target, payload);
          rsc = 2001;
        }
        if (body['cod:binSh']) await hooks.switch?.();
        if (body['m2m:grp']) await hooks.group?.();
      } else if (init.method === 'GET') {
        payload = resources.get(path);
      } else if (init.method === 'PUT' && path.endsWith('/fopt')) {
        const members = resources.get(path.slice(0, -5))['m2m:grp'].mid;
        fanouts.push(members);
        for (const member of members) resources.get(`/${member}`)['cod:binSh'].state = body['cod:binSh'].state;
        payload = { 'm2m:agr': { 'm2m:rsp': members.map((fr) => ({ fr, rsc: 2004 })) } };
        rsc = 2004;
      } else throw new Error(`Unexpected CSE request ${init.method} ${path}`);
      return new Response(JSON.stringify(payload ?? {}), { status,
        headers: { 'X-M2M-RSC': String(rsc), 'X-M2M-RI': init.headers['X-M2M-RI'] } });
    } };
  const start = async () => {
    runtime.groupRuntime = new GroupRuntime(options);
    await runtime.groupRuntime.ready;
    runtime.portalService.groupRuntime = runtime.groupRuntime;
    runtime.api.groupRuntime = runtime.groupRuntime;
  };
  await start();
  // Emulate the enrollment transaction after the runtime has already started.
  const binding = { deviceId: 'keyring-new:button', householdId: 'household-demo', gatewayId: 'pi-01', enrollmentId: 'enrollment-1' };
  await runtime.store.transaction('enrollment', async () => {
    await runtime.store.put('keyringBindings', binding.deviceId, binding);
    await runtime.store.put('portalDevices', binding.deviceId, binding);
    const gateway = runtime.store.get('gateways', binding.gatewayId);
    await runtime.store.put('gateways', binding.gatewayId, { ...gateway, devices: { ...gateway.devices, [binding.deviceId]: binding.householdId } });
  });
  const api = (role, action, body) => runtime.api.handle({ method: 'POST',
    path: `/v1/portal/${action}`, principal: principals[role], body });
  const consent = await api('guardian', 'consents', { householdId: binding.householdId, purpose: 'group', scopes: ['bubble:command'], ttlSec: 900, idempotencyKey: 'consent' });
  const grant = await api('guardian', 'grants', { consentId: consent.body.consentId, scopes: ['bubble:command'], ttlSec: 900, idempotencyKey: 'grant' });
  const request = await api('visitor', 'commands/request', { householdId: binding.householdId,
    deviceIds: ['keyring-A', binding.deviceId], desiredState: { state: true }, reason: 'group', idempotencyKey: 'request' });
  assert.equal(request.status, 200);
  const approval = { requestId: request.body.requestId, grantId: grant.body.grantId, idempotencyKey: 'approve' };
  return { runtime, api, binding, approval, resources, fanouts, hooks,
    restart: async () => { runtime.groupRuntime.close(); await start(); } };
}

test('button-enrolled keyring joins canonical fanout and native receipt reconciliation after restart', async (t) => {
  const f = await fixture(t);
  const approved = await f.api('guardian', 'commands/approve', f.approval);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const switches = [...f.resources.entries()].filter(([, body]) => body['cod:binSh']);
  assert.equal(switches.length, 2);
  assert.deepEqual(switches.map(([, body]) => [body['cod:binSh'].cnd, body['cod:binSh'].state]), [
    ['org.onem2m.common.moduleclass.binarySwitch', true], ['org.onem2m.common.moduleclass.binarySwitch', true],
  ]);
  assert.deepEqual(f.fanouts, [switches.map(([path]) => path.slice(1))]);
  const command = approved.body.commands.find((item) => item.deviceId === f.binding.deviceId);
  const peer = { principalId: 'gateway-demo', mtlsFingerprint: 'DEMO-ONLY-NO-TRANSPORT' };
  assert.deepEqual(f.runtime.gatewayControl.poll('pi-01', peer).commands, approved.body.commands);
  await f.restart();
  const authorization = { commandId: command.commandId, deviceId: command.deviceId, claimId: command.claimId,
    grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, payloadHash: approvalHash(command) };
  await f.runtime.gatewayControl.authorize('pi-01', peer, authorization);
  await f.runtime.gatewayControl.dispatchStart('pi-01', peer, authorization);
  const received = await f.runtime.api.handle({ method: 'POST', path: '/api/v1/gateways/pi-01/receipts', principal: peer,
    body: { version: 1, gatewayId: command.gatewayId, deviceId: command.deviceId, commandId: command.commandId,
      payloadHash: approvalHash(command), status: 'APPLIED', ackCode: 'APPLIED', acceptedAt: command.issuedAt,
      appliedAt: command.issuedAt, receivedAt: command.issuedAt, readback: { state: true }, firmwareRevision: 'sim-v1',
      ownershipEpoch: command.ownershipEpoch, grantRevision: command.grantRevision, timestampSource: 'gateway-estimated',
      detail: null, bootId: 'sim-boot' } });
  assert.equal(received.status, 200, JSON.stringify(received.body));
  const group = await f.api('guardian', 'commands/group', { requestId: f.approval.requestId });
  assert.equal(group.body.appliedCount, 1);
  assert.equal(group.body.members.find((member) => member.deviceId === command.deviceId).status, 'READBACK_VERIFIED');
  assert.equal(f.fanouts.length, 1);
});

for (const invalid of ['missing enrollment', 'wrong household', 'wrong gateway', 'wrong device', 'missing gateway ownership']) {
  test(`dynamic admission rejects ${invalid} before any CSE side effect`, async (t) => {
    const f = await fixture(t);
    const binding = { ...f.binding };
    switch (invalid) {
      case 'missing enrollment': delete binding.enrollmentId; break;
      case 'wrong household': binding.householdId = 'other-home'; break;
      case 'wrong gateway': binding.gatewayId = 'other-gateway'; break;
      case 'wrong device': binding.deviceId = 'other-device'; break;
      case 'missing gateway ownership': {
        const gateway = f.runtime.store.get('gateways', binding.gatewayId);
        await f.runtime.store.put('gateways', binding.gatewayId, { ...gateway, devices: { 'keyring-A': binding.householdId } });
        break;
      }
      default: throw new Error('Unknown invalid binding');
    }
    await f.runtime.store.put('keyringBindings', f.binding.deviceId, binding);
    assert.equal((await f.api('guardian', 'commands/approve', f.approval)).status, 403);
    assert.equal(f.resources.size, 1);
    assert.equal(f.runtime.store.list('gatewayCommands').length, 0);
  });
}

for (const change of ['enrollment', 'gateway ownership', 'grant']) {
  test(`dynamic fanout rechecks ${change} after CSE provisioning`, async (t) => {
    const f = await fixture(t);
    f.hooks.group = async () => {
      if (change === 'enrollment') await f.runtime.store.put('keyringBindings', f.binding.deviceId, { ...f.binding, enrollmentId: 'replacement' });
      else if (change === 'gateway ownership') {
        const gateway = f.runtime.store.get('gateways', f.binding.gatewayId);
        await f.runtime.store.put('gateways', f.binding.gatewayId, { ...gateway, devices: { 'keyring-A': f.binding.householdId } });
      } else await f.api('guardian', 'grants/revoke', { grantId: f.approval.grantId, idempotencyKey: 'revoke' });
    };
    assert.equal((await f.api('guardian', 'commands/approve', f.approval)).status, 200);
    assert.deepEqual(f.fanouts, []);
    const group = await f.api('guardian', 'commands/group', { requestId: f.approval.requestId });
    assert.deepEqual(group.body.members.map((member) => member.status), ['RETRY_PENDING', 'RETRY_PENDING']);
  });
}

test('retry after restart reuses admitted switch without resetting its existing state', async (t) => {
  const f = await fixture(t);
  f.hooks.switch = () => { throw new Error('provisioning interrupted'); };
  await f.api('guardian', 'commands/approve', f.approval);
  assert.deepEqual(f.fanouts, []);
  const dynamic = [...f.resources.values()].find((body) => body['cod:binSh']?.rn !== 'switch-A' && body['cod:binSh']);
  assert.ok(dynamic, 'switch was provisioned before interruption');
  dynamic['cod:binSh'].state = true;
  f.hooks.switch = () => assert.equal(dynamic['cod:binSh'].state, true, 'ensure must not reset a previously created switch');
  await f.restart();
  const retried = await f.api('guardian', 'commands/retry', { requestId: f.approval.requestId });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(f.fanouts.length, 1);
  assert.deepEqual(retried.body.members.map((member) => member.status), ['DISPATCHED', 'DISPATCHED']);
  assert.equal([...f.resources.values()].filter((body) => body['cod:binSh']).length, 2);
});
