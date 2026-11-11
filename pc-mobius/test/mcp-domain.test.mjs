import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createMcpDiscoveryAdapter } from '../integration/src/mcp-discovery.mjs';
import { createMcpDomainHandlers } from '../integration/src/mcp-domain-tools.mjs';
import { createPortalDemo } from '../integration/src/portal-demo.mjs';

test('oneM2M MCP discovery는 실제 HTTP group 응답과 가구별 등록 resource를 대조한다', async (t) => {
  let resultCode = '2000';
  const server = createServer((request, response) => {
    assert.equal(request.headers['x-m2m-origin'], 'Cguardian'); assert.equal(request.headers['x-m2m-rvi'], '4'); assert.equal(request.url, '/Mobius/home-1/devices');
    response.writeHead(200, { 'Content-Type': 'application/json', 'X-M2M-RI': request.headers['x-m2m-ri'], 'X-M2M-RSC': resultCode });
    response.end(JSON.stringify({ 'm2m:grp': { mid: ['/Mobius/relay/keyring-A', '/Mobius/relay/keyring-B'] } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; });
  const discover = createMcpDiscoveryAdapter({ baseUrl: `http://127.0.0.1:${server.address().port}`, allowLoopbackHttp: true, householdGroups: { 'home-1': '/Mobius/home-1/devices' }, bindings: [
    { householdId: 'home-1', deviceId: 'keyring-A', resourcePath: '/Mobius/relay/keyring-A' }, { householdId: 'home-2', deviceId: 'keyring-B', resourcePath: '/Mobius/relay/keyring-B' },
  ] });
  const input = { subjectId: 'home-1', principal: { originator: 'Cguardian' } };
  const result = await discover(input); assert.deepEqual(result.deviceIds, ['keyring-A']); assert.deepEqual(result.resourcePaths, ['/Mobius/relay/keyring-A']);
  await assert.rejects(discover({ ...input, groupId: 'home-2' }), /binding/);
  resultCode = '4103'; await assert.rejects(discover(input), /receipt/);
});

test('MCP applyApprovedPolicy는 기존 canonical Gateway 큐와 소유자 grant에 연결한다', async (t) => {
  const { runtime, principals } = await createPortalDemo(); t.after(() => runtime.close());
  const principal = { ...principals.guardian, scopes: [...principals.guardian.scopes, 'policy:approve'] };
  const consent = await runtime.policyService.createConsent({ principal, subjectId: 'household-demo', purpose: 'MCP 기기 제어', scopes: ['bubble:command'] });
  const grant = await runtime.policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['bubble:command'] });
  const policy = await runtime.policyService.approvePolicy({ principal, policy: { grantId: grant.grantId, ueId: 'keyring-A', desiredState: { state: true } }, idempotencyKey: 'mcp-policy' });
  const handler = createMcpDomainHandlers(runtime).oneM2M.applyApprovedPolicy;
  const context = { principal, principalId: principal.principalId, grantId: grant.grantId, operationKey: 'a'.repeat(64), deadline: new Date(Date.now() + 30000).toISOString() };
  const queued = await handler({ policyId: policy.policyId }, context);
  assert.equal(queued.status, 'QUEUED');
  const command = runtime.store.get('gatewayCommands', queued.executionId).command;
  assert.equal(command.deviceId, 'keyring-A'); assert.ok(command.claimId); assert.equal(command.grantRevision, grant.revision);
  assert.deepEqual(await handler({ policyId: policy.policyId }, context), queued);
  assert.equal(runtime.store.list('gatewayCommands').length, 1);
  await runtime.policyService.revokeGrant({ principal, grantId: grant.grantId });
  await assert.rejects(handler({ policyId: policy.policyId }, context), /grant/);
});
