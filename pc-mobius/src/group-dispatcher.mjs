export class GroupDispatcher {
  constructor({ bridge, members, clock = () => new Date().toISOString(), maxRetries = 2 }) {
    if (!bridge || typeof bridge.sendCommand !== 'function') throw new Error('GroupDispatcher requires a GatewayBridge');
    if (typeof bridge.onAck !== 'function') throw new Error('GroupDispatcher requires GatewayBridge ACK events');
    this.bridge = bridge;
    this.members = new Map(Object.entries(members ?? {}));
    this.clock = clock;
    this.maxRetries = maxRetries;
    this.groups = new Map();
    this.unsubscribe = bridge.onAck((receipt) => this.handleAck(receipt));
  }

  async dispatch({ groupId, state, commandId, deadline, epoch, claimId, grantRevision, issuedAt, memberCommands = null }) {
    const groupMembers = [...this.members.entries()].filter(([, member]) => member.groupId === groupId || member.groups?.includes(groupId));
    if (groupMembers.length === 0) throw new Error(`Group ${groupId} has no registered members`);
    if (this.groups.has(commandId)) throw new Error('Group commandId is already registered; use retryPending');
    const entry = { groupId, commandId, state, deadline, epoch, attempts: 1, status: 'DISPATCHING', createdAt: this.clock(), members: new Map() };
    // Prepare all member identities before publishing, including immediate ACKs.
    for (const [memberId, member] of groupMembers) {
      let command;
      if (memberCommands) {
        command = memberCommands[memberId];
        if (!command || command.version !== 1 || command.deviceId !== member.deviceId || command.gatewayId !== member.gatewayId
            || command.desiredState?.state !== state) throw new Error(`Canonical command binding required for member ${memberId}`);
        command = structuredClone(command);
      } else {
        command = { deviceId: member.deviceId, state, commandId: `${commandId}:${memberId}`, deadline, epoch, issuedAt: issuedAt ?? entry.createdAt };
        if (claimId !== undefined) command.claimId = claimId;
        if (grantRevision !== undefined) command.grantRevision = grantRevision;
      }
      if (this.bridge.gatewayId && member.gatewayId !== this.bridge.gatewayId) throw new Error(`GatewayBridge binding required for member ${memberId}`);
      if ([...entry.members.values()].some((item) => item.memberCommandId === command.commandId)) throw new Error('Each member requires a distinct commandId');
      entry.members.set(memberId, { memberId, memberCommandId: command.commandId, deviceId: member.deviceId, gatewayId: member.gatewayId, status: 'PENDING', attempts: 0, command });
    }
    this.groups.set(commandId, entry);
    for (const member of entry.members.values()) await this.sendMember(member);
    this.refreshStatus(entry);
    return this.summary(commandId);
  }

  async sendMember(member) {
    member.attempts += 1;
    member.status = 'DISPATCHED';
    try {
      await this.bridge.sendCommand(member.command);
    } catch (error) {
      member.status = 'RETRY_PENDING';
      member.error = error.message;
      throw error;
    }
  }

  refreshStatus(entry) {
    entry.status = [...entry.members.values()].every((item) => item.status === 'READBACK_VERIFIED') ? 'SETTLED' : 'IN_FLIGHT';
  }

  async handleAck(receipt) {
    for (const entry of this.groups.values()) {
      const member = [...entry.members.values()].find((item) => item.memberCommandId === receipt.commandId);
      if (!member || member.deviceId !== receipt.deviceId || (receipt.gatewayId && member.gatewayId !== receipt.gatewayId)) continue;
      if (member.status === 'READBACK_VERIFIED') return receipt;
      member.status = receipt.ackState;
      member.ackTimestamp = receipt.timestamp;
      this.refreshStatus(entry);
      return receipt;
    }
    return receipt;
  }

  async retryPending(commandId) {
    const entry = this.groups.get(commandId);
    if (!entry) throw new Error(`Group command ${commandId} is not registered`);
    if (entry.attempts >= this.maxRetries + 1) return this.summary(commandId);
    for (const member of entry.members.values()) {
      if (member.status !== 'READBACK_VERIFIED') await this.sendMember(member);
    }
    entry.attempts += 1;
    this.refreshStatus(entry);
    return this.summary(commandId);
  }

  summary(commandId) {
    const entry = this.groups.get(commandId);
    if (!entry) throw new Error(`Group command ${commandId} is not registered`);
    const members = [...entry.members.values()].map(({ command, ...member }) => ({ ...member }));
    return { contractId: 'privacy-bubble.group-dispatch', groupId: entry.groupId, commandId: entry.commandId,
      state: entry.state, status: entry.status, attempts: entry.attempts, memberCount: members.length,
      appliedCount: members.filter((member) => member.status === 'READBACK_VERIFIED').length, members, timestamp: this.clock() };
  }
}
