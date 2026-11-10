import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayBridge, mqttTo } from '../src/gateway-bridge.mjs';

class FakeMqtt {
  constructor() { this.subscriptions = []; this.published = []; this.listeners = []; }
  async subscribe(topic, options) { this.subscriptions.push({ topic, options }); }
  async publish(topic, payload, options) { this.published.push({ topic, payload: JSON.parse(payload), options }); }
  on(event, listener) { if (event === 'message') this.listeners.push(listener); }
}

test('GatewayBridge publishes oneM2M MQTT primitive and settles response rqi/rsc', async () => {
  const mqtt = new FakeMqtt();
  const bridge = new GatewayBridge({ mqttClient: mqtt, baseUrl: 'http://127.0.0.1:7599', originator: 'pb-core-admin-local', cseId: 'Mobius4', gatewayId: 'pi-01', oneM2MTransport: 'mqtt' });
  await bridge.start();
  await bridge.start();
  const dispatched = await bridge.handleTelemetry({ deviceId: 'keyring-M', sequence: 12, timestamp: '2026-10-28T00:00:00.000Z', state: true, batteryPct: 88, rssiDbm: -42, schemaVersion: '1.0.0' });
  assert.equal(dispatched.status, 'MQTT_DISPATCHED');
  assert.equal(mqtt.published[0].topic, '/oneM2M/req/pb-core-admin-local/Mobius4/json');
  assert.equal(mqtt.published[0].payload.op, 3);
  assert.equal(mqtt.published[0].payload.to, 'Mobius/privacy-bubble-test-ae/bubbleState');
  assert.equal(mqtt.published[0].payload.pc['pb:binarySwitch'].state, true);
  const settled = await bridge.handleOneM2MResponse({ rqi: dispatched.requestId, rsc: 2004 });
  assert.equal(settled.status, 'APPLIED');
  assert.equal(settled.responseStatus, 2004);
  assert.equal(mqtt.listeners.length, 1);
  assert.deepEqual(mqtt.subscriptions.slice(-3).map((item) => item.topic), [
    'privacy-bubble/gateway/pi-01/telemetry',
    'privacy-bubble/gateway/pi-01/ack',
    '/oneM2M/resp/pb-core-admin-local/Mobius4/json'
  ]);
});

const telemetry = { deviceId: 'keyring-M', sequence: 13, timestamp: '2026-10-28T00:00:00.000Z', state: true, batteryPct: 88, rssiDbm: -42, schemaVersion: '1.0.0' };

test('oneM2M UPDATE settles a response arriving before PUBACK', async () => {
  const mqtt = new FakeMqtt();
  const bridge = new GatewayBridge({ mqttClient: mqtt, originator: 'core', gatewayId: 'pi-01', oneM2MTransport: 'mqtt' });
  mqtt.publishAsync = async (_topic, raw) => {
    const primitive = JSON.parse(raw);
    assert.equal(primitive.op, 3);
    assert.equal(primitive.rvi, '4');
    await bridge.handleOneM2MResponse({ 'm2m:rsp': { rqi: primitive.rqi, rsc: 2004 } });
  };
  const receipt = await bridge.handleTelemetry(telemetry);
  assert.equal(receipt.status, 'APPLIED');
  assert.equal(bridge.pendingOneM2M.size, 0);
  assert.equal((await bridge.handleTelemetry(telemetry)).status, 'DUPLICATE');
});

test('oneM2M CREATE success cannot settle an UPDATE and retry stays available', async () => {
  const mqtt = new FakeMqtt();
  const bridge = new GatewayBridge({ mqttClient: mqtt, originator: 'core', oneM2MTransport: 'mqtt' });
  const sent = await bridge.handleTelemetry(telemetry);
  assert.equal((await bridge.handleOneM2MResponse({ rqi: sent.requestId, rsc: 2001 })).status, 'REVIEW');
  assert.equal((await bridge.handleTelemetry(telemetry)).status, 'MQTT_DISPATCHED');
});

test('oneM2M MQTT To reverses CSE relative, SP relative and absolute HTTP encodings', () => {
  assert.equal(mqttTo('/Mobius/ae/state'), 'Mobius/ae/state');
  assert.equal(mqttTo('/~/Mobius4/Mobius/ae/state'), '/Mobius4/Mobius/ae/state');
  assert.equal(mqttTo('/_/sp.example/Mobius4/Mobius/ae/state'), '//sp.example/Mobius4/Mobius/ae/state');
  assert.throws(() => mqttTo('/Mobius/../other'));
});

test('GatewayBridge awaits MQTT.js async subscription and publish APIs', async () => {
  const mqtt = new FakeMqtt();
  mqtt.subscribe = mqtt.publish = () => { throw new Error('callback-only MQTT method used'); };
  mqtt.subscribeAsync = async (topic) => { mqtt.subscriptions.push(topic); };
  mqtt.publishAsync = async () => { throw new Error('broker unavailable'); };
  const bridge = new GatewayBridge({ mqttClient: mqtt, originator: 'core', oneM2MTransport: 'mqtt' });
  await bridge.start();
  assert.equal(mqtt.subscriptions.length, 3);
  assert.equal((await bridge.handleTelemetry(telemetry)).status, 'REVIEW');
  assert.equal(bridge.pendingOneM2M.size, 0);
});
