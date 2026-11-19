import { randomBytes } from 'node:crypto';
import { approvalHash } from './integration-utils.mjs';
import { MCP_AGENT_CONTRACT, toolReview } from './mcp-schema.mjs';
import { McpAgentWorkflow, agentAcop } from './mcp-orchestrator.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { pointInGeofence } from './mec-state.mjs';
import { BINARY_SWITCH_CND, encodeBinarySwitch } from '../../src/sdt-adapter.mjs';

const attributes = (payload) => Object.values(payload ?? {})[0] ?? {};
const labelValue = (labels, prefix) => (Array.isArray(labels) ? labels : []).find((entry) => typeof entry === 'string' && entry.startsWith(prefix))?.slice(prefix.length) ?? null;
const RESOURCE_TAG = { location: 'm2m:cnt', grants: 'm2m:cnt', bubble: 'cod:binSh' };
export const toOneM2mTime = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').slice(0, 15);
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Findings compare the draft with the guardian task; the guardian step approves only drafts without findings. */
export function leastPrivilegeFindings(policy, task) {
  const findings = [];
  for (const field of ['deviceId', 'visitorId', 'incidentId']) if (policy[field] !== task[field]) findings.push(`${field} ${policy[field]} differs from task ${task[field]}`);
  if (policy.resource !== task.resource) findings.push(`resource ${policy.resource} is broader than task resource ${task.resource}`);
  const extra = policy.operations.filter((operation) => !task.operations.includes(operation));
  if (extra.length) findings.push(`operations ${extra.join(',')} exceed task operations ${task.operations.join(',')}`);
  if (policy.durationMinutes > task.durationMinutes) findings.push(`duration ${policy.durationMinutes} min exceeds task ${task.durationMinutes} min`);
  return findings.slice(0, 8);
}

/** Domain handlers for the LLM agent profile; every mutating handler routes through the persistent workflow. */
export function createAgentToolHandlers({ workflow, oneM2M, mec, clock = workflow.clock }) {
  if (!(workflow instanceof McpAgentWorkflow) || !oneM2M || !mec) throw new Error('MCP agent workflow, oneM2M and MEC adapters required');
  const now = () => clock();
  return {
    oneM2M: {
      async discoverDevices(input, context) {
        const { run } = workflow.current(context.runId, { scope: 'bubble:read' }); workflow.route(run, 'discoverDevices');
        if (input.householdId !== run.task.householdId) throw toolReview('HOUSEHOLD_BINDING', `Run is bound to household ${run.task.householdId}`);
        const found = await oneM2M.discoverDevices({ householdId: input.householdId });
        const output = { householdId: input.householdId, discovery: found.discovery, devices: found.devices.map(({ deviceId, resourcePath, sdtPath, sdtState }) => ({ deviceId, resourcePath, sdtPath, sdtState })), observedAt: found.observedAt };
        await workflow.checkpoint(context, 'discoverDevices', { input, output, update: (state) => { state.devices = Object.fromEntries(found.devices.map((device) => [device.deviceId, device])); } });
        return output;
      },
      async readGrant(input, context) {
        const { run, grant } = workflow.current(context.runId, { scope: 'bubble:read' }); workflow.route(run, 'readGrant');
        const device = workflow.discoveredDevice(run, input.deviceId);
        const access = await oneM2M.readDeviceAccess(device);
        const output = { grantId: grant.grantId, revision: grant.revision, status: grant.status, scopes: grant.scopes, expiresAt: grant.expiresAt, deviceId: device.deviceId, locationAcpi: access.locationAcpi, visitorGrants: access.visitorGrants };
        await workflow.checkpoint(context, 'readGrant', { input, output });
        return output;
      },
      async draftPolicy(input, context) {
        const { run } = workflow.current(context.runId, { scope: 'bubble:command' }); workflow.route(run, 'draftPolicy');
        const device = workflow.discoveredDevice(run, input.deviceId);
        const operations = [...input.operations].sort();
        const policy = { runId: run.runId, householdId: run.task.householdId, deviceId: device.deviceId, visitorId: input.visitorId, visitorOriginator: oneM2M.visitorOriginator(input.visitorId), incidentId: input.incidentId,
          resource: input.resource, resourcePath: device.paths[input.resource], operations, acop: agentAcop(operations), durationMinutes: input.durationMinutes, grantId: run.grantId, grantRevision: run.grantRevision };
        const findings = leastPrivilegeFindings(policy, run.task); const draftHash = approvalHash(policy); const draftId = `draft-${context.operationKey.slice(0, 16)}`;
        const output = { draftId, draftHash, acop: policy.acop, resourcePath: policy.resourcePath, durationMinutes: policy.durationMinutes, leastPrivilege: { withinTask: findings.length === 0, findings }, status: 'DRAFT' };
        await workflow.checkpoint(context, 'draftPolicy', { input, output, update: (state) => {
          for (const draft of Object.values(state.drafts)) draft.superseded = true;
          state.drafts[draftId] = { draftId, draftHash, policy, findings, createdAt: now(), invocation: context.invocation, superseded: false };
          delete state.steps.requestGuardianApproval;
        } });
        return output;
      },
      async requestGuardianApproval(input, context) {
        const { run } = workflow.current(context.runId, { scope: 'bubble:command' }); workflow.route(run, 'requestGuardianApproval');
        const draft = run.drafts[input.draftId];
        if (!draft || draft.superseded) throw toolReview('DRAFT_REQUIRED', 'Current draftId returned by draftPolicy required');
        if (input.draftHash !== draft.draftHash) throw toolReview('DRAFT_HASH_MISMATCH', 'draftHash must equal the stored draft hash');
        const approvalRequestId = `approval-${context.operationKey.slice(0, 16)}`;
        const { visitorOriginator, ...policy } = draft.policy;
        const record = await oneM2M.publishApprovalRequest({ approvalRequestId, runId: run.runId, draftId: draft.draftId, draftHash: draft.draftHash, policy, findings: draft.findings });
        const output = { approvalRequestId, draftHash: draft.draftHash, status: 'PENDING_GUARDIAN', requestRecordPath: record.path };
        await workflow.checkpoint(context, 'requestGuardianApproval', { input, output, update: (state) => {
          state.approvals[approvalRequestId] = { approvalRequestId, draftId: draft.draftId, draftHash: draft.draftHash, status: 'PENDING_GUARDIAN', sequence: Object.keys(state.approvals).length + 1, requestedAt: now(), requestRecordPath: record.path, invocation: context.invocation };
        } });
        return output;
      },
      async applyApprovedPolicy(input, context) {
        const { run, grant } = workflow.current(context.runId, { scope: 'bubble:command' }); workflow.route(run, 'applyApprovedPolicy');
        const { draft, approval } = workflow.verifyApproval(run, input.draftId, input.approvalHash);
        const device = workflow.discoveredDevice(run, draft.policy.deviceId);
        const notAfter = new Date(Math.min(Date.parse(approval.decidedAt) + draft.policy.durationMinutes * 60000, Date.parse(grant.expiresAt))).toISOString();
        if (Date.parse(notAfter) <= Date.parse(now())) throw toolReview('ACCESS_WINDOW_EXPIRED', 'Approved access window has already ended');
        const applied = await oneM2M.applyVisitorAccess({ device, policy: draft.policy, draftHash: draft.draftHash, approval: { approvalRequestId: approval.approvalRequestId, approvalHash: approval.approvalHash }, notAfter });
        const output = { status: 'APPLIED', acpPath: applied.acpPath, acpRi: applied.acpRi, grantRecordPath: applied.grantRecordPath, notAfter, grantRevision: run.grantRevision, payloadHash: applied.payloadHash };
        await workflow.checkpoint(context, 'applyApprovedPolicy', { input, output, update: (state) => {
          state.approvals[approval.approvalRequestId].consumedAt = now();
          state.approvalChecks.push({ result: 'ACCEPTED', reason: 'APPROVAL_HASH_MATCH', draftId: draft.draftId, presentedHashPrefix: input.approvalHash.slice(0, 12), invocation: context.invocation, at: now() });
          state.applied = { ...output, deviceId: device.deviceId, visitorId: draft.policy.visitorId, visitorOriginator: draft.policy.visitorOriginator, resourcePath: draft.policy.resourcePath, approvalHash: approval.approvalHash, draftHash: draft.draftHash, acpi: applied.acpi };
        } });
        return output;
      },
    },
    MEC: {
      async reconcileApprovedIntent(input, context) {
        const { run } = workflow.current(context.runId, { scope: 'mec:location' }); workflow.route(run, 'reconcileApprovedIntent');
        if (!run.applied || input.deviceId !== run.applied.deviceId || input.incidentId !== run.task.incidentId) throw toolReview('MEC_INTENT_BINDING', 'Applied device and task incident required');
        const device = workflow.discoveredDevice(run, input.deviceId);
        const located = await mec.locate({ ueAddress: device.ueAddress });
        const inside = run.task.incidentArea ? pointInGeofence(located.point, run.task.incidentArea) : true;
        const sample = { type: 'MEC_LOCATION_SAMPLE', runId: run.runId, deviceId: device.deviceId, incidentId: run.task.incidentId, zoneId: located.zoneId, lat: round(located.point.lat), lon: round(located.point.lon),
          accuracyM: located.accuracyM, observedAt: located.observedAt, source: located.source, serviceInstanceId: located.serviceInstanceId, simulation: located.simulation, grantRevision: run.grantRevision, notAfter: run.applied.notAfter };
        const record = await oneM2M.publishLocation(device, sample);
        const output = { status: inside ? 'RECONCILED' : 'REVIEW', serviceInstanceId: located.serviceInstanceId, zoneId: located.zoneId, insideIncidentArea: inside, locationRecordPath: record.path, observedAt: located.observedAt, simulation: located.simulation };
        await workflow.checkpoint(context, 'reconcileApprovedIntent', { input, output, update: (state) => { state.reconciled = { ...output, payloadHash: record.payloadHash }; } });
        return output;
      },
    },
    Audit: {
      async readExecution(input, context) {
        const { run } = workflow.current(context.runId, { scope: 'audit:read' });
        if (input.runId !== run.runId) throw toolReview('RUN_BINDING', 'Agent session is bound to a different runId');
        return workflow.executionView(run);
      },
      async appendRunEvidence(input, context) {
        const { run } = workflow.current(context.runId, { scope: 'audit:write' }); workflow.route(run, 'appendRunEvidence');
        if (input.runId !== run.runId) throw toolReview('RUN_BINDING', 'Agent session is bound to a different runId');
        const evidence = { runId: run.runId, taskHash: run.taskHash, grantId: run.grantId, grantRevision: run.grantRevision,
          steps: McpAgentWorkflow.steps.slice(0, -1).map((step) => ({ step, operationKey: run.steps[step].operationKey, outputHash: run.steps[step].outputHash, invocation: run.steps[step].invocation })),
          approvalHash: run.applied.approvalHash, draftHash: run.applied.draftHash, acpRi: run.applied.acpRi, grantRecordPath: run.applied.grantRecordPath, grantPayloadHash: run.applied.payloadHash, locationRecordPath: run.reconciled.locationRecordPath };
        const evidenceHash = approvalHash(evidence); const evidenceId = `evidence-${context.operationKey.slice(0, 16)}`;
        const record = await oneM2M.publishEvidence({ evidenceId, evidence, evidenceHash, summary: input.summary });
        const output = { evidenceId, evidenceHash, evidenceRecordPath: record.path, recordedAt: now(), status: 'COMPLETED' };
        await workflow.checkpoint(context, 'appendRunEvidence', { input, output, update: (state) => { state.evidence = { ...output, summaryHash: approvalHash(input.summary) }; } });
        await workflow.receipt(run, 'AGENT_RUN_EVIDENCE', { evidenceId, evidenceHash, evidenceRecordPath: record.path });
        return output;
      },
    },
  };
}

/** Real oneM2M adapter: discovery, ACP and contentInstance writes go to the CSE through the HTTP binding. */
export function createOneM2mAgentAdapter({ client, layout, clock = () => new Date().toISOString() }) {
  if (!client || !layout?.householdPath || !layout.approvalsPath || !layout.auditPath || !layout.guardianOriginator) throw new Error('oneM2M client and provisioned household layout required');
  const strip = (uri) => `/${String(uri).replace(/^\/+/, '')}`;
  const discoverChildren = async (parent, ty) => {
    const response = await client.request('GET', parent, undefined, undefined, { fu: 1, ty });
    return response.missing ? [] : (response.payload?.['m2m:uril'] ?? []).map(strip).filter((path) => path.startsWith(`${parent}/`)).slice(0, 64);
  };
  return {
    simulation: false,
    transport: 'oneM2M HTTP binding RVI 4',
    async discoverDevices({ householdId }) {
      if (householdId !== layout.householdId) throw toolReview('HOUSEHOLD_BINDING', `Adapter is bound to household ${layout.householdId}`);
      const response = await client.discover(layout.householdPath, { ty: 28, cnd: BINARY_SWITCH_CND });
      if (response.rsc !== 2000) throw toolReview('CSE_DISCOVERY', `oneM2M discovery returned ${response.rsc}`);
      const uris = response.payload?.['m2m:uril'] ?? [];
      if (!Array.isArray(uris) || uris.length > 64) throw toolReview('CSE_DISCOVERY', 'Bounded oneM2M discovery result required');
      const devices = [];
      for (const sdtPath of uris.map(strip)) {
        if (!sdtPath.startsWith(`${layout.householdPath}/`)) continue;
        const sdt = attributes(await client.read(sdtPath)); const resourcePath = sdtPath.slice(0, sdtPath.lastIndexOf('/'));
        const container = attributes(await client.read(resourcePath)); const deviceId = labelValue(container.lbl, 'pb-device:');
        if (!deviceId) continue;
        devices.push({ deviceId, resourcePath, sdtPath, sdtState: sdt.state === true, sdtRi: sdt.ri ?? null, ueAddress: labelValue(container.lbl, 'pb-ue:'),
          paths: { location: `${resourcePath}/location`, bubble: sdtPath, grants: `${resourcePath}/grants` } });
      }
      return { discovery: { fu: 1, ty: 28, cnd: BINARY_SWITCH_CND, rsc: response.rsc, matched: uris.length }, devices, observedAt: clock(), requestId: response.rqi };
    },
    async readDeviceAccess(device) {
      const location = attributes(await client.read(device.paths.location));
      const visitorGrants = [];
      for (const path of await discoverChildren(device.paths.grants, 4)) {
        const record = attributes(await client.read(path)).con;
        if (record?.type === 'VISITOR_GRANT' && visitorGrants.length < 16) visitorGrants.push({ visitorId: record.visitorId, notAfter: record.notAfter, acop: record.acop });
      }
      return { locationAcpi: location.acpi ?? [], visitorGrants };
    },
    visitorOriginator(visitorId) {
      const originator = layout.visitors?.[visitorId];
      if (!originator) throw toolReview('VISITOR_REGISTRY', `Visitor ${visitorId} is not registered for household ${layout.householdId}`);
      return originator;
    },
    async publishApprovalRequest({ approvalRequestId, runId, draftId, draftHash, policy, findings }) {
      const con = { type: 'APPROVAL_REQUEST', approvalRequestId, runId, draftId, draftHash, policy, findings };
      const payloadHash = approvalHash(con);
      const result = await client.ensure(layout.approvalsPath, 4, { 'm2m:cin': { rn: approvalRequestId, cnf: 'application/json', con: { ...con, payloadHash } } }, { immutable: true });
      return { path: result.path, ri: result.ri, payloadHash };
    },
    async applyVisitorAccess({ device, policy, draftHash, approval, notAfter }) {
      const tag = approval.approvalHash.slice(0, 16);
      const acp = await client.ensure(layout.householdPath, 1, { 'm2m:acp': { rn: `visit-${tag}`, et: toOneM2mTime(notAfter), lbl: [`pb-incident:${policy.incidentId}`, `pb-approval:${tag}`, `pb-visitor:${policy.visitorId}`],
        pv: { acr: [{ acor: [policy.visitorOriginator], acop: policy.acop }] }, pvs: { acr: [{ acor: [client.originator, layout.guardianOriginator], acop: 63 }] } } }, { update: false });
      const target = attributes(await client.read(policy.resourcePath));
      const acpi = [...new Set([...(target.acpi ?? []), acp.ri])];
      if (acpi.length !== (target.acpi ?? []).length) await client.request('PUT', policy.resourcePath, { [RESOURCE_TAG[policy.resource]]: { acpi } });
      const con = { type: 'VISITOR_GRANT', runId: policy.runId, grantId: policy.grantId, grantRevision: policy.grantRevision, deviceId: device.deviceId, visitorId: policy.visitorId, visitorOriginator: policy.visitorOriginator,
        incidentId: policy.incidentId, resource: policy.resource, resourcePath: policy.resourcePath, operations: policy.operations, acop: policy.acop, notAfter, deadline: notAfter, draftHash,
        approvalRequestId: approval.approvalRequestId, approvalHash: approval.approvalHash, acpRi: acp.ri, acpPath: acp.path };
      const payloadHash = approvalHash(con);
      const grantRecord = await client.ensure(device.paths.grants, 4, { 'm2m:cin': { rn: `grant-${tag}`, cnf: 'application/json', con: { ...con, payloadHash } } }, { immutable: true });
      return { acpPath: acp.path, acpRi: acp.ri, grantRecordPath: grantRecord.path, payloadHash, acpi };
    },
    async publishLocation(device, sample) {
      const payloadHash = approvalHash(sample);
      const created = await client.request('POST', device.paths.location, { 'm2m:cin': { cnf: 'application/json', con: { ...sample, payloadHash } } }, 4);
      const rn = attributes(created.payload).rn;
      if (!rn) throw toolReview('CSE_WRITE', 'oneM2M location contentInstance receipt required');
      return { path: `${device.paths.location}/${rn}`, payloadHash };
    },
    async publishEvidence({ evidenceId, evidence, evidenceHash, summary }) {
      const result = await client.ensure(layout.auditPath, 4, { 'm2m:cin': { rn: evidenceId, cnf: 'application/json', con: { type: 'MCP_AGENT_EVIDENCE', evidenceId, evidenceHash, evidence, summary } } }, { update: false });
      return { path: result.path, ri: result.ri };
    },
  };
}

/** Real MEC adapter: ETSI MEC 013 Location discovery and user query through the project MecAdapter HTTP client. */
export function createMecAgentAdapter({ adapter }) {
  if (!adapter || adapter.serviceName !== 'Location') throw new Error('MEC Location adapter required');
  let discovery = null;
  return {
    simulation: adapter.simulation === true,
    async locate({ ueAddress }) {
      if (!ueAddress) throw toolReview('MEC_UE_BINDING', 'Device MEC UE binding required');
      let query;
      try { discovery ??= await adapter.discover(); query = await adapter.query({ ueId: ueAddress }); }
      catch (error) { discovery = null; throw toolReview('MEC_QUERY', `MEC Location request failed (${error.code ?? 'transport'})`); }
      const user = query.response?.userList?.user?.find((entry) => entry.address === ueAddress);
      const lat = user?.locationInfo?.latitude?.[0]; const lon = user?.locationInfo?.longitude?.[0];
      if (!user || !Number.isFinite(lat) || !Number.isFinite(lon)) throw toolReview('MEC_LOCATION', 'MEC Location response for the device UE required');
      const seconds = user.timestamp?.seconds;
      return { serviceInstanceId: discovery.serviceInstanceId ?? 'unregistered', zoneId: user.zoneId ?? 'unknown', point: { lat, lon }, accuracyM: Number.isFinite(user.locationInfo.accuracy) ? user.locationInfo.accuracy : null,
        observedAt: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : query.timestamp, source: 'ETSI-MEC013-Location', simulation: query.simulation === true || adapter.simulation === true, endpoint: query.endpoint };
    },
  };
}

/** Provision the household tree used by the agent profile on a real CSE (admin originator). */
export async function provisionAgentHousehold({ client, tag, householdId, devices, visitors }) {
  const ae = (rn, api) => client.ensure(client.cseBase, 2, { 'm2m:ae': { rn, api, rr: true } }, { update: false });
  const household = await ae(`pb-hh-${tag}`, 'N.privacy.bubble.household');
  const guardian = await ae(`pb-guardian-${tag}`, 'N.privacy.bubble.guardian');
  const stranger = await ae(`pb-stranger-${tag}`, 'N.privacy.bubble.stranger');
  const visitorAes = {};
  for (const visitorId of visitors) visitorAes[visitorId] = await ae(`pb-${visitorId}-${tag}`.slice(0, 64), 'N.privacy.bubble.visitor');
  const baseAcp = await client.ensure(household.path, 1, { 'm2m:acp': { rn: 'household-acp', pv: { acr: [{ acor: [client.originator, household.aei, guardian.aei], acop: 63 }] }, pvs: { acr: [{ acor: [client.originator, guardian.aei], acop: 63 }] } } });
  await client.request('PUT', household.path, { 'm2m:ae': { acpi: [baseAcp.ri] } });
  const acpi = [baseAcp.ri]; const provisioned = [];
  for (const device of devices) {
    const container = await client.ensure(household.path, 3, { 'm2m:cnt': { rn: device.deviceId, lbl: [`pb-device:${device.deviceId}`, `pb-ue:${device.ueAddress}`, `pb-household:${householdId}`], acpi } });
    const sdt = await client.ensure(container.path, 28, encodeBinarySwitch({ rn: 'bubble', state: device.sdtState ?? true, acpi }, { operation: 'CREATE' }));
    const location = await client.ensure(container.path, 3, { 'm2m:cnt': { rn: 'location', mni: 20, acpi } });
    const grants = await client.ensure(container.path, 3, { 'm2m:cnt': { rn: 'grants', acpi } });
    provisioned.push({ deviceId: device.deviceId, resourcePath: container.path, sdtPath: sdt.path, locationPath: location.path, grantsPath: grants.path });
  }
  const approvals = await client.ensure(household.path, 3, { 'm2m:cnt': { rn: 'approvals', acpi } });
  const audit = await client.ensure(household.path, 3, { 'm2m:cnt': { rn: 'audit', acpi } });
  return { householdId, householdPath: household.path, householdOriginator: household.aei, baseAcpRi: baseAcp.ri, baseAcpPath: baseAcp.path, guardianOriginator: guardian.aei, guardianPath: guardian.path,
    strangerOriginator: stranger.aei, visitors: Object.fromEntries(Object.entries(visitorAes).map(([visitorId, entry]) => [visitorId, entry.aei])), approvalsPath: approvals.path, auditPath: audit.path, devices: provisioned };
}

/** Run-bound bearer tokens, one audience per MCP server; the principal carries the runId the server context binds to. */
export function issueAgentTokens({ runId, agentPrincipalId }) {
  const tokens = new Map(); const byServer = {};
  for (const [serverId, definition] of Object.entries(MCP_AGENT_CONTRACT.servers)) {
    const token = randomBytes(32).toString('base64url');
    tokens.set(token, { audience: definition.audience, principal: { principalId: agentPrincipalId, runId, serverId, scopes: [...new Set(definition.tools.map((tool) => tool.requiredScope))] } });
    byServer[serverId] = token;
  }
  return { tokens, byServer };
}

export async function startAgentMcpServers({ store, workflow, handlers, tokens, ports = {}, host = '127.0.0.1', clock = workflow.clock, timeoutMs = 15000, trace = null, onCommitted = null, onToolError = null }) {
  const started = [];
  for (const [serverId, definition] of Object.entries(MCP_AGENT_CONTRACT.servers)) {
    const server = createMcpHttpServer({ serverId, audience: definition.audience, tools: definition.tools, handlers: handlers[serverId], store, clock, timeoutMs, exposeToolErrors: true,
      trace: trace ? (entry) => trace({ ...entry, serverId }) : null,
      authenticate: async (request, audience) => {
        const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(String(request.headers.authorization ?? '')); const entry = match ? tokens.get(match[1]) : null;
        return entry && entry.audience === audience ? entry.principal : null;
      },
      resolveContext: ({ principal, tool, input }) => workflow.agentContext({ principal, serverId, audience: definition.audience, tool, input, timeoutMs }),
      authorizeCall: async ({ principal, context, tool }) => workflow.authorizeAgentCall({ principal, context, tool }),
      onToolError: async (detail) => { await workflow.recordToolError(detail); await onToolError?.(detail); }, onCommitted });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ports[serverId] ?? 0, host, resolve); });
    started.push({ serverId, audience: definition.audience, server, endpoint: `http://${host}:${server.address().port}/mcp` });
  }
  return { servers: started, endpoints: Object.fromEntries(started.map((entry) => [entry.serverId, entry.endpoint])),
    async close() { for (const entry of started) { entry.server.closeAllConnections(); await new Promise((resolve) => entry.server.close(resolve)); } } };
}

/** Claude Code `--mcp-config` document for the three HTTP servers (tokens stay in the .local run directory). */
export function agentMcpConfig({ endpoints, byServer }) {
  return { mcpServers: Object.fromEntries(Object.keys(MCP_AGENT_CONTRACT.servers).map((serverId) => [serverId.toLowerCase(), { type: 'http', url: endpoints[serverId], headers: { Authorization: `Bearer ${byServer[serverId]}` } }])) };
}
export const agentToolNames = () => Object.entries(MCP_AGENT_CONTRACT.servers).flatMap(([serverId, definition]) => definition.tools.map((tool) => `mcp__${serverId.toLowerCase()}__${tool.name}`));
