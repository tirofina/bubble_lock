import assert from 'node:assert/strict';
import test from 'node:test';
import { compareJournalSettlements, requireScopedJournalReport } from '../../dev/mobius4/receipt-settlement/journal-evidence.mjs';

const gatewayId = 'gw-a';
const deviceId = 'kr-a';
const receiptContainer = '/Mobius/privacy-bubble-test-ae/command-receipts-a';
const applied = { commandId: 'cmd-a', result: 'matched_applied', gatewayDelivered: true, devicePhase: 'completed',
  deviceReadbackState: false, payloadHash: 'a'.repeat(64), gatewayReceiptSha256: 'b'.repeat(64),
  cseReceiptSha256: 'b'.repeat(64), nativeResourceId: 'native-a', nativeStoredAt: '2026-11-10T09:00:04.000Z' };
const reportFor = (...results) => ({ reportVersion: 1, gatewayId, deviceId, cseId: 'Mobius4', receiptContainer,
  gatewayArchiveId: 'archive-a', deviceSnapshotId: 'c'.repeat(32), deviceRecordsSha256: 'd'.repeat(64),
  recordCount: results.length, settlementStatus: 'not-settled', deviceJournalModified: false, results });
const settlement = { version: 1, gatewayId, deviceId, commandId: applied.commandId, payloadHash: applied.payloadHash,
  receiptSha256: applied.cseReceiptSha256, readbackState: false, nativeResourceId: applied.nativeResourceId,
  nativeStoredAt: applied.nativeStoredAt, authorizationEventId: 'evt-approved' };
const central = { commandId: applied.commandId, nativeRef: receiptContainer + '/gw-example', inbox: null, settlement };

test('archive scope and applied evidence must match before lookup', () => {
  const report = reportFor(applied);
  assert.doesNotThrow(() => requireScopedJournalReport(report, gatewayId, receiptContainer));
  assert.throws(() => requireScopedJournalReport(report, 'gw-b', receiptContainer), /JOURNAL_REPORT_BINDING/);
  assert.throws(() => requireScopedJournalReport(reportFor(applied, applied), gatewayId, receiptContainer),
    /JOURNAL_REPORT_ROW/);
  const differentReceipt = { ...applied, cseReceiptSha256: 'e'.repeat(64) };
  assert.throws(() => requireScopedJournalReport(reportFor(differentReceipt), gatewayId, receiptContainer),
    /JOURNAL_REPORT_APPLIED_BINDING/);
});

test('a replaced native resource, missing settlement and undelivered archive remain distinguishable', () => {
  const report = reportFor(applied);
  const checked = compareJournalSettlements(report, [central]);
  assert.equal(checked.results[0].centralResult, 'settlement_matched');
  assert.equal(checked.reviewCount, 0);
  assert.equal(checked.settlementStatus, 'not-settled');
  const replaced = { ...central, settlement: { ...settlement, nativeResourceId: 'native-other' } };
  const conflict = compareJournalSettlements(report, [replaced]).results[0];
  assert.equal(conflict.centralResult, 'settlement_mismatch');
  assert.deepEqual(conflict.mismatchedFields, ['nativeResourceId']);
  const missing = compareJournalSettlements(report, [{ ...central, settlement: null }]).results[0];
  assert.equal(missing.centralResult, 'settlement_missing');
  const undelivered = compareJournalSettlements(reportFor({ ...applied, gatewayDelivered: false }), [central]);
  assert.equal(undelivered.matchedCount, 1);
  assert.equal(undelivered.reviewCount, 1);
});
