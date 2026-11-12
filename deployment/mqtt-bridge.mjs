import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const mqtt = createRequire(new URL('../pc-mobius/package.json', import.meta.url))('mqtt');
const config = JSON.parse(await readFile('/run/bridge/bridge.json', 'utf8'));
const client = mqtt.connect(config.broker, {
  ca: await readFile('/run/bridge/ca.pem'),
  cert: await readFile('/run/bridge/client.pem'),
  key: await readFile('/run/bridge/client.key'),
  minVersion: 'TLSv1.3', rejectUnauthorized: true,
  clientId: 'bubble-cse-authenticated-bridge', protocolVersion: 4,
});
client.on('connect', () => {
  client.subscribe(`/oneM2M/req/+/${config.cseId}/json`, { qos: 1 }, (error) => {
    if (error) throw error;
    console.log(JSON.stringify({ status: 'READY', transport: 'mqtt-mtls-to-private-cse-https' }));
  });
});
client.on('error', (error) => console.error(JSON.stringify({ status: 'MQTT_ERROR', message: error.message })));
client.on('message', async (topic, bytes) => {
  const originator = topic.split('/')[3];
  let primitive;
  try {
    if (bytes.length > 65536) throw new RangeError('MQTT primitive too large');
    primitive = JSON.parse(bytes.toString('utf8'));
    if (!primitive || typeof primitive !== 'object' || Array.isArray(primitive)
      || typeof primitive.rqi !== 'string' || primitive.rqi.length > 128
      || !config.identities.includes(originator) || primitive.fr !== originator
      || typeof primitive.to !== 'string' || !/^\/Mobius(?:\/|$)/.test(primitive.to)
      || primitive.to.includes('..') || /[?#\r\n]/.test(primitive.to)
      || ![1, 2, 3, 4, 5].includes(primitive.op)) throw new TypeError('Enrolled topic and primitive identity required');
    const methods = { 1: 'POST', 2: 'GET', 3: 'PUT', 4: 'DELETE', 5: 'POST' };
    const response = await fetch(new URL(primitive.to, config.endpoint), {
      method: methods[primitive.op], redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {
        'X-M2M-Origin': originator, 'X-M2M-RI': primitive.rqi, 'X-M2M-RVI': String(primitive.rvi ?? '4'),
        Accept: 'application/json', 'Content-Type': `application/json${primitive.op === 1 ? `;ty=${Number(primitive.ty)}` : ''}`,
      },
      ...([1, 3, 5].includes(primitive.op) ? { body: JSON.stringify(primitive.pc ?? {}) } : {}),
    });
    const pc = await response.json();
    await client.publishAsync(`/oneM2M/resp/${originator}/${config.cseId}/json`, JSON.stringify({
      rqi: primitive.rqi, rvi: String(primitive.rvi ?? '4'), fr: `/${config.cseId}`, to: originator,
      rsc: Number(response.headers.get('x-m2m-rsc') ?? 5000), pc,
    }), { qos: 1 });
  } catch (error) {
    console.error(JSON.stringify({ status: 'MQTT_REQUEST_REJECTED', originator, rqi: primitive?.rqi, message: error instanceof Error ? error.message : 'Unknown error' }));
    if (typeof primitive?.rqi === 'string' && config.identities.includes(originator)) {
      await client.publishAsync(`/oneM2M/resp/${originator}/${config.cseId}/json`, JSON.stringify({ rqi: primitive.rqi, rsc: 4103, pc: { 'm2m:dbg': 'Enrolled identity or valid CSE operation required' } }), { qos: 1 });
    }
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void client.endAsync());
