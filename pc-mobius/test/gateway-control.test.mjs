import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';
import { enrollLocalClient } from '../integration/src/fl-client.mjs';

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
const receiptFor = (command, changes = {}) => ({ version: 1, gatewayId: command.gatewayId, deviceId: command.deviceId, commandId: command.commandId, payloadHash: approvalHash(command), status: 'APPLIED', ackCode: 'APPLIED', acceptedAt: command.issuedAt, appliedAt: command.issuedAt, receivedAt: command.issuedAt, readback: { state: true }, firmwareRevision: 'keyring-test', ownershipEpoch: command.ownershipEpoch, grantRevision: command.grantRevision, timestampSource: 'gateway-estimated', detail: null, bootId: 'test-boot', ...changes });

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
  assert.deepEqual(approved.body, { allowed: true, ...binding(command), expiresAt: '2026-11-10T00:00:05.000Z' });
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
  const { runtime, options, grant } = await fixture(t);
  runtime.handoverCoordinator.registerEdge({ edgeId: 'edge-a' });
  await runtime.handoverCoordinator.handover({ ueId: 'kr-test', targetEdgeId: 'edge-a', grantId: grant.grantId });
  await enrollLocalClient(runtime.flCoordinator, { participantId: 'vm-a', taskId: 'task-a', labels: ['test'], seed: 101, clientIndex: 0 });
  await enrollLocalClient(runtime.flCoordinator, { participantId: 'vm-b', taskId: 'task-a', labels: ['test'], seed: 202, clientIndex: 1 });
  await runtime.flCoordinator.createRound({ taskId: 'task-a', requiredLabels: ['test'], minParticipants: 2 });
  const resumed = await createIntegrationRuntime(options);
  resumed.handoverCoordinator.registerEdge({ edgeId: 'edge-b' });
  assert.equal((await resumed.handoverCoordinator.handover({ ueId: 'kr-test', targetEdgeId: 'edge-b', grantId: grant.grantId })).epoch, 3);
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

test('D01/D02 reserved command expires at five seconds before admission', async (t) => {
  const { runtime, peer, input, setTime } = await fixture(t);
  const command = await runtime.gatewayControl.issue(input);
  assert.equal(runtime.store.get('gatewayCommands', command.commandId).executionState, 'RESERVED');
  setTime('2026-11-10T00:00:05.000Z');
  assert.equal((await runtime.gatewayControl.authorize('gw-test', peer, binding(command))).allowed, false);
  const record = runtime.store.get('gatewayCommands', command.commandId);
  assert.equal(record.executionState, 'SETTLED_CANCELLED'); assert.equal(record.settlementReason, 'EXPIRED');
  assert.equal(runtime.store.list('dispatchLanes').length, 0); assert.equal(runtime.store.list('dispatchOutbox').length, 0);
});

test('D05/D07 claim retries preserve deadline and expired admitted lane waits for exact readback', async (t) => {
  const { runtime, peer, input, setTime, options } = await fixture(t);
  const command = await runtime.gatewayControl.issue(input); setTime('2026-11-10T00:00:01.000Z');
  const first = await runtime.gatewayControl.authorize('gw-test', peer, binding(command));
  assert.equal(first.expiresAt, '2026-11-10T00:00:05.000Z');
  const restored = await createIntegrationRuntime({ ...options, clock: () => '2026-11-10T00:00:02.000Z' });
  const retry = await restored.gatewayControl.authorize('gw-test', peer, binding(command)); assert.equal(retry.expiresAt, first.expiresAt);
  assert.equal(restored.store.get('gatewayCommands', command.commandId).claimCommittedAt, '2026-11-10T00:00:01.000Z');
  setTime('2026-11-10T00:00:06.000Z');
  assert.equal((await runtime.gatewayControl.authorize('gw-test', peer, binding(command))).allowed, false);
  assert.equal(runtime.store.get('gatewayCommands', command.commandId).executionState, 'DISPATCH_UNCERTAIN');
  assert.equal(runtime.handoverCoordinator.activeLanes(command.deviceId).length, 1);
  await assert.rejects(runtime.handoverCoordinator.settleDispatch({ ueId: command.deviceId, commandId: command.commandId, claimId: command.claimId, epoch: command.ownershipEpoch, payloadHash: approvalHash(command), readback: { state: false }, ackState: 'READBACK_VERIFIED' }));
  await runtime.handoverCoordinator.settleDispatch({ ueId: command.deviceId, commandId: command.commandId, claimId: command.claimId, epoch: command.ownershipEpoch, payloadHash: approvalHash(command), readback: { state: true }, ackState: 'READBACK_VERIFIED' });
  assert.equal(runtime.store.get('gatewayCommands', command.commandId).executionState, 'APPLIED_VERIFIED');
  assert.equal(runtime.handoverCoordinator.activeLanes(command.deviceId).length, 0);
});

test('authenticated native receipt settles the canonical claim after revocation and deduplicates across restart', async (t) => {
  const { runtime, principal, peer, input, grant, options } = await fixture(t);
  const command = await runtime.gatewayControl.issue(input); const receipt = receiptFor(command);
  await runtime.gatewayControl.authorize('gw-test', peer, binding(command));
  await runtime.policyService.revokeGrant({ principal, grantId: grant.grantId });
  assert.equal((await runtime.gatewayControl.authorize('gw-test', peer, binding(command))).allowed, false);
  await assert.rejects(runtime.gatewayControl.receiveReceipt('gw-test', peer, { ...receipt, readback: { state: false } }), /READBACK/);
  await assert.rejects(runtime.gatewayControl.receiveReceipt('gw-test', peer, { ...receipt, payloadHash: 'f'.repeat(64) }), /BINDING/);
  await assert.rejects(runtime.gatewayControl.receiveReceipt('gw-test', peer, { ...receipt, receivedAt: '2026-11-10T00:01:00Z' }), /TIME/);
  await assert.rejects(runtime.gatewayControl.receiveReceipt('gw-test', { ...peer, mtlsFingerprint: 'other' }, receipt), /certificate/);
  const response = await runtime.api.handle({ method: 'POST', path: '/api/v1/gateways/gw-test/receipts', principal: peer, body: receipt });
  assert.equal(response.status, 200); assert.equal(response.body.executionState, 'APPLIED_VERIFIED');
  assert.equal(runtime.handoverCoordinator.activeLanes(command.deviceId).length, 0);
  assert.equal(runtime.store.get('dispatchOutbox', `${command.commandId}:${command.deviceId}`).state, 'APPLIED_VERIFIED');
  const resumed = await createIntegrationRuntime(options);
  assert.equal((await resumed.gatewayControl.receiveReceipt('gw-test', peer, receipt)).status, 'DUPLICATE');
  assert.equal(resumed.store.list('gatewayDeviceReceipts').length, 1);
  assert.equal(resumed.store.list('receipts').filter((item) => item.type === 'GATEWAY_RECEIPT_SETTLED').length, 1);
  await assert.rejects(resumed.gatewayControl.receiveReceipt('gw-test', peer, { ...receipt, bootId: 'another-boot' }), /CONFLICT/);
});

test('timeout keeps the lane fenced and native rejection or later verified readback settles the exact claim', async (t) => {
  for (const outcome of ['TIMEOUT', 'REJECTED']) {
    const { runtime, peer, input } = await fixture(t);
    const command = await runtime.gatewayControl.issue(input);
    await assert.rejects(runtime.gatewayControl.receiveReceipt('gw-test', peer, receiptFor(command)), /READBACK/);
    await runtime.gatewayControl.authorize('gw-test', peer, binding(command));
    const receipt = receiptFor(command, { status: outcome, ackCode: outcome === 'REJECTED' ? 'EXPIRED' : 'TIMEOUT', acceptedAt: null, appliedAt: null, readback: null, firmwareRevision: null, timestampSource: 'unavailable', bootId: null });
    const result = await runtime.gatewayControl.receiveReceipt('gw-test', peer, receipt);
    assert.equal(result.executionState, outcome === 'REJECTED' ? 'SETTLED_CANCELLED' : 'DISPATCH_UNCERTAIN');
    assert.equal(runtime.handoverCoordinator.activeLanes(command.deviceId).length, outcome === 'REJECTED' ? 0 : 1);
    if (outcome === 'TIMEOUT') {
      await assert.rejects(runtime.gatewayControl.receiveReceipt('gw-test', peer, { ...receipt, status: 'REJECTED', ackCode: 'APPLIED' }), /REJECTION/);
      const resolved = await runtime.gatewayControl.receiveReceipt('gw-test', peer, receiptFor(command, { acceptedAt: null, appliedAt: null, timestampSource: 'unavailable' }));
      assert.equal(resolved.executionState, 'APPLIED_VERIFIED');
      assert.equal(runtime.store.get('gatewayCommands', command.commandId).deviceAppliedAt, null);
      assert.equal(runtime.handoverCoordinator.activeLanes(command.deviceId).length, 0);
    } else await assert.rejects(runtime.gatewayControl.receiveReceipt('gw-test', peer, receiptFor(command)), /CONFLICT/);
  }
});

test('dispatch start rechecks the committed claim and records one durable start timestamp', async (t) => {
  const { runtime, principal, peer, input, grant, setTime, options } = await fixture(t);
  const command = await runtime.gatewayControl.issue(input); const request = binding(command);
  await assert.rejects(runtime.gatewayControl.dispatchStart('gw-test', peer, request), /CLAIM_REQUIRED/);
  assert.equal(runtime.store.get('gatewayCommands', command.commandId).executionState, 'RESERVED');
  await runtime.gatewayControl.authorize('gw-test', peer, request);
  setTime('2026-11-10T00:00:01.000Z');
  assert.equal((await runtime.gatewayControl.dispatchStart('gw-test', peer, request)).allowed, true);
  const resumed = await createIntegrationRuntime({ ...options, clock: () => '2026-11-10T00:00:02.000Z' });
  assert.equal((await resumed.gatewayControl.dispatchStart('gw-test', peer, request)).allowed, true);
  assert.equal(resumed.store.get('gatewayCommands', command.commandId).dispatchStartedAt, '2026-11-10T00:00:01.000Z');
  assert.equal(resumed.store.list('receipts').filter((row) => row.type === 'GATEWAY_DISPATCH_STARTED').length, 1);
  assert.equal(resumed.store.get('dispatchOutbox', `${command.commandId}:${command.deviceId}`).state, 'IN_FLIGHT');
  await runtime.policyService.revokeGrant({ principal, grantId: grant.grantId });
  assert.equal((await runtime.gatewayControl.dispatchStart('gw-test', peer, request)).allowed, false);
  assert.equal(runtime.store.get('gatewayCommands', command.commandId).executionState, 'DISPATCH_UNCERTAIN');
  assert.equal(runtime.handoverCoordinator.activeLanes(command.deviceId).length, 1);
});

test('D09 desired generations fence stale work while late receipts preserve the current lane and latest readback', async (t) => {
  const { runtime, peer, input, options } = await fixture(t);
  const first = await runtime.gatewayControl.issue(input);
  assert.deepEqual(await runtime.gatewayControl.issue(input), first);
  const second = await runtime.gatewayControl.issue({ ...input, commandId: 'second', desiredState: { state: false } });
  assert.equal(runtime.store.get('gatewayCommands', first.commandId).desiredGeneration, 1);
  assert.equal(runtime.store.get('gatewayCommands', second.commandId).desiredGeneration, 2);
  assert.equal((await runtime.gatewayControl.authorize('gw-test', peer, binding(first))).allowed, true);
  assert.equal((await runtime.gatewayControl.authorize('gw-test', peer, binding(second))).allowed, false);
  const firstReceipt = receiptFor(first);
  await runtime.gatewayControl.receiveReceipt('gw-test', peer, firstReceipt);
  assert.equal((await runtime.gatewayControl.authorize('gw-test', peer, binding(second))).allowed, true);
  const resumed = await createIntegrationRuntime(options);
  assert.equal((await resumed.gatewayControl.receiveReceipt('gw-test', peer, firstReceipt)).status, 'DUPLICATE');
  assert.equal(resumed.handoverCoordinator.activeLanes(first.deviceId)[0].desiredGeneration, 2);
  await resumed.gatewayControl.receiveReceipt('gw-test', peer, receiptFor(second, { readback: { state: false } }));
  assert.deepEqual(resumed.store.get('gatewayCommands', second.commandId).readback, { state: false });
  await assert.rejects(resumed.handoverCoordinator.admitDispatch({ ueId: first.deviceId, commandId: 'old-work', claimId: 'old-claim', epoch: first.ownershipEpoch, payloadHash: 'f'.repeat(64), desiredState: { state: true }, desiredGeneration: 1 }), /GENERATION_STALE/);
  assert.equal(resumed.store.get('deviceGenerationFences', first.deviceId).generation, 2);
});
