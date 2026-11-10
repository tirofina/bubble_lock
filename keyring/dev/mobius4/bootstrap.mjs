// Provision empty development resources. No synthetic sensor events or device commands.
import https from 'node:https';
import {readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--scoped')) {
  throw new Error('Usage: node bootstrap.mjs [--scoped]');
}
const root = new URL(args.length ? './.local/scoped/' : './.local/', import.meta.url);
const environment = Object.fromEntries((await readFile(new URL('compose.env', root), 'utf8'))
  .split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
const tls = {
  ca: await readFile(new URL('tls/ca.pem', root)),
  cert: await readFile(new URL('tls/client.pem', root)),
  key: await readFile(new URL('tls/client.key', root)),
  minVersion: 'TLSv1.3', rejectUnauthorized: true,
};
const ae = 'privacy-bubble-test-ae';
const resources = [
  {path: '/Mobius', ty: 2, body: {'m2m:ae': {rn: ae, api: 'Nprivacy-bubble', rr: true}}},
  ...['observations', 'receipts', 'health'].map(rn => ({
    path: `/Mobius/${ae}`, ty: 3, body: {'m2m:cnt': {rn, mni: 10000}},
  })),
  {path: `/Mobius/${ae}`, ty: 28, body: {'pb:binarySwitch': {
    rn: 'bubbleState', cnd: 'org.onem2m.common.moduleclass.binarySwitch',
    state: false, lbl: ['dev-bootstrap', 'unobserved'],
  }}},
];
if (args.length) {
  resources.push({path: `/Mobius/${ae}`, ty: 28, body: {'pb:binarySwitch': {
    rn: 'featherState', cnd: 'org.onem2m.common.moduleclass.binarySwitch',
    state: false, lbl: ['dev-bootstrap', 'feather-bench'],
  }}});
}
async function exchange(method, path, resource = null) {
  const requestId = `kr-setup-${randomUUID()}`;
  const encoded = resource ? Buffer.from(JSON.stringify(resource.body)) : null;
  const headers = {Accept: 'application/json', 'X-M2M-RVI': '4', 'X-M2M-RI': requestId,
    'X-M2M-Origin': environment.CSE_ADMIN};
  if (encoded) {
    headers['Content-Type'] = `application/json;ty=${resource.ty}`;
    headers['Content-Length'] = encoded.length;
  }
  const response = await new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'localhost', port: Number(environment.KEYRING_CSE_TLS_PORT || '8759'),
      path, method, ...tls, headers,
    }, incoming => {
      const chunks = [];
      let size = 0;
      incoming.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) incoming.destroy(new Error('Provisioning response too large'));
        else chunks.push(chunk);
      });
      incoming.on('end', () => resolve({httpStatus: incoming.statusCode,
        rsc: Number(incoming.headers['x-m2m-rsc']), rqi: incoming.headers['x-m2m-ri'],
        content: Buffer.concat(chunks).toString('utf8')}));
      incoming.on('error', reject);
    });
    request.setTimeout(15000, () => request.destroy(new Error('Provisioning request timed out')));
    request.on('error', reject);
    request.end(encoded ?? undefined);
  });
  return {...response, requestId};
}

async function provision(resource) {
  if (args.length) {
    const [[envelope, expected]] = Object.entries(resource.body);
    const existing = await exchange('GET', `${resource.path}/${expected.rn}`);
    if (existing.rqi !== existing.requestId) throw new Error('Scoped resource response RQI mismatch');
    if (existing.httpStatus === 200 && existing.rsc === 2000) {
      const actual = JSON.parse(existing.content)[envelope];
      if (actual?.rn !== expected.rn || actual.ty !== resource.ty || (expected.cnd && actual.cnd !== expected.cnd)) {
        throw new Error('Existing scoped resource does not match the required name, type or specialization.');
      }
      return {...existing, status: 'EXISTS_UNCHANGED'};
    }
    if (existing.httpStatus !== 404 || existing.rsc !== 4004) {
      throw new Error(`Scoped resource lookup stopped: HTTP ${existing.httpStatus}, rsc ${existing.rsc}`);
    }
    await delay(7000);
  }
  const response = await exchange('POST', resource.path, resource);
  if (response.rqi !== response.requestId || !((response.httpStatus === 201 && response.rsc === 2001)
      || (!args.length && response.httpStatus === 409 && response.rsc === 4105))) {
    throw new Error(`Resource provisioning stopped: HTTP ${response.httpStatus}, rsc ${response.rsc}`);
  }
  return {...response, status: response.rsc === 2001 ? 'CREATED' : 'EXISTS_UNCHANGED'};
}

const receipts = [];
for (const [index, resource] of resources.entries()) {
  if (index) await delay(7000);
  const {requestId, status, httpStatus, rsc, rqi} = await provision(resource);
  const resourceName = Object.values(resource.body)[0].rn;
  receipts.push({requestId, parent: resource.path, resourceName, ty: resource.ty, httpStatus, rsc, rqi, status,
    timestamp: new Date().toISOString(), evidenceScope: 'empty-resource-provisioning'});
  console.log(`${status} ${resource.path}/${resourceName} ty=${resource.ty} HTTP=${httpStatus} rsc=${rsc}`);
}
await writeFile(new URL('resource-provisioning.json', root), JSON.stringify(receipts, null, 2) + '\n');
console.log('Empty resources prepared. No BLE, device command, observation or end-to-end test was run.');
