import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortalDemo } from '../integration/src/portal-demo.mjs';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'group-product-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = '2026-11-12T10:00:00.000Z';
  const options = { statePath: join(dir, 'state.json'), clock: () => now };
  const seed = await createPortalDemo(options);
  await seed.runtime.close();
  const writes = [];
  let denied = true;
  const core = { retention: { autoPrune: false }, group: {
    cse: { endpoint: 'http://127.0.0.1:7579', originator: 'Cgroup', parentPath: '/Mobius/groups' },
    members: Object.fromEntries(['A', 'B', 'C'].map((suffix) => [`keyring-${suffix}`, {
      deviceId: `keyring-${suffix}`, gatewayId: 'pi-01', groupId: 'household-demo', resourcePath: `/Mobius/devices/switch-${suffix}`,
    }])),
  } };
  const groups = new Map();
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const input = init.body && JSON.parse(init.body);
    let payload;
    if (init.method === 'POST') {
      const group = { ...input['m2m:grp'], ri: 'group-ri' };
      groups.set(`${path}/${group.rn}`, group);
      payload = { 'm2m:grp': group };
    } else if (path.endsWith('/fopt')) {
      const members = groups.get(path.slice(0, -5)).mid;
      writes.push({ members, state: input['cod:binSh'].state });
      payload = { 'm2m:agr': { 'm2m:rsp': members.map((fr) => ({ fr, rsc: denied && fr.endsWith('B') ? 4103 : 2004 })) } };
    } else throw new Error(`Unexpected CSE request ${init.method} ${path}`);
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'X-M2M-RSC': init.method === 'POST' ? '2001' : '2004', 'X-M2M-RI': init.headers['X-M2M-RI'] } });
  };
  let runtime = await createIntegrationRuntime({ ...options, core, fetchImpl });
  t.after(() => runtime.close());
  const api = (role, action, body = {}, method = 'POST') => runtime.api.handle({
    method, path: `/v1/portal/${action}`, principal: seed.principals[role], body,
  });
  const consent = await api('guardian', 'consents', { householdId: 'household-demo', purpose: 'group', scopes: ['bubble:command'], ttlSec: 900, idempotencyKey: 'consent' });
  const grant = await api('guardian', 'grants', { consentId: consent.body.consentId, scopes: ['bubble:command'], ttlSec: 900, idempotencyKey: 'grant' });
  const requested = await api('visitor', 'commands/request', { householdId: 'household-demo', deviceIds: ['keyring-A', 'keyring-B'], desiredState: { state: true }, reason: 'group', idempotencyKey: 'request' });
  const approval = { requestId: requested.body.requestId, grantId: grant.body.grantId, idempotencyKey: 'approve' };
  return { api, approval, writes, get runtime() { return runtime; }, allow: () => { denied = false; },
    expire: () => { now = '2026-11-12T10:00:06.000Z'; },
    restart: async () => { await runtime.close(); runtime = await createIntegrationRuntime({ ...options, core, fetchImpl }); },
  };
}

test('portal approval durably fans out only selected canonical members and preserves partial CSE results', async (t) => {
  const f = await fixture(t);
  const approved = await f.api('guardian', 'commands/approve', f.approval);
  assert.equal(approved.status, 200);
  const group = await f.api('guardian', 'commands/group', { requestId: f.approval.requestId });
  assert.equal(group.status, 200);
  assert.deepEqual(group.body.members.map((member) => [member.deviceId, member.status]), [
    ['keyring-A', 'DISPATCHED'], ['keyring-B', 'RETRY_PENDING'],
  ]);
  assert.deepEqual(f.writes, [{ members: ['Mobius/devices/switch-A', 'Mobius/devices/switch-B'], state: true }]);
  assert.equal(group.body.appliedCount, 0, 'CSE update is not a physical device ACK');
  const peer = { principalId: 'gateway-demo', mtlsFingerprint: 'DEMO-ONLY-NO-TRANSPORT' };
  assert.deepEqual(f.runtime.gatewayControl.poll('pi-01', peer).commands.map((command) => command.deviceId), ['keyring-A']);
  await f.api('guardian', 'commands/approve', f.approval);
  assert.equal(f.writes.length, 1, 'approval replay does not resend');
});

test('restart retries failed CSE member with original claim while keeping published member untouched', async (t) => {
  const f = await fixture(t);
  const approved = (await f.api('guardian', 'commands/approve', f.approval)).body;
  const withheld = approved.commands[1];
  const peer = { principalId: 'gateway-demo', mtlsFingerprint: 'DEMO-ONLY-NO-TRANSPORT' };
  const authorization = { commandId: withheld.commandId, deviceId: withheld.deviceId, claimId: withheld.claimId,
    grantRevision: withheld.grantRevision, ownershipEpoch: withheld.ownershipEpoch, payloadHash: approvalHash(withheld) };
  assert.equal((await f.runtime.gatewayControl.authorize('pi-01', peer, authorization)).allowed, false);
  await f.restart();
  f.allow();
  const retried = await f.api('guardian', 'commands/retry', { requestId: f.approval.requestId });
  assert.equal(retried.status, 200);
  assert.deepEqual(f.writes.map((write) => write.members), [
    ['Mobius/devices/switch-A', 'Mobius/devices/switch-B'], ['Mobius/devices/switch-B'],
  ]);
  assert.deepEqual(f.runtime.gatewayControl.poll('pi-01', peer).commands, approved.commands);
});

test('expired claim prevents retry publication and unrelated household cannot inspect group', async (t) => {
  const f = await fixture(t);
  await f.api('guardian', 'commands/approve', f.approval);
  f.expire(); f.allow();
  await f.api('guardian', 'commands/retry', { requestId: f.approval.requestId });
  assert.equal(f.writes.length, 1);
  const denied = await f.runtime.api.handle({ method: 'POST', path: '/v1/portal/commands/group',
    principal: { principalId: 'outsider', scopes: ['portal:read'] }, body: { requestId: f.approval.requestId } });
  assert.equal(denied.status, 403);
});

test('only a validated native receipt settles group readback and survives restart', async (t) => {
  const f = await fixture(t);
  const approved = (await f.api('guardian', 'commands/approve', f.approval)).body;
  const command = approved.commands[0];
  const peer = { principalId: 'gateway-demo', mtlsFingerprint: 'DEMO-ONLY-NO-TRANSPORT' };
  const binding = { commandId: command.commandId, deviceId: command.deviceId, claimId: command.claimId,
    grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, payloadHash: approvalHash(command) };
  await f.runtime.gatewayControl.authorize('pi-01', peer, binding);
  await f.runtime.gatewayControl.dispatchStart('pi-01', peer, binding);
  const receipt = { version: 1, gatewayId: command.gatewayId, deviceId: command.deviceId, commandId: command.commandId,
    payloadHash: approvalHash(command), status: 'APPLIED', ackCode: 'APPLIED', acceptedAt: command.issuedAt, appliedAt: command.issuedAt,
    receivedAt: command.issuedAt, readback: { state: true }, firmwareRevision: 'sim-v1', ownershipEpoch: command.ownershipEpoch,
    grantRevision: command.grantRevision, timestampSource: 'gateway-estimated', detail: null, bootId: 'sim-boot' };
  const receive = (body) => f.runtime.api.handle({ method: 'POST', path: '/api/v1/gateways/pi-01/receipts', principal: peer, body });
  assert.equal((await receive({ ...receipt, readback: { state: false } })).status, 403);
  assert.equal((await f.api('guardian', 'commands/group', { requestId: f.approval.requestId })).body.appliedCount, 0);
  assert.equal((await receive(receipt)).status, 200);
  await f.restart();
  const group = (await f.api('guardian', 'commands/group', { requestId: f.approval.requestId })).body;
  assert.equal(group.appliedCount, 1);
  assert.equal(group.members[0].status, 'READBACK_VERIFIED');
  assert.equal((await receive(receipt)).body.status, 'DUPLICATE');
});

test('failed durable approval never publishes a CSE side effect', async (t) => {
  const f = await fixture(t);
  const flush = f.runtime.store.flush.bind(f.runtime.store);
  f.runtime.store.flush = async () => { throw new Error('disk fault'); };
  assert.equal((await f.api('guardian', 'commands/approve', f.approval)).status, 403);
  f.runtime.store.flush = flush;
  assert.deepEqual(f.writes, []);
  assert.equal(f.runtime.store.list('gatewayCommands').length, 0);
  assert.equal(f.runtime.store.list('groupCommands').length, 0);
  assert.equal((await f.api('guardian', 'commands/approve', f.approval)).status, 200);
});

test('partial approval keeps already issued members out of Gateway polling until CSE publication', async (t) => {
  const f = await fixture(t);
  const issue = f.runtime.gatewayControl.issue.bind(f.runtime.gatewayControl);
  f.runtime.gatewayControl.issue = async (input) => {
    if (input.deviceId === 'keyring-B') throw new Error('second member unavailable');
    return issue(input);
  };
  assert.equal((await f.api('guardian', 'commands/approve', f.approval)).status, 403);
  const peer = { principalId: 'gateway-demo', mtlsFingerprint: 'DEMO-ONLY-NO-TRANSPORT' };
  assert.deepEqual(f.runtime.gatewayControl.poll('pi-01', peer).commands, []);
  f.runtime.gatewayControl.issue = issue;
  assert.equal((await f.api('guardian', 'commands/approve', f.approval)).status, 200);
  assert.deepEqual(f.runtime.gatewayControl.poll('pi-01', peer).commands.map((command) => command.deviceId), ['keyring-A']);
});

test('revoked grant blocks failed member retry and concurrent approval replay sends once', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([f.api('guardian', 'commands/approve', f.approval), f.api('guardian', 'commands/approve', f.approval)]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(f.writes.length, 1);
  await f.api('guardian', 'grants/revoke', { grantId: f.approval.grantId, idempotencyKey: 'revoke' });
  f.allow();
  await f.api('guardian', 'commands/retry', { requestId: f.approval.requestId });
  assert.equal(f.writes.length, 1);
});
