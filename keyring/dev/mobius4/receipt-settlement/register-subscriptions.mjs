import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { scopedCommandReceiptContainers } from '../scoped-command-receipts.mjs';
import { openScopedCseExchange } from './scoped-io.mjs';

const exchange = await openScopedCseExchange();
const desired = { rn: 'keyring-settlement', nu: ['http://127.0.0.1:8791/onem2m/keyring/receipt-notifications'],
  enc: { net: [3], chty: [4] }, nct: 3 };
const reports = [];

function record(gatewayId, nativeRef, result, action) {
  const subscription = result.body?.['m2m:sub'];
  if (subscription?.ty !== 23 || subscription.rn !== desired.rn || subscription.nct !== desired.nct
      || !isDeepStrictEqual(subscription.nu, desired.nu) || !isDeepStrictEqual(subscription.enc?.net, desired.enc.net)
      || !isDeepStrictEqual(subscription.enc?.chty, desired.enc.chty)) throw new Error('RECEIPT_SUBSCRIPTION_BINDING');
  const entry = { gatewayId, nativeRef, action, httpStatus: result.status, rsc: result.rsc,
    rqiMatched: true, recordedAt: new Date().toISOString() };
  console.log(JSON.stringify(entry));
  reports.push(entry);
}

for (const [gatewayId, container] of Object.entries(scopedCommandReceiptContainers)) {
  if (reports.length) await delay(5000);
  const nativeRef = `${container}/${desired.rn}`;
  const existing = await exchange(nativeRef);
  if (existing.status === 200 && existing.rsc === 2000) {
    record(gatewayId, nativeRef, existing, 'EXISTS_UNCHANGED');
    continue;
  }
  if (existing.status !== 404 || existing.rsc !== 4004) throw new Error('RECEIPT_SUBSCRIPTION_LOOKUP_FAILED');
  await delay(5000);
  const created = await exchange(container, { method: 'POST', ty: 23, body: { 'm2m:sub': desired } });
  if (created.status !== 201 || created.rsc !== 2001) throw new Error('RECEIPT_SUBSCRIPTION_CREATE_FAILED');
  record(gatewayId, nativeRef, created, 'CREATED');
}

await writeFile(new URL('../.local/scoped/receipt-subscriptions-provisioning.json', import.meta.url),
  `${JSON.stringify(reports, null, 2)}\n`);
