import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import malformed from '../fixtures/malformed-events.json' with { type: 'json' };
import {
  ContractError, createReceiptAdapter, parseCoreReceipt, parseDashboardEvent,
  parseReceiptJsonl, validateDashboardEvent,
} from '../shared/index.ts';
import { DEFAULT_RECEIPT_FILE, loadReplay } from '../server/replay.ts';

test('validates default events when exact CORE fixtures are wrapped', async () => {
  // Given
  const replay = await loadReplay();
  // When
  const events = replay.events.map(parseDashboardEvent);
  // Then
  assert.equal(events.length, 18);
  assert.equal(events.every((event) => event.simulation), true);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 18 }, (_, index) => index + 1));
  assert.equal(events.filter((event) => event.type === 'command.accepted').length, 2);
});

test('rejects malformed fixtures when event schema boundaries are crossed', () => {
  // Given / When / Then
  for (const fixture of malformed) {
    assert.equal(validateDashboardEvent(fixture.event).valid, false, fixture.name);
  }
  assert.equal(validateDashboardEvent('{broken json').valid, false);
});

test('preserves exact receipt fields and hashes when adapting a CORE JSONL journal', async () => {
  // Given
  const receipts = parseReceiptJsonl(await readFile(DEFAULT_RECEIPT_FILE, 'utf8'));
  const adapter = createReceiptAdapter({ currentRevision: 'integration-revision-7' });
  // When
  const events = receipts.map(adapter.adaptReceipt);
  // Then
  for (const [index, event] of events.entries()) {
    const receipt = receipts[index];
    assert.ok(receipt);
    assert.deepEqual(event.receipt, receipt);
    assert.equal(event.receivedAt, receipt.journaledAt);
    assert.equal(event.currentRevision, 'integration-revision-7');
    const { receiptHash, journaledAt: _journaledAt, ...rawReceipt } = receipt;
    assert.equal(receiptHash, createHash('sha256').update(JSON.stringify(rawReceipt)).digest('hex'));
  }
  const telemetry = events.find((event) => event.type === 'gateway.telemetry');
  assert.ok(telemetry);
  assert.equal(telemetry.sequence, 16);
  assert.equal(telemetry.receipt?.sequence, 700);
  assert.equal(telemetry.resourceUri, '/Mobius/privacy-bubble-test-ae/bubbleState');
});

test('uses receipt timestamp and null revision when journal metadata is absent', () => {
  // Given
  const receipt = { status: 'REVIEW', transport: 'mqtt', error: 'offline', timestamp: '2026-10-29T00:00:00.000Z' };
  // When
  const event = createReceiptAdapter().adaptReceipt(receipt);
  // Then
  assert.equal(event.receivedAt, receipt.timestamp);
  assert.equal(event.currentRevision, null);
  assert.equal(event.type, 'receipt.review');
});

test('rejects inconsistent identities when ACK payload and receipt disagree', async () => {
  // Given
  const receipt = (await loadReplay()).events.find((event) => event.type === 'command.ack')?.receipt;
  assert.ok(receipt);
  // When / Then
  assert.throws(() => parseCoreReceipt({ ...receipt, commandId: 'other:keyringA' }), ContractError);
});

test('reports the actual line when a journal record is malformed', () => {
  // Given
  const text = '\n{"status":"REVIEW","timestamp":"2026-10-29T00:00:00.000Z"}\n{broken}\n';
  // When / Then
  assert.throws(() => parseReceiptJsonl(text), /JSONL line 3/);
});

test('does not add acceptance when an explicit receipt file is supplied', async () => {
  // Given / When
  const replay = await loadReplay(DEFAULT_RECEIPT_FILE);
  // Then
  assert.equal(replay.source, 'core-journal-replay');
  assert.equal(replay.events.length, 16);
  assert.equal(replay.events.some((event) => event.type === 'command.accepted'), false);
});
