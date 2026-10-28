import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupDispatcher } from '../src/group-dispatcher.mjs';

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
