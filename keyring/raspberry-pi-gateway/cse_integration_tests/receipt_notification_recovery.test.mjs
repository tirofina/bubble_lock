import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createReceiptNotificationSweep } from '../../integration-candidate/receipt-notification-recovery.mjs';
import { commandReceiptName } from '../../integration-candidate/receipt-native-source.mjs';

const from = '2026-11-10T09:00:00.000Z';
const until = '2026-11-10T09:01:00.000Z';
const authorizedAt = '2026-11-10T09:00:01.100Z';
const receiptContainer = '/Mobius/bench/receipts-a';
const nativeRef = (commandId) => `${receiptContainer}/${commandReceiptName(commandId)}`;
const hashPayload = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function evidence(commandId, overrides = {}) {
  const binding = { gatewayId: 'gw-a', commandId, deviceId: 'kr-a', claimId: `claim-${commandId}`,
    ownershipEpoch: 2, grantRevision: 3 };
  const command = { ...binding, version: 1, issuedAt: '2026-11-10T08:59:58.000Z',
    deadline: '2026-11-10T09:02:00.000Z', desiredState: { state: false } };
  const payloadHash = hashPayload(command);
  const approval = { ...binding, payloadHash, expiresAt: command.deadline, timestamp: authorizedAt,
    contractId: 'privacy-bubble.integration.v1', docRevision: '2.0.0', owner: 'PC-MOBIUS-INTEGRATION',
    type: 'GATEWAY_COMMAND_AUTHORIZED', allowed: true, eventId: `evt-${commandId}`, ...overrides };
  return { command, payloadHash, approval };
}

function snapshotFor(...rows) {
  return { gatewayCommands: Object.fromEntries(rows.map(({ command, payloadHash }) => [command.commandId, { command, payloadHash }])),
    receipts: rows.map(({ approval }) => approval) };
}

test('walks an authorization window with stable ties, discarding denied, duplicate, and mismatched approvals', async () => {
  const snapshot = snapshotFor(evidence('b'), evidence('a'), evidence('denied', { allowed: false }),
    evidence('mismatch', { payloadHash: '0'.repeat(64) }), evidence('outside', { timestamp: until }));
  snapshot.receipts.push({ ...snapshot.receipts[1], timestamp: '2026-11-10T09:00:03.000Z' });
  const requested = [];
  const queued = [];
  const sweep = createReceiptNotificationSweep({ snapshot, from, until, hashPayload,
    resolveRoute: async ({ commandId, issuedAt }) => {
      assert.equal(issuedAt, '2026-11-10T08:59:58.000Z');
      return { cseKey: 'original-cse', receiptContainer, readNativeReceipt: async (uri) => {
        requested.push(uri);
        return { gatewayId: 'gw-a', receipt: { commandId } };
      } };
    },
    inbox: { has: async () => false, enqueue: async (entry, source) => {
      assert.equal(source, 'RECOVERY_SWEEP');
      queued.push(entry);
      return true;
    } },
  });
  const first = await sweep({ limit: 1 });
  assert.deepEqual(first, { checked: 1, queued: 1, alreadyQueued: 0, gaps: [], next: { commandId: 'a', authorizedAt } });
  const second = await sweep({ after: first.next });
  assert.deepEqual(second, { checked: 1, queued: 1, alreadyQueued: 0, gaps: [], next: null });
  assert.deepEqual(requested, [nativeRef('a'), nativeRef('b')]);
  assert.deepEqual(queued.map(({ cseKey }) => cseKey), ['original-cse', 'original-cse']);
  await assert.rejects(sweep({ after: { commandId: 'a', authorizedAt: until } }), /INVALID_RECEIPT_RECOVERY_CURSOR/);
});

test('checks only missing work and reports absent or unavailable originals without inserting them', async () => {
  const requested = [];
  const enqueued = [];
  const sweep = createReceiptNotificationSweep({ snapshot: snapshotFor(
    evidence('already'), evidence('lost'), evidence('missing'), evidence('race'), evidence('wrong')), from, until, hashPayload,
  resolveRoute: ({ commandId }) => ({ cseKey: 'cse-a', receiptContainer, readNativeReceipt: async (uri) => {
    requested.push(uri);
    if (commandId === 'lost') throw new Error('timeout');
    if (commandId === 'missing') return null;
    return { gatewayId: commandId === 'wrong' ? 'gw-b' : 'gw-a', receipt: { commandId } };
  } }),
  inbox: { has: async ({ nativeRef: uri }) => uri === nativeRef('already'),
    enqueue: async (entry) => { enqueued.push(entry); return false; } },
  });
  const report = await sweep();
  assert.deepEqual(requested, ['lost', 'missing', 'race', 'wrong'].map(nativeRef));
  assert.deepEqual(enqueued, [{ cseKey: 'cse-a', nativeRef: nativeRef('race') }]);
  assert.equal(report.alreadyQueued, 2);
  assert.equal(report.queued, 0);
  assert.deepEqual(report.gaps.map(({ reason }) => reason), [
    'NATIVE_RECEIPT_UNAVAILABLE', 'WAITING_FOR_NATIVE', 'NATIVE_RECEIPT_BINDING',
  ]);
});
