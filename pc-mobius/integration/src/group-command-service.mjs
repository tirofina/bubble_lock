import { GroupDispatcher } from '../../src/group-dispatcher.mjs';
import { memberKey } from '../../src/onem2m-group-fanout.mjs';
import { approvalHash, recordEnvelope } from './integration-utils.mjs';

const groupName = (householdId) => `${householdId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 52)}-switches`;
const ACK_BY_EXECUTION = { APPLIED_VERIFIED: 'READBACK_VERIFIED', SETTLED_CANCELLED: 'RETRY_PENDING', DISPATCH_UNCERTAIN: 'FORWARDED' };

/**
 * Household-wide guardian command through a oneM2M <group> fanOutPoint.
 *
 * 1. ensure <grp> (mt=28, mid = each keyring's cod:binSh flexContainer, macp, et = grant expiry)
 * 2. one UPDATE to <grp>/fopt and per-member rsc from m2m:agr
 * 3. per accepted member, GatewayControl issues the canonical claim
 *    (claimId, grantRevision, ownershipEpoch, deadline, payloadHash) for Gateway/BLE/ACK
 * 4. failed members stay RETRY_PENDING; GroupDispatcher(retryScope 'failed') re-sends only them
 * 5. Gateway receipt -> device readback + CSE readback + ACK contentInstance per member
 */
export class HouseholdGroupCommandService {
  constructor({ store, gatewayControl, policyService, fanout, groupParent, memberResources = {}, ackContainers = {}, auditContainer = null, macp = null, acpi = null, clock = () => new Date().toISOString(), maxRetries = 2, ackRetentionSec = 86400 }) {
    if (!store || !gatewayControl || !policyService || !fanout) throw new Error('Group 명령 서비스 구성 요소를 확인하세요.');
    Object.assign(this, { store, gatewayControl, policyService, fanout, clock, ackRetentionSec });
    this.groupParent = fanout.path(groupParent);
    this.memberResources = Object.fromEntries(Object.entries(memberResources).map(([deviceId, path]) => [deviceId, fanout.path(path)]));
    this.ackContainers = Object.fromEntries(Object.entries(ackContainers).map(([deviceId, path]) => [deviceId, fanout.path(path)]));
    this.auditContainer = auditContainer ? fanout.path(auditContainer) : null;
    this.macp = macp; this.acpi = acpi;
    this.ackListeners = new Set();
    const bridge = {
      fanOut: (input) => this.fanOutMembers(input),
      sendCommand: (command) => this.sendMember(command),
      onAck: (listener) => { this.ackListeners.add(listener); return () => this.ackListeners.delete(listener); },
    };
    this.dispatcher = new GroupDispatcher({ bridge, members: {}, clock, maxRetries, store, retryScope: 'failed', authorizeCommand: (command) => this.authorizeMember(command) });
    this.ready = this.dispatcher.ready.then(() => { for (const context of this.store.list('groupCommandContexts')) this.syncMembers(context); });
    this.unsubscribe = gatewayControl.onReceipt((event) => this.handleReceipt(event));
    this.pending = new Set();
  }

  close() { this.unsubscribe(); this.dispatcher.close(); }

  memberPath(deviceId) {
    const path = this.memberResources[deviceId];
    if (!path) throw new Error(`기기 ${deviceId}의 binarySwitch 자원 연결을 확인하세요.`);
    return path;
  }

  // GroupDispatcher membership mirrors the current household devices and Gateway binding.
  syncMembers(context) {
    const current = this.store.list('portalDevices').filter((device) => device.householdId === context.householdId);
    for (const [memberId, member] of [...this.dispatcher.members.entries()]) if (member.groupId === context.groupId && !current.some((device) => device.deviceId === memberId)) this.dispatcher.members.delete(memberId);
    for (const device of current) this.dispatcher.members.set(device.deviceId, { deviceId: device.deviceId, gatewayId: device.gatewayId, groupId: context.groupId });
  }

  context(groupCommandId) {
    const context = this.store.get('groupCommandContexts', groupCommandId);
    if (!context) throw new Error('Group 명령 기록을 확인하세요.');
    return context;
  }

  memberContext(commandId) {
    const link = this.store.get('groupMemberCommands', commandId);
    const context = link && this.store.get('groupCommandContexts', link.groupCommandId);
    const member = context?.members[link.deviceId];
    if (!member) throw new Error('Group 구성원 명령 연결을 확인하세요.');
    return { context, member };
  }

  async authorizeMember(command) {
    const { context } = this.memberContext(command.commandId);
    const decision = this.policyService.evaluateGrant(context.grantId, { scope: 'bubble:command' });
    return { allowed: Boolean(decision.allowed && decision.grant.principalId === context.principal.principalId && decision.grant.subjectId === context.householdId) };
  }

  async approve({ principal, request, grantId, deadline }) {
    await this.ready;
    const groupCommandId = `group-${approvalHash({ requestId: request.requestId }).slice(0, 32)}`;
    if (this.store.get('groupCommandContexts', groupCommandId)) return this.summary(groupCommandId);
    const decision = this.policyService.evaluateGrant(grantId, { scope: 'bubble:command' });
    if (!decision.allowed || decision.grant.subjectId !== request.householdId) throw new Error('현재 가구의 유효한 명령 승인 권한을 확인하세요.');
    const state = request.desiredState.state;
    const members = request.deviceIds.map((deviceId) => {
      const device = this.store.get('portalDevices', deviceId);
      if (!device || device.householdId !== request.householdId) throw new Error('가구에 연결된 기기를 선택하세요.');
      return { deviceId, gatewayId: device.gatewayId, path: this.memberPath(deviceId), memberCommandId: `portal-${approvalHash({ requestId: request.requestId, deviceId }).slice(0, 32)}` };
    });
    const groupId = groupName(request.householdId);
    const group = await this.fanout.ensureGroup({ parent: this.groupParent, rn: groupId, members, macp: this.macp, acpi: this.acpi, et: decision.grant.expiresAt, lbl: [`pb-household:${request.householdId}`] });
    const context = { groupCommandId, requestId: request.requestId, householdId: request.householdId, groupId, groupPath: group.path, groupRi: group.ri,
      group: { mt: group.mt, mtv: group.mtv, cnm: group.cnm, mnm: group.mnm, csy: group.csy, mid: group.mid, macp: group.macp, et: group.et, created: group.created, updated: group.updated },
      principal: { principalId: principal.principalId, scopes: [...(principal.scopes ?? [])] }, grantId, deadline, state, createdAt: this.clock(), fanouts: [], retries: [],
      members: Object.fromEntries(members.map((member) => [member.deviceId, member])) };
    await this.store.put('groupCommandContexts', groupCommandId, context);
    for (const member of members) await this.store.put('groupMemberCommands', member.memberCommandId, { groupCommandId, deviceId: member.deviceId });
    this.syncMembers(context);
    const memberCommands = Object.fromEntries(members.map((member) => [member.deviceId, { version: 1, gatewayId: member.gatewayId, deviceId: member.deviceId, commandId: member.memberCommandId, desiredState: { state }, deadline }]));
    await this.dispatcher.dispatch({ groupId, state, commandId: groupCommandId, deadline, memberCommands });
    return this.summary(groupCommandId);
  }

  async retry(groupCommandId) {
    await this.ready;
    const context = this.context(groupCommandId);
    this.syncMembers(context);
    await this.dispatcher.retryPending(groupCommandId);
    return this.summary(groupCommandId);
  }

  async issueClaim(context, intent) {
    const command = await this.gatewayControl.issue({ principal: context.principal, gatewayId: intent.gatewayId, deviceId: intent.deviceId, commandId: intent.commandId, grantId: context.grantId, desiredState: { state: intent.desiredState.state }, deadline: intent.deadline });
    return { command, payloadHash: this.store.get('gatewayCommands', command.commandId)?.payloadHash ?? approvalHash(command) };
  }

  async audit(context, content) {
    if (!this.auditContainer) return null;
    const et = new Date(Date.parse(context.deadline) + this.ackRetentionSec * 1000).toISOString();
    const written = await this.fanout.appendInstance(this.auditContainer, content, { et });
    return { rsc: written.rsc, ri: written.ri, et: written.et };
  }

  async fanOutMembers({ commandId, state, members }) {
    const context = this.context(commandId);
    const result = await this.fanout.fanOut(context.groupPath, state);
    const byKey = new Map(Object.values(context.members).map((member) => [memberKey(member.path), member.deviceId]));
    const answers = new Map();
    for (const answer of result.members) { const deviceId = byKey.get(answer.fr); if (deviceId) answers.set(deviceId, answer); }
    const outcome = {};
    for (const member of members) {
      const answer = answers.get(member.memberId);
      if (!answer) { outcome[member.memberId] = { ok: false, rsc: null, error: result.aggregateRsc === 2000 ? 'GROUP_FANOUT_MEMBER_RESULT_MISSING' : `GROUP_FANOUT_RSC_${result.aggregateRsc ?? result.transportError}` }; continue; }
      if (!answer.ok) { outcome[member.memberId] = { ok: false, rsc: answer.rsc, error: `CSE_MEMBER_RSC_${answer.rsc}` }; continue; }
      try { outcome[member.memberId] = { ok: true, rsc: answer.rsc, ...await this.issueClaim(context, member.command) }; }
      catch (error) { outcome[member.memberId] = { ok: false, rsc: answer.rsc, error: `CLAIM_${error.message}` }; }
    }
    const record = { operation: 'GROUP_FOPT_UPDATE', at: this.clock(), groupPath: context.groupPath, fopt: `${context.groupPath}/fopt`, request: result.request, aggregateRsc: result.aggregateRsc, requestId: result.rqi, rqiMatches: result.rqiMatches,
      memberResults: members.map((member) => ({ deviceId: member.memberId, fr: answers.get(member.memberId)?.fr ?? null, rsc: outcome[member.memberId].rsc, ok: outcome[member.memberId].ok, error: outcome[member.memberId].error ?? null, claimId: outcome[member.memberId].command?.claimId ?? null })) };
    record.auditInstance = await this.audit(context, { type: 'GROUP_FANOUT', groupCommandId: commandId, requestId: context.requestId, state, aggregateRsc: result.aggregateRsc, members: record.memberResults.map(({ deviceId, rsc, claimId }) => ({ deviceId, rsc, claimId })) });
    await this.store.put('groupCommandContexts', commandId, { ...this.context(commandId), fanouts: [...this.context(commandId).fanouts, record] });
    await this.store.append('receipts', recordEnvelope({ owner: 'PC-MOBIUS-INTEGRATION', type: 'GROUP_FANOUT_SENT', groupCommandId: commandId, requestId: context.requestId, householdId: context.householdId, groupPath: context.groupPath, aggregateRsc: result.aggregateRsc, memberResults: record.memberResults }, this.clock));
    return outcome;
  }

  // Retry path for one failed member: direct UPDATE of that member's flexContainer, then its claim.
  async sendMember(command) {
    const { context, member } = this.memberContext(command.commandId);
    const updated = await this.fanout.updateMember(member.path, command.desiredState.state);
    let outcome;
    try {
      if (!updated.ok) throw Object.assign(new Error(`CSE_MEMBER_RSC_${updated.rsc}`), { rsc: updated.rsc });
      outcome = { rsc: updated.rsc, ...await this.issueClaim(context, command) };
      return outcome;
    } finally {
      const record = { operation: 'GROUP_MEMBER_RETRY_UPDATE', at: this.clock(), deviceId: member.deviceId, path: member.path, rsc: updated.rsc, requestId: updated.rqi, ok: Boolean(outcome), claimId: outcome?.command?.claimId ?? null };
      await this.store.put('groupCommandContexts', context.groupCommandId, { ...this.context(context.groupCommandId), retries: [...this.context(context.groupCommandId).retries, record] });
      await this.store.append('receipts', recordEnvelope({ owner: 'PC-MOBIUS-INTEGRATION', type: 'GROUP_MEMBER_RETRY', groupCommandId: context.groupCommandId, ...record }, this.clock));
    }
  }

  handleReceipt(event) {
    const job = this.processReceipt(event);
    this.pending.add(job); job.finally(() => this.pending.delete(job));
    return job;
  }

  async idle() { await this.gatewayControl.drainReceiptListeners(); while (this.pending.size) await Promise.allSettled([...this.pending]); }

  async processReceipt(event) {
    await this.ready;
    const link = this.store.get('groupMemberCommands', event.commandId);
    if (!link) return null;
    const { context, member } = this.memberContext(event.commandId);
    if (member.deviceId !== event.deviceId || member.gatewayId !== event.gatewayId) return null;
    const ackState = ACK_BY_EXECUTION[event.executionState];
    if (!ackState) return null;
    const read = await this.fanout.readMember(member.path);
    const cseReadback = { rsc: read.rsc, state: read.state, envelope: read.envelope, matchesDesired: read.state === context.state, readAt: this.clock() };
    const ackContainer = this.ackContainers[member.deviceId];
    if (ackContainer) {
      const et = new Date(Date.parse(this.clock()) + this.ackRetentionSec * 1000).toISOString();
      const written = await this.fanout.appendInstance(ackContainer, { groupCommandId: context.groupCommandId, commandId: event.commandId, claimId: event.claimId, payloadHash: event.payloadHash, grantRevision: event.grantRevision, ownershipEpoch: event.ownershipEpoch, executionState: event.executionState, ackCode: event.ackCode, readback: event.readback, cseState: read.state, receiptHash: event.receiptHash }, { et });
      cseReadback.ackInstance = { container: ackContainer, rsc: written.rsc, ri: written.ri, et: written.et };
    }
    const ack = { commandId: event.commandId, deviceId: event.deviceId, gatewayId: event.gatewayId, ackState, timestamp: this.clock(), readback: event.readback, cseReadback, ...(ackState === 'RETRY_PENDING' ? { error: `DEVICE_${event.ackCode}` } : {}) };
    for (const listener of this.ackListeners) await listener(ack);
    return ack;
  }

  summary(groupCommandId) {
    const context = this.context(groupCommandId);
    const summary = this.dispatcher.summary(groupCommandId);
    return { ...summary, requestId: context.requestId, householdId: context.householdId, groupPath: context.groupPath, groupRi: context.groupRi, fanoutPoint: `${context.groupPath}/fopt`, group: context.group,
      members: summary.members.map((member) => ({ ...member, path: context.members[member.memberId]?.path })), fanouts: context.fanouts, retries: context.retries };
  }
}
