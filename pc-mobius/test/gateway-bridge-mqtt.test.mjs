import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayBridge } from '../src/gateway-bridge.mjs';

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
  assert.equal(mqtt.published[0].payload.op, 2);
  assert.equal(mqtt.published[0].payload.to, '/Mobius/privacy-bubble-test-ae/bubbleState');
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
