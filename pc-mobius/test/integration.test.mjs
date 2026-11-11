import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { MecAdapter, MecCallbackIngress, MecPolicyReconciler } from '../integration/src/mec-adapter.mjs';
import { HandoverCoordinator } from '../integration/src/handover-coordinator.mjs';
import { FlCoordinator } from '../integration/src/fl-coordinator.mjs';
import { enrollLocalClient, buildLocalUpdate } from '../integration/src/fl-client.mjs';
import { McpOrchestrator } from '../integration/src/mcp-orchestrator.mjs';
import { registerMcpSimulation } from '../integration/src/mcp-domain-tools.mjs';
import { IntegrationApiGateway } from '../integration/src/api-gateway.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'privacy-bubble-integration-'));
  const store = await new IntegrationStore(join(dir, 'state.json')).init();
  const policy = new PolicyService({ store });
  const principal = policy.bindPrincipal({ oidcToken: { sub: 'test-user', iss: 'privacy-bubble-oidc', aud: 'privacy-bubble-api', scope: 'consent:write grant:write grant:revoke policy:approve mcp:run' }, mtlsPeer: { verified: true, fingerprint: 'sha256:test', subject: 'test-user' } });
  return { dir, store, policy, principal };
}

test('OIDC/mTLS principal, consent, grant, revoke lifecycle', async () => {
  const { policy, principal } = await fixture();
  const consent = await policy.createConsent({ principal, subjectId: 'household-1', purpose: 'demo', scopes: ['bubble:command'] });
  const grant = await policy.createGrant({ principal, consentId: consent.consentId, scopes: ['bubble:command'] });
  assert.equal(policy.evaluateGrant(grant.grantId, { scope: 'bubble:command', approvalHash: grant.approvalHash }).allowed, true);
  await policy.revokeGrant({ principal, grantId: grant.grantId });
  assert.equal(policy.evaluateGrant(grant.grantId, { scope: 'bubble:command' }).allowed, false);
});

test('MEC Location/RNIS callback dedup and policy reconciliation', async () => {
  const { store, policy, principal } = await fixture();
  const consent = await policy.createConsent({ principal, subjectId: 'household-1', purpose: 'demo', scopes: ['mec:location'] });
  const grant = await policy.createGrant({ principal, consentId: consent.consentId, scopes: ['mec:location'] });
  const handover = new HandoverCoordinator({ store });
  handover.registerEdge({ edgeId: 'edge-a', health: 'HEALTHY', load: 0.5, capabilities: ['Location'] });
  const approved = await policy.approvePolicy({ principal, idempotencyKey: 'mec-fixture', policy: { grantId: grant.grantId, ueId: 'keyring-1', geofence: { type: 'circle', lat: 37.5, lon: 127, radiusM: 100 } } });
  const ingress = new MecCallbackIngress({ store, policyService: policy, locationAdapter: new MecAdapter({ serviceName: 'Location' }), rnisAdapter: new MecAdapter({ serviceName: 'RNIS', queryImpl: async () => ({ simulation: true }) }) });
  const reconciler = new MecPolicyReconciler({ store, policyService: policy, handoverCoordinator: handover });
  ingress.onEvent((event) => reconciler.reconcileApprovedIntent(event));
  const event = { eventId: 'mec-1', simulation: true, service: 'Location', eventType: 'UE_LOCATION_UPDATE', ueId: 'keyring-1', location: { lat: 37.5, lon: 127 }, health: { status: 'HEALTHY' }, intent: { policyId: approved.policyId, grantId: grant.grantId } };
  const first = await ingress.ingest(event);
  const second = await ingress.ingest(event);
  assert.equal(first.status, 'RECONCILED');
  assert.equal(second.status, 'DUPLICATE');
  assert.equal((await ingress.query('RNIS', { ueId: 'keyring-1' })).serviceName, 'RNIS');
});

test('handover epoch, security context, rollback', async () => {
  const { store } = await fixture();
  const handover = new HandoverCoordinator({ store });
  handover.registerEdge({ edgeId: 'edge-a', health: 'HEALTHY', load: 0.8, capabilities: ['RNIS'], securityContext: { keyId: 'a' } });
  handover.registerEdge({ edgeId: 'edge-b', health: 'HEALTHY', load: 0.1, capabilities: ['RNIS'], securityContext: { keyId: 'b' } });
  const active = await handover.handover({ ueId: 'ue-1', targetEdgeId: 'edge-b', subscriptionIds: ['sub-1'] });
  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.epoch, 1);
  assert.equal(active.securityContext.keyId, 'b');
  const rolled = await handover.rollback('ue-1');
  assert.equal(rolled.state, 'ROLLED_BACK');
  assert.equal(rolled.epoch, 2);
});

test('local numeric FL selection, signed updates, artifact fence and recovery', async () => {
  const { store } = await fixture();
  const fl = new FlCoordinator({ store });
  const clients = [await enrollLocalClient(fl, { participantId: 'vm-a', taskId: 'task-1', seed: 101, clientIndex: 0 }), await enrollLocalClient(fl, { participantId: 'vm-b', taskId: 'task-1', seed: 202, clientIndex: 1 })];
  const round = await fl.createRound({ taskId: 'task-1', requiredLabels: ['privacy'], minParticipants: 2 });
  for (const client of clients) await fl.submitUpdate(buildLocalUpdate(fl, client, round));
  const complete = await fl.finalizeRound(round.roundId);
  assert.equal(complete.state, 'COMPLETED');
  assert.equal(fl.serveArtifact(round.roundId, complete.modelHash).artifactHash, complete.modelHash);
  const recovered = await fl.recover(round.roundId);
  assert.equal(recovered.checkpoint.resumed, true);
});

test('MCP multi-server approval hash, checkpoint, resume, persistent run', async () => {
  const { store, policy, principal } = await fixture();
  const mcp = new McpOrchestrator({ store, policyService: policy });
  registerMcpSimulation(mcp);
  const scopes = ['bubble:read', 'mec:location', 'audit:write'];
  const consent = await policy.createConsent({ principal, subjectId: 'household-1', purpose: 'MCP 검토', scopes });
  const grant = await policy.createGrant({ principal, consentId: consent.consentId, scopes });
  const run = await mcp.startRun({ principal, grantId: grant.grantId, toolCalls: [{ serverId: 'oneM2M', tool: 'discoverDevices' }, { serverId: 'MEC', tool: 'reconcileApprovedIntent', input: { eventId: 'test-event' } }, { serverId: 'Audit', tool: 'appendRunEvidence', input: { evidenceHash: 'a'.repeat(64) } }], idempotencyKey: 'run-1' });
  assert.equal(run.status, 'PENDING_APPROVAL');
  await mcp.approveRun({ principal, runId: run.runId, approvalHash: run.approvalHash });
  await mcp.execute(run.runId, { maxSteps: 1 });
  const resumed = await mcp.resume(run.runId);
  assert.equal(resumed.status, 'COMPLETED');
  assert.equal(store.get('mcpRuns', run.runId).outputs.length, 3);
});

test('integration API exposes contract-shaped routes', async () => {
  const { store, policy, principal } = await fixture();
  const handover = new HandoverCoordinator({ store });
  const fl = new FlCoordinator({ store });
  const ingress = new MecCallbackIngress({ store });
  const mcp = new McpOrchestrator({ store, policyService: policy });
  const api = new IntegrationApiGateway({ policyService: policy, mecIngress: ingress, handoverCoordinator: handover, flCoordinator: fl, mcpOrchestrator: mcp });
  const response = await api.handle({ method: 'POST', path: '/v1/auth/bind', principal });
  assert.equal(response.status, 200);
  assert.equal(response.body.principalId, 'test-user');
  const route = await api.handle({ method: 'GET', path: '/v1/mcp/servers', principal });
  assert.equal(route.status, 200);
});

test('fault fixtures cover duplicate, replay, drain, crash and resume paths', async () => {
  const path = fileURLToPath(new URL('../integration/fixtures/fault-fixtures.json', import.meta.url));
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(fixture.cases.map((item) => item.id), ['F-MQTT-DUPLICATE', 'F-MEC-REPLAY', 'F-EDGE-DRAIN', 'F-FL-CRASH', 'F-MCP-RESUME']);
});
