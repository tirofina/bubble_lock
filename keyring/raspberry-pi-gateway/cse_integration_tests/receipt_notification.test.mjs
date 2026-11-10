import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptNotificationIngress } from '../../integration-candidate/receipt-notification-ingress.mjs';
import { createPostgresReceiptInbox } from '../../integration-candidate/receipt-notification-postgres.mjs';
import { createReceiptNotificationWorker } from '../../integration-candidate/receipt-notification-worker.mjs';

const container = '/Mobius/bench/command-receipts-a';
const subscriptionRef = `${container.slice(1)}/settlement`; // Mobius4 structured ID omits the leading slash.
const nativeRef = `${container}/gw-${'a'.repeat(64)}`;
const registration = { cseKey: 'scoped', originator: '/Mobius4', subscriptionRef, receiptContainer: container };
const headers = { 'x-m2m-origin': '/Mobius4', 'x-m2m-ri': 'http-noti-test', 'x-m2m-rvi': '4' };
const delivery = (signal, verifiedCseKey = 'scoped') => ({ verifiedCseKey, headers,
  body: Buffer.from(JSON.stringify({ 'm2m:sgn': { sur: subscriptionRef, ...signal } })) });
const event = { nev: { net: 3, rep: { 'm2m:uri': nativeRef.slice(1) } } };

test('verification only responds, and the receipt callback enqueues the canonical URI', async () => {
  const queued = [];
  const receive = createReceiptNotificationIngress({ subscriptions: [registration], enqueue: async (...args) => queued.push(args) });
  assert.deepEqual(await receive(delivery({ vrq: true })), {
    httpStatus: 200, headers: { 'x-m2m-rsc': '2000', 'x-m2m-ri': 'http-noti-test' },
  });
  assert.deepEqual(queued, []);
  assert.equal((await receive(delivery(event))).httpStatus, 200);
  assert.deepEqual(queued, [[{ cseKey: 'scoped', nativeRef }, 'CSE_CALLBACK']]);
});

test('records both delivery paths in the same transaction as their inbox insertion attempts', async () => {
  const statements = [];
  let hasInbox = false;
  const client = { async query(sql, params) {
    const statement = sql.trimStart();
    if (statement.startsWith('INSERT INTO privacy_bubble.keyring_receipt_notification')) {
      statements.push(['inbox', params]);
      if (hasInbox) return { rowCount: 0 };
      hasInbox = true;
      return { rowCount: 1 };
    }
    if (statement.startsWith('INSERT INTO privacy_bubble.keyring_receipt_delivery')) {
      statements.push(['delivery', params]);
      return { rowCount: 1 };
    }
    if (statement === 'COMMIT') statements.push(['commit']);
    return { command: statement };
  }, release() {} };
  const inbox = createPostgresReceiptInbox({ connect: async () => client });
  const entry = { cseKey: 'scoped', nativeRef };
  assert.equal(await inbox.enqueue(entry, 'RECOVERY_SWEEP'), true);
  assert.equal(await inbox.enqueue(entry, 'CSE_CALLBACK'), false);
  assert.deepEqual(statements, [
    ['inbox', ['scoped', nativeRef]], ['delivery', ['scoped', nativeRef, 'RECOVERY_SWEEP', true]], ['commit'],
    ['inbox', ['scoped', nativeRef]], ['delivery', ['scoped', nativeRef, 'CSE_CALLBACK', false]], ['commit'],
  ]);
});

test('rejects a spoofed peer, cross-container URI, and full-body notification', async () => {
  const receive = createReceiptNotificationIngress({ subscriptions: [registration], enqueue: async () => assert.fail('unexpected enqueue') });
  assert.equal((await receive(delivery(event, null))).httpStatus, 403);
  assert.equal((await receive(delivery(event, 'other'))).httpStatus, 403);
  const other = { nev: { net: 3, rep: { 'm2m:uri': nativeRef.slice(1).replace('receipts-a', 'receipts-b') } } };
  assert.equal((await receive(delivery(other))).httpStatus, 400);
  const full = { nev: { net: 3, rep: { 'm2m:cin': { rn: nativeRef.split('/').pop(), con: {} } } } };
  assert.equal((await receive(delivery(full))).httpStatus, 400);
});

test('a lost database commit reply never yields notification success', async () => {
  const receive = createReceiptNotificationIngress({ subscriptions: [registration], enqueue: async () => { throw new Error('offline'); } });
  assert.deepEqual(await receive(delivery(event)), {
    httpStatus: 503, headers: { 'x-m2m-rsc': '5000', 'x-m2m-ri': 'http-noti-test' },
  });
});

test('the worker retries missing receipts and accepts an already-settled replay', async () => {
  const job = { cseKey: 'scoped', nativeRef, attempts: 1, leaseToken: 'lease-one' };
  const completions = [];
  const outcomes = ['WAITING_FOR_NATIVE', 'ALREADY_SETTLED'];
  const run = createReceiptNotificationWorker({ inbox: { claim: async () => ({ ...job }),
    finish: async (claimed, result) => { completions.push([claimed, result]); return true; } },
  resolveSettlement: async (key) => {
    assert.equal(key, 'scoped');
    return async (request) => {
      assert.deepEqual(request, { nativeRef });
      return { status: outcomes.shift() };
    };
  } });
  assert.deepEqual(await run(), { status: 'PENDING', reason: 'WAITING_FOR_NATIVE' });
  assert.deepEqual(completions[0][1], { state: 'PENDING', reason: 'WAITING_FOR_NATIVE', delaySeconds: 5 });
  job.attempts = 2;
  job.leaseToken = 'lease-two';
  assert.deepEqual(await run(), { status: 'SETTLED', reason: 'ALREADY_SETTLED' });
  assert.equal(completions[1][0].leaseToken, 'lease-two');
});

test('an expired worker lease cannot report completion, and exhausted work goes to review', async () => {
  let finishAllowed = false;
  const run = createReceiptNotificationWorker({ maxAttempts: 1,
    inbox: { claim: async () => ({ cseKey: 'scoped', nativeRef, attempts: 2 }), finish: async () => finishAllowed },
    resolveSettlement: async () => assert.fail('retry limit must not read CSE'),
  });
  assert.deepEqual(await run(), { status: 'LEASE_LOST' });
  finishAllowed = true;
  assert.deepEqual(await run(), { status: 'REVIEW', reason: 'RETRY_LIMIT' });
});
