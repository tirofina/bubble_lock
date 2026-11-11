import assert from 'node:assert/strict';
import test from 'node:test';
import { compareJournalSettlements, requireScopedJournalReport } from '../../dev/mobius4/receipt-settlement/journal-evidence.mjs';
import { scopedReceiptCseKey } from '../../dev/mobius4/scoped-command-receipts.mjs';

const gatewayId = 'gw-a';
const deviceId = 'kr-a';
const receiptContainer = '/Mobius/privacy-bubble-test-ae/command-receipts-a';
const nativeRef = receiptContainer + '/gw-example';
const applied = { commandId: 'cmd-a', result: 'matched_applied', gatewayDelivered: true, devicePhase: 'completed',
  deviceReadbackState: false, payloadHash: 'a'.repeat(64), gatewayReceiptSha256: 'b'.repeat(64),
  cseReceiptSha256: 'b'.repeat(64), nativeResourceId: 'native-a', nativeStoredAt: '2026-11-10T09:00:04.000Z' };
const reportFor = (...results) => ({ reportVersion: 1, gatewayId, deviceId, cseId: 'Mobius4', receiptContainer,
  gatewayArchiveId: 'archive-a', deviceSnapshotId: 'c'.repeat(32), deviceRecordsSha256: 'd'.repeat(64),
  recordCount: results.length, settlementStatus: 'not-settled', deviceJournalModified: false, results });
const settlement = { version: 1, gatewayId, deviceId, commandId: applied.commandId, payloadHash: applied.payloadHash,
  receiptSha256: applied.cseReceiptSha256, readbackState: false, nativeResourceId: applied.nativeResourceId,
  nativeStoredAt: applied.nativeStoredAt, nativeCseKey: scopedReceiptCseKey, nativeRef, authorizationEventId: 'evt-approved' };
const central = { commandId: applied.commandId, nativeRef, inbox: null, settlement };

test('archive scope and applied evidence must match before lookup', () => {
  const report = reportFor(applied);
  assert.doesNotThrow(() => requireScopedJournalReport(report, gatewayId, receiptContainer));
  assert.doesNotThrow(() => requireScopedJournalReport({ ...report, cseDeploymentId: scopedReceiptCseKey },
    gatewayId, receiptContainer));
  assert.throws(() => requireScopedJournalReport({ ...report, cseDeploymentId: 'production' },
    gatewayId, receiptContainer), /JOURNAL_REPORT_BINDING/);
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
  const otherCse = { ...central, settlement: { ...settlement, nativeCseKey: 'replacement-cse' } };
  assert.deepEqual(compareJournalSettlements(report, [otherCse]).results[0].mismatchedFields, ['nativeCseKey']);
  const { nativeCseKey: oldKey, nativeRef: oldRef, ...unbound } = settlement;
  const legacy = compareJournalSettlements(report, [{ ...central, settlement: unbound }]);
  assert.equal(legacy.results[0].centralResult, 'settlement_source_unbound');
  const missing = compareJournalSettlements(report, [{ ...central, settlement: null }]).results[0];
  assert.equal(missing.centralResult, 'settlement_missing');
  const undelivered = compareJournalSettlements(reportFor({ ...applied, gatewayDelivered: false }), [central]);
  assert.equal(undelivered.matchedCount, 1);
  assert.equal(undelivered.reviewCount, 1);
});

test('same-boot evidence must bind the selected command, phase, timing and ACK', () => {
  const row = { ...applied, gatewayAckCode: 'APPLIED' };
  const selected = { commandId: row.commandId, boardRevision: 'r18-hand-solder', firmwareRevision: 'keyring-0.7.14',
    sameBoot: true, sourceRecordCount: 3, desiredState: false, acceptedUptimeMs: 100, appliedUptimeMs: 101 };
  const report = { ...reportFor(row), selectedCommand: selected };
  assert.doesNotThrow(() => requireScopedJournalReport(report, gatewayId, receiptContainer));
  const matched = compareJournalSettlements(report, [central]);
  assert.deepEqual(matched.selectedCommand, selected);
  assert.equal(matched.results[0].gatewayAckCode, 'APPLIED');
  assert.equal(matched.originalApplicationMatched, true);

  const duplicate = { ...report, results: [{ ...row, gatewayAckCode: 'DUPLICATE' }] };
  assert.doesNotThrow(() => requireScopedJournalReport(duplicate, gatewayId, receiptContainer));
  const duplicateResult = compareJournalSettlements(duplicate, [central]);
  assert.equal(duplicateResult.results[0].centralResult, 'settlement_matched');
  assert.equal(duplicateResult.originalApplicationMatched, false);
  assert.equal(duplicateResult.reviewCount, 1);
  assert.equal(compareJournalSettlements(report, [{ ...central, settlement: null }]).originalApplicationMatched, false);
  assert.equal(compareJournalSettlements({ ...report, results: [{ ...row, gatewayDelivered: false }] },
    [central]).originalApplicationMatched, false);

  const invalid = [
    [{ commandId: 'other' }, /JOURNAL_SELECTED_COMMAND_BINDING/],
    [{ sameBoot: false }, /JOURNAL_SELECTED_COMMAND_BINDING/],
    [{ appliedUptimeMs: 99 }, /JOURNAL_SELECTED_COMMAND_UPTIME/],
    [{ desiredState: true }, /JOURNAL_SELECTED_COMMAND_ACK/],
  ];
  for (const [fields, error] of invalid) {
    assert.throws(() => requireScopedJournalReport({ ...report, selectedCommand: { ...selected, ...fields } },
      gatewayId, receiptContainer), error);
  }
  assert.throws(() => requireScopedJournalReport({ ...report, results: [applied] }, gatewayId, receiptContainer),
    /JOURNAL_SELECTED_COMMAND_ACK/);
});
