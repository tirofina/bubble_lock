import { recordEnvelope } from './integration-utils.mjs';

function jsonResponse(status, body) {
  return { status, headers: { 'content-type': 'application/json', 'x-privacy-bubble-contract': 'privacy-bubble.integration.v1' }, body };
}

export class IntegrationApiGateway {
  constructor({ policyService, mecIngress, handoverCoordinator, flCoordinator, mcpOrchestrator, gatewayControl, clock = () => new Date().toISOString() } = {}) {
    Object.assign(this, { policyService, mecIngress, handoverCoordinator, flCoordinator, mcpOrchestrator, gatewayControl, clock });
  }

  principalFrom(request) {
    if (request.principal) return request.principal;
    throw new Error('Verified transport principal required');
  }

  async handle(request) {
    const method = String(request.method ?? 'GET').toUpperCase();
    let path = request.path ?? '/';
    try {
      const url = new URL(path, 'http://localhost');
      path = url.pathname;
      if (method === 'POST' && path === '/v1/auth/bind') return jsonResponse(200, this.principalFrom(request));
      const principal = this.principalFrom(request);
      const gatewayRoute = path.match(/^\/(?:api\/)?v1\/gateways\/([^/]+)\/(commands|authorize|credentials\/status)$/);
      if (gatewayRoute && this.gatewayControl) {
        const gatewayId = decodeURIComponent(gatewayRoute[1]);
        const action = gatewayRoute[2];
        if (method === 'GET' && action === 'credentials/status') return jsonResponse(200, this.gatewayControl.credentialStatus(gatewayId, principal));
        if (method === 'GET' && action === 'commands') return jsonResponse(200, this.gatewayControl.poll(gatewayId, principal, Number(url.searchParams.get('limit') ?? 16)));
        if (method === 'POST' && action === 'authorize') return jsonResponse(200, await this.gatewayControl.authorize(gatewayId, principal, request.body));
        if (method === 'POST' && action === 'commands') return jsonResponse(201, await this.gatewayControl.issue({ ...request.body, principal, gatewayId }));
      }
      if (method === 'POST' && path === '/v1/consents') return jsonResponse(201, await this.policyService.createConsent({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/grants') return jsonResponse(201, await this.policyService.createGrant({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/grants/revoke') return jsonResponse(200, await this.policyService.revokeGrant({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/policies/approve') return jsonResponse(201, await this.policyService.approvePolicy({ ...request.body, principal }));
      const serviceScope = {
        '/v1/mec/callback': 'mec:callback', '/v1/handover': 'handover:write',
        '/v1/fl/rounds': 'fl:write', '/v1/fl/updates': 'fl:write', '/v1/fl/finalize': 'fl:write',
        '/v1/mcp/runs': 'mcp:run', '/v1/mcp/execute': 'mcp:run', '/v1/mcp/resume': 'mcp:run', '/v1/mcp/servers': 'mcp:run'
      }[path];
      if (serviceScope) this.policyService.authorize(principal, serviceScope);
      if (method === 'POST' && ['/v1/mcp/execute', '/v1/mcp/resume'].includes(path)) {
        const run = this.mcpOrchestrator.store.get('mcpRuns', request.body?.runId);
        if (!run || run.principalId !== principal.principalId) throw new Error('MCP run owner binding required');
      }
      if (method === 'POST' && path === '/v1/mcp/runs') {
        const prior = this.mcpOrchestrator.store.list('mcpRuns').find((run) => run.idempotencyKey === request.body?.idempotencyKey);
        if (prior && prior.principalId !== principal.principalId) throw new Error('MCP idempotency owner binding required');
      }
      if (method === 'POST' && path === '/v1/mec/callback') return jsonResponse(202, await this.mecIngress.ingest(request.body));
      if (method === 'POST' && path === '/v1/handover') return jsonResponse(202, await this.handoverCoordinator.handover(request.body));
      if (method === 'POST' && path === '/v1/fl/rounds') return jsonResponse(201, await this.flCoordinator.createRound(request.body));
      if (method === 'POST' && path === '/v1/fl/updates') return jsonResponse(202, await this.flCoordinator.submitUpdate(request.body));
      if (method === 'POST' && path === '/v1/fl/finalize') return jsonResponse(200, await this.flCoordinator.finalizeRound(request.body.roundId));
      if (method === 'POST' && path === '/v1/mcp/runs') return jsonResponse(201, await this.mcpOrchestrator.startRun({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/mcp/execute') return jsonResponse(200, await this.mcpOrchestrator.execute(request.body.runId, request.body.options));
      if (method === 'POST' && path === '/v1/mcp/resume') return jsonResponse(200, await this.mcpOrchestrator.resume(request.body.runId));
      if (method === 'GET' && path === '/v1/mcp/servers') return jsonResponse(200, this.mcpOrchestrator.listServers());
      return jsonResponse(404, recordEnvelope({ type: 'API_ROUTE_REVIEW', method, path }, this.clock));
    } catch (error) {
      return jsonResponse(403, recordEnvelope({ type: 'API_REVIEW', method, path, error: error.message }, this.clock));
    }
  }
}
