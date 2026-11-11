import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createReceiptNotificationHttpHandler } from '../../integration-candidate/receipt-notification-https.mjs';

const path = '/onem2m/keyring/receipt-notifications';
const fingerprint256 = Array(32).fill('AB').join(':');
const peers = [{ fingerprint256, cseKey: 'scoped' }];

async function deliver(handle, options = {}) {
  const request = Readable.from(options.chunks ?? [Buffer.from('{}')]);
  Object.assign(request, {
    method: options.method ?? 'POST', url: options.url ?? path,
    headers: { 'content-type': 'application/json', 'x-verified-cse': 'scoped', ...options.headers },
    socket: { authorized: options.authorized ?? true,
      getPeerCertificate: () => ({ fingerprint256: options.fingerprint ?? fingerprint256 }) },
  });
  const result = {};
  await handle(request, {
    writeHead(status, headers) { Object.assign(result, { status, headers }); return this; },
    end() {},
  });
  return result;
}

test('binds the verified certificate fingerprint to the configured CSE identity', async () => {
  const received = [];
  const handle = createReceiptNotificationHttpHandler({ peers, receive: async (input) => {
    received.push(input);
    return { httpStatus: 200, headers: { 'x-m2m-rsc': '2000' } };
  } });
  assert.equal((await deliver(handle, { headers: { 'x-verified-cse': 'forged' } })).status, 200);
  assert.equal(received[0].verifiedCseKey, 'scoped');
  assert.equal(received[0].body.toString(), '{}');
  assert.equal((await deliver(handle, { authorized: false })).status, 403);
  assert.equal((await deliver(handle, { fingerprint: Array(32).fill('CD').join(':') })).status, 403);
  assert.equal(received.length, 1);
});

test('rejects unregistered paths, methods, encodings and oversized requests before enqueue', async () => {
  const handle = createReceiptNotificationHttpHandler({ peers, receive: async () => assert.fail('unexpected enqueue') });
  assert.equal((await deliver(handle, { url: `${path}?token=value` })).status, 404);
  assert.equal((await deliver(handle, { method: 'GET' })).status, 405);
  assert.equal((await deliver(handle, { headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await deliver(handle, { headers: { 'content-length': '8193' } })).status, 413);
  assert.equal((await deliver(handle, { chunks: [Buffer.alloc(8192), Buffer.from('x')] })).status, 413);
});

test('returns a failure response when durable ingress is unavailable', async () => {
  const handle = createReceiptNotificationHttpHandler({ peers, receive: async () => { throw new Error('unavailable'); } });
  assert.equal((await deliver(handle)).status, 503);
});
