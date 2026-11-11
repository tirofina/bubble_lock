import { randomUUID } from 'node:crypto';
import { approvalHash, id, recordEnvelope, requireArray, requireString } from './integration-utils.mjs';
import { MCP_CONTRACT, compileTools, validateTool } from './mcp-schema.mjs';
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
