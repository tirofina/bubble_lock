import { recordEnvelope } from './integration-utils.mjs';

function jsonResponse(status, body) {
  return { status, headers: { 'content-type': 'application/json', 'x-privacy-bubble-contract': 'privacy-bubble.integration.v1' }, body };
}

export class IntegrationApiGateway {
  constructor({ policyService, mecIngress, mecSubscriptions, handoverCoordinator, flCoordinator, mcpOrchestrator, gatewayControl, gatewayRegistration, portalService, portalLocations, clock = () => new Date().toISOString() } = {}) {
    Object.assign(this, { policyService, mecIngress, mecSubscriptions, handoverCoordinator, flCoordinator, mcpOrchestrator, gatewayControl, gatewayRegistration, portalService, portalLocations, clock });
  }

  principalFrom(request) {
    if (request.principal) return request.principal;
    throw new Error('Verified transport principal required');
  }

  registeredSubject(principal, subjectId) {
    const household = this.policyService.store.get('households', subjectId);
    if (!household || !household.members.some((member) => member.principalId === principal.principalId && member.role === 'guardian')) throw new Error('Registered household guardian binding required');
  }

  async handle(request) {
    const store = this.policyService?.store;
    if (store?.kind === 'postgres') {
      const path = new URL(request.path ?? '/', 'http://localhost').pathname;
      const phased = /^\/v1\/(mcp|mec|fl|handover|gateway-registrations|gateway-lifecycle)(\/|$)/.test(path) || path.startsWith('/callbacks/');
      try {
        if (phased) { await store.refresh(); return await this.handleRequest(request); }
        return await store.transaction(`api:${request.method ?? 'GET'}:${path}`, () => this.handleRequest(request));
      } catch (error) { return jsonResponse(503, recordEnvelope({ type: 'API_STORAGE_REVIEW', code: error.code ?? 'STORAGE_TRANSACTION' }, this.clock)); }
    }
    return this.handleRequest(request);
  }

  async handleRequest(request) {
    const method = String(request.method ?? 'GET').toUpperCase();
    let path = request.path ?? '/';
    try {
      const url = new URL(path, 'http://localhost');
      path = url.pathname;
      if (method === 'POST' && path === '/v1/auth/bind') return jsonResponse(200, this.principalFrom(request));
      const principal = this.principalFrom(request);
      const mecCallback = path.match(/^\/callbacks\/(Location|RNIS)\/([A-Za-z0-9_-]{43})$/);
      if (method === 'POST' && (mecCallback || path === '/v1/mec/callback')) {
        this.policyService.authorize(principal, 'mec:callback');
        const result = await this.mecIngress.ingestCallback({ service: mecCallback?.[1] ?? request.body?.service, token: mecCallback?.[2] ?? request.body?.token, providerIdentity: { verified: Boolean(principal.mtlsFingerprint), providerId: principal.principalId, mtlsFingerprint: principal.mtlsFingerprint }, payload: mecCallback ? request.body : request.body?.payload });
        if (result.status === 'ACCEPTED') await this.mecIngress.drainOutbox();
        return jsonResponse(result.httpStatus, result);
      }
      if (path.startsWith('/v1/mec/subscriptions') && this.mecSubscriptions) {
        this.policyService.authorize(principal, 'mec:manage');
        const key = path.match(/^\/v1\/mec\/subscriptions\/([a-f0-9]{64})$/)?.[1];
        if (!key && path !== '/v1/mec/subscriptions') throw new Error('MEC 구독 경로를 확인하세요.');
        const subscription = key ? this.mecSubscriptions.store.get('mecSubscriptions', key) : null;
        const owner = (policyId) => this.mecSubscriptions.store.get('policies', policyId)?.principalId === principal.principalId;
        if (key && (!subscription || !owner(subscription.intentId))) throw new Error('MEC 구독의 승인 주체를 확인하세요.');
        if (method === 'GET' && !key) return jsonResponse(200, this.mecSubscriptions.list().filter((item) => owner(item.intentId)));
        if (method === 'POST' && !key) {
          if (!owner(request.body?.policyId)) throw new Error('MEC 정책의 승인 주체를 확인하세요.');
          return jsonResponse(201, await this.mecSubscriptions.create(request.body));
        }
        if (method === 'GET' && key) return jsonResponse(200, subscription ? this.mecSubscriptions.list().find((item) => item.key === key) : {});
        if (method === 'PUT' && key) return jsonResponse(200, await this.mecSubscriptions.update(key));
        if (method === 'DELETE' && key) return jsonResponse(202, await this.mecSubscriptions.cancel(key));
      }
      if (this.gatewayRegistration && method === 'POST' && path === '/v1/gateway-registrations') return jsonResponse(201, await this.gatewayRegistration.register({...request.body,principal}));
      if (this.gatewayRegistration && method === 'POST' && path === '/v1/gateway-lifecycle/lost') return jsonResponse(200, await this.gatewayRegistration.markLost({...request.body,principal}));
      if (path.startsWith('/v1/portal/') && this.portalService) {
        if (method === 'GET' && path === '/v1/portal/locations' && this.portalLocations) return jsonResponse(200, await this.portalLocations.read(principal));
        const result = await this.portalService.handle({ method, path, principal, body: request.body });
        return jsonResponse(result.status, result.body);
      }
      const gatewayRoute = path.match(/^\/(?:api\/)?v1\/gateways\/([^/]+)\/(commands|authorize|dispatch-start|credentials\/status|telemetry|receipts)$/);
      if (gatewayRoute && this.gatewayControl) {
        const gatewayId = decodeURIComponent(gatewayRoute[1]);
        const action = gatewayRoute[2];
        if (method === 'POST' && action === 'receipts') return jsonResponse(200, await this.gatewayControl.receiveReceipt(gatewayId, principal, request.body));
        if (method === 'POST' && action === 'dispatch-start') return jsonResponse(200, await this.gatewayControl.dispatchStart(gatewayId, principal, request.body));
        if (method === 'POST' && action === 'telemetry' && this.portalLocations) return jsonResponse(200, await this.portalLocations.ingestGateway({ gatewayId, principal, observation: request.body }));
        if (method === 'GET' && action === 'credentials/status') return jsonResponse(200, this.gatewayControl.credentialStatus(gatewayId, principal));
        if (method === 'GET' && action === 'commands') return jsonResponse(200, this.gatewayControl.poll(gatewayId, principal, Number(url.searchParams.get('limit') ?? 16)));
        if (method === 'POST' && action === 'authorize') return jsonResponse(200, await this.gatewayControl.authorize(gatewayId, principal, request.body));
        if (method === 'POST' && action === 'commands') return jsonResponse(201, await this.gatewayControl.issue({ ...request.body, principal, gatewayId }));
      }
      if (method === 'POST' && path === '/v1/consents') {
        this.policyService.authorize(principal, 'consent:write'); this.registeredSubject(principal, request.body?.subjectId);
        return jsonResponse(201, await this.policyService.createConsent({ ...request.body, principal }));
      }
      if (method === 'POST' && path === '/v1/grants') {
        this.policyService.authorize(principal, 'grant:write'); this.registeredSubject(principal, this.policyService.store.get('consents', request.body?.consentId)?.subjectId);
        return jsonResponse(201, await this.policyService.createGrant({ ...request.body, principal }));
      }
      if (method === 'POST' && path === '/v1/grants/revoke') return jsonResponse(200, await this.policyService.revokeGrant({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/policies/approve') return jsonResponse(201, await this.policyService.approvePolicy({ ...request.body, principal }));
      const serviceScope = {
        '/v1/mec/callback': 'mec:callback', '/v1/handover': 'handover:write',
        '/v1/fl/rounds': 'fl:write', '/v1/fl/updates': 'fl:write', '/v1/fl/finalize': 'fl:write',
        '/v1/fl/participants': 'fl:write', '/v1/fl/consents': 'fl:write', '/v1/fl/heartbeat': 'fl:write',
        '/v1/fl/vms': 'fl:admin', '/v1/fl/recover': 'fl:admin', '/v1/fl/reselect': 'fl:write',
        '/v1/fl/publish': 'fl:admin', '/v1/fl/retrain': 'fl:admin', '/v1/fl/artifacts': 'fl:read', '/v1/fl/participant-state': 'fl:write',
        '/v1/mcp/runs': 'mcp:run', '/v1/mcp/approve': 'policy:approve', '/v1/mcp/execute': 'mcp:run', '/v1/mcp/resume': 'mcp:run', '/v1/mcp/servers': 'mcp:run'
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
      if (path.startsWith('/v1/handover')) {
        if (method === 'POST' && path === '/v1/handover/settle') {
          const gateway = this.gatewayControl.authenticate(request.body?.gatewayId, principal);
          const record = this.gatewayControl.store.get('gatewayCommands', request.body?.commandId);
          if (gateway.status !== 'ACTIVE' || record?.command.gatewayId !== gateway.gatewayId || record.command.deviceId !== request.body?.ueId) throw new Error('Gateway claim receipt 연결을 확인하세요.');
          return jsonResponse(200, await this.handoverCoordinator.settleDispatch(request.body));
        }
        this.policyService.authorize(principal, 'handover:write');
        if (method === 'POST' && path === '/v1/handover') return jsonResponse(202, await this.handoverCoordinator.handover(request.body));
        if (method === 'POST' && path === '/v1/handover/resume') return jsonResponse(202, await this.handoverCoordinator.resume(request.body.ueId));
        if (method === 'POST' && path === '/v1/handover/rollback') return jsonResponse(202, await this.handoverCoordinator.rollback(request.body.ueId, request.body.reason));
        if (method === 'GET' && path === '/v1/handover/status') return jsonResponse(200, this.handoverCoordinator.status(url.searchParams.get('ueId')));
      }
      if (method === 'POST' && path === '/v1/fl/rounds') return jsonResponse(201, await this.flCoordinator.createRound(request.body));
      if (method === 'POST' && path === '/v1/fl/participants') return jsonResponse(201, await this.flCoordinator.registerParticipant({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/fl/consents') return jsonResponse(200, await this.flCoordinator.setParticipantConsent({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/fl/heartbeat') return jsonResponse(200, await this.flCoordinator.heartbeat({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/fl/vms') { const vm = this.flCoordinator.registerVm(request.body); await this.flCoordinator.store.flush(); return jsonResponse(201, vm); }
      if (method === 'POST' && path === '/v1/fl/updates') return jsonResponse(202, await this.flCoordinator.submitUpdate({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/fl/finalize') return jsonResponse(200, await this.flCoordinator.finalizeRound(request.body.roundId));
      if (method === 'POST' && path === '/v1/fl/recover') return jsonResponse(200, await this.flCoordinator.recover(request.body.roundId));
      if (method === 'POST' && path === '/v1/fl/reselect') return jsonResponse(200, await this.flCoordinator.reselect(request.body.roundId));
      if (method === 'POST' && path === '/v1/fl/publish') return jsonResponse(200, await this.flCoordinator.publishRound(request.body.roundId));
      if (method === 'POST' && path === '/v1/fl/retrain') return jsonResponse(200, await this.flCoordinator.approveRetraining(request.body.taskId));
      if (method === 'GET' && path === '/v1/fl/artifacts') return this.flCoordinator.store.transaction('fl:serve', async () => jsonResponse(200, this.flCoordinator.serveArtifact(url.searchParams.get('roundId'), url.searchParams.get('artifactHash'))));
      if (method === 'GET' && path === '/v1/fl/participant-state') return this.flCoordinator.store.transaction('fl:participant-state', async () => jsonResponse(200, this.flCoordinator.participantState({ taskId: url.searchParams.get('taskId'), participantId: url.searchParams.get('participantId'), roundId: url.searchParams.get('roundId'), principal })));
      if (method === 'POST' && path === '/v1/mcp/runs') return jsonResponse(201, await this.mcpOrchestrator.startRun({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/mcp/approve') return jsonResponse(200, await this.mcpOrchestrator.approveRun({ ...request.body, principal }));
      if (method === 'POST' && path === '/v1/mcp/execute') return jsonResponse(200, await this.mcpOrchestrator.execute(request.body.runId, { ...request.body.options, principal }));
      if (method === 'POST' && path === '/v1/mcp/resume') return jsonResponse(200, await this.mcpOrchestrator.resume(request.body.runId, { principal }));
      if (method === 'GET' && /^\/v1\/mcp\/runs\/[^/]+$/.test(path)) return jsonResponse(200, this.mcpOrchestrator.getRun(decodeURIComponent(path.split('/').at(-1)), principal));
      if (method === 'GET' && path === '/v1/mcp/servers') return jsonResponse(200, this.mcpOrchestrator.listServers());
      return jsonResponse(404, recordEnvelope({ type: 'API_ROUTE_REVIEW', method, path: path.replace(/(\/callbacks\/[^/]+\/)[^/]+/, '$1[masked]') }, this.clock));
    } catch (error) {
      return jsonResponse(403, recordEnvelope({ type: 'API_REVIEW', method, path: path.replace(/(\/callbacks\/[^/]+\/)[^/]+/, '$1[masked]'), error: error.message }, this.clock));
    }
  }
}
