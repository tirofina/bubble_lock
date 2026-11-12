import { GroupDispatcher } from '../../src/group-dispatcher.mjs';
import { encodeBinarySwitch } from '../../src/sdt-adapter.mjs';
import { OneM2mEdgeClient } from './handover-cse.mjs';
import { approvalHash, recordEnvelope } from './integration-utils.mjs';

/** CSE publication is admission to the existing canonical Gateway queue, never a device ACK. */
export class GroupRuntime {
  constructor({ store, gatewayControl, clock, fetchImpl, cse, members, maxRetries = 2 }) {
    Object.assign(this, { store, gatewayControl, clock });
    this.client = new OneM2mEdgeClient({ ...cse, fetchImpl });
    this.parentPath = cse.parentPath;
    this.client.url(this.parentPath);
    this.members = members;
    this.dispatches = new Map();
    const paths = new Set();
    for (const [deviceId, member] of Object.entries(members)) {
      if (member.deviceId !== deviceId || !member.gatewayId || !member.groupId) throw new Error('Group device/gateway/household binding required');
      this.client.url(member.resourcePath);
      if (paths.has(member.resourcePath)) throw new Error('Each group member requires a distinct CSE resource');
      paths.add(member.resourcePath);
    }
    const bridge = {
      onAck: () => () => {},
      sendCommand: async (command) => this.publish([command], command.commandId),
      sendCommands: (commands, commandId) => this.publish(commands, commandId),
    };
    this.dispatcher = new GroupDispatcher({ bridge, members, store, clock, maxRetries,
      authorizeCommand: (command) => this.authorize(command) });
    this.ready = this.dispatcher.ready;
  }

  validateRequest(request) {
    for (const deviceId of request.deviceIds) {
      const member = this.members[deviceId];
      const device = this.store.get('portalDevices', deviceId);
      if (!member || member.groupId !== request.householdId || member.gatewayId !== device?.gatewayId) throw new Error('Current portal/CSE group member binding required');
    }
  }

  authorize(command) {
    const record = this.store.get('gatewayCommands', command.commandId);
    const member = this.members[command.deviceId];
    const device = this.store.get('portalDevices', command.deviceId);
    return Boolean(record && record.payloadHash === approvalHash(command) && member?.gatewayId === command.gatewayId
      && device?.gatewayId === member.gatewayId && device.householdId === member.groupId
      && this.gatewayControl.active(record, this.gatewayControl.gateway(command.gatewayId), { publication: true }));
  }

  dispatch(request, retry = false) {
    const prior = this.dispatches.get(request.requestId);
    if (prior) return prior;
    const operation = this.dispatchOnce(request, retry).finally(() => this.dispatches.delete(request.requestId));
    this.dispatches.set(request.requestId, operation);
    return operation;
  }

  async dispatchOnce(request, retry) {
    await this.ready;
    this.validateRequest(request);
    if (!request.commands.length || request.status !== 'QUEUED') throw new Error('Complete canonical portal approval required');
    if (!this.dispatcher.groups.has(request.requestId)) {
      return this.dispatcher.dispatch({ groupId: request.householdId, commandId: request.requestId, state: request.desiredState.state,
        memberCommands: Object.fromEntries(request.commands.map((command) => [command.deviceId, command])) });
    }
    await this.reconcile(request.requestId);
    return retry ? this.dispatcher.retryPending(request.requestId) : this.dispatcher.summary(request.requestId);
  }

  async publish(commands, commandId) {
    const results = commands.filter((command) => this.store.get('gatewayCommands', command.commandId)?.groupCsePublished)
      .map((command) => ({ commandId: command.commandId, published: true }));
    const pending = commands.filter((command) => !results.some((result) => result.commandId === command.commandId));
    if (!pending.length) return results;
    const paths = pending.map((command) => this.members[command.deviceId].resourcePath.replace(/^\//, ''));
    const rn = `group-${approvalHash({ commandId, paths }).slice(0, 32)}`;
    const group = await this.client.ensure(this.parentPath, 9, { 'm2m:grp': {
      rn, mt: 28, mnm: paths.length, mid: paths, csy: 1,
    } }, { update: false });
    if (approvalHash(group.body['m2m:grp'].mid) !== approvalHash(paths)) throw new Error('CSE group membership must match approved canonical members');
    // Provisioning may take time. Recheck every member before the actual fanout request.
    if (!pending.every((command) => this.authorize(command))) throw new Error('Current canonical authorization required before CSE fanout');
    const response = await this.client.request('PUT', `${group.path}/fopt`, encodeBinarySwitch({ state: pending[0].desiredState.state }));
    const aggregate = response.payload?.['m2m:agr']?.['m2m:rsp'];
    if (!Array.isArray(aggregate) || aggregate.length !== pending.length) throw new Error('Complete CSE member aggregate required');
    for (const [index, command] of pending.entries()) {
      const matched = aggregate.filter((item) => item.fr?.replace(/^\//, '') === paths[index]);
      const published = matched.length === 1 && matched[0].rsc === 2004;
      await this.store.transaction(`group:publication:${command.commandId}`, async () => {
        const record = this.store.get('gatewayCommands', command.commandId);
        if (!record || record.payloadHash !== approvalHash(command)) throw new Error('Canonical publication payload binding required');
        await this.store.put('gatewayCommands', command.commandId, { ...record,
          ...(published ? { groupCsePublished: true, groupCsePublishedAt: this.clock() } : {}),
          groupCseRsc: matched[0]?.rsc ?? null, groupCsePath: group.path });
        await this.store.append('receipts', recordEnvelope({ type: 'GROUP_CSE_MEMBER_PUBLISHED', groupId: this.members[command.deviceId].groupId,
          groupCommandId: commandId, commandId: command.commandId, deviceId: command.deviceId, claimId: command.claimId,
          payloadHash: record.payloadHash, grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch,
          deadline: command.deadline, resourcePath: paths[index], foptPath: `${group.path}/fopt`,
          rsc: matched[0]?.rsc ?? null, published }, this.clock));
      });
      results.push({ commandId: command.commandId, published, ...(published ? {} : { error: `CSE member response ${matched[0]?.rsc ?? 'missing'}` }) });
    }
    return results;
  }

  async reconcile(requestId) {
    await this.ready;
    const entry = this.dispatcher.groups.get(requestId);
    if (!entry) throw new Error('Durable group command required');
    for (const member of entry.members.values()) {
      const record = this.store.get('gatewayCommands', member.memberCommandId);
      if (record?.executionState === 'APPLIED_VERIFIED') await this.dispatcher.handleAck({
        commandId: member.memberCommandId, deviceId: member.deviceId, gatewayId: member.gatewayId,
        ackState: 'READBACK_VERIFIED', timestamp: record.ackObservedAt ?? this.clock(),
      });
    }
    return this.dispatcher.summary(requestId);
  }

  async receiveReceipt(commandId) {
    await this.ready;
    for (const entry of this.dispatcher.groups.values()) {
      if ([...entry.members.values()].some((member) => member.memberCommandId === commandId)) return this.reconcile(entry.commandId);
    }
  }

  close() { this.dispatcher.close(); }
}
