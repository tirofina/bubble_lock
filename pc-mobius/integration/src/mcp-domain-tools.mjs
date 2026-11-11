import { approvalHash } from './integration-utils.mjs';
import { MCP_CONTRACT } from './mcp-schema.mjs';

export function createMcpAuthorizer(runtime) {
  return async ({ principal, context, tool, input }) => {
    const run = runtime.store.get('mcpRuns', context.runId);
    if (!run || !run.approvedAt || run.principalId !== principal.principalId || run.approvalHash !== context.approvalHash
      || run.grantId !== context.grantId || run.grantRevision !== context.grantRevision) throw new Error('Current approved MCP run required');
    const call = run.toolCalls[context.index]; const binding = run.toolBindings[context.index];
    if (!call || call.serverId !== tool.serverId || call.tool !== tool.name || approvalHash(call.input) !== approvalHash(input)
      || binding.audience !== context.audience || binding.scope !== tool.requiredScope
      || context.operationKey !== approvalHash({ runId: run.runId, index: context.index, approvalHash: run.approvalHash })) throw new Error('MCP reviewed tool intent binding required');
    runtime.mcpOrchestrator.currentGrant(run, tool.requiredScope);
  };
}

/** 생산 도구는 등록된 중앙 상태와 기존 command/reconcile 경로를 사용합니다. */
export function createMcpDomainHandlers(runtime, { discoverDevices = null } = {}) {
  const { store, policyService, gatewayControl } = runtime;
  const now = () => policyService.clock();
  return {
    oneM2M: {
      async discoverDevices(input, context) {
        if (typeof discoverDevices !== 'function') throw new Error('Configured oneM2M discovery adapter required');
        const grant = policyService.evaluateGrant(context.grantId, { scope: 'bubble:read' }).grant;
        return discoverDevices({ ...input, subjectId: grant.subjectId, principal: context.principal, operationKey: context.operationKey });
      },
      async readGrant(input, context) {
        if (input.grantId !== context.grantId) throw new Error('MCP run grant binding required');
        const decision = policyService.evaluateGrant(input.grantId);
        if (!decision.allowed) throw new Error('Current MCP grant required');
        const { grantId, revision, status, scopes, expiresAt } = decision.grant;
        return { grantId, revision, status, scopes, expiresAt };
      },
      async draftPolicy(input, context) {
        if (input.grantId !== context.grantId) throw new Error('MCP draft grant binding required');
        const draftId = `draft-${context.operationKey.slice(0, 32)}`; const policyHash = approvalHash(input);
        await store.put('mcpPolicyDrafts', draftId, { draftId, policyHash, policy: input, principalId: context.principalId, status: 'DRAFT', createdAt: now() });
        return { draftId, policyHash };
      },
      async applyApprovedPolicy(input, context) {
        const approved = store.get('policies', input.policyId);
        if (!approved || approved.principalId !== context.principalId || approved.status !== 'APPROVED' || approved.policy.grantId !== context.grantId) throw new Error('MCP current approved policy owner required');
        const device = store.get('portalDevices', approved.policy.ueId);
        if (!device || typeof approved.policy.desiredState?.state !== 'boolean') throw new Error('MCP policy device and desired state required');
        const command = await gatewayControl.issue({ principal: context.principal, gatewayId: device.gatewayId, deviceId: device.deviceId, grantId: context.grantId,
          commandId: `mcp-${context.operationKey.slice(0, 32)}`, desiredState: approved.policy.desiredState, deadline: context.deadline });
        return { policyId: approved.policyId, status: 'QUEUED', revision: approved.revision, executionId: command.commandId };
      },
    },
    MEC: {
      async reconcileApprovedIntent(input, context) {
        const event = await runtime.mecIngress.readEvent(input.eventId);
        if (!event || event.intent?.grantId !== context.grantId) throw new Error('MCP accepted MEC event and grant binding required');
        const outbox = store.get('mecOutbox', event.eventKey);
        if (!outbox || outbox.grantId !== context.grantId || outbox.grantRevision !== context.grantRevision) throw new Error('MCP current MEC outbox binding required');
        await store.put('mcpReconcileIntents', context.operationKey, { operationKey: context.operationKey, eventKey: event.eventKey, runId: context.runId, requestedAt: now() });
        const status = outbox.state === 'COMPLETED' ? outbox.outcomes?.every((outcome) => outcome.allowed) ? 'RECONCILED' : 'REVIEW' : ['PENDING', 'RETRY'].includes(outbox.state) ? 'PENDING' : 'REVIEW';
        return { eventId: input.eventId, status, ...(event.intent.policyId ? { policyId: event.intent.policyId } : {}) };
      },
    },
    Audit: {
      async readExecution(input, context) {
        const run = store.get('mcpRuns', input.runId);
        if (!run || run.principalId !== context.principalId || run.grantId !== context.grantId) throw new Error('MCP execution owner required');
        return { runId: run.runId, status: run.status, cursor: run.cursor, outputCount: run.outputs.length };
      },
      async appendRunEvidence(input, context) {
        const evidenceId = `evidence-${context.operationKey.slice(0, 32)}`;
        const record = { evidenceId, evidenceHash: input.evidenceHash, recordedAt: now() };
        await store.put('mcpEvidence', evidenceId, { ...record, runId: context.runId, principalId: context.principalId }); return record;
      },
    },
  };
}

export function registerMcpSimulation(orchestrator, { clock = () => new Date().toISOString() } = {}) {
  const handlers = {
    oneM2M: {
      discoverDevices: async () => ({ deviceIds: ['keyring-demo'], resourcePaths: ['/Mobius/demo/keyring-demo'], observedAt: clock() }),
      readGrant: async (input) => ({ grantId: input.grantId, revision: 1, status: 'ACTIVE', scopes: ['bubble:read'], expiresAt: new Date(Date.parse(clock()) + 60000).toISOString() }),
      draftPolicy: async (input, context) => ({ draftId: `draft-${context.operationKey.slice(0, 24)}`, policyHash: approvalHash(input) }),
      applyApprovedPolicy: async () => { throw new Error('Simulation device adapter requires explicit command fixture'); },
    },
    MEC: { reconcileApprovedIntent: async (input) => ({ eventId: input.eventId, status: 'PENDING' }) },
    Audit: {
      readExecution: async (input) => ({ runId: input.runId, status: 'PENDING_APPROVAL', cursor: 0, outputCount: 0 }),
      appendRunEvidence: async (input, context) => ({ evidenceId: `evidence-${context.operationKey.slice(0, 24)}`, evidenceHash: input.evidenceHash, recordedAt: clock() }),
    },
  };
  for (const [serverId, definition] of Object.entries(MCP_CONTRACT.servers)) orchestrator.registerServer({ serverId, simulation: true, tools: definition.tools, handlers: handlers[serverId] });
}
