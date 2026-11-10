import { id, nowIso, recordEnvelope } from './integration-utils.mjs';

export class HandoverCoordinator {
  constructor({ store, clock = () => new Date().toISOString() } = {}) {
    if (!store) throw new Error('HandoverCoordinator requires IntegrationStore');
    this.store = store;
    this.clock = clock;
    this.edges = new Map();
    this.sessions = new Map();
  }

  registerEdge(edge) {
    if (!edge?.edgeId) throw new Error('edgeId is required');
    const next = { edgeId: edge.edgeId, region: edge.region ?? 'local', location: edge.location ?? null, health: edge.health ?? 'HEALTHY', load: edge.load ?? 0, capabilities: edge.capabilities ?? [], subscriptions: [...(edge.subscriptions ?? [])], securityContext: edge.securityContext ?? {}, updatedAt: nowIso(this.clock) };
    this.edges.set(next.edgeId, next);
    return next;
  }

  updateHealth(edgeId, patch) {
    const edge = this.edges.get(edgeId);
    if (!edge) throw new Error(`Edge ${edgeId} is not registered`);
    Object.assign(edge, patch, { updatedAt: nowIso(this.clock) });
    return edge;
  }

  selectEdge({ location = null, capabilities = [] } = {}) {
    const candidates = [...this.edges.values()].filter((edge) => edge.health === 'HEALTHY' && capabilities.every((capability) => edge.capabilities.includes(capability)));
    candidates.sort((a, b) => (a.load - b.load) || String(a.edgeId).localeCompare(String(b.edgeId)));
    return candidates[0] ?? null;
  }

  async handover({ ueId, targetEdgeId, grantId = null, subscriptionIds = [], reason = 'location-health' }) {
    const target = this.edges.get(targetEdgeId);
    if (!target || target.health !== 'HEALTHY') throw new Error('Target edge health review required');
    const prior = this.status(ueId) ?? { ueId, epoch: 0, state: 'DETACHED', edgeId: null, subscriptions: [], securityContext: {} };
    const enrolledEpoch = Math.max(0, ...this.store.list('gateways').filter((gateway) => gateway.devices?.[ueId]).map((gateway) => gateway.ownershipEpoch));
    const nextEpoch = Math.max(prior.epoch, enrolledEpoch) + 1;
    if (nextEpoch > 2147483647) throw new Error('Gateway ownership epoch capacity reached');
    const next = { ...prior, state: 'DRAINING', handoverId: id('handover'), previousEdgeId: prior.edgeId, edgeId: targetEdgeId, targetEdgeId, grantId, reason, startedAt: nowIso(this.clock), epoch: nextEpoch, subscriptions: [...new Set(subscriptionIds)], securityContext: { ...prior.securityContext, ...target.securityContext, grantId, epoch: nextEpoch } };
    this.sessions.set(ueId, next);
    await this.store.put('handovers', ueId, recordEnvelope({ ...next, type: 'HANDOVER_DRAINING' }, this.clock));
    await this.store.append('receipts', recordEnvelope({ ...next, type: 'HANDOVER_DRAINING' }, this.clock));
    next.state = 'ACTIVE';
    next.completedAt = nowIso(this.clock);
    await this.store.put('handovers', ueId, recordEnvelope({ ...next, type: 'HANDOVER_ACTIVE' }, this.clock));
    await this.store.append('receipts', recordEnvelope({ ...next, type: 'HANDOVER_ACTIVE' }, this.clock));
    return next;
  }

  async rollback(ueId, reason = 'handover-review') {
    const session = this.sessions.get(ueId) ?? this.store.get('handovers', ueId);
    if (!session) throw new Error('Handover session is required');
    const target = session.previousEdgeId ?? session.edgeId;
    const epoch = Math.max(session.epoch, ...this.store.list('gateways').filter((gateway) => gateway.devices?.[ueId]).map((gateway) => gateway.ownershipEpoch)) + 1;
    if (epoch > 2147483647) throw new Error('Gateway ownership epoch capacity reached');
    const next = { ...session, state: 'ROLLED_BACK', edgeId: target, rollbackReason: reason, rolledBackAt: nowIso(this.clock), epoch, securityContext: { ...session.securityContext, epoch } };
    this.sessions.set(ueId, next);
    await this.store.put('handovers', ueId, recordEnvelope({ ...next, type: 'HANDOVER_ROLLBACK' }, this.clock));
    await this.store.append('receipts', recordEnvelope({ ...next, type: 'HANDOVER_ROLLBACK' }, this.clock));
    return next;
  }

  status(ueId) {
    return this.sessions.get(ueId) ?? this.store.get('handovers', ueId) ?? null;
  }
}
