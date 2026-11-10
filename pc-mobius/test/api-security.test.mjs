import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';

async function fixture() {
  const runtime = await createIntegrationRuntime({ clock: () => '2026-11-10T00:00:00.000Z' });
  const principal = { principalId: 'guardian', scopes: ['consent:write', 'grant:write', 'policy:approve', 'bubble:command', 'mcp:run'] };
  const peer = { principalId: 'gw-test', scopes: [], mtlsFingerprint: 'gateway-cert' };
  await runtime.gatewayControl.enroll({ gatewayId: 'gw-test', principalId: peer.principalId, fingerprint: peer.mtlsFingerprint, devices: { 'kr-test': 'household-1' }, credentialRevision: '1', ownershipEpoch: 1 });
  const consent = await runtime.policyService.createConsent({ principal, subjectId: 'household-1', purpose: 'test', scopes: ['bubble:command'] });
  const grant = await runtime.policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['bubble:command'] });
  return { runtime, principal, peer, consent, grant };
}

test('Gateway certificates require explicit service scopes before privileged API work', async () => {
  const { runtime, peer } = await fixture();
  const calls = [
    ['POST', '/v1/mec/callback'], ['POST', '/v1/handover'], ['POST', '/v1/fl/rounds'],
    ['POST', '/v1/fl/updates'], ['POST', '/v1/fl/finalize'], ['POST', '/v1/mcp/runs'],
    ['POST', '/v1/mcp/execute'], ['POST', '/v1/mcp/resume'], ['GET', '/v1/mcp/servers']
  ];
  const before = runtime.store.snapshot();
  for (const [method, path] of calls) {
    const response = await runtime.api.handle({ method, path, principal: peer, body: {} });
    assert.equal(response.status, 403, path);
    assert.match(response.body.error, /Scope/, path);
  }
  assert.deepEqual(runtime.store.snapshot(), before);
  assert.throws(() => runtime.policyService.authorize({ principalId: 'text-scopes', scopes: 'consent:write *' }, 'handover:write'));
});

test('MCP execute, resume and replay keep the original run owner', async () => {
  const { runtime, principal } = await fixture();
  const run = await runtime.mcpOrchestrator.startRun({ principal, toolCalls: [{ serverId: 'oneM2M', tool: 'read' }], idempotencyKey: 'private-run' });
  const other = { principalId: 'other-user', scopes: ['mcp:run'] };
  for (const path of ['/v1/mcp/execute', '/v1/mcp/resume']) {
    assert.equal((await runtime.api.handle({ method: 'POST', path, principal: other, body: { runId: run.runId } })).status, 403);
  }
  const replay = await runtime.api.handle({ method: 'POST', path: '/v1/mcp/runs', principal: other, body: { toolCalls: [], idempotencyKey: 'private-run' } });
  assert.equal(replay.status, 403);
  assert.equal(runtime.store.get('mcpRuns', run.runId).cursor, 0);
  runtime.mcpOrchestrator.registerServer({ serverId: 'oneM2M', tools: { read: async () => 'approved-result' } });
  assert.equal((await runtime.api.handle({ method: 'POST', path: '/v1/mcp/execute', principal, body: { runId: run.runId } })).body.status, 'COMPLETED');
});

test('authorization numeric bounds match the Python closed response schema', async () => {
  const { runtime, peer, principal, grant } = await fixture();
  const command = await runtime.gatewayControl.issue({ principal, gatewayId: 'gw-test', deviceId: 'kr-test', commandId: 'issued-1', grantId: grant.grantId, desiredState: { state: true }, deadline: '2026-11-10T00:01:00.000Z' });
  const body = Object.fromEntries(['commandId', 'deviceId', 'claimId', 'grantRevision', 'ownershipEpoch'].map((key) => [key, command[key]]));
  body.payloadHash = approvalHash(command);
  for (const change of [{ grantRevision: 0 }, { ownershipEpoch: -1 }, { grantRevision: 2147483648 }, { ownershipEpoch: 2147483648 }]) {
    assert.equal((await runtime.api.handle({ method: 'POST', path: '/api/v1/gateways/gw-test/authorize', principal: peer, body: { ...body, ...change } })).status, 403);
  }
  await runtime.store.put('handovers', 'kr-test', { ueId: 'kr-test', state: 'DRAINING', epoch: 1 });
  assert.equal((await runtime.gatewayControl.authorize('gw-test', peer, body)).allowed, false);
  assert.deepEqual(runtime.gatewayControl.poll('gw-test', peer).commands, []);
});

test('consent status and policy idempotency stay bound to the current owner and intent', async () => {
  const { runtime, principal, consent, grant } = await fixture();
  const policy = { grantId: grant.grantId, state: true };
  const first = await runtime.policyService.approvePolicy({ principal, policy, idempotencyKey: 'policy-1' });
  assert.equal((await runtime.policyService.approvePolicy({ principal, policy, idempotencyKey: 'policy-1' })).policyId, first.policyId);
  await assert.rejects(runtime.policyService.approvePolicy({ principal, policy: { ...policy, state: false }, idempotencyKey: 'policy-1' }));
  await assert.rejects(runtime.policyService.approvePolicy({ principal: { ...principal, principalId: 'other' }, policy, idempotencyKey: 'policy-1' }));
  await runtime.store.put('consents', consent.consentId, { ...consent, status: 'REVOKED' });
  assert.equal(runtime.policyService.evaluateGrant(grant.grantId).allowed, false);
  for (const ttlSec of [0, -1, '3600', 1.5]) await assert.rejects(runtime.policyService.createConsent({ principal, subjectId: 'household-1', purpose: 'test', scopes: ['bubble:command'], ttlSec }));
});
