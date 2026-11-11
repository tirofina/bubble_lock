import { approvalHash, recordEnvelope } from './integration-utils.mjs';

const identifier = (value, name = '식별자') => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${name} 형식을 확인하세요.`);
  return value;
};
const text = (value, name, maximum = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new Error(`${name}을 확인하세요.`);
  return value.trim();
};

/** Guardian/Visitor 앱의 영속 상태와 household 접근 범위를 관리합니다. */
export class PortalService {
  constructor({ store, policyService, gatewayControl, clock = () => new Date().toISOString() }) {
    Object.assign(this, { store, policyService, gatewayControl, clock });
    this.queue = Promise.resolve();
  }

  async provisionHousehold({ householdId, name, ownerId, members = [] }) {
    identifier(householdId); identifier(ownerId);
    name = text(name, '가구 이름', 80);
    if (!Array.isArray(members) || members.some((member) => !['guardian', 'visitor'].includes(member.role))) throw new Error('가구 구성원 역할을 확인하세요.');
    const membership = new Map(members.map((member) => [identifier(member.principalId), { principalId: member.principalId, role: member.role }]));
    membership.set(ownerId, { principalId: ownerId, role: 'guardian' });
    const prior = this.store.get('households', householdId);
    if (prior && prior.ownerId !== ownerId) throw new Error('가구 소유자 일치를 확인하세요.');
    return this.store.put('households', householdId, { householdId, name, ownerId, members: [...membership.values()], createdAt: prior?.createdAt ?? this.clock() });
  }

  household(principal, householdId, guardian = false) {
    this.policyService.authorize(principal, 'portal:read');
    const household = this.store.get('households', identifier(householdId));
    const member = household?.members.find((entry) => entry.principalId === principal.principalId);
    if (!household || !member || (guardian && member.role !== 'guardian')) throw new Error('가구 구성원과 보호자 권한을 확인하세요.');
    return household;
  }

  async event(principal, householdId, type, title, details = {}) {
    const record = recordEnvelope({ type, owner: 'PC-MOBIUS-INTEGRATION', principalId: principal.principalId, householdId, ...details }, this.clock);
    await this.store.append('receipts', record);
    const household = this.store.get('households', householdId);
    for (const member of household.members) {
      const notificationId = `notice-${approvalHash({ eventId: record.eventId, principalId: member.principalId }).slice(0,32)}`;
      await this.store.put('portalNotifications', notificationId, { notificationId, householdId, principalId: member.principalId, type, title, createdAt: record.timestamp, readAt: null });
    }
    return record;
  }

  mutate(principal, action, input, work) {
    this.policyService.authorize(principal, 'portal:read');
    const idempotencyKey = text(input?.idempotencyKey, 'idempotencyKey', 128);
    const key = approvalHash({ principalId: principal.principalId, action, idempotencyKey });
    const intentHash = approvalHash(input);
    const operation = this.queue.then(async () => {
      const outcome = await this.store.transaction(`portal:${key}`, async () => {
        const prior = this.store.get('portalOperations', key);
        if (prior) {
          if (prior.intentHash !== intentHash) throw new Error('같은 요청 키에는 원래 요청 내용을 사용하세요.');
          return { result: prior.result };
        }
        let result;
        try { result = await work(key); }
        catch (error) {
          if (action === 'command.approve' && this.store.get('portalCommandRequests', input.requestId)?.status === 'PARTIAL') return { error };
          throw error;
        }
        await this.store.put('portalOperations', key, { principalId: principal.principalId, action, intentHash, result, completedAt: this.clock() });
        return { result };
      });
      if (outcome.error) throw outcome.error;
      return structuredClone(outcome.result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  snapshot(principal) {
    this.policyService.authorize(principal, 'portal:read');
    const households = this.store.list('households').filter((home) => home.members.some((entry) => entry.principalId === principal.principalId));
    const ids = new Set(households.map((home) => home.householdId));
    const guardian = households.some((home) => home.members.some((member) => member.principalId === principal.principalId && member.role === 'guardian'));
    const now = Date.parse(this.clock());
    const effective = (record) => record.status === 'ACTIVE' && Date.parse(record.expiresAt) <= now ? 'EXPIRED' : record.status;
    const consents = this.store.list('consents').filter((record) => record.principalId === principal.principalId && ids.has(record.subjectId))
      .map((record) => ({ ...record, effectiveStatus: effective(record) }));
    const grants = this.store.list('grants').filter((record) => record.principalId === principal.principalId && ids.has(record.subjectId))
      .map((record) => ({ ...record, effectiveStatus: effective(record) === 'ACTIVE' && !this.policyService.evaluateGrant(record.grantId).allowed ? 'INACTIVE' : effective(record) }));
    return structuredClone({
      schemaVersion: '1.0.0', generatedAt: this.clock(), principal: { principalId: principal.principalId, role: guardian ? 'guardian' : 'visitor' },
      households, devices: this.store.list('portalDevices').filter((record) => ids.has(record.householdId)), consents, grants,
      locationLeases:this.locationPrivacy?.list(principal)??[],
      incidents: this.store.list('portalIncidents').filter((record) => ids.has(record.householdId)),
      commandRequests: this.store.list('portalCommandRequests').filter((record) => ids.has(record.householdId)).map((record) => ({ ...record, effectiveStatus: ['PENDING', 'PARTIAL'].includes(record.status) && Date.parse(record.expiresAt) <= now ? 'EXPIRED' : record.status })),
      notifications: this.store.list('portalNotifications').filter((record) => record.principalId === principal.principalId && ids.has(record.householdId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0,100),
    });
  }

  locationAccess(principal) {
    this.policyService.authorize(principal, 'portal:read');
    const households = this.store.list('households').filter((home) => {
      const member = home.members.find((entry) => entry.principalId === principal.principalId);
      if (!member) return false;
      if (member.role === 'guardian') return true;
      return this.store.list('grants').some((grant) => grant.subjectId === home.householdId
        && grant.scopes.includes('location:read')
        && home.members.some((owner) => owner.principalId === grant.principalId && owner.role === 'guardian')
        && this.policyService.evaluateGrant(grant.grantId, { scope: 'location:read' }).allowed);
    });
    const householdIds = households.map((home) => home.householdId);
    const preciseIds=this.locationPrivacy?new Set(this.locationPrivacy.deviceIds(principal)):null;
    const deviceIds = this.store.list('portalDevices').filter((device) => householdIds.includes(device.householdId)&&(!preciseIds||preciseIds.has(device.deviceId))).map((device) => device.deviceId);
    const role = households.some((home) => home.members.some((member) => member.principalId === principal.principalId && member.role === 'guardian')) ? 'guardian' : 'visitor';
    return { deviceIds, householdIds, role };
  }

  createHousehold(principal, input) {
    this.policyService.authorize(principal, 'household:write');
    return this.mutate(principal, 'household.create', input, async (key) => {
      const household = await this.provisionHousehold({ householdId: `household-${key.slice(0,24)}`, name: input.name, ownerId: principal.principalId });
      await this.event(principal, household.householdId, 'HOUSEHOLD_CREATED', '새 가구가 등록되었습니다.');
      return household;
    });
  }

  registerDevice(principal, input) {
    this.policyService.authorize(principal, 'device:write');
    this.household(principal, input.householdId, true);
    return this.mutate(principal, 'device.register', input, async () => {
      const deviceId = identifier(input.deviceId);
      const gateway = this.gatewayControl.gateway(input.gatewayId);
      if (gateway.devices[deviceId] !== input.householdId || gateway.status !== 'ACTIVE') throw new Error('운영자가 등록한 기기·Gateway·가구 연결을 확인하세요.');
      const prior = this.store.get('portalDevices', deviceId);
      if (prior && (prior.householdId !== input.householdId || prior.gatewayId !== input.gatewayId)) throw new Error('기기의 기존 가구 연결을 확인하세요.');
      const device = { deviceId, householdId: input.householdId, gatewayId: input.gatewayId, label: text(input.label, '기기 이름', 80), registeredAt: prior?.registeredAt ?? this.clock() };
      await this.store.put('portalDevices', deviceId, device);
      await this.event(principal, input.householdId, 'DEVICE_REGISTERED', `${device.label} 기기가 등록되었습니다.`, { deviceId });
      return device;
    });
  }

  createConsent(principal, input) {
    this.household(principal, input.householdId, true);
    if (!Array.isArray(input.scopes) || input.scopes.some((value) => !['bubble:command', 'location:read', 'mec:location', 'mec:rnis', 'fl:participate'].includes(value))) throw new Error('사용자 동의 범위에서 제공하는 기능을 선택하세요.');
    return this.mutate(principal, 'consent.create', input, async () => {
      const consent = await this.policyService.createConsent({ principal, subjectId: input.householdId, purpose: input.purpose, scopes: input.scopes, ttlSec: input.ttlSec });
      await this.event(principal, input.householdId, 'PORTAL_CONSENT_CREATED', '새 동의가 저장되었습니다.', { consentId: consent.consentId });
      return consent;
    });
  }

  createGrant(principal, input) {
    const consent = this.store.get('consents', identifier(input.consentId));
    this.household(principal, consent?.subjectId, true);
    return this.mutate(principal, 'grant.create', input, async () => {
      const grant = await this.policyService.createGrant({ principal, consentId: input.consentId, scopes: input.scopes, ttlSec: input.ttlSec, purpose: input.purpose });
      await this.event(principal, consent.subjectId, 'PORTAL_GRANT_CREATED', '승인 권한이 발급되었습니다.', { grantId: grant.grantId });
      return grant;
    });
  }

  revokeConsent(principal, input) {
    this.policyService.authorize(principal, 'consent:write');
    const consent = this.store.get('consents', identifier(input.consentId));
    this.household(principal, consent?.subjectId, true);
    if (consent.principalId !== principal.principalId) throw new Error('동의 소유자 권한을 확인하세요.');
    return this.mutate(principal, 'consent.revoke', input, async () => this.store.transaction(`consent:${consent.consentId}`, async () => {
      const current = this.store.get('consents', consent.consentId);
      if (current.status === 'REVOKED') return current;
      const next = { ...current, status: 'REVOKED', revision: current.revision + 1, revokedAt: this.clock(), revokeReason: text(input.reason ?? '보호자 동의 회수', '회수 사유') };
      await this.store.put('consents', consent.consentId, next);
      await this.event(principal, consent.subjectId, 'CONSENT_REVOKED', '동의가 회수되어 연결된 권한이 종료되었습니다.', { consentId: consent.consentId });
      return next;
    }));
  }

  revokeGrant(principal, input) {
    const grant = this.store.get('grants', identifier(input.grantId));
    this.household(principal, grant?.subjectId, true);
    return this.mutate(principal, 'grant.revoke', input, async () => {
      const result = await this.policyService.revokeGrant({ principal, grantId: input.grantId, reason: input.reason });
      await this.event(principal, grant.subjectId, 'PORTAL_GRANT_REVOKED', '명령 승인 권한이 회수되었습니다.', { grantId: grant.grantId });
      return result;
    });
  }

  createIncident(principal, input) {
    this.policyService.authorize(principal, 'incident:write');
    this.household(principal, input.householdId);
    return this.mutate(principal, 'incident.create', input, async (key) => {
      if (input.deviceId && this.store.get('portalDevices', identifier(input.deviceId))?.householdId !== input.householdId) throw new Error('가구에 연결된 기기를 선택하세요.');
      if (!['HELP', 'LOST', 'SAFETY'].includes(input.kind)) throw new Error('도움·분실·안전 요청 유형을 선택하세요.');
      const incident = { incidentId: `incident-${key.slice(0,24)}`, householdId: input.householdId, deviceId: input.deviceId ?? null, kind: input.kind, message: text(input.message, '요청 내용'), status: 'OPEN', createdBy: principal.principalId, createdAt: this.clock() };
      await this.store.put('portalIncidents', incident.incidentId, incident);
      await this.event(principal, incident.householdId, 'INCIDENT_OPENED', '새 안전 요청이 도착했습니다.', { incidentId: incident.incidentId, deviceId: incident.deviceId });
      return incident;
    });
  }

  resolveIncident(principal, input) {
    this.policyService.authorize(principal, 'incident:resolve');
    const incident = this.store.get('portalIncidents', identifier(input.incidentId));
    this.household(principal, incident?.householdId, true);
    return this.mutate(principal, 'incident.resolve', input, async () => {
      const next = { ...incident, status: 'RESOLVED', resolvedAt: this.clock(), resolvedBy: principal.principalId };
      await this.store.put('portalIncidents', incident.incidentId, next);
      await this.event(principal, incident.householdId, 'INCIDENT_RESOLVED', '안전 요청 처리가 완료되었습니다.', { incidentId: incident.incidentId });
      return next;
    });
  }

  requestCommand(principal, input) {
    this.policyService.authorize(principal, 'command:request');
    this.household(principal, input.householdId);
    return this.mutate(principal, 'command.request', input, async (key) => {
      if (!Array.isArray(input.deviceIds) || input.deviceIds.length < 1 || input.deviceIds.length > 16 || new Set(input.deviceIds).size !== input.deviceIds.length) throw new Error('1~16개 기기를 선택하세요.');
      for (const deviceId of input.deviceIds) if (this.store.get('portalDevices', identifier(deviceId))?.householdId !== input.householdId) throw new Error('가구에 연결된 기기를 선택하세요.');
      if (!input.desiredState || Object.keys(input.desiredState).join() !== 'state' || typeof input.desiredState.state !== 'boolean') throw new Error('기기 목표 상태를 확인하세요.');
      const ttlSec = input.ttlSec ?? 300;
      if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > 900) throw new Error('요청 유효기간은 1~900초로 설정하세요.');
      const request = { requestId: `request-${key.slice(0,24)}`, householdId: input.householdId, deviceIds: [...input.deviceIds], desiredState: { state: input.desiredState.state }, reason: text(input.reason, '명령 요청 사유'), requestedBy: principal.principalId, requestedAt: this.clock(), expiresAt: new Date(Date.parse(this.clock()) + ttlSec * 1000).toISOString(), status: 'PENDING', commands: [] };
      await this.store.put('portalCommandRequests', request.requestId, request);
      await this.event(principal, request.householdId, 'COMMAND_APPROVAL_REQUESTED', '기기 명령 승인을 기다리고 있습니다.', { requestId: request.requestId });
      return request;
    });
  }

  approveCommand(principal, input) {
    this.policyService.authorize(principal, 'bubble:command');
    const request = this.store.get('portalCommandRequests', identifier(input.requestId));
    this.household(principal, request?.householdId, true);
    return this.mutate(principal, 'command.approve', input, async () => {
      const current = this.store.get('portalCommandRequests', input.requestId);
      if (!['PENDING', 'PARTIAL'].includes(current.status)) throw new Error('승인 대기 중인 요청을 선택하세요.');
      const decision = this.policyService.evaluateGrant(input.grantId, { scope: 'bubble:command' });
      if (!decision.allowed || decision.grant.principalId !== principal.principalId || decision.grant.subjectId !== current.householdId) throw new Error('현재 가구의 유효한 명령 승인 권한을 확인하세요.');
      if (Date.parse(current.expiresAt) <= Date.parse(this.clock())) throw new Error('새 명령 요청으로 유효기간을 갱신하세요.');
      const deadline = new Date(Math.min(Date.parse(current.expiresAt), Date.parse(decision.grant.expiresAt))).toISOString();
      const commands = [];
      try {
        for (const deviceId of current.deviceIds) {
          const device = this.store.get('portalDevices', deviceId);
          const commandId = `portal-${approvalHash({ requestId: current.requestId, deviceId }).slice(0,32)}`;
          commands.push(await this.gatewayControl.issue({ principal, gatewayId: device.gatewayId, deviceId, commandId, grantId: input.grantId, desiredState: current.desiredState, deadline }));
        }
      } catch (error) {
        if (commands.length > 0) {
          await this.store.put('portalCommandRequests', current.requestId, { ...current, status: 'PARTIAL', commands, approvalError: error.message });
          await this.event(principal, current.householdId, 'COMMAND_APPROVAL_PARTIAL', '일부 명령이 전달 대기 중입니다. 남은 기기 상태를 확인하세요.', { requestId: current.requestId, queuedCount: commands.length });
        }
        throw error;
      }
      const result = { ...current, status: 'QUEUED', approvedBy: principal.principalId, approvedAt: this.clock(), grantId: input.grantId, approvalHash: approvalHash({ requestId: current.requestId, principalId: principal.principalId, grantId: input.grantId, commands }), commands };
      await this.store.put('portalCommandRequests', current.requestId, result);
      await this.event(principal, current.householdId, 'COMMAND_APPROVED_QUEUED', '명령이 승인되어 Gateway 전달을 기다리고 있습니다.', { requestId: current.requestId, approvalHash: result.approvalHash });
      return result;
    });
  }

  readNotification(principal, input) {
    const notification = this.store.get('portalNotifications', identifier(input.notificationId));
    if (!notification || notification.principalId !== principal.principalId) throw new Error('본인 알림을 선택하세요.');
    this.household(principal, notification.householdId);
    return this.mutate(principal, 'notification.read', input, async () => {
      const next = { ...notification, readAt: notification.readAt ?? this.clock() };
      await this.store.put('portalNotifications', notification.notificationId, next);
      return next;
    });
  }

  async handle({ method, path, principal, body = {} }) {
    if (method === 'GET' && path === '/v1/portal/snapshot') return { status: 200, body: this.snapshot(principal) };
    if (method === 'GET' && path === '/v1/portal/location-access') return { status: 200, body: this.locationAccess(principal) };
    if(method==='POST'&&this.locationPrivacy){
      const actions={'/v1/portal/location-leases':'createLease','/v1/portal/location-leases/revoke':'revokeLease','/v1/portal/relay-associations':'approveAssociation'};
      if(Object.hasOwn(actions,path))return {status:200,body:await this.locationPrivacy[actions[path]](principal,body)};
    }
    const actions = {
      households: 'createHousehold', devices: 'registerDevice', consents: 'createConsent', grants: 'createGrant',
      'consents/revoke': 'revokeConsent', 'grants/revoke': 'revokeGrant', incidents: 'createIncident', 'incidents/resolve': 'resolveIncident',
      'commands/request': 'requestCommand', 'commands/approve': 'approveCommand', 'notifications/read': 'readNotification',
    };
    const actionKey = path.replace(/^\/v1\/portal\//, '');
    const action = Object.hasOwn(actions, actionKey) ? actions[actionKey] : null;
    if (method !== 'POST' || !action) return { status: 404, body: { error: 'portal_route_required' } };
    return { status: 200, body: await this[action](principal, body) };
  }
}
