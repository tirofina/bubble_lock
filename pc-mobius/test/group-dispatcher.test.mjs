import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupDispatcher } from '../src/group-dispatcher.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeBridge {
  constructor() { this.commands = []; this.listeners = []; }
  onAck(listener) { this.listeners.push(listener); return () => {}; }
  async sendCommand(command) { this.commands.push(command); return { status: 'DISPATCHED', commandId: command.commandId }; }
  async emitAck(commandId, deviceId, ackState) {
    for (const listener of this.listeners) await listener({ commandId, deviceId, ackState, status: 'ACK_RECORDED', timestamp: '2026-10-28T00:00:01.000Z' });
  }
}

test('GroupDispatcher fans out a command and settles member readback', async () => {
  const bridge = new FakeBridge();
  const dispatcher = new GroupDispatcher({
    bridge,
    members: {
      keyringA: { deviceId: 'keyring-A', gatewayId: 'pi-01', groupId: 'household' },
      keyringB: { deviceId: 'keyring-B', gatewayId: 'pi-01', groupId: 'household' }
    },
    clock: () => '2026-10-28T00:00:00.000Z'
  });
  const dispatched = await dispatcher.dispatch({ groupId: 'household', state: true, commandId: 'grp-001', deadline: '2026-10-28T00:01:00.000Z', epoch: 2 });
  assert.equal(dispatched.status, 'IN_FLIGHT');
  assert.equal(dispatched.memberCount, 2);
  assert.deepEqual(bridge.commands.map((command) => command.commandId), ['grp-001:keyringA', 'grp-001:keyringB']);
  await bridge.emitAck('grp-001:keyringA', 'keyring-A', 'READBACK_VERIFIED');
  await bridge.emitAck('grp-001:keyringB', 'keyring-B', 'READBACK_VERIFIED');
  const settled = dispatcher.summary('grp-001');
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.appliedCount, 2);
});

test('GroupDispatcher retries the member whose ACK remains pending', async () => {
  const bridge = new FakeBridge();
  const dispatcher = new GroupDispatcher({
    bridge,
    members: { keyringA: { deviceId: 'keyring-A', gatewayId: 'pi-01', groupId: 'household' }, keyringB: { deviceId: 'keyring-B', gatewayId: 'pi-01', groupId: 'household' } },
    clock: () => '2026-10-28T00:00:00.000Z'
  });
  await dispatcher.dispatch({ groupId: 'household', state: false, commandId: 'grp-002', deadline: '2026-10-28T00:01:00.000Z', epoch: 4 });
  await bridge.emitAck('grp-002:keyringA', 'keyring-A', 'READBACK_VERIFIED');
  const retried = await dispatcher.retryPending('grp-002');
  assert.equal(retried.status, 'IN_FLIGHT');
  assert.equal(bridge.commands.length, 3);
  assert.equal(bridge.commands.at(-1).commandId, 'grp-002:keyringB');
});

test('GroupDispatcher forwards issued member claims and keeps retry payloads identical', async () => {
  const bridge = new FakeBridge();
  const dispatcher = new GroupDispatcher({ bridge, clock: () => '2026-10-28T00:00:00.000Z', members: { one: { deviceId: 'keyring-1', gatewayId: 'pi-01', groupId: 'household' } } });
  const command = { version: 1, gatewayId: 'pi-01', deviceId: 'keyring-1', commandId: 'issued-command-1', claimId: 'claim-issued-1', desiredState: { state: true }, issuedAt: '2026-10-28T00:00:00.000Z', deadline: '2026-10-28T00:01:00.000Z', grantRevision: 2, ownershipEpoch: 3 };
  await dispatcher.dispatch({ groupId: 'household', state: true, commandId: 'group-claim', memberCommands: { one: command } });
  await dispatcher.retryPending('group-claim');
  assert.deepEqual(bridge.commands, [command, command]);
  await bridge.emitAck(command.commandId, 'other-device', 'READBACK_VERIFIED');
  assert.equal(dispatcher.summary('group-claim').status, 'IN_FLIGHT');
  await bridge.emitAck(command.commandId, command.deviceId, 'READBACK_VERIFIED');
  assert.equal(dispatcher.summary('group-claim').status, 'SETTLED');
  await bridge.emitAck(command.commandId, command.deviceId, 'RECEIVED');
  assert.equal(dispatcher.summary('group-claim').status, 'SETTLED');
});

test('GroupDispatcher keeps immediate ACKs while fan-out is publishing', async () => {
  const bridge = new FakeBridge();
  const dispatcher = new GroupDispatcher({ bridge, clock: () => '2026-10-28T00:00:00.000Z', members: { one: { deviceId: 'keyring-1', gatewayId: 'pi-01', groupId: 'household' } } });
  bridge.sendCommand = async (command) => {
    await bridge.emitAck(command.commandId, command.deviceId, 'READBACK_VERIFIED');
    return { status: 'DISPATCHED' };
  };
  const result = await dispatcher.dispatch({ groupId: 'household', state: true, commandId: 'instant', deadline: '2026-10-28T00:01:00.000Z', epoch: 1 });
  assert.equal(result.status, 'SETTLED');
});

const durableMembers={one:{deviceId:'keyring-1',gatewayId:'pi-01',groupId:'household'},two:{deviceId:'keyring-2',gatewayId:'pi-01',groupId:'household'}};
const durableCommand={groupId:'household',state:true,commandId:'durable',deadline:'2026-11-10T09:00:00.000Z',epoch:2};
const durableClock=()=> '2026-11-10T08:00:00.000Z';

test('한 구성원의 송신 오류 뒤 다음 구성원 전송과 부분 readback을 보존',async()=>{
  const bridge=new FakeBridge();
  bridge.sendCommand=async(command)=>{bridge.commands.push(command);if(command.deviceId==='keyring-1')throw Error('offline');await bridge.emitAck(command.commandId,command.deviceId,'READBACK_VERIFIED');};
  const dispatcher=new GroupDispatcher({bridge,members:durableMembers,clock:durableClock});
  const result=await dispatcher.dispatch(durableCommand);
  assert.equal(result.appliedCount,1);assert.equal(bridge.commands.length,2);
  assert.equal(result.members[0].status,'RETRY_PENDING');assert.equal(result.members[0].error,'offline');
  assert.equal(result.members[1].status,'READBACK_VERIFIED');
});

test('재시작 뒤 확인한 구성원을 보존하고 남은 동일 명령만 동시 재시도',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'bubble-group-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const statePath=join(dir,'state.json');const first=new FakeBridge();
  const dispatcher=new GroupDispatcher({bridge:first,members:durableMembers,clock:durableClock,statePath});
  await dispatcher.dispatch(durableCommand);await first.emitAck('durable:one','keyring-1','READBACK_VERIFIED');dispatcher.close();
  const next=new FakeBridge();const recovered=new GroupDispatcher({bridge:next,members:durableMembers,clock:durableClock,statePath});
  await recovered.ready;
  assert.equal(recovered.summary('durable').appliedCount,1);
  await Promise.all([recovered.retryPending('durable'),recovered.retryPending('durable')]);
  assert.deepEqual(next.commands,[first.commands[1]]);
  await next.emitAck('durable:two','keyring-2','READBACK_VERIFIED');
  const last=new GroupDispatcher({bridge:new FakeBridge(),members:durableMembers,clock:durableClock,statePath});await last.ready;
  assert.equal(last.summary('durable').status,'SETTLED');
});

test('재시도 직전 현재 권한·마감·기기 재바인딩을 검사',async()=>{
  let allowed=true;let now=durableClock();const bridge=new FakeBridge();
  const dispatcher=new GroupDispatcher({bridge,members:durableMembers,clock:()=>now,authorizeCommand:()=>({allowed})});
  await dispatcher.dispatch(durableCommand);
  allowed=false;await dispatcher.retryPending('durable');assert.equal(bridge.commands.length,2);
  allowed=true;now='2026-11-10T09:00:01.000Z';await dispatcher.retryPending('durable');assert.equal(bridge.commands.length,2);
  assert.match(dispatcher.summary('durable').members[0].error,/유효기간/);
  const rebound=new GroupDispatcher({bridge,members:durableMembers,clock:durableClock});await rebound.dispatch({...durableCommand,commandId:'rebound'});
  rebound.members.set('one',{...durableMembers.one,deviceId:'replacement'});
  await rebound.retryPending('rebound');assert.equal(bridge.commands.filter((command)=>command.commandId==='rebound:one').length,1);
});
