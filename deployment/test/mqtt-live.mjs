import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { once } from 'node:events';
const mqtt = createRequire(new URL('../../pc-mobius/package.json', import.meta.url))('mqtt');
const directory = resolve(process.env.RUN_TMP ?? '.local/deployment');
const api = JSON.parse(await readFile(resolve(directory, 'api.json'), 'utf8'));
const tls = {
  ca: await readFile(resolve(directory, 'pki/ca.pem')),
  cert: await readFile(resolve(directory, 'pki/gateway-1.pem')),
  key: await readFile(resolve(directory, 'pki/gateway-1.key')),
  servername: process.env.PUBLIC_DOMAIN || 'bubble.localhost',
  minVersion: 'TLSv1.3', rejectUnauthorized: true,
};
const client = mqtt.connect(`mqtts://127.0.0.1:${process.env.MQTT_PORT ?? 8883}`, {
  ...tls, clientId: 'deployment-pi-fixture', protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 5000,
});
await once(client, 'connect', { signal: AbortSignal.timeout(6000) });
try {
  const responseTopic = '/oneM2M/resp/gateway-1/bubble-cse/json';
  await client.subscribeAsync(responseTopic, { qos: 1 });
  const exchange = async (primitive) => {
    const received = new Promise((resolveResponse, reject) => {
      const signal = AbortSignal.timeout(8000);
      const message = (topic, bytes) => {
        const body = JSON.parse(bytes.toString());
        if (topic !== responseTopic || body.rqi !== primitive.rqi) return;
        client.off('message', message);
        resolveResponse(body);
      };
      signal.addEventListener('abort', () => { client.off('message', message); reject(new Error(`No CSE application response for ${primitive.rqi}`)); }, { once: true });
      client.on('message', message);
    });
    await client.publishAsync('/oneM2M/req/gateway-1/bubble-cse/json', JSON.stringify(primitive), { qos: 1 });
    return received;
  };
  const path = api.core.group.members['keyring-A'].resourcePath;
  const read = await exchange({ op: 2, fr: 'gateway-1', to: path, rqi: `mqtt-read-${Date.now()}`, rvi: '4' });
  assert.equal(read.rsc, 2000);
  assert.equal(typeof read.pc['cod:binSh'].state, 'boolean');
  const forged = await exchange({ op: 2, fr: 'forged-admin', to: path, rqi: `mqtt-forged-${Date.now()}`, rvi: '4' });
  assert.equal(forged.rsc, 4103);
  // Mosquitto accepts subscription filters but applies its read ACL when delivering.
  // MQTT5 publish authorization returns an explicit negative PUBACK.
  await assert.rejects(client.publishAsync('/oneM2M/req/other-gateway/bubble-cse/json', JSON.stringify({ op: 2, fr: 'other-gateway', to: path, rqi: 'foreign-topic', rvi: '4' }), { qos: 1 }));
  console.log(JSON.stringify({ status: 'MQTT_CSE_PASS', tls: client.stream.getProtocol(), actualCseRsc: read.rsc, readbackState: read.pc['cod:binSh'].state, forgedOriginatorRsc: forged.rsc, foreignTopicPublish: 'DENIED' }));
} finally {
  await client.endAsync();
}
const anonymous = mqtt.connect(`mqtts://127.0.0.1:${process.env.MQTT_PORT ?? 8883}`, { ca: tls.ca, servername: tls.servername, minVersion: 'TLSv1.3', reconnectPeriod: 0, connectTimeout: 3000 });
await assert.rejects(once(anonymous, 'connect', { signal: AbortSignal.timeout(4000) }));
await anonymous.endAsync(true);
console.log(JSON.stringify({ status: 'MQTT_ANONYMOUS_DENIED' }));
