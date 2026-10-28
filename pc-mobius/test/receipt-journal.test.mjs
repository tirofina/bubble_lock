import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptJournal, hashReceipt } from '../src/receipt-journal.mjs';

test('ReceiptJournal writes a hash-recorded JSONL receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'privacy-bubble-receipt-'));
  const path = join(directory, 'gateway.jsonl');
  const journal = new ReceiptJournal(path, { clock: () => '2026-10-28T00:00:00.000Z' });
  const receipt = { contractId: 'privacy-bubble.raspberrypi-gateway', status: 'APPLIED', requestId: 'pb-7' };
  const record = await journal.append(receipt);
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(record.receiptHash, hashReceipt(receipt));
  assert.deepEqual(JSON.parse(lines[0]), record);
});
