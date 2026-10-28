// Provision empty development resources. No synthetic sensor events or device commands.
import https from 'node:https';
import {readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';

const root = new URL('./.local/', import.meta.url);
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
const receipts = [];
for (const [index, resource] of resources.entries()) {
  if (index) await delay(7000);  // Sequential, at most 5 resource operations.
  const requestId = `kr-setup-${randomUUID()}`;
  const encoded = Buffer.from(JSON.stringify(resource.body));
  const response = await new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'localhost', port: Number(environment.KEYRING_CSE_TLS_PORT || '8759'),
      path: resource.path, method: 'POST', ...tls,
      headers: {'Content-Type': `application/json;ty=${resource.ty}`, Accept: 'application/json',
        'Content-Length': encoded.length, 'X-M2M-RVI': '4', 'X-M2M-RI': requestId,
        'X-M2M-Origin': environment.CSE_ADMIN},
    }, incoming => {
      const chunks = [];
      let size = 0;
      incoming.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) incoming.destroy(new Error('Provisioning response too large'));
        else chunks.push(chunk);
      });
      incoming.on('end', () => resolve({httpStatus: incoming.statusCode,
        rsc: Number(incoming.headers['x-m2m-rsc']), rqi: incoming.headers['x-m2m-ri']}));
      incoming.on('error', reject);
    });
    request.setTimeout(15000, () => request.destroy(new Error('Provisioning request timed out')));
    request.on('error', reject);
    request.end(encoded);
  });
  if (response.rqi !== requestId || !((response.httpStatus === 201 && response.rsc === 2001)
      || (response.httpStatus === 409 && response.rsc === 4105))) {
    throw new Error(`Resource provisioning stopped: HTTP ${response.httpStatus}, rsc ${response.rsc}`);
  }
  const status = response.rsc === 2001 ? 'CREATED' : 'EXISTS_UNCHANGED';
  receipts.push({requestId, parent: resource.path, ty: resource.ty, ...response, status,
    timestamp: new Date().toISOString(), evidenceScope: 'empty-resource-provisioning'});
  console.log(`${status} ${resource.path} ty=${resource.ty} HTTP=${response.httpStatus} rsc=${response.rsc}`);
}
await writeFile(new URL('resource-provisioning.json', root), JSON.stringify(receipts, null, 2) + '\n');
console.log('Empty resources prepared. No BLE, device command, observation or end-to-end test was run.');
