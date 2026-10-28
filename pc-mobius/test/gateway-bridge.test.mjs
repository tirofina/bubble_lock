import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayBridge } from '../src/gateway-bridge.mjs';

class FakeMqtt {
  constructor() { this.subscriptions = []; this.published = []; this.listeners = []; }
  async subscribe(topic, options) { this.subscriptions.push({ topic, options }); }
  async publish(topic, payload, options) { this.published.push({ topic, payload: JSON.parse(payload), options }); }
  on(event, listener) { if (event === 'message') this.listeners.push(listener); }
  async emit(topic, payload) { for (const listener of this.listeners) await listener(topic, Buffer.from(JSON.stringify(payload))); }
}

function response(status, body = '{}') { return { status, text: async () => body }; }

test('GatewayBridge maps Raspberry Pi telemetry to oneM2M state and deduplicates sequence', async () => {
  const mqtt = new FakeMqtt();
  const calls = [];
  const bridge = new GatewayBridge({
    mqttClient: mqtt,
    baseUrl: 'http://127.0.0.1:7599',
    originator: 'pb-core-admin-local',
    gatewayId: 'pi-01',
    clock: () => '2026-10-28T00:00:00.000Z',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response(200, '{"m2m:fcnt":{"state":false}}'); }
  });
  await bridge.start();
  const telemetry = { deviceId: 'keyring-01', sequence: 7, timestamp: '2026-10-28T00:00:00.000Z', state: false, batteryPct: 91, rssiDbm: -47, schemaVersion: '1.0.0' };
  const applied = await bridge.handleTelemetry(telemetry);
  const duplicate = await bridge.handleTelemetry(telemetry);
  assert.equal(applied.status, 'APPLIED');
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['X-M2M-RVI'], '4');
  assert.equal(JSON.parse(calls[0].init.body)['pb:binarySwitch'].state, false);
  assert.deepEqual(mqtt.subscriptions.map((item) => item.topic), [
    'privacy-bubble/gateway/pi-01/telemetry', 'privacy-bubble/gateway/pi-01/ack'
  ]);
});

test('GatewayBridge publishes command and settles it with ACK/readback', async () => {
  const mqtt = new FakeMqtt();
  const bridge = new GatewayBridge({ mqttClient: mqtt, baseUrl: 'http://127.0.0.1:7599', originator: 'pb-core-admin-local', gatewayId: 'pi-01' });
  await bridge.start();
  const command = await bridge.sendCommand({ deviceId: 'keyring-01', state: true, commandId: 'cmd-007', deadline: '2026-10-28T00:01:00.000Z', epoch: 3 });
  const ack = await bridge.handleAck({ deviceId: 'keyring-01', commandId: 'cmd-007', ackState: 'READBACK_VERIFIED', timestamp: '2026-10-28T00:00:01.000Z' });
  assert.equal(command.status, 'DISPATCHED');
  assert.equal(ack.status, 'ACK_RECORDED');
  assert.equal(mqtt.published[0].topic, 'privacy-bubble/gateway/pi-01/command');
  assert.deepEqual(bridge.getReceiptSnapshot().pendingCommands, []);
  assert.deepEqual(bridge.getReceiptSnapshot().acknowledgedCommands, ['cmd-007']);
});

test('GatewayBridge keeps a reviewable telemetry event available for retry', async () => {
  const mqtt = new FakeMqtt();
  let callCount = 0;
  const bridge = new GatewayBridge({
    mqttClient: mqtt,
    baseUrl: 'http://127.0.0.1:7599',
    originator: 'pb-core-admin-local',
    gatewayId: 'pi-01',
    fetchImpl: async () => (++callCount === 1 ? response(503, 'temporary') : response(200, 'applied'))
  });
  const telemetry = { deviceId: 'keyring-02', sequence: 8, timestamp: '2026-10-28T00:00:00.000Z', state: true, batteryPct: 75, rssiDbm: -51, schemaVersion: '1.0.0' };
  const first = await bridge.handleTelemetry(telemetry);
  const second = await bridge.handleTelemetry(telemetry);
  assert.equal(first.status, 'REVIEW');
  assert.equal(second.status, 'APPLIED');
  assert.equal(callCount, 2);
});
