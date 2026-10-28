export class GroupDispatcher {
  constructor({ bridge, members, clock = () => new Date().toISOString(), maxRetries = 2 }) {
    if (!bridge || typeof bridge.sendCommand !== 'function') throw new Error('GroupDispatcher requires a GatewayBridge');
    if (!bridge.onAck || typeof bridge.onAck !== 'function') throw new Error('GroupDispatcher requires GatewayBridge ACK events');
    this.bridge = bridge;
    this.members = new Map(Object.entries(members ?? {}));
    this.clock = clock;
    this.maxRetries = maxRetries;
    this.groups = new Map();
    this.unsubscribe = bridge.onAck((receipt) => this.handleAck(receipt));
  }

  async dispatch({ groupId, state, commandId, deadline, epoch }) {
    const groupMembers = [...this.members.entries()].filter(([, member]) => member.groupId === groupId || member.groups?.includes(groupId));
    if (groupMembers.length === 0) throw new Error(`Group ${groupId} has no registered members`);
    const entry = {
      groupId,
      commandId,
      state,
      deadline,
      epoch,
      attempts: 0,
      status: 'DISPATCHING',
      createdAt: this.clock(),
      members: new Map()
    };
    this.groups.set(commandId, entry);
    for (const [memberId, member] of groupMembers) {
      const memberCommandId = `${commandId}:${memberId}`;
      const receipt = await this.bridge.sendCommand({ deviceId: member.deviceId, state, commandId: memberCommandId, deadline, epoch });
      entry.members.set(memberId, { memberId, memberCommandId, deviceId: member.deviceId, gatewayId: member.gatewayId, status: receipt.status, attempts: 1 });
    }
    entry.attempts = 1;
    entry.status = 'IN_FLIGHT';
    return this.summary(commandId);
  }

  async handleAck(receipt) {
    const separator = receipt.commandId.lastIndexOf(':');
    if (separator < 1) return receipt;
    const commandId = receipt.commandId.slice(0, separator);
    const memberId = receipt.commandId.slice(separator + 1);
    const entry = this.groups.get(commandId);
    if (!entry || !entry.members.has(memberId)) return receipt;
    const member = entry.members.get(memberId);
    member.status = receipt.ackState;
    member.ackTimestamp = receipt.timestamp;
    entry.status = [...entry.members.values()].every((item) => item.status === 'READBACK_VERIFIED') ? 'SETTLED' : 'IN_FLIGHT';
    return receipt;
  }

  async retryPending(commandId) {
    const entry = this.groups.get(commandId);
    if (!entry) throw new Error(`Group command ${commandId} is not registered`);
    if (entry.attempts >= this.maxRetries + 1) return this.summary(commandId);
    for (const member of entry.members.values()) {
      if (member.status === 'READBACK_VERIFIED') continue;
      await this.bridge.sendCommand({ deviceId: member.deviceId, state: entry.state, commandId: member.memberCommandId, deadline: entry.deadline, epoch: entry.epoch });
      member.attempts += 1;
      member.status = 'DISPATCHED';
    }
    entry.attempts += 1;
    entry.status = 'IN_FLIGHT';
    return this.summary(commandId);
  }

  summary(commandId) {
    const entry = this.groups.get(commandId);
    if (!entry) throw new Error(`Group command ${commandId} is not registered`);
    const members = [...entry.members.values()].map((member) => ({ ...member }));
    return {
      contractId: 'privacy-bubble.group-dispatch',
      groupId: entry.groupId,
      commandId: entry.commandId,
      state: entry.state,
      status: entry.status,
      attempts: entry.attempts,
      memberCount: members.length,
      appliedCount: members.filter((member) => member.status === 'READBACK_VERIFIED').length,
      members,
      timestamp: this.clock()
    };
  }
}
