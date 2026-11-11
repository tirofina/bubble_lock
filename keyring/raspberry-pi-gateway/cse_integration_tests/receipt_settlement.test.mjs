import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createNativeReceiptReader } from '../../integration-candidate/receipt-native-source.mjs';
import { createFileSettlementCommit } from '../../integration-candidate/receipt-settlement-files.mjs';
import { createCommandReceiptSettlement } from '../../integration-candidate/receipt-settlement.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const hashPayload = (value) => digest(JSON.stringify(value));
const identity = { gatewayId: 'gw-a', deviceId: 'kr-a', commandId: 'cmd-a', grantRevision: 3, ownershipEpoch: 2 };
const command = { version: 1, ...identity, claimId: 'claim-a', issuedAt: '2026-11-10T09:00:01.123Z',
  deadline: '2026-11-10T09:00:15.000Z', desiredState: { state: true } };
const payloadHash = hashPayload(command);
const approval = { ...identity, payloadHash, claimId: command.claimId, expiresAt: command.deadline,
  contractId: 'privacy-bubble.integration.v1', docRevision: '2.0.0', owner: 'PC-MOBIUS-INTEGRATION',
  type: 'GATEWAY_COMMAND_AUTHORIZED', eventId: 'evt-approved', timestamp: '2026-11-10T09:00:02.135Z', allowed: true };
const originalReceipt = { version: 1, ...identity, payloadHash, status: 'APPLIED', ackCode: 'APPLIED',
  acceptedAt: null, appliedAt: null, receivedAt: '2026-11-10T09:00:03.241Z', readback: { state: true },
  firmwareRevision: 'keyring-0.7.4', timestampSource: 'unavailable', detail: null, bootId: null };
const ack = { ...identity, payloadHash, ackState: 'READBACK_VERIFIED', timestamp: originalReceipt.receivedAt,
  readback: originalReceipt.readback, measurementScope: 'gpio-at-application', gatewayReceipt: originalReceipt };
const container = '/Mobius/gw-a/receipts';
const name = `gw-${digest(`kr-${digest('receipt:cmd-a').slice(0, 48)}`)}`;
const nativeRef = `${container}/${name}`;
const cseKey = 'test-cse';

function setup(overrides = {}) {
  const cin = { ty: 4, rn: name, ri: 'native-a', ct: '20261110T090004', con: originalReceipt };
  const cse = { status: 200, rsc: 2000, body: { 'm2m:cin': cin } };
  const paths = [];
  const readNativeReceipt = createNativeReceiptReader({ receiptContainers: { 'gw-a': container },
    retrieve: async (path) => { paths.push(path); return cse; } });
  let saved;
  const settle = createCommandReceiptSettlement({ cseKey, readNativeReceipt, validateNativeReceipt: async () => true,
    readIssuedCommand: async () => ({ command, payloadHash }),
    readAuthorizationHistory: async () => [
      { ...approval, allowed: false, eventId: 'evt-later-denial', timestamp: '2026-11-10T09:00:16.000Z' }, approval,
    ],
    hashPayload,
    commitIfAbsent: async (key, candidate) => {
      assert.deepEqual(key, ['gw-a', 'cmd-a']);
      if (saved) return { created: false, record: saved };
      saved = candidate;
      return { created: true, record: saved };
    },
    ...overrides,
  });
  return { cin, cse, paths, settle };
}

test('settles authenticated native readback once and checks any later ACK', async () => {
  const { cin, paths, settle } = setup();
  const first = await settle({ nativeRef });
  assert.equal(first.status, 'SETTLED');
  assert.equal(first.record.authorizationEventId, 'evt-approved');
  assert.equal(first.record.nativeStoredAt, '2026-11-10T09:00:04.000Z');
  assert.equal(first.record.nativeCseKey, cseKey);
  assert.equal(first.record.nativeRef, nativeRef);
  assert.deepEqual(await settle({ nativeRef, ack }), { status: 'ALREADY_SETTLED', record: first.record });
  assert.deepEqual(await settle({ nativeRef, ack: { ...ack, payloadHash: '0'.repeat(64) } }),
    { status: 'REVIEW', reason: 'CORE_ACK_BINDING' });
  cin.con = { ...originalReceipt, detail: 'changed' };
  assert.deepEqual(await settle({ nativeRef }), { status: 'REVIEW', reason: 'SETTLEMENT_CONFLICT' });
  assert.deepEqual(paths, Array(4).fill(nativeRef));
});

test('holds recreated native instances and refuses to infer an old CSE route', async () => {
  const { cin, settle } = setup();
  const { record } = await settle({ nativeRef });
  cin.ri = 'recreated-cin';
  assert.deepEqual(await settle({ nativeRef }), { status: 'REVIEW', reason: 'SETTLEMENT_NATIVE_CONFLICT' });
  cin.ri = record.nativeResourceId;
  cin.ct = '20261110T090005';
  assert.deepEqual(await settle({ nativeRef }), { status: 'REVIEW', reason: 'SETTLEMENT_NATIVE_CONFLICT' });
  const fromExistingRecord = (saved) => async () => ({ created: false, record: saved });
  const otherCse = setup({ cseKey: 'replacement-cse', commitIfAbsent: fromExistingRecord(record) });
  assert.deepEqual(await otherCse.settle({ nativeRef }), { status: 'REVIEW', reason: 'SETTLEMENT_SOURCE_CONFLICT' });
  const otherPath = setup({ commitIfAbsent: fromExistingRecord({ ...record, nativeRef: `/Mobius/retired/${name}` }) });
  assert.deepEqual(await otherPath.settle({ nativeRef }), { status: 'REVIEW', reason: 'SETTLEMENT_SOURCE_CONFLICT' });
  const { nativeCseKey: oldKey, nativeRef: oldRef, ...legacy } = record;
  const oldSettlement = setup({ commitIfAbsent: fromExistingRecord(legacy) });
  assert.deepEqual(await oldSettlement.settle({ nativeRef }), { status: 'REVIEW', reason: 'SETTLEMENT_SOURCE_UNBOUND' });
});

test('holds missing, misnamed or unverifiable receipts without settling', async () => {
  const { cin, cse, paths, settle } = setup({ commitIfAbsent: async () => assert.fail('unexpected write') });
  assert.deepEqual(await settle({ nativeRef: `/unregistered/receipts/${name}` }),
    { status: 'REVIEW', reason: 'INVALID_NATIVE_REFERENCE' });
  assert.deepEqual(paths, []);
  cse.status = 404;
  cse.rsc = 4004;
  assert.deepEqual(await settle({ nativeRef }), { status: 'WAITING_FOR_NATIVE' });
  cse.status = 403;
  cse.rsc = 4103;
  await assert.rejects(settle({ nativeRef }), /NATIVE_RECEIPT_RETRIEVE_FAILED/);
  cse.status = 200;
  cse.rsc = 2000;
  cin.con = { ...originalReceipt, commandId: 'different-command' };
  assert.deepEqual(await settle({ nativeRef }), { status: 'REVIEW', reason: 'NATIVE_RECEIPT_NAME_BINDING' });
  cin.con = originalReceipt;
  cin.ct = '20261110T090002';
  assert.deepEqual(await settle({ nativeRef }), { status: 'REVIEW', reason: 'AUTHORIZATION_ORDER_UNCERTAIN' });
  const denied = setup({ readAuthorizationHistory: async () => [] });
  assert.deepEqual(await denied.settle({ nativeRef }), { status: 'REVIEW', reason: 'HISTORICAL_AUTHORIZATION_REQUIRED' });
  const badSchema = setup({ validateNativeReceipt: async () => false });
  assert.deepEqual(await badSchema.settle({ nativeRef }), { status: 'REVIEW', reason: 'INVALID_NATIVE_RECEIPT' });
});

test('preserves bound negative outcomes without claiming application or requiring a positive authorization', async () => {
  const { cin, settle } = setup({ readAuthorizationHistory: async () => assert.fail('unexpected positive authorization lookup'),
    commitIfAbsent: async () => assert.fail('unexpected successful settlement') });
  for (const [status, ackCode] of [['REJECTED', 'NOT_AUTHORIZED'], ['TIMEOUT', 'TIMEOUT'],
    ['INDETERMINATE', 'RESTART_INTERRUPTED']]) {
    cin.con = { ...originalReceipt, status, ackCode, readback: null };
    assert.deepEqual(await settle({ nativeRef }), { status: 'REVIEW', reason: `${status}_${ackCode}` });
  }
  assert.deepEqual(await settle({ nativeRef, ack }), { status: 'REVIEW', reason: 'CORE_ACK_BINDING' });
  cin.con = { ...cin.con, payloadHash: '0'.repeat(64) };
  assert.deepEqual(await settle({ nativeRef }), { status: 'REVIEW', reason: 'ISSUED_COMMAND_BINDING' });
});

test('propagates settlement persistence failure', async () => {
  const { settle } = setup({ commitIfAbsent: async () => { throw new Error('storage unavailable'); } });
  await assert.rejects(settle({ nativeRef }), /storage unavailable/);
});

test('POSIX commit records a single winner across independent callers and reopen',
  { skip: typeof process.getuid !== 'function' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'keyring-settlement-'));
    try {
      const first = setup({ commitIfAbsent: createFileSettlementCommit(directory) });
      const second = setup({ commitIfAbsent: createFileSettlementCommit(directory) });
      const results = await Promise.all([first.settle({ nativeRef }), second.settle({ nativeRef })]);
      assert.deepEqual(results.map(({ status }) => status).sort(), ['ALREADY_SETTLED', 'SETTLED']);
      assert.deepEqual(results[0].record, results[1].record);
      const reopened = setup({ commitIfAbsent: createFileSettlementCommit(directory) });
      assert.deepEqual(await reopened.settle({ nativeRef }), { status: 'ALREADY_SETTLED', record: results[0].record });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
