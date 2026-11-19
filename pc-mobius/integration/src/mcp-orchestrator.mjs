import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { approvalHash, id, recordEnvelope, requireArray, requireString } from './integration-utils.mjs';
import { MCP_AGENT_CONTRACT, MCP_CONTRACT, compileTools, toolReview, validateTool } from './mcp-schema.mjs';
import { McpHttpClient } from './mcp-http.mjs';

export class McpOrchestrator {
  constructor({ store, policyService, clock = () => new Date().toISOString(), timeoutMs = 5000, faultInjector = null } = {}) {
    if (!store || !policyService || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new Error('MCP store, policy and bounded timeout required');
    Object.assign(this, { store, policyService, clock, timeoutMs, faultInjector });
    this.servers = new Map(); this.execution = new Map(); this.workerId = randomUUID();
  }
  registerServer({ serverId, domain, tools, handlers, simulation = false }) {
    if (simulation !== true) throw new Error('Local MCP handlers require explicit simulation mode');
    requireString(serverId, 'serverId');
    const definition = MCP_CONTRACT.servers[serverId]; const catalog = compileTools(tools ?? definition?.tools);
    if (!handlers || [...catalog.keys()].some((name) => typeof handlers[name] !== 'function')) throw new Error('Local MCP handlers required');
    this.servers.set(serverId, { serverId, domain: domain ?? serverId, audience: definition?.audience ?? `privacy-bubble-mcp-${serverId}`, catalog, handlers, transport: 'LOCAL_SIMULATION' });
    return this.servers.get(serverId);
  }
  async registerRemoteServer({ serverId, domain, tools, client = null, ...options }) {
    requireString(serverId, 'serverId');
    const definition = MCP_CONTRACT.servers[serverId]; const catalog = compileTools(tools ?? definition?.tools);
    const audience = options.audience ?? definition?.audience;
    if (!audience) throw new Error('MCP server audience required');
    const transport = client ?? new McpHttpClient({ ...options, audience });
    if (transport.audience !== audience) throw new Error('MCP client audience binding required');
    const discovered = await transport.connect();
    if (discovered.serverInfo?.name !== serverId || discovered.tools.length !== catalog.size) throw new Error('Pinned MCP server and tool set required');
    for (const tool of discovered.tools) {
      const known = catalog.get(tool.name);
      if (!known || approvalHash({ input: tool.inputSchema, output: tool.outputSchema }) !== approvalHash({ input: known.inputSchema, output: known.outputSchema })) throw new Error('Pinned MCP tool schemas required');
    }
    this.servers.set(serverId, { serverId, domain: domain ?? serverId, audience, catalog, client: transport, transport: 'MCP_STREAMABLE_HTTP', endpoint: transport.endpoint });
    return this.listServers().find((entry) => entry.serverId === serverId);
  }
  listServers() {
    return [...this.servers.values()].map(({ serverId, domain, audience, catalog, transport, endpoint }) => ({ serverId, domain, audience, tools: [...catalog.keys()], transport, ...(endpoint ? { endpoint } : {}) }));
  }
  currentGrant(run, scope) {
    const { principalId, audience, scopes, grantId, grantRevision, toolCalls, toolBindings } = run;
    if (run.approvalHash !== approvalHash({ principalId, audience, scopes, grantId, grantRevision, toolCalls, toolBindings })) throw new Error('Reviewed MCP plan integrity required');
    const decision = this.policyService.evaluateGrant(run.grantId, { scope });
    if (!decision.allowed || decision.grant.principalId !== run.principalId || decision.grant.revision !== run.grantRevision) throw new Error('Current MCP owner grant and revision required');
    return decision.grant;
  }
  validatePlan(toolCalls) {
    requireArray(toolCalls, 'toolCalls');
    if (toolCalls.length > 32) throw new Error('Bounded MCP plan required');
    return toolCalls.map((call) => {
      if (!call || Object.keys(call).some((key) => !['serverId', 'tool', 'input'].includes(key))) throw new Error('Reviewed MCP call fields required');
      const server = this.servers.get(call.serverId);
      if (!server) throw new Error('Registered MCP server required');
      const input = structuredClone(call.input ?? {}); validateTool(server.catalog, call.tool, 'input', input);
      return { serverId: call.serverId, tool: call.tool, input };
    });
  }
  async startRun({ principal, audience = 'privacy-bubble-mcp', scopes = [], grantId, approvalHash: expectedApprovalHash, toolCalls, idempotencyKey }) {
    this.policyService.authorize(principal, 'mcp:run'); requireString(idempotencyKey, 'idempotencyKey'); requireString(grantId, 'grantId');
    if (audience !== 'privacy-bubble-mcp' || idempotencyKey.length > 128) throw new Error('MCP configured audience and bounded idempotency key required');
    const plan = this.validatePlan(toolCalls);
    const requiredScopes = [...new Set(plan.map((call) => this.servers.get(call.serverId).catalog.get(call.tool).requiredScope))].sort();
    if (!Array.isArray(scopes) || scopes.length > 32 || scopes.some((scope) => typeof scope !== 'string')) throw new Error('MCP scope list required');
    scopes = scopes.length ? [...new Set(scopes)].sort() : requiredScopes;
    if (requiredScopes.some((scope) => !scopes.includes(scope))) throw new Error('MCP declared tool scopes required');
    const decision = this.policyService.evaluateGrant(grantId);
    if (!decision.allowed || decision.grant.principalId !== principal.principalId || scopes.some((scope) => !decision.grant.scopes.includes(scope))) throw new Error('MCP plan grant owner and scopes required');
    const toolBindings = plan.map((call) => { const server = this.servers.get(call.serverId); const tool = server.catalog.get(call.tool); return { serverId: call.serverId, audience: server.audience, schemaHash: approvalHash({ input: tool.inputSchema, output: tool.outputSchema }), scope: tool.requiredScope }; });
    const intent = { principalId: principal.principalId, audience, scopes, grantId, grantRevision: decision.grant.revision, toolCalls: plan, toolBindings };
    const calculated = approvalHash(intent);
    if (expectedApprovalHash !== undefined) { this.policyService.authorize(principal, 'policy:approve'); if (expectedApprovalHash !== calculated) throw new Error('MCP approval hash requires the reviewed plan'); }
    return this.store.transaction(`mcp-start:${principal.principalId}:${idempotencyKey}`, async () => {
      const prior = this.store.list('mcpRuns').find((run) => run.principalId === principal.principalId && run.idempotencyKey === idempotencyKey);
      if (prior) { if (prior.approvalHash !== calculated) throw new Error('MCP idempotency requires original intent'); return prior; }
      const run = { runId: id('mcp-run'), idempotencyKey, ...intent, approvalHash: calculated, status: expectedApprovalHash ? 'APPROVED' : 'PENDING_APPROVAL', approvedAt: expectedApprovalHash ? this.clock() : null, approvedBy: expectedApprovalHash ? principal.principalId : null,
        simulation: plan.some((call) => this.servers.get(call.serverId).transport === 'LOCAL_SIMULATION'), cursor: 0, checkpoints: [], outputs: [], activeStep: null, startedAt: this.clock() };
      await this.store.put('mcpRuns', run.runId, run); await this.audit(run, 'RUN_PLANNED'); return run;
    });
  }
  async approveRun({ principal, runId, approvalHash: reviewedHash }) {
    this.policyService.authorize(principal, 'policy:approve');
    return this.store.transaction(`mcp-run:${runId}`, async () => {
      const run = structuredClone(this.store.get('mcpRuns', runId));
      if (!run || run.principalId !== principal.principalId || run.approvalHash !== reviewedHash) throw new Error('MCP plan owner and exact approval hash required');
      this.currentGrant(run); if (run.approvedAt) return run;
      run.approvedAt = this.clock(); run.approvedBy = principal.principalId; run.status = 'APPROVED';
      await this.store.put('mcpRuns', runId, run); await this.audit(run, 'RUN_APPROVED'); return run;
    });
  }
  getRun(runId, principal) {
    this.policyService.authorize(principal, 'mcp:run'); const run = this.store.get('mcpRuns', runId);
    if (!run || run.principalId !== principal.principalId) throw new Error('MCP run owner required');
    this.currentGrant(run); return structuredClone(run);
  }
  execute(runId, options = {}) {
    const prior = this.execution.get(runId) ?? Promise.resolve(); const next = prior.then(() => this.executeOnce(runId, options));
    this.execution.set(runId, next.catch(() => {})); return next;
  }
  async executeOnce(runId, { principal = null, maxSteps = 32 } = {}) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 32) throw new Error('MCP bounded maxSteps required');
    if (principal) this.getRun(runId, principal);
    let steps = 0;
    while (steps < maxSteps) {
      const prepared = await this.store.transaction(`mcp-run:${runId}`, async () => {
        const run = structuredClone(this.store.get('mcpRuns', runId));
        if (!run || !run.approvedAt || run.approvedBy !== run.principalId) throw new Error('Explicit MCP plan approval required');
        this.currentGrant(run); if (run.status === 'COMPLETED') return { done: run };
        const call = run.toolCalls[run.cursor]; const binding = run.toolBindings[run.cursor]; const server = this.servers.get(call.serverId);
        if (!server || server.audience !== binding.audience) throw new Error('Reviewed MCP server audience required');
        const tool = validateTool(server.catalog, call.tool, 'input', call.input);
        if (approvalHash({ input: tool.inputSchema, output: tool.outputSchema }) !== binding.schemaHash || tool.requiredScope !== binding.scope || !run.scopes.includes(binding.scope)) throw new Error('Reviewed MCP tool schema and scope required');
        const grant = this.currentGrant(run, binding.scope);
        if (run.activeStep?.leaseOwner && run.activeStep.leaseOwner !== this.workerId && Date.parse(run.activeStep.leaseExpiresAt) > Date.parse(this.clock())) throw new Error('MCP active execution lease requires settlement');
        const deadline = new Date(Math.min(Date.parse(grant.expiresAt), Date.parse(this.clock()) + this.timeoutMs)).toISOString();
        const operationKey = approvalHash({ runId, index: run.cursor, approvalHash: run.approvalHash });
        run.activeStep = { index: run.cursor, operationKey, status: 'PREPARED', leaseOwner: this.workerId, leaseExpiresAt: new Date(Date.parse(this.clock()) + this.timeoutMs + 1000).toISOString() };
        run.status = 'RUNNING'; await this.store.put('mcpRuns', runId, run); await this.audit(run, 'STEP_PREPARED', { operationKey, index: run.cursor });
        return { run, server, call, context: { operationKey, runId, index: run.cursor, principalId: run.principalId, approvalHash: run.approvalHash, grantId: run.grantId, grantRevision: run.grantRevision, audience: binding.audience, deadline } };
      });
      if (prepared.done) return prepared.done;
      const { server, call, context } = prepared; let timer;
      try {
        const invocation = server.client ? server.client.call(call.tool, call.input, context, this.timeoutMs) : server.handlers[call.tool](call.input, context);
        const output = await Promise.race([invocation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP tool timeout requires retry review')), this.timeoutMs); })]);
        clearTimeout(timer); validateTool(server.catalog, call.tool, 'output', output);
        await this.faultInjector?.('after-tool-before-checkpoint', { runId, operationKey: context.operationKey });
        const completed = await this.store.transaction(`mcp-run:${runId}`, async () => {
          const current = structuredClone(this.store.get('mcpRuns', runId));
          if (current.activeStep?.operationKey !== context.operationKey || current.activeStep.leaseOwner !== this.workerId || current.cursor !== context.index) throw new Error('MCP checkpoint execution lease required');
          this.currentGrant(current, current.toolBindings[current.cursor].scope);
          current.outputs.push({ index: current.cursor, serverId: call.serverId, tool: call.tool, operationKey: context.operationKey, output, completedAt: this.clock() });
          current.cursor += 1; current.checkpoints.push({ cursor: current.cursor, outputCount: current.outputs.length, operationKey: context.operationKey, outputHash: approvalHash(output), at: this.clock() });
          current.activeStep = null; current.status = current.cursor === current.toolCalls.length ? 'COMPLETED' : 'APPROVED';
          if (current.status === 'COMPLETED') current.completedAt = this.clock();
          await this.store.put('mcpRuns', runId, current); await this.audit(current, current.status === 'COMPLETED' ? 'RUN_COMPLETED' : 'CHECKPOINT', { operationKey: context.operationKey }); return current;
        });
        if (completed.status === 'COMPLETED') return completed;
      } catch (error) {
        clearTimeout(timer);
        await this.store.transaction(`mcp-run:${runId}`, async () => {
          const current = structuredClone(this.store.get('mcpRuns', runId));
          if (current.activeStep?.operationKey === context.operationKey && current.activeStep.leaseOwner === this.workerId) {
            current.status = 'PAUSED'; current.activeStep.leaseOwner = null; current.lastError = String(error.message).slice(0, 300);
            await this.store.put('mcpRuns', runId, current); await this.audit(current, 'STEP_REVIEW', { operationKey: context.operationKey, reason: current.lastError });
          }
        }); throw error;
      }
      steps += 1;
    }
    return structuredClone(this.store.get('mcpRuns', runId));
  }
  async resume(runId, options = {}) { return this.execute(runId, options); }
  async close() { await Promise.all([...this.servers.values()].filter((server) => server.client).map((server) => server.client.close())); }
  async audit(run, action, detail = {}) {
    const evidence = recordEnvelope({ type: 'MCP_AUDIT', runId: run.runId, principalId: run.principalId, approvalHash: run.approvalHash, simulation: run.simulation, action, cursor: run.cursor, detail }, this.clock);
    await this.store.append('receipts', evidence); return evidence;
  }
}

const AGENT_STEPS = MCP_AGENT_CONTRACT.workflow.steps;
const AGENT_READ_ONLY = new Set(MCP_AGENT_CONTRACT.workflow.readOnlyTools);
const AGENT_SCOPES = [...new Set(Object.values(MCP_AGENT_CONTRACT.servers).flatMap((server) => server.tools.map((tool) => tool.requiredScope)))].sort();
const AGENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const OPERATION_BITS = { CREATE: 1, RETRIEVE: 2, UPDATE: 4, DELETE: 8, DISCOVER: 32 };
const STEP_STATUS = { requestGuardianApproval: 'AWAITING_GUARDIAN', applyApprovedPolicy: 'APPLIED', reconcileApprovedIntent: 'RECONCILED', appendRunEvidence: 'COMPLETED' };
const safeEqual = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
export const agentAcop = (operations) => operations.reduce((mask, operation) => mask | (OPERATION_BITS[operation] ?? 0), 0);

/**
 * Persistent LLM-agent workflow ledger. Every tool commit writes its checkpoint in the same store transaction as the
 * MCP dedup record, so a killed runner resumes from the stored cursor. The guardian decision is a separate principal
 * step; applyApprovedPolicy only accepts the approvalHash that the guardian produced for the exact current draftHash.
 */
export class McpAgentWorkflow {
  constructor({ store, policyService, clock = policyService?.clock ?? (() => new Date().toISOString()), approvalTtlMs = 20 * 60000 } = {}) {
    if (!store || !policyService) throw new Error('MCP agent workflow store and policy service required');
    Object.assign(this, { store, policyService, clock, approvalTtlMs });
  }
  static get steps() { return [...AGENT_STEPS]; }
  static get scopes() { return [...AGENT_SCOPES]; }
  async createRun({ guardian, task, grantId, agentPrincipalId, idempotencyKey }) {
    this.policyService.authorize(guardian, 'mcp:run'); requireString(idempotencyKey, 'idempotencyKey'); requireString(agentPrincipalId, 'agentPrincipalId');
    const clean = structuredClone(task ?? {});
    for (const field of ['householdId', 'deviceId', 'visitorId', 'incidentId']) if (!AGENT_ID.test(clean[field] ?? '')) throw new Error(`MCP agent task ${field} required`);
    if (!Number.isInteger(clean.durationMinutes) || clean.durationMinutes < 1 || clean.durationMinutes > MCP_AGENT_CONTRACT.workflow.maxDurationMinutes) throw new Error('Bounded MCP agent task duration required');
    if (clean.resource !== 'location' || JSON.stringify(clean.operations) !== JSON.stringify(['RETRIEVE'])) throw new Error('MCP agent task is limited to location RETRIEVE');
    const decision = this.policyService.evaluateGrant(grantId);
    if (!decision.allowed || decision.grant.principalId !== guardian.principalId || decision.grant.subjectId !== clean.householdId || AGENT_SCOPES.some((scope) => !decision.grant.scopes.includes(scope))) throw new Error('MCP agent run requires the household guardian grant with agent scopes');
    const intent = { task: clean, grantId, grantRevision: decision.grant.revision, guardianId: guardian.principalId, agentPrincipalId };
    const taskHash = approvalHash(intent);
    return this.store.transaction(`mcp-agent-start:${guardian.principalId}:${idempotencyKey}`, async () => {
      const prior = this.store.list('mcpAgentRuns').find((run) => run.guardianId === guardian.principalId && run.idempotencyKey === idempotencyKey);
      if (prior) { if (prior.taskHash !== taskHash) throw new Error('MCP agent idempotency requires the original task'); return structuredClone(prior); }
      const run = { runId: id('agent-run'), idempotencyKey, ...intent, taskHash, status: 'READY', steps: {}, checkpoints: [], invocations: [], devices: {}, drafts: {}, approvals: {}, approvalChecks: [], toolErrors: [], repeatedCalls: [], createdAt: this.clock() };
      await this.store.put('mcpAgentRuns', run.runId, run); await this.receipt(run, 'AGENT_RUN_CREATED', { taskHash }); return structuredClone(run);
    });
  }
  getRun(runId) {
    const run = this.store.get('mcpAgentRuns', runId);
    if (!run) throw toolReview('RUN_REQUIRED', 'Registered agent run required');
    return structuredClone(run);
  }
  /** Current-authority check used before the handler and again before the tool commit. */
  current(runId, { principalId = null, scope = null } = {}) {
    const run = this.getRun(runId);
    if (principalId !== null && run.agentPrincipalId !== principalId) throw toolReview('RUN_PRINCIPAL', 'Agent session is bound to a different run principal');
    const decision = this.policyService.evaluateGrant(run.grantId, scope ? { scope } : {});
    if (!decision.allowed || decision.grant.revision !== run.grantRevision || decision.grant.principalId !== run.guardianId) throw toolReview('GRANT_CURRENT', `Current guardian grant revision ${run.grantRevision} required (${decision.reason ?? 'revision changed'})`);
    return { run, grant: decision.grant };
  }
  resumePoint(run) {
    const completedSteps = AGENT_STEPS.filter((step) => run.steps[step]?.status === 'COMPLETED');
    const nextStep = AGENT_STEPS.find((step) => run.steps[step]?.status !== 'COMPLETED') ?? 'NONE';
    return { cursor: completedSteps.length, completedSteps, nextStep };
  }
  latestApproval(run, draftId = null) {
    return Object.values(run.approvals).filter((entry) => draftId === null || entry.draftId === draftId).sort((left, right) => left.sequence - right.sequence).at(-1) ?? null;
  }
  approvalView(run) {
    const approval = this.latestApproval(run);
    if (!approval) return { status: 'NONE' };
    const expired = approval.status === 'APPROVED' && !approval.consumedAt && Date.parse(approval.expiresAt) <= Date.parse(this.clock());
    return { status: expired ? 'REJECTED' : approval.status, approvalRequestId: approval.approvalRequestId, draftId: approval.draftId, draftHash: approval.draftHash,
      ...(approval.status === 'APPROVED' && !expired ? { approvalHash: approval.approvalHash } : {}), ...(approval.reason || expired ? { reason: expired ? 'approval expired' : approval.reason } : {}) };
  }
  executionView(run) {
    const point = this.resumePoint(run); const approval = this.approvalView(run);
    const resumed = run.invocations.at(-1)?.resumedFrom;
    return { runId: run.runId, status: run.status, invocation: run.invocations.length, completedSteps: point.completedSteps, nextStep: point.nextStep,
      waitingFor: point.nextStep === 'applyApprovedPolicy' && approval.status === 'PENDING_GUARDIAN' ? 'GUARDIAN_APPROVAL' : 'NONE', approval, checkpointCount: run.checkpoints.length,
      ...(resumed ? { resumedFrom: { invocation: resumed.invocation, nextStep: resumed.nextStep, cursor: resumed.cursor } } : {}) };
  }
  /** Ordered routing: mutating steps follow the contract order once; read-only steps may refresh after their prerequisites. */
  route(run, step) {
    const index = AGENT_STEPS.indexOf(step);
    if (index < 0) throw toolReview('ROUTE_UNKNOWN', `${step} is not a workflow step`);
    const point = this.resumePoint(run);
    if (run.status === 'COMPLETED') throw toolReview('RUN_COMPLETED', 'Run is completed; use audit readExecution');
    const missing = AGENT_STEPS.slice(0, index).filter((name) => run.steps[name]?.status !== 'COMPLETED');
    if (missing.length) throw toolReview('ROUTE_ORDER', `${step} requires ${missing.join(', ')} first; nextStep is ${point.nextStep}`);
    if (AGENT_READ_ONLY.has(step)) return point;
    const redraft = step === 'draftPolicy' && this.latestApproval(run)?.status === 'REJECTED';
    if (run.steps[step]?.status === 'COMPLETED' && !redraft) throw toolReview('STEP_COMPLETED', `${step} is already checkpointed; nextStep is ${point.nextStep}`);
    return point;
  }
  discoveredDevice(run, deviceId) {
    const device = run.devices[deviceId];
    if (!device) throw toolReview('DEVICE_DISCOVERY', `Device ${deviceId} is not among the discovered household devices`);
    return device;
  }
  /** Session-bound MCP context: run, grant revision, audience and deadline come from the server, never from the client. */
  agentContext({ principal, serverId, audience, tool, input, timeoutMs = 15000 }) {
    const { run, grant } = this.current(principal.runId, { principalId: principal.principalId, scope: tool.requiredScope });
    const sequence = tool.readOnly ? randomUUID() : null;
    return { runId: run.runId, principalId: principal.principalId, approvalHash: run.taskHash, grantId: run.grantId, grantRevision: run.grantRevision, audience, invocation: run.invocations.length,
      deadline: new Date(Math.min(Date.parse(grant.expiresAt), Date.parse(this.clock()) + timeoutMs)).toISOString(),
      operationKey: approvalHash({ runId: run.runId, serverId, tool: tool.name, input, ...(sequence ? { sequence } : {}) }) };
  }
  authorizeAgentCall({ principal, context, tool }) {
    if (context.runId !== principal.runId || context.approvalHash !== this.getRun(context.runId).taskHash) throw toolReview('RUN_BINDING', 'Agent session run binding required');
    this.current(context.runId, { principalId: principal.principalId, scope: tool.requiredScope });
  }
  async mutate(runId, operation) {
    return this.store.transaction(`mcp-agent-run:${runId}`, async () => {
      const run = this.getRun(runId); const value = await operation(run);
      await this.store.put('mcpAgentRuns', runId, run); return value === undefined ? structuredClone(run) : value;
    });
  }
  async beginInvocation(runId, { agent, mode = 'start', pid = null } = {}) {
    return this.mutate(runId, (run) => {
      const point = this.resumePoint(run);
      const entry = { invocation: run.invocations.length + 1, agent, mode, pid, startedAt: this.clock(), ...(run.invocations.length ? { resumedFrom: { invocation: run.invocations.length, ...point } } : {}) };
      run.invocations.push(entry); if (run.status === 'READY') run.status = 'RUNNING';
      return structuredClone(entry);
    });
  }
  async endInvocation(runId, detail = {}) {
    return this.mutate(runId, (run) => { const entry = run.invocations.at(-1); if (entry && !entry.endedAt) Object.assign(entry, { endedAt: this.clock(), ...detail }); return structuredClone(entry ?? null); });
  }
  async recordInterruption(runId, { method, lastEvent = null, at = this.clock() }) {
    return this.mutate(runId, (run) => {
      const entry = run.invocations.at(-1);
      if (!entry) throw new Error('MCP agent invocation required');
      Object.assign(entry, { interruptedAt: at, interruption: method, lastEvent, cursorAtInterruption: this.resumePoint(run).cursor, endedAt: at });
      return structuredClone(entry);
    });
  }
  /** Runs inside the MCP tool transaction, so the checkpoint and the dedup record commit together. */
  async checkpoint(context, step, { input, output, update = null }) {
    return this.mutate(context.runId, (run) => {
      if (run.steps[step]?.status === 'COMPLETED' && AGENT_READ_ONLY.has(step)) {
        run.repeatedCalls.push({ step, invocation: context.invocation, at: this.clock() }); update?.(run); return structuredClone(run);
      }
      update?.(run);
      run.steps[step] = { status: 'COMPLETED', operationKey: context.operationKey, inputHash: approvalHash(input), outputHash: approvalHash(output), output, completedAt: this.clock(), invocation: context.invocation };
      run.checkpoints.push({ index: run.checkpoints.length, step, cursor: this.resumePoint(run).cursor, operationKey: context.operationKey, outputHash: approvalHash(output), invocation: context.invocation, at: this.clock() });
      run.status = STEP_STATUS[step] ?? 'RUNNING';
      if (run.status === 'COMPLETED') run.completedAt = this.clock();
      return structuredClone(run);
    });
  }
  /** Guardian step outside the agent session; the guardian reviews the exact draft hash. */
  async guardianDecide({ guardian, runId, approvalRequestId, reviewedDraftHash, decision = 'APPROVE', reason = null }) {
    this.policyService.authorize(guardian, 'policy:approve');
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new Error('Guardian decision required');
    return this.mutate(runId, async (run) => {
      if (guardian.principalId !== run.guardianId) throw new Error('Run guardian principal required');
      this.current(runId);
      const request = run.approvals[approvalRequestId]; const draft = request && run.drafts[request.draftId];
      if (!request || request.status !== 'PENDING_GUARDIAN' || !draft || draft.superseded || !safeEqual(reviewedDraftHash, draft.draftHash) || request.draftHash !== draft.draftHash) throw new Error('Guardian review of the exact pending draft hash required');
      const decidedAt = this.clock(); const nonce = randomBytes(16).toString('hex');
      const decisionHash = approvalHash({ runId, approvalRequestId, draftId: draft.draftId, draftHash: draft.draftHash, guardianId: guardian.principalId, decision, grantId: run.grantId, grantRevision: run.grantRevision, decidedAt, nonce });
      Object.assign(request, { status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedAt, decidedBy: guardian.principalId, approvalHash: decisionHash, nonce, grantRevision: run.grantRevision,
        expiresAt: new Date(Date.parse(decidedAt) + this.approvalTtlMs).toISOString(), ...(reason ? { reason: String(reason).slice(0, 160) } : {}) });
      run.status = decision === 'APPROVE' ? 'APPROVED' : 'DRAFT_REJECTED';
      await this.receipt(run, 'GUARDIAN_DECISION', { approvalRequestId, decision, draftHash: draft.draftHash, approvalHash: decisionHash });
      return { approvalRequestId, decision, draftId: draft.draftId, draftHash: draft.draftHash, approvalHash: decisionHash, decidedAt, expiresAt: request.expiresAt };
    });
  }
  /** Server-side approval gate for applyApprovedPolicy. */
  verifyApproval(run, draftId, presentedHash) {
    const draft = run.drafts[draftId];
    if (!draft) throw toolReview('DRAFT_REQUIRED', `Draft ${draftId} is not stored for this run`);
    const approval = this.latestApproval(run, draftId);
    if (!approval) throw toolReview('APPROVAL_REQUIRED', 'Guardian approval request required before apply');
    if (approval.status === 'PENDING_GUARDIAN') throw toolReview('APPROVAL_PENDING', 'Guardian decision is pending; read audit readExecution later');
    if (approval.status === 'REJECTED') throw toolReview('APPROVAL_REJECTED', `Guardian rejected the draft${approval.reason ? `: ${approval.reason}` : ''}`);
    if (draft.superseded || draft.draftHash !== approval.draftHash) throw toolReview('APPROVAL_DRAFT_CHANGED', 'Approval is bound to a different draftHash');
    if (!safeEqual(presentedHash, approval.approvalHash)) throw toolReview('APPROVAL_HASH_MISMATCH', 'approvalHash does not match the guardian approval for this draftHash');
    if (Date.parse(approval.expiresAt) <= Date.parse(this.clock())) throw toolReview('APPROVAL_EXPIRED', 'Guardian approval expired');
    if (approval.grantRevision !== run.grantRevision) throw toolReview('APPROVAL_GRANT_REVISION', 'Approval grant revision changed');
    return { draft, approval };
  }
  /** Rejections and failed tool calls are recorded after the aborted tool transaction. */
  async recordToolError({ principal, context, serverId, tool, input, reason, message, internal = null }) {
    const runId = context?.runId ?? principal?.runId;
    if (!runId || !this.store.get('mcpAgentRuns', runId)) return null;
    return this.mutate(runId, (run) => {
      const entry = { serverId, tool, reason, message: String(message).slice(0, 200), invocation: run.invocations.length, at: this.clock(), ...(internal ? { internal } : {}) };
      run.toolErrors.push(entry); if (run.toolErrors.length > 64) run.toolErrors.splice(0, run.toolErrors.length - 64);
      if (tool === 'applyApprovedPolicy' && String(reason).startsWith('APPROVAL_')) run.approvalChecks.push({ result: 'REJECTED', reason, draftId: input?.draftId ?? null, presentedHashPrefix: String(input?.approvalHash ?? '').slice(0, 12), invocation: run.invocations.length, at: entry.at });
      return structuredClone(entry);
    });
  }
  async receipt(run, action, detail = {}) {
    const evidence = recordEnvelope({ type: 'MCP_AGENT_AUDIT', runId: run.runId, action, taskHash: run.taskHash, detail }, this.clock);
    await this.store.append('receipts', evidence); return evidence;
  }
}
