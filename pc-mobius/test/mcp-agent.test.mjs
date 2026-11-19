import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { McpAgentWorkflow } from '../integration/src/mcp-orchestrator.mjs';
import { MCP_AGENT_CONTRACT } from '../integration/src/mcp-schema.mjs';
import { OneM2mEdgeClient } from '../integration/src/handover-cse.mjs';
import { MecAdapter } from '../integration/src/mec-http-client.mjs';
import { agentMcpConfig, agentToolNames, createAgentToolHandlers, createMecAgentAdapter, createOneM2mAgentAdapter, issueAgentTokens, provisionAgentHousehold, startAgentMcpServers, toOneM2mTime } from '../integration/src/mcp-agent-tools.mjs';
import { createFixtureMecAdapter, createFixtureOneM2mAdapter, startMecLocationSimulator } from '../integration/src/mcp-agent-fixtures.mjs';

const task = { householdId: 'household-h1', deviceId: 'keyring-x', visitorId: 'visitor-v1', incidentId: 'incident-i42', durationMinutes: 30, resource: 'location', operations: ['RETRIEVE'],
  incidentArea: { type: 'circle', lat: 37.5665, lon: 126.978, radiusM: 300 } };
const guardianScopes = ['mcp:run', 'policy:approve', 'consent:write', 'grant:write', 'grant:revoke'];

async function runtime(t, { statePath = null, oneM2M = null, mec = null } = {}) {
  const directory = statePath ? null : await mkdtemp(join(tmpdir(), 'bubble-mcp-agent-'));
  if (directory) t.after(() => rm(directory, { recursive: true, force: true }));
  let now = '2026-11-19T09:00:00.000Z'; const clock = () => now;
  const path = statePath ?? join(directory, 'agent-state.json');
  const store = await new IntegrationStore(path).init();
  const policyService = new PolicyService({ store, clock });
  const workflow = new McpAgentWorkflow({ store, policyService, clock });
  const guardian = { principalId: 'guardian-g1', scopes: guardianScopes };
  const adapters = { oneM2M: oneM2M ?? createFixtureOneM2mAdapter({ householdId: task.householdId, devices: [{ deviceId: 'keyring-x', ueAddress: '192.0.2.10' }, { deviceId: 'keyring-y', ueAddress: '192.0.2.11' }], visitors: { 'visitor-v1': 'Cvisitor-v1' }, clock }),
    mec: mec ?? createFixtureMecAdapter({ users: { '192.0.2.10': { lat: 37.5667, lon: 126.9781, zoneId: 'zone-home' } }, clock }) };
  const handlers = createAgentToolHandlers({ workflow, ...adapters });
  return { path, store, policyService, workflow, guardian, handlers, adapters, clock, setTime: (value) => { now = value; } };
}

async function newRun(f) {
  const consent = await f.policyService.createConsent({ principal: f.guardian, subjectId: task.householdId, purpose: 'visitor location access agent', scopes: McpAgentWorkflow.scopes, ttlSec: 7200 });
  const grant = await f.policyService.createGrant({ principal: f.guardian, consentId: consent.consentId, scopes: McpAgentWorkflow.scopes, ttlSec: 3600 });
  const run = await f.workflow.createRun({ guardian: f.guardian, task, grantId: grant.grantId, agentPrincipalId: 'agent-claude', idempotencyKey: 'visit-incident-i42' });
  return { grant, run, agent: { principalId: 'agent-claude', runId: run.runId } };
}

const serverOf = Object.fromEntries(Object.entries(MCP_AGENT_CONTRACT.servers).flatMap(([serverId, definition]) => definition.tools.map((tool) => [tool.name, { serverId, audience: definition.audience, tool }])));
/** Direct handler call with the same session-bound context and single transaction that the MCP server uses. */
async function call(f, agent, name, input) {
  const { serverId, audience, tool } = serverOf[name];
  const context = f.workflow.agentContext({ principal: agent, serverId, audience, tool: { name, requiredScope: tool.requiredScope, readOnly: tool.readOnly === true }, input });
  return f.store.transaction(`mcp-tool:${context.operationKey}`, () => f.handlers[serverId][name](input, { ...context, store: f.store, principal: agent }));
}
const draftInput = { deviceId: 'keyring-x', visitorId: 'visitor-v1', incidentId: 'incident-i42', resource: 'location', operations: ['RETRIEVE'], durationMinutes: 30 };

test('R17 agent workflow routes tools in order and keeps the approval gate on the server', async (t) => {
  const f = await runtime(t); const { run, agent } = await newRun(f);
  await assert.rejects(call(f, agent, 'draftPolicy', draftInput), (error) => error.reason === 'ROUTE_ORDER');
  await assert.rejects(call(f, agent, 'discoverDevices', { householdId: 'household-other' }), (error) => error.reason === 'HOUSEHOLD_BINDING');
  const discovered = await call(f, agent, 'discoverDevices', { householdId: task.householdId });
  assert.deepEqual(discovered.devices.map((device) => device.deviceId), ['keyring-x', 'keyring-y']);
  assert.equal(discovered.discovery.ty, 28); assert.equal('ueAddress' in discovered.devices[0], false);
  const grant = await call(f, agent, 'readGrant', { deviceId: 'keyring-x' });
  assert.equal(grant.revision, run.grantRevision); assert.deepEqual(grant.visitorGrants, []);
  const broad = await call(f, agent, 'draftPolicy', { ...draftInput, resource: 'bubble', operations: ['RETRIEVE', 'UPDATE'], durationMinutes: 120 });
  assert.equal(broad.leastPrivilege.withinTask, false); assert.equal(broad.acop, 6); assert.equal(broad.leastPrivilege.findings.length, 3);
  const request = await call(f, agent, 'requestGuardianApproval', { draftId: broad.draftId, draftHash: broad.draftHash });
  assert.equal(request.status, 'PENDING_GUARDIAN');
  await assert.rejects(call(f, agent, 'applyApprovedPolicy', { draftId: broad.draftId, approvalHash: 'a'.repeat(64) }), (error) => error.reason === 'APPROVAL_PENDING');
  await assert.rejects(f.workflow.guardianDecide({ guardian: { principalId: 'agent-claude', scopes: ['bubble:command'] }, runId: run.runId, approvalRequestId: request.approvalRequestId, reviewedDraftHash: broad.draftHash }), /policy:approve/);
  await assert.rejects(f.workflow.guardianDecide({ guardian: f.guardian, runId: run.runId, approvalRequestId: request.approvalRequestId, reviewedDraftHash: 'b'.repeat(64) }), /exact pending draft/);
  const rejected = await f.workflow.guardianDecide({ guardian: f.guardian, runId: run.runId, approvalRequestId: request.approvalRequestId, reviewedDraftHash: broad.draftHash, decision: 'REJECT', reason: 'least privilege: location RETRIEVE for 30 minutes' });
  await assert.rejects(call(f, agent, 'applyApprovedPolicy', { draftId: broad.draftId, approvalHash: rejected.approvalHash }), (error) => error.reason === 'APPROVAL_REJECTED');
  const narrow = await call(f, agent, 'draftPolicy', draftInput);
  assert.equal(narrow.leastPrivilege.withinTask, true); assert.equal(narrow.acop, 2);
  assert.equal(f.workflow.executionView(f.workflow.getRun(run.runId)).nextStep, 'requestGuardianApproval');
  await assert.rejects(call(f, agent, 'applyApprovedPolicy', { draftId: broad.draftId, approvalHash: rejected.approvalHash }), (error) => error.reason === 'ROUTE_ORDER');
  const second = await call(f, agent, 'requestGuardianApproval', { draftId: narrow.draftId, draftHash: narrow.draftHash });
  const approved = await f.workflow.guardianDecide({ guardian: f.guardian, runId: run.runId, approvalRequestId: second.approvalRequestId, reviewedDraftHash: narrow.draftHash });
  assert.equal(f.workflow.executionView(f.workflow.getRun(run.runId)).approval.approvalHash, approved.approvalHash);
  await assert.rejects(call(f, agent, 'applyApprovedPolicy', { draftId: narrow.draftId, approvalHash: approved.approvalHash.replace(/^./, (c) => (c === 'f' ? 'e' : 'f')) }), (error) => error.reason === 'APPROVAL_HASH_MISMATCH');
  await assert.rejects(call(f, agent, 'applyApprovedPolicy', { draftId: broad.draftId, approvalHash: approved.approvalHash }), (error) => error.reason === 'APPROVAL_REJECTED');
  const applied = await call(f, agent, 'applyApprovedPolicy', { draftId: narrow.draftId, approvalHash: approved.approvalHash });
  assert.equal(applied.status, 'APPLIED'); assert.equal(applied.notAfter, '2026-11-19T09:30:00.000Z');
  const acp = [...f.adapters.oneM2M.acps.values()][0];
  assert.deepEqual(acp.pv.acr, [{ acor: ['Cvisitor-v1'], acop: 2 }]);
  const record = f.adapters.oneM2M.records.get(applied.grantRecordPath);
  assert.equal(record.approvalHash, approved.approvalHash); assert.equal(record.grantRevision, run.grantRevision); assert.equal(record.deadline, applied.notAfter); assert.match(record.payloadHash, /^[a-f0-9]{64}$/);
  await assert.rejects(call(f, agent, 'reconcileApprovedIntent', { deviceId: 'keyring-y', incidentId: 'incident-i42' }), (error) => error.reason === 'MEC_INTENT_BINDING');
  const reconciled = await call(f, agent, 'reconcileApprovedIntent', { deviceId: 'keyring-x', incidentId: 'incident-i42' });
  assert.equal(reconciled.status, 'RECONCILED'); assert.equal(reconciled.insideIncidentArea, true); assert.equal(reconciled.simulation, true);
  const evidence = await call(f, agent, 'appendRunEvidence', { runId: run.runId, summary: 'visitor location access applied for 30 minutes' });
  assert.equal(evidence.status, 'COMPLETED');
  const final = f.workflow.getRun(run.runId);
  assert.equal(final.status, 'COMPLETED'); assert.equal(final.checkpoints.length, 9);
  assert.deepEqual(final.approvalChecks.map((entry) => entry.result), ['ACCEPTED']);
  await assert.rejects(call(f, agent, 'draftPolicy', draftInput), (error) => error.reason === 'RUN_COMPLETED');
});

test('R17 agent run resumes from the persisted checkpoint in a new runtime', async (t) => {
  const first = await runtime(t); const { run, agent } = await newRun(first);
  await first.workflow.beginInvocation(run.runId, { agent: 'scripted', mode: 'start' });
  await call(first, agent, 'discoverDevices', { householdId: task.householdId });
  await call(first, agent, 'readGrant', { deviceId: 'keyring-x' });
  const draft = await call(first, agent, 'draftPolicy', draftInput);
  const request = await call(first, agent, 'requestGuardianApproval', { draftId: draft.draftId, draftHash: draft.draftHash });
  await first.workflow.recordInterruption(run.runId, { method: 'process tree kill', lastEvent: 'requestGuardianApproval' });
  await first.store.close();
  const second = await runtime(t, { statePath: first.path });
  const invocation = await second.workflow.beginInvocation(run.runId, { agent: 'scripted', mode: 'resume' });
  assert.deepEqual(invocation.resumedFrom, { invocation: 1, cursor: 4, completedSteps: ['discoverDevices', 'readGrant', 'draftPolicy', 'requestGuardianApproval'], nextStep: 'applyApprovedPolicy' });
  const view = await call(second, agent, 'readExecution', { runId: run.runId });
  assert.equal(view.nextStep, 'applyApprovedPolicy'); assert.equal(view.waitingFor, 'GUARDIAN_APPROVAL'); assert.equal(view.resumedFrom.cursor, 4);
  await assert.rejects(call(second, agent, 'requestGuardianApproval', { draftId: draft.draftId, draftHash: 'c'.repeat(64) }), (error) => error.reason === 'STEP_COMPLETED');
  await assert.rejects(call(second, agent, 'draftPolicy', draftInput), (error) => error.reason === 'STEP_COMPLETED');
  const approved = await second.workflow.guardianDecide({ guardian: second.guardian, runId: run.runId, approvalRequestId: request.approvalRequestId, reviewedDraftHash: draft.draftHash });
  await call(second, agent, 'applyApprovedPolicy', { draftId: draft.draftId, approvalHash: approved.approvalHash });
  await call(second, agent, 'reconcileApprovedIntent', { deviceId: 'keyring-x', incidentId: 'incident-i42' });
  await call(second, agent, 'appendRunEvidence', { runId: run.runId, summary: 'resumed after interruption' });
  const final = second.workflow.getRun(run.runId);
  assert.equal(final.status, 'COMPLETED');
  assert.deepEqual(final.checkpoints.map((entry) => entry.invocation), [1, 1, 1, 1, 2, 2, 2]);
  assert.equal(final.invocations[0].cursorAtInterruption, 4);
  await second.policyService.revokeGrant({ principal: second.guardian, grantId: run.grantId });
  await assert.rejects(call(second, agent, 'readExecution', { runId: run.runId }), (error) => error.reason === 'GRANT_CURRENT');
});

async function rpcSession(endpoint, token) {
  let sessionId = null; let id = 0; let version = null;
  const post = async (message) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'MCP-Session-Id': sessionId } : {}), ...(version ? { 'MCP-Protocol-Version': version } : {}) }, body: JSON.stringify(message) });
    if (message.method === 'initialize') sessionId = response.headers.get('mcp-session-id');
    return { status: response.status, body: response.status === 202 ? null : await response.json() };
  };
  const init = await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-wire-test', version: '1' } } });
  version = init.body.result.protocolVersion;
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  return {
    post, list: async () => (await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list' })).body.result.tools,
    call: async (name, args, extra = {}) => (await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args, ...extra } })).body.result,
  };
}

test('R17 agent MCP servers bind context to the session token over real HTTP without client _meta', async (t) => {
  const f = await runtime(t); const { run, agent } = await newRun(f);
  const { tokens, byServer } = issueAgentTokens({ runId: run.runId, agentPrincipalId: agent.principalId });
  const committed = [];
  const servers = await startAgentMcpServers({ store: f.store, workflow: f.workflow, handlers: f.handlers, tokens, onCommitted: (entry) => committed.push(entry) });
  t.after(() => servers.close());
  const config = agentMcpConfig({ endpoints: servers.endpoints, byServer });
  assert.deepEqual(Object.keys(config.mcpServers), ['onem2m', 'mec', 'audit']);
  assert.equal(agentToolNames().length, 8);
  assert.equal((await fetch(servers.endpoints.Audit, { method: 'POST', headers: { Authorization: `Bearer ${byServer.oneM2M}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })).status, 401);
  const onem2m = await rpcSession(servers.endpoints.oneM2M, byServer.oneM2M); const mec = await rpcSession(servers.endpoints.MEC, byServer.MEC); const audit = await rpcSession(servers.endpoints.Audit, byServer.Audit);
  assert.deepEqual((await onem2m.list()).map((tool) => tool.name), ['discoverDevices', 'readGrant', 'draftPolicy', 'requestGuardianApproval', 'applyApprovedPolicy']);
  assert.equal((await mec.list()).length, 1); assert.equal((await audit.list()).length, 2);
  assert.equal((await onem2m.post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).status, 202);
  const forged = { _meta: { 'privacy-bubble': { runId: 'agent-run-other', operationKey: 'f'.repeat(64), approvalHash: 'f'.repeat(64), principalId: 'someone', audience: 'x', grantId: 'g', grantRevision: 9, deadline: '2099-01-01T00:00:00.000Z' } } };
  const discovered = await onem2m.call('discoverDevices', { householdId: task.householdId }, forged);
  assert.equal(discovered.isError, false); assert.equal(discovered.structuredContent.devices.length, 2);
  assert.match((await onem2m.call('draftPolicy', { ...draftInput, extra: true })).content[0].text, /schema review required: \/ must NOT have additional properties/);
  assert.match((await onem2m.call('draftPolicy', draftInput)).content[0].text, /^ROUTE_ORDER/);
  await onem2m.call('readGrant', { deviceId: 'keyring-x' });
  const draft = (await onem2m.call('draftPolicy', draftInput)).structuredContent;
  const replay = await onem2m.call('draftPolicy', draftInput);
  assert.equal(replay.structuredContent.draftId, draft.draftId); assert.equal(committed.at(-1).replayed, true);
  const request = (await onem2m.call('requestGuardianApproval', { draftId: draft.draftId, draftHash: draft.draftHash })).structuredContent;
  const approved = await f.workflow.guardianDecide({ guardian: f.guardian, runId: run.runId, approvalRequestId: request.approvalRequestId, reviewedDraftHash: draft.draftHash });
  const mismatch = await onem2m.call('applyApprovedPolicy', { draftId: draft.draftId, approvalHash: draft.draftHash });
  assert.equal(mismatch.isError, true); assert.match(mismatch.content[0].text, /^APPROVAL_HASH_MISMATCH/);
  assert.deepEqual(f.workflow.getRun(run.runId).approvalChecks.map((entry) => [entry.result, entry.reason]), [['REJECTED', 'APPROVAL_HASH_MISMATCH']]);
  assert.equal(f.workflow.getRun(run.runId).steps.applyApprovedPolicy, undefined);
  assert.equal((await audit.call('readExecution', { runId: run.runId })).structuredContent.approval.approvalHash, approved.approvalHash);
  assert.equal((await onem2m.call('applyApprovedPolicy', { draftId: draft.draftId, approvalHash: approved.approvalHash })).structuredContent.status, 'APPLIED');
  assert.equal((await mec.call('reconcileApprovedIntent', { deviceId: 'keyring-x', incidentId: 'incident-i42' })).structuredContent.status, 'RECONCILED');
  assert.equal((await audit.call('appendRunEvidence', { runId: run.runId, summary: 'wire test' })).structuredContent.status, 'COMPLETED');
  const final = f.workflow.getRun(run.runId);
  assert.deepEqual(final.approvalChecks.map((entry) => entry.result), ['REJECTED', 'ACCEPTED']);
  assert.equal(f.store.list('mcpToolOperations').filter((entry) => entry.output?.status === 'APPLIED').length, 1);
  await f.policyService.revokeGrant({ principal: f.guardian, grantId: run.grantId });
  assert.match((await audit.call('readExecution', { runId: run.runId })).content[0].text, /^GRANT_CURRENT/);
});

/** Minimal in-memory oneM2M HTTP CSE for adapter tests: create, retrieve, update, la and fu=1 discovery. */
async function fakeCse(t) {
  const resources = new Map(); const requests = []; let counter = 0;
  const tags = { 1: 'm2m:acp', 2: 'm2m:ae', 3: 'm2m:cnt', 4: 'm2m:cin' };
  resources.set('/Mobius', { ty: 5, tag: 'm2m:cb', attrs: { ri: 'cb', rn: 'Mobius', csi: '/fake-in' } });
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://cse'); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), origin: request.headers['x-m2m-origin'], body });
    const reply = (status, rsc, value) => { response.writeHead(status, { 'content-type': 'application/json', 'X-M2M-RSC': String(rsc), 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end(value ? JSON.stringify(value) : ''); };
    const path = url.pathname;
    if (request.method === 'GET' && url.searchParams.get('fu') === '1') {
      const ty = Number(url.searchParams.get('ty')); const cnd = url.searchParams.get('cnd');
      const uril = [...resources.entries()].filter(([key, value]) => key.startsWith(`${path}/`) && value.ty === ty && (!cnd || value.attrs.cnd === cnd)).map(([key]) => key.slice(1));
      return reply(200, 2000, { 'm2m:uril': uril });
    }
    if (request.method === 'GET' && path.endsWith('/la')) {
      const parent = path.slice(0, -3); const latest = [...resources.entries()].filter(([key, value]) => key.startsWith(`${parent}/`) && value.ty === 4).at(-1);
      return latest ? reply(200, 2000, { 'm2m:cin': latest[1].attrs }) : reply(404, 4004, { 'm2m:dbg': 'missing' });
    }
    const current = resources.get(path);
    if (request.method === 'GET') return current ? reply(200, 2000, { [current.tag]: current.attrs }) : reply(404, 4004, { 'm2m:dbg': 'missing' });
    if (request.method === 'PUT') { if (!current) return reply(404, 4004); Object.assign(current.attrs, Object.values(body)[0]); return reply(200, 2004, { [current.tag]: current.attrs }); }
    if (request.method === 'POST') {
      if (!current) return reply(404, 4004);
      const ty = Number(/ty=(\d+)/.exec(request.headers['content-type'])?.[1]); const tag = Object.keys(body)[0]; const attrs = { ...body[tag] };
      attrs.rn ??= `cin-${++counter}`; const child = `${path}/${attrs.rn}`;
      if (resources.has(child)) return reply(409, 4105, { 'm2m:dbg': 'conflict' });
      attrs.ri = `ri-${++counter}`; attrs.pi = current.attrs.ri; if (ty === 2) attrs.aei = `C${attrs.rn}`;
      resources.set(child, { ty, tag: tags[ty] ?? tag, attrs }); return reply(201, 2001, { [tags[ty] ?? tag]: attrs });
    }
    reply(405, 4000);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, resources, requests };
}

test('R17 real agent adapters use the oneM2M HTTP binding and the MEC Location client', async (t) => {
  const cse = await fakeCse(t);
  const client = new OneM2mEdgeClient({ endpoint: cse.endpoint, cseBase: '/Mobius', originator: 'CAdmin' });
  const layout = await provisionAgentHousehold({ client, tag: 'unit', householdId: task.householdId, devices: [{ deviceId: 'keyring-x', ueAddress: '192.0.2.10' }, { deviceId: 'keyring-y', ueAddress: '192.0.2.11', sdtState: false }], visitors: ['visitor-v1'] });
  assert.equal(layout.visitors['visitor-v1'], 'Cpb-visitor-v1-unit');
  const simulator = await startMecLocationSimulator({ users: { '192.0.2.10': { lat: 37.56671, lon: 126.97812, zoneId: 'zone-home' } } });
  t.after(() => simulator.close());
  const mecClient = new MecAdapter({ serviceName: 'Location', platformRoot: simulator.url, simulation: true, timeoutMs: 1000 });
  const f = await runtime(t, { oneM2M: createOneM2mAgentAdapter({ client, layout }), mec: createMecAgentAdapter({ adapter: mecClient }) });
  const { run, agent } = await newRun(f);
  const discovered = await call(f, agent, 'discoverDevices', { householdId: task.householdId });
  const discovery = cse.requests.find((entry) => entry.query.fu === '1');
  assert.deepEqual(discovery.query, { fu: '1', ty: '28', cnd: 'org.onem2m.common.moduleclass.binarySwitch' });
  assert.deepEqual(discovered.devices.map((device) => [device.deviceId, device.sdtState]), [['keyring-x', true], ['keyring-y', false]]);
  await call(f, agent, 'readGrant', { deviceId: 'keyring-x' });
  const draft = await call(f, agent, 'draftPolicy', draftInput);
  const request = await call(f, agent, 'requestGuardianApproval', { draftId: draft.draftId, draftHash: draft.draftHash });
  assert.equal(cse.resources.get(request.requestRecordPath).attrs.con.draftHash, draft.draftHash);
  assert.equal(cse.resources.get(request.requestRecordPath).attrs.con.policy.visitorOriginator, undefined);
  const approved = await f.workflow.guardianDecide({ guardian: f.guardian, runId: run.runId, approvalRequestId: request.approvalRequestId, reviewedDraftHash: draft.draftHash });
  const applied = await call(f, agent, 'applyApprovedPolicy', { draftId: draft.draftId, approvalHash: approved.approvalHash });
  const acp = cse.resources.get(applied.acpPath).attrs;
  assert.deepEqual(acp.pv.acr, [{ acor: ['Cpb-visitor-v1-unit'], acop: 2 }]); assert.equal(acp.et, toOneM2mTime(applied.notAfter)); assert.equal(acp.et, '20261119T093000');
  assert.deepEqual(cse.resources.get(layout.devices[0].locationPath).attrs.acpi, [layout.baseAcpRi, applied.acpRi]);
  const grantRecord = cse.resources.get(applied.grantRecordPath).attrs.con;
  assert.equal(grantRecord.payloadHash, applied.payloadHash); assert.equal(grantRecord.grantRevision, run.grantRevision); assert.equal(grantRecord.approvalHash, approved.approvalHash);
  assert.deepEqual((await call(f, agent, 'readGrant', { deviceId: 'keyring-x' })).visitorGrants, [{ visitorId: 'visitor-v1', notAfter: applied.notAfter, acop: 2 }]);
  const reconciled = await call(f, agent, 'reconcileApprovedIntent', { deviceId: 'keyring-x', incidentId: 'incident-i42' });
  assert.equal(reconciled.serviceInstanceId, 'mec-location-sim-1'); assert.equal(reconciled.zoneId, 'zone-home'); assert.equal(reconciled.simulation, true);
  assert.deepEqual(simulator.requests.map((entry) => entry.path), ['/mec_service_mgmt/v1/services', '/location/v2/queries/users']);
  const sample = cse.resources.get(reconciled.locationRecordPath).attrs.con;
  assert.equal(sample.lat, 37.567); assert.equal(sample.lon, 126.978); assert.match(sample.payloadHash, /^[a-f0-9]{64}$/);
  const evidence = await call(f, agent, 'appendRunEvidence', { runId: run.runId, summary: 'adapter test' });
  assert.equal(cse.resources.get(evidence.evidenceRecordPath).attrs.con.evidenceHash, evidence.evidenceHash);
  assert.ok(cse.requests.filter((entry) => entry.method !== 'GET').every((entry) => entry.origin === 'CAdmin' || entry.origin === 'C'));
});
