import { approvalHash, id, recordEnvelope } from './integration-utils.mjs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import receiptSchema from '../../../contracts/keyring/receipt.schema.json' with { type: 'json' };

const receiptAjv = new Ajv2020({ strict: false, allErrors: true }); addFormats(receiptAjv); const validateReceipt = receiptAjv.compile(receiptSchema);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const AUTH_FIELDS = ['commandId', 'deviceId', 'claimId', 'grantRevision', 'ownershipEpoch', 'payloadHash'];
const REJECTED_CODES = new Set(['REJECTED_EPOCH', 'REJECTED_GRANT', 'EXPIRED', 'CONFLICT', 'INVALID', 'JOURNAL_FULL', 'CLOCK_UNTRUSTED', 'CREDENTIAL_UNKNOWN', 'CREDENTIAL_LOST', 'CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED', 'NOT_AUTHORIZED', 'DISPATCH_NOT_SENT', 'STALE_EPOCH', 'STALE_GRANT']);
const identifier = (value) => {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Valid gateway/device/command identity required');
  return value;
};

export class GatewayControl {
  constructor({ store, policyService, handoverCoordinator, clock }) {
    Object.assign(this, { store, policyService, handoverCoordinator, clock });
    this.issuance = Promise.resolve();
    this.pollOffsets = new Map();
    const authorize = this.authorize.bind(this);
    this.authorize = (...args) => this.store.transaction(`gateway:authorize:${args[0]}`, () => authorize(...args));
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
    const current = this.store.get('gateways', gatewayId);
    // Restarting trusted provisioning preserves an established loss/revocation.
    if (current && ['LOST', 'REVOKED'].includes(current.status)) return current;
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

  active(record, gateway, { publication = false } = {}) {
    const { command, grantId } = record;
    const decision = this.policyService.evaluateGrant(grantId, { scope: 'bubble:command' });
    const consent = decision.grant && this.store.get('consents', decision.grant.consentId);
    const now = Date.parse(this.clock());
    const handover = this.handoverCoordinator.status(command.deviceId);
    const ready = !handover || ['ACTIVE', 'ROLLED_BACK'].includes(handover.state);
    return ready && (!record.groupRequestId || publication || record.groupCsePublished === true)
      && gateway.status === 'ACTIVE' && decision.allowed && consent?.status === 'ACTIVE'
      && !['SETTLED_CANCELLED', 'APPLIED_VERIFIED'].includes(record.executionState)
      && Date.parse(consent.expiresAt) > now && consent.revision === command.grantRevision
      && decision.grant.revision === command.grantRevision
      && decision.grant.subjectId === gateway.devices[command.deviceId]
      && record.credentialRevision === gateway.credentialRevision
      && (record.desiredGeneration ?? 0) >= (this.store.get('deviceGenerationFences', command.deviceId)?.generation ?? 0)
      && this.epoch(gateway, command.deviceId) === command.ownershipEpoch
      && Date.parse(record.claimExpiresAt ?? record.reservationExpiresAt ?? command.deadline) > now
      && Date.parse(command.issuedAt) <= now && Date.parse(command.deadline) > now;
  }

  issue(input) {
    const next = this.issuance.then(() => this.store.transaction(`gateway:claim:${input.commandId}`, () => this.issueOnce(input)));
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
      if (prior.intentHash !== intentHash || !this.active(prior, gateway, { publication: true })) throw new Error('Command identity requires the original active intent');
      return prior.command;
    }
    const command = { version: 1, gatewayId, deviceId, commandId, claimId: id('claim'), desiredState,
      issuedAt, deadline: intent.deadline, grantRevision: decision.grant.revision,
      ownershipEpoch: this.epoch(gateway, deviceId) };
    const reservationExpiresAt = new Date(Math.min(maxExpiry, expiry, Date.parse(issuedAt) + 5000)).toISOString();
    const desiredGeneration = (this.store.get('deviceDesiredGenerations', deviceId)?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(desiredGeneration)) throw new Error('GATEWAY_GENERATION_ROTATION_REQUIRED');
    const record = { command, desiredGeneration, grantId, intentHash, payloadHash: approvalHash(command), credentialRevision: gateway.credentialRevision, executionState: 'RESERVED', reservedAt: issuedAt, reservationExpiresAt };
    if (!this.active(record, gateway)) throw new Error('Active gateway/grant/epoch required');
    await this.store.put('deviceDesiredGenerations', deviceId, { deviceId, generation: desiredGeneration, commandId, reservedAt: issuedAt });
    await this.store.put('gatewayCommands', commandId, record);
    await this.store.append('receipts', recordEnvelope({ owner: 'PC-MOBIUS-INTEGRATION', type: 'GATEWAY_COMMAND_ISSUED', gatewayId, deviceId, commandId, claimId: command.claimId, payloadHash: record.payloadHash, desiredGeneration, grantId, executionState: record.executionState, reservedAt: issuedAt, reservationExpiresAt }, this.clock));
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
    const exact = Boolean(record && record.command.gatewayId === gatewayId && AUTH_FIELDS.every((key) => body[key] === (key === 'payloadHash' ? record.payloadHash : record.command[key])));
    const now = this.clock();
    const reservationDeadline = record?.reservationExpiresAt ?? (record && new Date(Math.min(Date.parse(record.command.deadline), Date.parse(record.command.issuedAt) + 5000)).toISOString());
    const claimDeadline = record?.claimExpiresAt ?? reservationDeadline;
    let allowed = Boolean(exact && this.active(record, gateway) && Date.parse(claimDeadline) > Date.parse(now));
    if (allowed && this.handoverCoordinator.admitDispatch) {
      try { await this.handoverCoordinator.admitDispatch({ ueId: body.deviceId, commandId: body.commandId, claimId: body.claimId, epoch: body.ownershipEpoch, payloadHash: body.payloadHash, desiredState: record.command.desiredState, desiredGeneration: record.desiredGeneration ?? 0 }); }
      catch { allowed = false; }
    }
    if (exact) {
      if (allowed) {
        record.executionState = record.dispatchStartedAt ? 'IN_FLIGHT' : 'DISPATCH_CLAIMED'; record.claimCommittedAt ??= now; record.claimExpiresAt ??= claimDeadline;
        await this.store.put('dispatchOutbox', `${body.commandId}:${body.deviceId}`, { commandId: body.commandId, memberLogicalId: body.deviceId, claimId: body.claimId, payloadHash: body.payloadHash, desiredGeneration: record.desiredGeneration ?? 0, deadline: record.claimExpiresAt, state: record.dispatchStartedAt ? 'IN_FLIGHT' : 'PENDING', claimCommittedAt: record.claimCommittedAt, ...(record.dispatchStartedAt ? { dispatchStartedAt: record.dispatchStartedAt } : {}) });
      } else if (!['SETTLED_CANCELLED', 'APPLIED_VERIFIED'].includes(record.executionState) && (!this.active(record, gateway, { publication: true }) || Date.parse(claimDeadline) <= Date.parse(now))) {
        record.executionState = record.claimCommittedAt ? 'DISPATCH_UNCERTAIN' : 'SETTLED_CANCELLED';
        record.settlementReason = Date.parse(claimDeadline) <= Date.parse(now) ? 'EXPIRED' : 'CURRENT_POLICY';
        if (!record.claimCommittedAt) record.settledAt = now;
        const outbox = this.store.get('dispatchOutbox', `${body.commandId}:${body.deviceId}`);
        if (outbox) await this.store.put('dispatchOutbox', `${body.commandId}:${body.deviceId}`, { ...outbox, state: record.executionState });
      }
      await this.store.put('gatewayCommands', body.commandId, record);
    }
    const response = { allowed, ...body, expiresAt: allowed ? record.claimExpiresAt : null };
    await this.store.append('receipts', recordEnvelope({ owner: 'PC-MOBIUS-INTEGRATION', type: 'GATEWAY_COMMAND_AUTHORIZED', gatewayId, ...response, desiredGeneration: exact ? record.desiredGeneration : undefined, executionState: exact ? record.executionState : undefined, claimCommittedAt: exact ? record.claimCommittedAt : undefined, reason: exact ? record.settlementReason : 'IDENTITY_SCOPE' }, this.clock));
    return response;
  }

  async dispatchStart(gatewayId, principal, body) {
    return this.store.transaction(`gateway:authorize:${gatewayId}`, async () => {
      this.authenticate(gatewayId, principal);
      const previous = this.store.get('gatewayCommands', body?.commandId);
      if (!previous?.claimCommittedAt) throw new Error('GATEWAY_DISPATCH_CLAIM_REQUIRED');
      const response = await this.authorize(gatewayId, principal, body);
      if (!response.allowed) return response;
      const record = this.store.get('gatewayCommands', body.commandId);
      const dispatchStartedAt = previous.dispatchStartedAt ?? this.clock();
      await this.store.put('gatewayCommands', body.commandId, { ...record, executionState: 'IN_FLIGHT', dispatchStartedAt });
      const key = `${body.commandId}:${body.deviceId}`; const outbox = this.store.get('dispatchOutbox', key);
      await this.store.put('dispatchOutbox', key, { ...outbox, state: 'IN_FLIGHT', dispatchStartedAt });
      if (!previous.dispatchStartedAt) await this.store.append('receipts', recordEnvelope({ type: 'GATEWAY_DISPATCH_STARTED', gatewayId, ...body, desiredGeneration: record.desiredGeneration, executionState: 'IN_FLIGHT', dispatchStartedAt, claimCommittedAt: record.claimCommittedAt }, this.clock));
      return response;
    });
  }

  async receiveReceipt(gatewayId, principal, receipt) {
    const gateway = this.authenticate(gatewayId, principal);
    if (!validateReceipt(receipt) || receipt.gatewayId !== gatewayId || !gateway.devices[receipt.deviceId]) throw new Error('GATEWAY_RECEIPT_SCHEMA');
    return this.store.transaction(`gateway:receipt:${receipt.commandId}`, async () => {
      const record = this.store.get('gatewayCommands', receipt.commandId); const command = record?.command;
      if (!command || command.gatewayId !== gatewayId || command.deviceId !== receipt.deviceId || record.payloadHash !== receipt.payloadHash || command.ownershipEpoch !== receipt.ownershipEpoch || command.grantRevision !== receipt.grantRevision) throw new Error('GATEWAY_RECEIPT_BINDING');
      const received = Date.parse(receipt.receivedAt); const accepted = receipt.acceptedAt === null ? null : Date.parse(receipt.acceptedAt); const applied = receipt.appliedAt === null ? null : Date.parse(receipt.appliedAt);
      if (received > Date.parse(this.clock()) + 2000 || received < Date.parse(command.issuedAt) || accepted !== null && (accepted > received || accepted < Date.parse(command.issuedAt)) || applied !== null && (accepted === null || applied < accepted || applied > received)) throw new Error('GATEWAY_RECEIPT_TIME');
      const receiptHash = approvalHash(receipt); const prior = this.store.get('gatewayDeviceReceipts', receipt.commandId);
      if (prior?.receiptHash === receiptHash || record.lastReceiptHash === receiptHash) return { status: 'DUPLICATE', commandId: command.commandId, claimId: command.claimId, receiptHash, executionState: record.executionState };
      if (record.executionState === 'APPLIED_VERIFIED' || record.executionState === 'SETTLED_CANCELLED' && record.lastReceiptHash) throw new Error('GATEWAY_RECEIPT_CONFLICT');
      const binding = { ueId: command.deviceId, commandId: command.commandId, claimId: command.claimId, epoch: command.ownershipEpoch, payloadHash: record.payloadHash, desiredGeneration: record.desiredGeneration ?? 0 };
      if (receipt.status === 'APPLIED') {
        if (!record.claimCommittedAt || !['APPLIED', 'DUPLICATE'].includes(receipt.ackCode) || receipt.readback?.state !== command.desiredState.state || !receipt.bootId || !receipt.firmwareRevision) throw new Error('GATEWAY_RECEIPT_READBACK');
        await this.handoverCoordinator.settleDispatch({ ...binding, ackState: 'READBACK_VERIFIED', readback: receipt.readback });
      } else {
        const cancelled = receipt.status === 'REJECTED' && receipt.appliedAt === null && REJECTED_CODES.has(receipt.ackCode);
        if (receipt.status === 'REJECTED' && !cancelled && receipt.ackCode !== 'ALREADY_DISPATCHED') throw new Error('GATEWAY_RECEIPT_REJECTION');
        const next = { ...record, executionState: cancelled ? 'SETTLED_CANCELLED' : 'DISPATCH_UNCERTAIN', settlementReason: receipt.ackCode, ...(cancelled ? { settledAt: this.clock() } : {}) };
        await this.store.put('gatewayCommands', command.commandId, next);
        const key = `${command.deviceId}:${command.claimId}`; const lane = this.store.get('dispatchLanes', key);
        if (cancelled && lane?.commandId === command.commandId && lane.payloadHash === record.payloadHash) await this.store.put('dispatchLanes', key, { ...lane, state: 'SETTLED', outcome: 'SETTLED_CANCELLED', settledAt: this.clock() });
        const outbox = this.store.get('dispatchOutbox', `${command.commandId}:${command.deviceId}`);
        if (outbox) await this.store.put('dispatchOutbox', `${command.commandId}:${command.deviceId}`, { ...outbox, state: next.executionState });
      }
      const current = this.store.get('gatewayCommands', command.commandId);
      await this.store.put('gatewayCommands', command.commandId, { ...current, lastReceiptHash: receiptHash, deviceAcceptedAt: receipt.acceptedAt, deviceAppliedAt: receipt.appliedAt, ackObservedAt: this.clock(), timestampSource: receipt.timestampSource });
      await this.store.put('gatewayDeviceReceipts', command.commandId, { receiptHash, receipt, receivedAt: this.clock() });
      await this.store.append('receipts', recordEnvelope({ type: 'GATEWAY_RECEIPT_SETTLED', gatewayId, ...binding, executionState: current.executionState, receiptHash, deviceAppliedAt: receipt.appliedAt, ackObservedAt: this.clock() }, this.clock));
      return { status: 'ACCEPTED', commandId: command.commandId, claimId: command.claimId, receiptHash, executionState: current.executionState };
    });
  }
}
