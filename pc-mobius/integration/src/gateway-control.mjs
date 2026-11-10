import { approvalHash, id, recordEnvelope } from './integration-utils.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const AUTH_FIELDS = ['commandId', 'deviceId', 'claimId', 'grantRevision', 'ownershipEpoch', 'payloadHash'];
const identifier = (value) => {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Valid gateway/device/command identity required');
  return value;
};

export class GatewayControl {
  constructor({ store, policyService, handoverCoordinator, clock }) {
    Object.assign(this, { store, policyService, handoverCoordinator, clock });
    this.issuance = Promise.resolve();
    this.pollOffsets = new Map();
  }

  // Provisioning uses the trusted server configuration, including the verified certificate identity.
  async enroll({ gatewayId, principalId, fingerprint, devices, credentialRevision, status = 'ACTIVE', ownershipEpoch = 0 }) {
    identifier(gatewayId);
    identifier(principalId);
    if (!fingerprint || typeof credentialRevision !== 'string' || credentialRevision.length < 1 || credentialRevision.length > 64) throw new Error('Credential identity required');
    if (!['ACTIVE', 'LOST', 'REVOKED'].includes(status)) throw new Error('Valid credential status required');
    if (!Number.isInteger(ownershipEpoch) || ownershipEpoch < 0 || ownershipEpoch > 2147483647) throw new Error('Valid ownership epoch required');
    if (!devices || typeof devices !== 'object' || Array.isArray(devices) || !Object.keys(devices).length) throw new Error('Enrolled devices required');
    for (const [deviceId, subjectId] of Object.entries(devices)) { identifier(deviceId); identifier(subjectId); }
    return this.store.put('gateways', gatewayId, { gatewayId, principalId, fingerprint, devices, credentialRevision, status, ownershipEpoch });
  }

  gateway(gatewayId) {
    const gateway = this.store.get('gateways', identifier(gatewayId));
    if (!gateway) throw new Error('Enrolled gateway required');
    return gateway;
  }

  authenticate(gatewayId, principal) {
    const gateway = this.gateway(gatewayId);
    if (principal?.principalId !== gateway.principalId || principal.mtlsFingerprint !== gateway.fingerprint) throw new Error('Gateway certificate binding required');
    return gateway;
  }

  credentialStatus(gatewayId, principal) {
    const gateway = this.authenticate(gatewayId, principal);
    return { gatewayId, credentialRevision: gateway.credentialRevision, status: gateway.status };
  }

  epoch(gateway, deviceId) {
    return Math.max(this.handoverCoordinator.status(deviceId)?.epoch ?? 0, gateway.ownershipEpoch);
  }

  active(record, gateway) {
    const { command, grantId } = record;
    const decision = this.policyService.evaluateGrant(grantId, { scope: 'bubble:command' });
    const consent = decision.grant && this.store.get('consents', decision.grant.consentId);
    const now = Date.parse(this.clock());
    const handover = this.handoverCoordinator.status(command.deviceId);
    const ready = !handover || ['ACTIVE', 'ROLLED_BACK'].includes(handover.state);
    return ready && gateway.status === 'ACTIVE' && decision.allowed && consent?.status === 'ACTIVE'
      && Date.parse(consent.expiresAt) > now && consent.revision === command.grantRevision
      && decision.grant.revision === command.grantRevision
      && decision.grant.subjectId === gateway.devices[command.deviceId]
      && record.credentialRevision === gateway.credentialRevision
      && this.epoch(gateway, command.deviceId) === command.ownershipEpoch
      && Date.parse(command.issuedAt) <= now && Date.parse(command.deadline) > now;
  }

  issue(input) {
    const next = this.issuance.then(() => this.issueOnce(input));
    this.issuance = next.catch(() => {});
    return next;
  }

  async issueOnce({ principal, gatewayId, deviceId, commandId, grantId, desiredState, deadline }) {
    this.policyService.authorize(principal, 'bubble:command');
    identifier(deviceId); identifier(commandId);
    const gateway = this.gateway(gatewayId);
    const decision = this.policyService.evaluateGrant(grantId, { scope: 'bubble:command' });
    if (!decision.allowed || decision.grant.principalId !== principal.principalId || decision.grant.subjectId !== gateway.devices[deviceId]) throw new Error('Current subject grant required');
    if (!desiredState || Object.keys(desiredState).join() !== 'state' || typeof desiredState.state !== 'boolean') throw new Error('Boolean desiredState.state required');
    const issuedAt = this.clock();
    const expiry = Date.parse(deadline);
    const consent = this.store.get('consents', decision.grant.consentId);
    const maxExpiry = Math.min(Date.parse(decision.grant.expiresAt), Date.parse(consent?.expiresAt));
    if (!Number.isFinite(expiry) || expiry <= Date.parse(issuedAt) || expiry > maxExpiry) throw new Error('Command deadline must fit the active grant and consent');
    desiredState = { state: desiredState.state };
    const intent = { gatewayId, deviceId, commandId, grantId, desiredState, deadline: new Date(expiry).toISOString() };
    const intentHash = approvalHash(intent);
    const prior = this.store.get('gatewayCommands', commandId);
    if (prior) {
      if (prior.intentHash !== intentHash || !this.active(prior, gateway)) throw new Error('Command identity requires the original active intent');
      return prior.command;
    }
    const command = { version: 1, gatewayId, deviceId, commandId, claimId: id('claim'), desiredState,
      issuedAt, deadline: intent.deadline, grantRevision: decision.grant.revision,
      ownershipEpoch: this.epoch(gateway, deviceId) };
    const record = { command, grantId, intentHash, payloadHash: approvalHash(command), credentialRevision: gateway.credentialRevision };
    if (!this.active(record, gateway)) throw new Error('Active gateway/grant/epoch required');
    await this.store.put('gatewayCommands', commandId, record);
    await this.store.append('receipts', recordEnvelope({ owner: 'PC-MOBIUS-INTEGRATION', type: 'GATEWAY_COMMAND_ISSUED', gatewayId, deviceId, commandId, claimId: command.claimId, payloadHash: record.payloadHash, grantId }, this.clock));
    return command;
  }

  poll(gatewayId, principal, limit = 16) {
    const gateway = this.authenticate(gatewayId, principal);
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error('Command limit must be 1..16');
    const active = this.store.list('gatewayCommands').filter((record) => record.command.gatewayId === gatewayId && this.active(record, gateway));
    if (!active.length) return { commands: [] };
    const offset = (this.pollOffsets.get(gatewayId) ?? 0) % active.length;
    const window = [...active.slice(offset), ...active.slice(0, offset)].slice(0, limit);
    this.pollOffsets.set(gatewayId, (offset + window.length) % active.length);
    return { commands: window.map(({ command }) => structuredClone(command)) };
  }

  async authorize(gatewayId, principal, body) {
    const gateway = this.authenticate(gatewayId, principal);
    if (!body || Object.keys(body).length !== AUTH_FIELDS.length || AUTH_FIELDS.some((key) => !(key in body))) throw new Error('Authorization request fields required');
    identifier(body.commandId); identifier(body.deviceId); identifier(body.claimId);
    if (typeof body.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.payloadHash)
        || !Number.isInteger(body.grantRevision) || body.grantRevision < 1 || body.grantRevision > 2147483647
        || !Number.isInteger(body.ownershipEpoch) || body.ownershipEpoch < 0 || body.ownershipEpoch > 2147483647) throw new Error('Authorization binding required');
    const record = this.store.get('gatewayCommands', body.commandId);
    const allowed = Boolean(record && record.command.gatewayId === gatewayId
      && AUTH_FIELDS.every((key) => body[key] === (key === 'payloadHash' ? record.payloadHash : record.command[key]))
      && this.active(record, gateway));
    const response = { allowed, ...body, expiresAt: allowed ? record.command.deadline : null };
    await this.store.append('receipts', recordEnvelope({ owner: 'PC-MOBIUS-INTEGRATION', type: 'GATEWAY_COMMAND_AUTHORIZED', gatewayId, ...response }, this.clock));
    return response;
  }
}
