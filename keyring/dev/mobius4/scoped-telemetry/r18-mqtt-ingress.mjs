import { createHash } from 'node:crypto';
import { request } from 'node:https';

const originator = 'Sscoped-r18-gateway-b';
export const r18RequestTopic = `/oneM2M/req/${originator}/Mobius4/json`;
export const r18ResponseTopic = `/oneM2M/resp/${originator}/Mobius4/json`;
const parent = '/Mobius/privacy-bubble-test-ae';
const routes = { observationContainerRi: `${parent}/command-observations-b`, healthContainerRi: `${parent}/command-health-b` };
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const requestId = /^kr-[a-f0-9]{48}$/;
const bringup = /^keyring-\d+\.\d+\.\d+(?:-st7789|-jd9853)?-bringup$/;
const maxBody = 256 * 1024;

function hasKeys(value, keys) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function scopedR18MqttExchange(tls, cseAdmin) {
  return (method, path, rqi, content) => new Promise((resolve, reject) => {
    const body = content === undefined ? undefined : Buffer.from(JSON.stringify(content));
    const headers = { 'X-M2M-Origin': cseAdmin, 'X-M2M-RVI': '4', 'X-M2M-RI': rqi, Accept: 'application/json' };
    if (body) Object.assign(headers, { 'Content-Type': 'application/json;ty=4', 'Content-Length': body.length });
    const req = request(new URL(path, 'https://tls:8759'), {
      ...tls, method, signal: AbortSignal.timeout(3500), headers,
    }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('error', reject);
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > maxBody) res.destroy(new Error('Scoped MQTT CSE response is too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        const rsc = res.headers['x-m2m-rsc'];
        if (res.headers['x-m2m-ri'] !== rqi || !/^[245]\d{3}$/.test(rsc)) {
          reject(new Error('Scoped MQTT CSE response is uncorrelated'));
          return;
        }
        try {
          const pc = length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ httpStatus: res.statusCode, rsc: Number(rsc), pc });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function createR18MqttIngress(pins, exchange) {
  if (!hasKeys(pins, Object.keys(routes)) || Object.values(pins).some((value) => typeof value !== 'string' || !identifier.test(value))
      || pins.observationContainerRi === pins.healthContainerRi) {
    throw new Error('Expected distinct r18 observation and health container pins');
  }
  for (const [name, path] of Object.entries(routes)) {
    const { httpStatus, rsc, pc } = await exchange('GET', path, `r18-mqtt-${name}`);
    const container = pc?.['m2m:cnt'];
    if (httpStatus !== 200 || rsc !== 2000 || container?.ty !== 3 || container.ri !== pins[name]
        || container.rn !== path.split('/').at(-1)) throw new Error('Scoped MQTT container pin does not match the CSE');
  }

  return async (bytes, { retain } = {}) => {
    if (retain || bytes.length > maxBody) return null;
    let wire;
    try { wire = JSON.parse(bytes.toString('utf8')); } catch { return null; }
    const primitive = hasKeys(wire, ['m2m:rqp']) ? wire['m2m:rqp'] : wire;
    const rqi = primitive?.rqi;
    if (typeof rqi !== 'string' || !requestId.test(rqi)) return null;
    const denied = { rqi, rsc: 4103 };
    if (!hasKeys(primitive, ['op', 'to', 'fr', 'rqi', 'ty', 'rvi', 'pc']) || primitive.op !== 1
        || primitive.fr !== originator || primitive.ty !== 4 || primitive.rvi !== '4'
        || !hasKeys(primitive.pc, ['m2m:cin'])) return denied;
    const cin = primitive.pc['m2m:cin'];
    if (!hasKeys(cin, ['rn', 'cnf', 'con']) || cin.cnf !== 'application/json:0'
        || cin.rn !== `gw-${createHash('sha256').update(rqi).digest('hex')}` || cin.con?.gatewayId !== 'gw-b') return denied;
    const { to } = primitive;
    if (to === pins.observationContainerRi) {
      if (cin.con.deviceId !== 'keyring-r18-lab' || typeof cin.con.firmwareRevision !== 'string'
          || !bringup.test(cin.con.firmwareRevision) || cin.con.state !== false) return denied;
    } else if (to !== pins.healthContainerRi || cin.con.commandCount !== 0 || Object.hasOwn(cin.con, 'credentialTransition')) {
      return denied;
    }

    const { httpStatus, rsc, pc } = await exchange('POST', `/${to}`, rqi, primitive.pc);
    if (!((httpStatus === 201 && rsc === 2001) || (httpStatus >= 400 && rsc >= 4000))) {
      throw new Error('Scoped MQTT CSE response does not settle a CREATE');
    }
    return { rqi, rsc, pc };
  };
}
