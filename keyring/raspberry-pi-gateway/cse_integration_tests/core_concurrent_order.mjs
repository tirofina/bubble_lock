import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTelemetryOrder } from '../../integration-candidate/core-telemetry-order.mjs';
import { createScopedTelemetryIngress } from '../../integration-candidate/core-telemetry-ingress.mjs';
import { deliver, loadSdtProbe } from './core_sdt_fixture.mjs';

const { tree, pki, bridge, tlsFetch, input: { paths, projections } } = await loadSdtProbe();
const { IntegrationStore } = await import(pathToFileURL(join(tree, 'pc-mobius', 'integration', 'src', 'integration-store.mjs')));
const [baselinePath, orderedPath, handoverPath, uncertainPath] = paths;
const gatewayA = 'gw-a-test';
const gatewayB = 'gw-b-test';
const message = (index, gatewayId) => ({ ...projections[index], gatewayId });
const source = (gatewayId, ownershipEpoch) => ({ gatewayId, ownershipEpoch, deviceId: projections[0].deviceId });
const older = message(0, gatewayA);
const newer = message(1, gatewayA);
const storePath = join(pki, 'core-telemetry-cursors.json');
const store = await new IntegrationStore(storePath).init();
const ownerA = source(gatewayA, 1);
const ownerB = source(gatewayB, 2);
const owners = new Map(paths.map((path) => [path, ownerA]));

function makeGate(storage, maxPending = 32, readOwner = (path) => owners.get(path)) {
  return createTelemetryOrder({ maxPending, readOwner,
    readCursor: (path) => storage.get('coreTelemetryCursors', path),
    writeCursor: (path, cursor) => storage.put('coreTelemetryCursors', path, cursor),
    compareAndSetOwner: (path, expected, next) => {
      assert.deepEqual(owners.get(path), expected);
      owners.set(path, next);
      return true;
    } });
}

function delayedFirst(path) {
  const arrived = Promise.withResolvers();
  const release = Promise.withResolvers();
  const started = [], completed = [];
  const instance = bridge(path, gatewayA, async (url, options) => {
    const state = JSON.parse(options.body)['pb:binarySwitch'].state;
    started.push(state);
    if (started.length === 1) {
      arrived.resolve();
      await release.promise;
    }
    const response = await tlsFetch(url, options);
    completed.push(state);
    return response;
  });
  return { instance, arrived, release, started, completed };
}

const baseline = delayedFirst(baselinePath);
const first = deliver(baseline.instance, older);
await baseline.arrived.promise;
assert.equal((await deliver(baseline.instance, newer)).status, 'APPLIED');
baseline.release.resolve();
assert.equal((await first).status, 'APPLIED');
assert.deepEqual(baseline.completed, [false, true]);

const gate = makeGate(store, 2);
const ordered = delayedFirst(orderedPath);
const apply = (payload) => deliver(ordered.instance, payload);
const pendingFirst = gate(orderedPath, ownerA, older, apply);
await ordered.arrived.promise;
const pendingSecond = gate(orderedPath, ownerA, newer, apply);
assert.equal((await gate(orderedPath, ownerA, newer, apply)).status, 'REVIEW_CAPACITY');
assert.deepEqual(ordered.started, [true]);
ordered.release.resolve();
assert.deepEqual((await Promise.all([pendingFirst, pendingSecond])).map((value) => value.status), ['APPLIED', 'APPLIED']);
assert.deepEqual(ordered.completed, [true, false]);
assert.equal((await gate(orderedPath, ownerA, older, apply)).status, 'STALE_SEQUENCE');

const instanceA = bridge(handoverPath, gatewayA);
const instanceB = bridge(handoverPath, gatewayB);
const applyA = (payload) => deliver(instanceA, payload);
const applyB = (payload) => deliver(instanceB, payload);
const oldUpdateStarted = Promise.withResolvers();
const allowOldUpdate = Promise.withResolvers();
const oldUpdate = gate(handoverPath, ownerA, older, async (payload) => {
  oldUpdateStarted.resolve();
  await allowOldUpdate.promise;
  assert.deepEqual(owners.get(handoverPath), ownerA);
  return applyA(payload);
});
await oldUpdateStarted.promise;
const switchOwner = gate.transition(handoverPath, ownerA, ownerB);
allowOldUpdate.resolve();
assert.equal((await oldUpdate).status, 'APPLIED');
assert.equal((await switchOwner).status, 'OWNER_SWITCHED');
assert.equal((await gate(handoverPath, ownerA, newer, applyA)).status, 'NOT_OWNER');
assert.equal((await gate(handoverPath, ownerB, newer, applyB)).status, 'INVALID_TELEMETRY_BINDING');
const bFirst = { ...message(1, gatewayB), sequence: 0 };
assert.equal((await gate(handoverPath, ownerB, bFirst, applyB)).status, 'APPLIED');
const ownerAfterRollback = source(gatewayA, 3);
assert.equal((await gate.transition(handoverPath, ownerB, ownerAfterRollback)).status, 'OWNER_SWITCHED');
assert.equal((await gate.transition(handoverPath, ownerAfterRollback, ownerA)).status, 'INVALID_OWNER_TRANSITION');
assert.equal((await gate(handoverPath, ownerA, newer, applyA)).status, 'NOT_OWNER');
assert.equal((await gate(handoverPath, ownerAfterRollback, newer, applyA)).status, 'APPLIED');

const uncertain = bridge(uncertainPath, gatewayA);
const pending = await gate(uncertainPath, ownerA, older, async (payload) => {
  assert.equal((await deliver(uncertain, payload)).status, 'APPLIED');
  throw new Error('synthetic loss after remote commit');
});
assert.equal(pending.status, 'REVIEW_PENDING');
const reopened = await new IntegrationStore(storePath).init();
assert.equal(reopened.get('coreTelemetryCursors', uncertainPath).phase, 'PENDING');
const resumed = makeGate(reopened);
assert.equal((await resumed(uncertainPath, ownerA, newer, () => assert.fail('unresolved UPDATE dispatched'))).status,
  'REVIEW_PENDING');
assert.equal((await resumed.transition(uncertainPath, ownerA, ownerB)).status, 'REVIEW_PENDING');
assert.equal((await resumed(orderedPath, ownerA, older, () => assert.fail('stale UPDATE dispatched'))).status,
  'STALE_SEQUENCE');

let ownerReads = 0;
const ownerChanged = makeGate(reopened, 2, () => ++ownerReads === 1 ? ownerA : ownerB);
const unusedResource = '/synthetic-before-send';
assert.equal((await ownerChanged(unusedResource, ownerA, older, () => assert.fail('old owner dispatched'))).status, 'NOT_OWNER');
assert.equal(reopened.get('coreTelemetryCursors', unusedResource), null);

const receiptResource = '/synthetic-receipt-replay';
const receiptTopic = `privacy-bubble/gateway/${gatewayA}/telemetry-epoch/${ownerA.deviceId}/1`;
const bytes = Buffer.from(JSON.stringify(older));
function scoped(storage, apply) {
  return createScopedTelemetryIngress({
    resolveResource: () => receiptResource,
    readOwner: () => ownerA,
    readCursor: (path) => storage.get('coreTelemetryCursors', path),
    writeCursor: (path, cursor) => storage.put('coreTelemetryCursors', path, cursor),
    apply,
  });
}
const recorded = await scoped(reopened, async () => ({ status: 'APPLIED' }))(receiptTopic, bytes, { retain: false });
assert.equal(recorded.receipt.payloadHash, createHash('sha256').update(bytes).digest('hex'));
assert.equal(recorded.receipt.responseStatus, 2004);
const receiptStore = await new IntegrationStore(storePath).init();
const retryReceipt = scoped(receiptStore, () => assert.fail('confirmed UPDATE ran again'));
const replay = await retryReceipt(receiptTopic, bytes, { retain: false });
assert.equal(replay.replayed, true);
assert.deepEqual(replay.receipt, recorded.receipt);
const conflict = await retryReceipt(receiptTopic, Buffer.from(JSON.stringify({ ...older, state: false })), { retain: false });
assert.equal(conflict.status, 'CONFLICT');
assert.equal(conflict.receipt, undefined);

console.log(JSON.stringify({
  originalCompletionOrder: baseline.completed, serializedCompletionOrder: ordered.completed,
  oldOwnerAndOldEpochRejected: true, rollbackAccepted: true, unresolvedPreservedOnReload: true,
  staleAfterReloadRejected: true, ownerChangeBeforeDispatchBlocked: true, queueBoundEnforced: true,
  matchingReceiptReplayed: true, conflictingReceiptRejected: true,
  ownershipTransitionSerialized: true, unresolvedTransitionBlocked: true,
}));
