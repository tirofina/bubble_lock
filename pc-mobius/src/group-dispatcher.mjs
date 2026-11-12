import { IntegrationStore } from '../integration/src/integration-store.mjs';
const ACK_STATES=new Set(['RECEIVED','FORWARDED','APPLIED','READBACK_VERIFIED','RETRY_PENDING']);

export class GroupDispatcher {
  constructor({ bridge, members, clock = () => new Date().toISOString(), maxRetries = 2, statePath = null, store = null, authorizeCommand = null }) {
    if (!bridge || typeof bridge.sendCommand !== 'function') throw new Error('GroupDispatcher requires a GatewayBridge');
    if (typeof bridge.onAck !== 'function') throw new Error('GroupDispatcher requires GatewayBridge ACK events');
    this.bridge = bridge;
    this.members = new Map(Object.entries(members ?? {}));
    this.clock = clock;
    this.maxRetries = maxRetries;
    this.groups = new Map();
    this.store=store ?? new IntegrationStore(statePath);
    this.authorizeCommand=authorizeCommand;
    this.retryLocks=new Map();
    this.ready=this.store.init().then(()=>{
      for(const saved of this.store.list('groupCommands'))this.groups.set(saved.commandId,{...saved,members:new Map(saved.members)});
    });
    this.unsubscribe = bridge.onAck((receipt) => this.handleAck(receipt));
  }

  async persist(entry){await this.store.put('groupCommands',entry.commandId,{...entry,members:[...entry.members.entries()]});}
  close(){this.unsubscribe();}

  async dispatch({ groupId, state, commandId, deadline, epoch, claimId, grantRevision, issuedAt, memberCommands = null }) {
    await this.ready;
    if(typeof state!=='boolean'||typeof commandId!=='string'||!commandId)throw Error('Group 상태와 명령 식별자를 확인하세요.');
    const groupMembers = [...this.members.entries()].filter(([memberId, member]) => (member.groupId === groupId || member.groups?.includes(groupId)) && (!memberCommands || Object.hasOwn(memberCommands, memberId)));
    if (groupMembers.length === 0) throw new Error(`Group ${groupId} has no registered members`);
    if (memberCommands && groupMembers.length !== Object.keys(memberCommands).length) throw new Error('Every canonical member requires a registered group binding');
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
    await this.persist(entry);
    await this.sendMembers(entry, [...entry.members.values()]);
    this.refreshStatus(entry);
    await this.persist(entry);
    return this.summary(commandId);
  }

  async sendMember(entry,member) {
    member.attempts += 1;
    member.status = 'DISPATCHED';
    delete member.error;
    await this.persist(entry);
    try {
      await this.authorizeMember(entry, member);
      await this.bridge.sendCommand(member.command);
    } catch (error) {
      if(member.status!=='READBACK_VERIFIED'){member.status = 'RETRY_PENDING';member.error = error.message;}
    }
    await this.persist(entry);
  }

  async authorizeMember(entry, member) {
    const binding = this.members.get(member.memberId);
    if (!binding || binding.deviceId !== member.deviceId || binding.gatewayId !== member.gatewayId || (binding.groupId !== entry.groupId && !binding.groups?.includes(entry.groupId))) throw Error('현재 그룹 구성원 연결을 확인하세요.');
    const deadline = member.command.deadline ?? entry.deadline;
    if (typeof deadline !== 'string' || !Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.parse(this.clock())) throw Error('명령 유효기간이 종료되었습니다.');
    if (this.authorizeCommand) {
      const decision = await this.authorizeCommand(structuredClone(member.command));
      if (decision !== true && decision?.allowed !== true) throw Error('현재 명령 실행 권한을 확인하세요.');
    }
  }

  async sendMembers(entry, members) {
    if (!this.bridge.sendCommands) {
      for (const member of members) await this.sendMember(entry, member);
      return;
    }
    const admitted = [];
    for (const member of members) {
      member.attempts += 1;
      delete member.error;
      try {
        await this.authorizeMember(entry, member);
        member.status = 'DISPATCHED';
        admitted.push(member);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        member.status = 'RETRY_PENDING';
        member.error = error.message;
      }
    }
    await this.persist(entry);
    if (!admitted.length) return;
    try {
      const results = await this.bridge.sendCommands(admitted.map((member) => structuredClone(member.command)), entry.commandId);
      for (const member of admitted) {
        const result = results.find((item) => item.commandId === member.memberCommandId);
        if (!result?.published && member.status !== 'READBACK_VERIFIED') {
          member.status = 'RETRY_PENDING';
          member.error = result?.error ?? 'CSE member publication receipt required';
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      for (const member of admitted) if (member.status !== 'READBACK_VERIFIED') {
        member.status = 'RETRY_PENDING';
        member.error = error.message;
      }
    }
    await this.persist(entry);
  }

  refreshStatus(entry) {
    entry.status = [...entry.members.values()].every((item) => item.status === 'READBACK_VERIFIED') ? 'SETTLED' : 'IN_FLIGHT';
  }

  async handleAck(receipt) {
    await this.ready;
    if(!ACK_STATES.has(receipt.ackState))return receipt;
    for (const entry of this.groups.values()) {
      const member = [...entry.members.values()].find((item) => item.memberCommandId === receipt.commandId);
      if (!member || member.deviceId !== receipt.deviceId || (receipt.gatewayId && member.gatewayId !== receipt.gatewayId)) continue;
      if (member.status === 'READBACK_VERIFIED') return receipt;
      member.status = receipt.ackState;
      member.ackTimestamp = receipt.timestamp;
      this.refreshStatus(entry);
      await this.persist(entry);
      return receipt;
    }
    return receipt;
  }

  async retryPending(commandId) {
    await this.ready;
    const prior=this.retryLocks.get(commandId);if(prior)return prior;
    const pending=this.retryGroup(commandId).finally(()=>this.retryLocks.delete(commandId));
    this.retryLocks.set(commandId,pending);return pending;
  }

  async retryGroup(commandId) {
    const entry = this.groups.get(commandId);
    if (!entry) throw new Error(`Group command ${commandId} is not registered`);
    if (entry.attempts >= this.maxRetries + 1) return this.summary(commandId);
    await this.sendMembers(entry, [...entry.members.values()].filter((member) => member.status !== 'READBACK_VERIFIED' && member.attempts < this.maxRetries + 1));
    entry.attempts += 1;
    this.refreshStatus(entry);
    await this.persist(entry);
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
