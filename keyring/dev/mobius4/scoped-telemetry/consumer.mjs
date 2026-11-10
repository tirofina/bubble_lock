import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { createScopedTelemetryIngress } from './integration-candidate/core-telemetry-ingress.mjs';
import { IntegrationStore } from './integration-store.mjs';

const { connect } = createRequire('/app/package.json')('mqtt');
const deviceId = 'kr-handover';
const path = '/Mobius/privacy-bubble-test-ae/bubbleState';
const featherPath = '/Mobius/privacy-bubble-test-ae/featherState';
const featherOwner = { gatewayId: 'gw-a', deviceId: 'keyring-feather-lab', ownershipEpoch: 1 };
const routes = new Map([[deviceId, path], [featherOwner.deviceId, featherPath]]);
const owners = 'coreTelemetryOwners';
const owner = (gatewayId, ownershipEpoch) => ({ gatewayId, deviceId, ownershipEpoch });
const initialOwner = owner('gw-a', 7);
const targetOwner = owner('gw-b', 8);
const rollbackOwner = owner('gw-a', 9);
const allowedOwners = [initialOwner, targetOwner, rollbackOwner];
const transitions = new Map([
  ['Forward', [initialOwner, targetOwner]],
  ['Rollback', [targetOwner, rollbackOwner]],
]);
const sameOwner = (current, expected) => current?.gatewayId === expected.gatewayId
  && current.deviceId === expected.deviceId && current.ownershipEpoch === expected.ownershipEpoch;
const cseAdmin = process.env.CSE_ADMIN;
if (!cseAdmin) throw new Error('Scoped CSE admin identity is required');
const store = await new IntegrationStore('/var/lib/mobius4/scoped-cursor.json').init();
const persistedOwner = store.get(owners, path);
if (persistedOwner === undefined) {
  const seed = JSON.parse(await readFile('/scoped/config/owner.json', 'utf8'));
  const initial = allowedOwners.find((candidate) => sameOwner(seed, candidate));
  const cursor = store.get('coreTelemetryCursors', path);
  if (!initial || (cursor && (cursor.deviceId !== deviceId || cursor.ownershipEpoch > initial.ownershipEpoch
      || (cursor.ownershipEpoch === initial.ownershipEpoch && cursor.gatewayId !== initial.gatewayId)))) {
    throw new Error('Scoped initial owner conflicts with the allowed assignments or persisted cursor');
  }
  await store.put(owners, path, initial);
} else if (!allowedOwners.some((candidate) => sameOwner(persistedOwner, candidate))) {
  throw new Error('Invalid scoped persisted owner');
}
const storedFeatherOwner = store.get(owners, featherPath);
const featherCursor = store.get('coreTelemetryCursors', featherPath);
if ((storedFeatherOwner !== undefined && !sameOwner(storedFeatherOwner, featherOwner))
    || (featherCursor != null && !sameOwner(featherCursor, featherOwner))) {
  throw new Error('Feather scoped resource has a conflicting persisted binding');
}
if (storedFeatherOwner === undefined) await store.put(owners, featherPath, featherOwner);
const tls = {
  ca: await readFile('/scoped/tls/ca.pem'),
  cert: await readFile('/scoped/tls/client.pem'),
  key: await readFile('/scoped/tls/client.key'),
  minVersion: 'TLSv1.3', rejectUnauthorized: true,
};

function apply({ resource, requestId, payload }) {
  const body = Buffer.from(JSON.stringify({ 'pb:binarySwitch': { state: payload.state } }));
  return new Promise((resolve, reject) => {
    const req = request(new URL(resource, 'https://tls:8759'), {
      ...tls, method: 'PUT', signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json', 'Content-Length': body.length,
        'X-M2M-Origin': cseAdmin, 'X-M2M-RVI': '4', 'X-M2M-RI': requestId,
      },
    }, (res) => {
      res.on('error', reject);
      res.on('end', () => {
        const confirmed = [200, 204].includes(res.statusCode)
          && res.headers['x-m2m-rsc'] === '2004' && res.headers['x-m2m-ri'] === requestId;
        resolve({ status: confirmed ? 'APPLIED' : 'REVIEW_PENDING' });
      });
      res.resume();
    });
    req.on('error', reject);
    req.end(body);
  });
}

const ingest = createScopedTelemetryIngress({
  resolveResource: (device) => routes.get(device),
  readOwner: (resource) => store.get(owners, resource),
  compareAndSetOwner: async (resource, expected, replacement) => {
    if (!sameOwner(store.get(owners, resource), expected)) return false;
    await store.put(owners, resource, replacement);
    return true;
  },
  readCursor: (resource) => store.get('coreTelemetryCursors', resource),
  writeCursor: (resource, cursor) => store.put('coreTelemetryCursors', resource, cursor),
  apply,
});
const mqtt = connect('mqtts://broker:8883', {
  ...tls, clientId: 'keyring-scoped-core', protocolVersion: 4, clean: false,
  resubscribe: false, reconnectPeriod: 2000, connectTimeout: 8000,
});
const subscription = 'privacy-bubble/gateway/+/telemetry-epoch/+/+';
const pending = new Set();
let stopping = false;
function track(job) {
  pending.add(job);
  job.finally(() => pending.delete(job));
}
mqtt.on('connect', () => {
  mqtt.subscribe(subscription, { qos: 1 }, (error, granted) => {
    if (error || granted?.[0]?.qos !== 1) {
      console.error('SCOPED_SUBSCRIPTION_DENIED');
      process.exitCode = 1;
      mqtt.end(true);
      return;
    }
    console.log('SCOPED_SUBSCRIBED receipts=1 handover=1 feather=1');
  });
});
mqtt.on('error', () => console.error('SCOPED_BROKER_ERROR'));
mqtt.on('message', (topic, bytes, packet) => {
  if (stopping) return;
  const job = ingest(topic, bytes, packet).then(({ status, receipt }) => {
    console.log(status);
    if (receipt && !stopping && mqtt.connected) {
      const { gatewayId, deviceId, ownershipEpoch } = receipt;
      mqtt.publish(`privacy-bubble/gateway/${gatewayId}/telemetry-result/${deviceId}/${ownershipEpoch}`,
        JSON.stringify(receipt), { qos: 1, retain: false }, (error) => {
          if (error) console.error('SCOPED_RECEIPT_PUBLISH_ERROR');
        });
    }
  }).catch(() => console.error('SCOPED_INGRESS_ERROR'));
  track(job);
});
process.on('SIGUSR2', () => {
  if (stopping) return;
  track((async () => {
    const input = JSON.parse(await readFile('/scoped/config/handover-request.json', 'utf8'));
    const requestId = input?.requestId;
    const transition = transitions.get(input?.direction);
    if (typeof requestId !== 'string' || requestId.length !== 32 || !/^[a-f0-9]{32}$/.test(requestId) || !transition) {
      console.error('SCOPED_HANDOVER_REQUEST_INVALID');
      return;
    }
    try {
      const { status } = await ingest.transition(...transition);
      console.log(`SCOPED_HANDOVER ${requestId} ${status}`);
    } catch {
      console.error(`SCOPED_HANDOVER ${requestId} REVIEW_ERROR`);
    }
  })().catch(() => console.error('SCOPED_HANDOVER_REQUEST_INVALID')));
});
function stop() {
  if (stopping) return;
  stopping = true;
  mqtt.end(true);
  Promise.allSettled(pending).then(() => console.log('SCOPED_STOPPED'));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
