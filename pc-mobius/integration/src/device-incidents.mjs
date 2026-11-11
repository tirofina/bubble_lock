import { approvalHash, recordEnvelope } from './integration-utils.mjs';

/** 인증된 버튼 관측을 사건·보호자 알림·승인 대기 요청으로 연결한다. */
export class DeviceIncidentService {
  constructor({ store, portalService, policyService, gatewayControl, clock = () => new Date().toISOString() }) {
    Object.assign(this, { store, portalService, policyService, gatewayControl, clock });
  }
  async ingest({ gatewayId, principal, observation, observationId }) {
    const gateway = this.gatewayControl.authenticate(gatewayId, principal);
    const deviceId = observation.deviceId; const householdId = gateway.devices?.[deviceId];
    if (gateway.status !== 'ACTIVE' || !householdId || observation.gatewayId !== gatewayId || !['released', 'confirm', 'panic'].includes(observation.buttonState)
      || !Number.isSafeInteger(observation.sequence) || !observationId) throw Error('DEVICE_BUTTON_BINDING');
    const household = this.store.get('households', householdId); const device = this.store.get('portalDevices', deviceId);
    if (!household || device?.householdId !== householdId) return { status: 'ENROLLMENT_PENDING' };
    const now = Date.parse(this.clock()); const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAt) || observedAt < now - 30000 || observedAt > now + 2000) return { status: 'STALE' };
    return this.store.transaction(`device-button:${deviceId}`, async () => {
      const currentGateway = this.gatewayControl.authenticate(gatewayId, principal);
      if (currentGateway.status !== 'ACTIVE' || currentGateway.devices[deviceId] !== householdId) throw Error('DEVICE_BUTTON_CURRENT_ENROLLMENT');
      const previous = this.store.get('deviceButtonStates', deviceId);
      if (this.store.get('deviceIncidentEvents', observationId)) return { status: 'DUPLICATE' };
      if (previous && (Date.parse(previous.observedAt) > observedAt || (previous.bootId === observation.bootId && previous.sequence >= observation.sequence))) return { status: 'STALE' };
      await this.store.put('deviceButtonStates', deviceId, { deviceId, householdId, bootId: observation.bootId, sequence: observation.sequence, observedAt: observation.observedAt, buttonState: observation.buttonState });
      if (observation.buttonState !== 'panic' || previous?.buttonState === 'panic') return { status: 'OBSERVED' };
      const existing = this.store.list('portalIncidents').find((item) => item.householdId === householdId && item.deviceId === deviceId && item.kind === 'SAFETY' && item.status === 'OPEN');
      const incident = existing ?? { incidentId: `incident-${approvalHash({ deviceId, observationId }).slice(0, 24)}`, householdId, deviceId, kind: 'SAFETY',
        message: `${device.label}에서 긴급 도움을 요청했습니다.`, status: 'OPEN', createdBy: principal.principalId, createdAt: this.clock() };
      if (!existing) await this.store.put('portalIncidents', incident.incidentId, incident);
      const policyRows = this.store.list('policies').filter((record) => record.status === 'APPROVED' && record.policy?.trigger === 'PANIC'
        && record.policy.householdId === householdId && record.policy.deviceId === deviceId
        && household.members.some((member) => member.principalId === record.principalId && member.role === 'guardian'));
      const requestIds = [];
      for (const record of policyRows) {
        const policy = record.policy; const decision = this.policyService.evaluateGrant(policy.grantId, { scope: 'bubble:command' });
        if (!decision.allowed || decision.grant.principalId !== record.principalId || decision.grant.subjectId !== householdId
          || (policy.expiresAt && (!Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= now)) || typeof policy.desiredState?.state !== 'boolean') continue;
        const deviceIds = policy.targetDeviceIds ?? [deviceId];
        if (!Array.isArray(deviceIds) || !deviceIds.length || deviceIds.length > 16 || new Set(deviceIds).size !== deviceIds.length
          || deviceIds.some((id) => this.store.get('portalDevices', id)?.householdId !== householdId)) continue;
        const requestId = `request-${approvalHash({ incidentId: incident.incidentId, policyId: record.policyId, revision: record.revision }).slice(0, 24)}`;
        if (!this.store.get('portalCommandRequests', requestId)) await this.store.put('portalCommandRequests', requestId, {
          requestId, householdId, deviceIds, desiredState: { state: policy.desiredState.state }, reason: `${device.label} 긴급 요청 · 보호자 승인`, requestedBy: principal.principalId,
          requestedAt: this.clock(), expiresAt: new Date(Math.min(now + 300000, Date.parse(decision.grant.expiresAt))).toISOString(), status: 'PENDING', commands: [],
        });
        requestIds.push(requestId);
      }
      if (!existing) for (const member of household.members.filter((item) => item.role === 'guardian')) {
        const notificationId = `notice-${approvalHash({ incidentId: incident.incidentId, principalId: member.principalId }).slice(0, 32)}`;
        await this.store.put('portalNotifications', notificationId, { notificationId, householdId, principalId: member.principalId, type: 'DEVICE_PANIC', title: incident.message, createdAt: this.clock(), readAt: null });
      }
      const result = { status: existing ? 'OPEN_INCIDENT_REUSED' : 'INCIDENT_OPENED', householdId, deviceId, observationId, incidentId: incident.incidentId,
        requestIds, observedAt: observation.observedAt, acceptedAt: this.clock(), latencyMs: now - observedAt, simulation: gateway.simulation === true || principal.simulation === true };
      await this.store.put('deviceIncidentEvents', observationId, result);
      await this.store.append('receipts', recordEnvelope({ type: 'DEVICE_PANIC_RECONCILED', ...result }, this.clock));
      return result;
    });
  }
}
