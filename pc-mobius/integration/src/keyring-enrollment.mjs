import { approvalHash, recordEnvelope } from './integration-utils.mjs';

const identifier = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)) throw new Error('키링과 수신기 ID를 확인하세요.');
  return value;
};

export class KeyringEnrollmentService {
  constructor({ store, portalService, gatewayControl, clock }) {
    Object.assign(this, { store, portalService, gatewayControl, clock });
  }

  effective(record) {
    return record.status === 'PENDING' && Date.parse(record.expiresAt) <= Date.parse(this.clock()) ? 'EXPIRED' : record.status;
  }

  snapshot(principal, householdIds) {
    return this.store.list('keyringEnrollments')
      .filter((record) => record.requestedBy === principal.principalId && householdIds.has(record.householdId))
      .map(({ released, confirmationObservationId, credentialRevision, ...record }) => ({ ...record, effectiveStatus: this.effective(record) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  }

  request(principal, input) {
    this.portalService.policyService.authorize(principal, 'device:write');
    this.portalService.household(principal, input.householdId, true);
    return this.portalService.mutate(principal, 'keyring-enrollment.request', input, async (key) => {
      const deviceId = identifier(input.deviceId);
      const gateway = this.gatewayControl.gateway(identifier(input.gatewayId));
      if (gateway.status !== 'ACTIVE') throw new Error('사용할 수 있는 수신기를 선택하세요.');
      const subjects = Object.values(gateway.devices);
      if (!subjects.length || !subjects.every((householdId) => householdId === input.householdId)
        || !this.store.list('portalDevices').some((device) => device.gatewayId === gateway.gatewayId && device.householdId === input.householdId && gateway.devices[device.deviceId] === input.householdId)) {
        throw new Error('가족에게 이미 연결된 전용 수신기를 선택하세요.');
      }
      if (this.store.get('portalDevices', deviceId) || this.store.get('keyringBindings', deviceId)
        || this.store.list('gateways').some((entry) => entry.devices[deviceId])) throw new Error('이미 연결된 키링은 다른 가족에 등록할 수 없어요.');
      const now = Date.parse(this.clock());
      if (this.store.list('keyringEnrollments').some((record) => record.deviceId === deviceId && this.effective(record) === 'PENDING')) throw new Error('이 키링은 이미 연결을 기다리고 있어요.');
      const recent = this.store.list('keyringEnrollments').filter((record) => Date.parse(record.createdAt) > now - 600000);
      if (recent.filter((record) => record.requestedBy === principal.principalId).length >= 5
        || recent.filter((record) => record.gatewayId === gateway.gatewayId).length >= 5) throw new Error('잠시 후 다시 연결을 시도해 주세요.');
      if (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 80) throw new Error('키링 이름을 확인하세요.');
      const record = {
        enrollmentId: `enroll-${key.slice(0, 24)}`, householdId: input.householdId,
        gatewayId: gateway.gatewayId, deviceId, label: input.label.trim(),
        requestedBy: principal.principalId, credentialRevision: gateway.credentialRevision,
        createdAt: this.clock(), expiresAt: new Date(now + 300000).toISOString(), status: 'PENDING',
      };
      await this.store.put('keyringEnrollments', record.enrollmentId, record);
      return { ...record, effectiveStatus: 'PENDING' };
    });
  }

  cancel(principal, input) {
    this.portalService.policyService.authorize(principal, 'device:write');
    const record = this.store.get('keyringEnrollments', identifier(input.enrollmentId));
    this.portalService.household(principal, record?.householdId, true);
    if (record.requestedBy !== principal.principalId) throw new Error('본인이 시작한 키링 연결만 취소할 수 있어요.');
    return this.portalService.mutate(principal, 'keyring-enrollment.cancel', input, async () => {
      const current = this.store.get('keyringEnrollments', record.enrollmentId);
      if (this.effective(current) !== 'PENDING') throw new Error('연결 대기 중인 키링을 선택하세요.');
      const next = { ...current, status: 'CANCELLED', cancelledAt: this.clock() };
      await this.store.put('keyringEnrollments', current.enrollmentId, next);
      return { ...next, effectiveStatus: 'CANCELLED' };
    });
  }

  async ingest({ gatewayId, principal, observation, observationId }) {
    const gateway = this.gatewayControl.authenticate(gatewayId, principal);
    if (gateway.status !== 'ACTIVE') return null;
    const binding = this.store.get('keyringBindings', observation.deviceId);
    if (binding?.confirmationObservationId === observationId && binding.gatewayId === gatewayId) {
      if (binding.confirmationPayloadHash !== approvalHash(observation)) throw new Error('원래 확인 신호의 내용을 유지하세요.');
      return { status: 'DUPLICATE', deviceId: observation.deviceId, observationId };
    }
    if (gateway.devices[observation.deviceId]) return null;
    const pending = this.store.list('keyringEnrollments').find((record) => record.deviceId === observation.deviceId && this.effective(record) === 'PENDING');
    if (!pending || pending.gatewayId !== gatewayId || gateway.status !== 'ACTIVE' || pending.credentialRevision !== gateway.credentialRevision) return null;
    const now = Date.parse(this.clock());
    const observedAt = Date.parse(observation.observedAt);
    const receivedAt = Date.parse(observation.receivedAt);
    if (!Number.isFinite(observedAt) || observedAt < now - 30000 || observedAt > now + 2000
      || receivedAt < observedAt || receivedAt > now + 2000 || observedAt < Date.parse(pending.createdAt)) throw new Error('새로 누른 키링 확인 버튼을 기다리고 있어요.');
    if (!['released', 'confirm'].includes(observation.buttonState)) throw new Error('키링 확인 버튼 신호를 기다리고 있어요.');
    return this.store.transaction(`keyring-enrollment:${pending.deviceId}`, async () => {
      const current = this.store.get('keyringEnrollments', pending.enrollmentId);
      const activeGateway = this.gatewayControl.authenticate(gatewayId, principal);
      if (this.effective(current) !== 'PENDING' || activeGateway.status !== 'ACTIVE'
        || activeGateway.credentialRevision !== current.credentialRevision
        || Object.values(activeGateway.devices).some((householdId) => householdId !== current.householdId)
        || this.store.list('gateways').some((entry) => entry.devices[current.deviceId])
        || this.store.get('portalDevices', current.deviceId) || this.store.get('keyringBindings', current.deviceId)) throw new Error('현재 가족과 키링 연결을 확인하세요.');
      const household = this.store.get('households', current.householdId);
      if (!household?.members.some((member) => member.principalId === current.requestedBy && member.role === 'guardian')) throw new Error('현재 보호자 권한을 확인하세요.');
      const previous = current.released;
      if (observation.buttonState === 'released') {
        if (previous && (Date.parse(previous.observedAt) > observedAt
          || previous.bootId === observation.bootId && previous.sequence >= observation.sequence)) {
          if (previous.bootId === observation.bootId && previous.sequence === observation.sequence
            && previous.payloadHash !== approvalHash(observation)) throw new Error('원래 확인 신호의 내용을 유지하세요.');
          return { status: 'DUPLICATE', deviceId: current.deviceId, observationId };
        }
        await this.store.put('keyringEnrollments', current.enrollmentId, { ...current, released: { bootId: observation.bootId, sequence: observation.sequence, observedAt: observation.observedAt, payloadHash: approvalHash(observation) } });
        return { status: 'ACCEPTED', deviceId: current.deviceId, observationId, enrollmentStatus: 'PENDING' };
      }
      if (!previous || previous.bootId !== observation.bootId || previous.sequence >= observation.sequence
        || Date.parse(previous.observedAt) > observedAt) return { status: 'ACCEPTED', deviceId: current.deviceId, observationId, enrollmentStatus: 'PENDING' };
      const bindingRecord = { deviceId: current.deviceId, householdId: current.householdId, gatewayId,
        enrollmentId: current.enrollmentId, confirmationObservationId: observationId, confirmationPayloadHash: approvalHash(observation) };
      const device = { deviceId: current.deviceId, householdId: current.householdId, gatewayId,
        label: current.label, registeredAt: this.clock() };
      await this.store.put('keyringBindings', current.deviceId, bindingRecord);
      await this.store.put('gateways', gatewayId, { ...activeGateway, devices: { ...activeGateway.devices, [current.deviceId]: current.householdId } });
      await this.store.put('portalDevices', current.deviceId, device);
      await this.store.put('keyringEnrollments', current.enrollmentId, { ...current, status: 'COMPLETED', completedAt: this.clock(), confirmationObservationId: observationId });
      await this.portalService.event({ principalId: current.requestedBy }, current.householdId, 'DEVICE_REGISTERED',
        `${device.label} is connected.`, { deviceId: current.deviceId, enrollmentId: current.enrollmentId });
      await this.store.append('receipts', recordEnvelope({ type: 'KEYRING_BUTTON_ENROLLED', deviceId: current.deviceId, gatewayId,
        householdId: current.householdId, enrollmentId: current.enrollmentId, observationId }, this.clock));
      return { status: 'ACCEPTED', deviceId: current.deviceId, observationId, enrollmentStatus: 'COMPLETED' };
    });
  }
}
