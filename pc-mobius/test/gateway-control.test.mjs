import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bubble-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = '2026-11-10T00:00:00.000Z';
  const options = { statePath: join(dir, 'state.json'), receiptPath: join(dir, 'receipts.jsonl'), clock: () => now };
  const runtime = await createIntegrationRuntime(options);
  const principal = { principalId: 'guardian', scopes: ['consent:write', 'grant:write', 'grant:revoke', 'bubble:command'], mtlsFingerprint: 'guardian-cert' };
  const peer = { principalId: 'gw-test', scopes: [], mtlsFingerprint: 'gateway-cert' };
  const enrollment = { gatewayId: 'gw-test', principalId: peer.principalId, fingerprint: peer.mtlsFingerprint, devices: { 'kr-test': 'household-1' }, credentialRevision: '1', ownershipEpoch: 1 };
  await runtime.gatewayControl.enroll(enrollment);
  const consent = await runtime.policyService.createConsent({ principal, subjectId: 'household-1', purpose: 'test', scopes: ['bubble:command'] });
  const grant = await runtime.policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['bubble:command'] });
  const input = { principal, gatewayId: 'gw-test', deviceId: 'kr-test', commandId: 'command-1', grantId: grant.grantId, desiredState: { state: true }, deadline: '2026-11-10T00:01:00.000Z' };
  return { runtime, principal, peer, enrollment, grant, input, options, setTime: (value) => { now = value; } };
}

const binding = (command) => Object.fromEntries(['commandId', 'deviceId', 'claimId', 'grantRevision', 'ownershipEpoch'].map((key) => [key, command[key]]).concat([['payloadHash', approvalHash(command)]]));

test('central command survives restart and binds Gateway poll/authorize to exact payload', async (t) => {
  const { runtime, peer, input, options } = await fixture(t);
  const [command, retry] = await Promise.all([runtime.gatewayControl.issue(input), runtime.gatewayControl.issue(input)]);
  assert.deepEqual(command, retry);
  assert.equal(command.claimId.startsWith('claim-'), true);
  const resumed = await createIntegrationRuntime(options);
  const path = '/api/v1/gateways/gw-test';
  const credentials = await resumed.api.handle({ method: 'GET', path: path + '/credentials/status', principal: peer });
  assert.deepEqual(credentials.body, { gatewayId: 'gw-test', credentialRevision: '1', status: 'ACTIVE' });
  const polled = await resumed.api.handle({ method: 'GET', path: path + '/commands?limit=16', principal: peer });
  assert.deepEqual(polled.body.commands, [command]);
  const approved = await resumed.api.handle({ method: 'POST', path: path + '/authorize', principal: peer, body: binding(command) });
  assert.deepEqual(approved.body, { allowed: true, ...binding(command), expiresAt: command.deadline });
  const altered = await resumed.gatewayControl.authorize('gw-test', peer, { ...binding(command), payloadHash: '0'.repeat(64) });
  assert.equal(altered.allowed, false);
});

test('revocation, epoch change, credential rotation and expiry fence Gateway execution', async (t) => {
  for (const change of ['revoke', 'epoch', 'credential', 'expiry']) {
    const { runtime, principal, peer, enrollment, grant, input, setTime } = await fixture(t);
    const command = await runtime.gatewayControl.issue(input);
    if (change === 'revoke') await runtime.policyService.revokeGrant({ principal, grantId: grant.grantId });
    if (change === 'epoch') await runtime.gatewayControl.enroll({ ...enrollment, ownershipEpoch: 2 });
    if (change === 'credential') await runtime.gatewayControl.enroll({ ...enrollment, credentialRevision: '2' });
    if (change === 'expiry') setTime('2026-11-10T00:02:00.000Z');
    assert.equal((await runtime.gatewayControl.authorize('gw-test', peer, binding(command))).allowed, false, change);
    assert.deepEqual(runtime.gatewayControl.poll('gw-test', peer).commands, [], change);
  }
});

test('transport principal, scopes, ownership and subject remain authoritative', async (t) => {
  const { runtime, principal, peer, input } = await fixture(t);
  await assert.rejects(runtime.gatewayControl.issue({ ...input, principal: { ...principal, scopes: [] } }));
  await assert.rejects(runtime.gatewayControl.issue({ ...input, deviceId: 'other-device' }));
  await assert.rejects(runtime.gatewayControl.issue({ ...input, principal: { ...principal, principalId: 'other-user' } }));
  assert.throws(() => runtime.gatewayControl.poll('gw-test', { ...peer, mtlsFingerprint: 'other-cert' }));
  const forged = await runtime.api.handle({ method: 'POST', path: '/v1/consents', body: { principal, subjectId: 'household-1', purpose: 'test', scopes: ['bubble:command'] } });
  assert.equal(forged.status, 403);
  const override = await runtime.api.handle({ method: 'POST', path: '/v1/consents', principal: { principalId: 'other', scopes: [] }, body: { principal, subjectId: 'household-1', purpose: 'test', scopes: ['bubble:command'] } });
  assert.equal(override.status, 403);
});

test('all service receipts share one journal and handover epochs survive restart', async (t) => {
  const { runtime, options } = await fixture(t);
  runtime.handoverCoordinator.registerEdge({ edgeId: 'edge-a' });
  await runtime.handoverCoordinator.handover({ ueId: 'kr-test', targetEdgeId: 'edge-a' });
  runtime.flCoordinator.registerVm({ vmId: 'vm-a', labels: ['test'], capacity: 1, attested: true });
  await runtime.flCoordinator.createRound({ taskId: 'task-a', requiredLabels: ['test'], minParticipants: 1, consentRevision: 1 });
  const resumed = await createIntegrationRuntime(options);
  resumed.handoverCoordinator.registerEdge({ edgeId: 'edge-b' });
  assert.equal((await resumed.handoverCoordinator.handover({ ueId: 'kr-test', targetEdgeId: 'edge-b' })).epoch, 3);
  const rolled = await resumed.handoverCoordinator.rollback('kr-test');
  assert.equal(rolled.epoch, 4);
  assert.equal(rolled.securityContext.epoch, 4);
  assert.equal(resumed.store.get('handovers', 'kr-test').type, 'HANDOVER_ROLLBACK');
  const rows = (await readFile(options.receiptPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter((r) => r.type === 'CONSENT_CREATED').length, 1);
  assert.equal(rows.filter((r) => r.type === 'HANDOVER_ACTIVE').length, 2);
  assert.equal(rows.some((r) => r.type?.startsWith('FL_')), true);
  assert.equal(rows.every((r) => /^[a-f0-9]{64}$/.test(r.receiptHash)), true);
});

test('bounded polling eventually delivers every active command while preserving retries', async (t) => {
  const { runtime, peer, input } = await fixture(t);
  for (let i = 0; i < 18; i += 1) await runtime.gatewayControl.issue({ ...input, commandId: `queued-${i}` });
  const first = runtime.gatewayControl.poll('gw-test', peer).commands;
  const second = runtime.gatewayControl.poll('gw-test', peer).commands;
  assert.equal(first.length, 16);
  assert.equal(second.length, 16);
  assert.equal(new Set([...first, ...second].map((command) => command.commandId)).size, 18);
});
