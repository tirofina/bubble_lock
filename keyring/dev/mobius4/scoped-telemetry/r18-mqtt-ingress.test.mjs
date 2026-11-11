import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createR18MqttIngress } from './r18-mqtt-ingress.mjs';

const pins = { observationContainerRi: 'cnt-observation', healthContainerRi: 'cnt-health' };
const rqi = `kr-${'a'.repeat(48)}`;
const content = { rn: `gw-${createHash('sha256').update(rqi).digest('hex')}`, cnf: 'application/json:0',
  con: { gatewayId: 'gw-b', deviceId: 'keyring-r18-lab', firmwareRevision: 'keyring-0.7.18-bringup', state: false } };
const primitive = { op: 1, to: pins.observationContainerRi, fr: 'Sscoped-r18-gateway-b', rqi, ty: 4, rvi: '4',
  pc: { 'm2m:cin': content } };
const encode = (value) => Buffer.from(JSON.stringify(value));

function fixture(response) {
  const posts = [];
  const exchange = async (method, path, requestId, body) => {
    if (method === 'GET') {
      const rn = path.split('/').at(-1);
      const ri = rn === 'command-observations-b' ? pins.observationContainerRi : pins.healthContainerRi;
      return { httpStatus: 200, rsc: 2000, pc: { 'm2m:cnt': { rn, ri, ty: 3 } } };
    }
    posts.push([path, requestId, body]);
    return response;
  };
  return { exchange, posts };
}

test('checks both pins and forwards the identical request ID and content on the pinned route', async () => {
  const { exchange, posts } = fixture({ httpStatus: 409, rsc: 4105, pc: { 'm2m:dbg': 'Already exists' } });
  const ingress = await createR18MqttIngress(pins, exchange);
  const result = await ingress(encode({ 'm2m:rqp': primitive }));
  assert.deepEqual(result, { rqi, rsc: 4105, pc: { 'm2m:dbg': 'Already exists' } });
  const health = { 'm2m:cin': { ...content, con: { gatewayId: 'gw-b', commandCount: 0 } } };
  await ingress(encode({ ...primitive, to: pins.healthContainerRi, pc: health }));
  assert.deepEqual(posts, [['/cnt-observation', rqi, primitive.pc], ['/cnt-health', rqi, health]]);
  await assert.rejects(createR18MqttIngress({ ...pins, observationContainerRi: 'other' }, exchange), /pin does not match/);
});

test('denies other origins, commands, paths and retained messages without contacting the CSE', async () => {
  const { exchange, posts } = fixture();
  const ingress = await createR18MqttIngress(pins, exchange);
  for (const changes of [{ fr: 'another-originator' }, { op: 3 }, { to: 'cnt-receipt' },
    { pc: { 'm2m:cin': { ...content, con: { ...content.con, state: true } } } },
    { to: pins.healthContainerRi, pc: { 'm2m:cin': { ...content, con: { gatewayId: 'gw-b', commandCount: 1 } } } }]) {
    assert.deepEqual(await ingress(encode({ ...primitive, ...changes })), { rqi, rsc: 4103 });
  }
  assert.equal(await ingress(encode(primitive), { retain: true }), null);
  assert.deepEqual(posts, []);
});
