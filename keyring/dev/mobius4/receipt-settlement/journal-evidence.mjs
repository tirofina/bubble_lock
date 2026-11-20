import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { receiptIdentifier } from '../../../integration-candidate/receipt-authorization.mjs';
import { scopedReceiptCseKey } from '../scoped-command-receipts.mjs';

const maxReportBytes = 64 * 1024;
const exact = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const isSha256 = (value) => exact(/^[a-f0-9]{64}$/, value);
const isNativeTime = (value) => exact(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/, value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function requireSelectedCommand(selected, rows) {
  const row = rows[0];
  if (rows.length !== 1 || !selected || typeof selected !== 'object'
      || Object.keys(selected).length !== 8 || selected.commandId !== row.commandId
      || !receiptIdentifier(selected.boardRevision) || !receiptIdentifier(selected.firmwareRevision)
      || selected.sameBoot !== true || typeof selected.desiredState !== 'boolean'
      || !Number.isInteger(selected.sourceRecordCount) || selected.sourceRecordCount < 1 || selected.sourceRecordCount > 32
      || !Number.isSafeInteger(selected.acceptedUptimeMs) || selected.acceptedUptimeMs < 0) {
    throw new Error('JOURNAL_SELECTED_COMMAND_BINDING');
  }
  const appliedTimeValid = row.devicePhase === 'prepared'
    ? selected.appliedUptimeMs === null
    : Number.isSafeInteger(selected.appliedUptimeMs) && selected.appliedUptimeMs >= selected.acceptedUptimeMs;
  if (!appliedTimeValid) throw new Error('JOURNAL_SELECTED_COMMAND_UPTIME');
  if (Object.hasOwn(row, 'gatewayAckCode') && !receiptIdentifier(row.gatewayAckCode)) {
    throw new Error('JOURNAL_SELECTED_COMMAND_ACK');
  }
  if (row.result === 'matched_applied' && (selected.desiredState !== row.deviceReadbackState
      || !['APPLIED', 'DUPLICATE'].includes(row.gatewayAckCode))) {
    throw new Error('JOURNAL_SELECTED_COMMAND_ACK');
  }
}

export async function readJournalReport(path) {
  const chunks = [];
  for await (const chunk of createReadStream(path, { end: maxReportBytes })) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (bytes.length > maxReportBytes) throw new Error('JOURNAL_REPORT_TOO_LARGE');
  return { report: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function requireScopedJournalReport(report, gatewayId, receiptContainer) {
  const rows = report?.results;
  if (report?.reportVersion !== 1 || report.gatewayId !== gatewayId
      || report.cseId !== 'Mobius4' || report.receiptContainer !== receiptContainer
      || (report.cseDeploymentId != null && report.cseDeploymentId !== scopedReceiptCseKey)
      || !receiptIdentifier(report.deviceId) || !receiptIdentifier(report.gatewayArchiveId)
      || !exact(/^[a-f0-9]{32}$/, report.deviceSnapshotId) || !isSha256(report.deviceRecordsSha256)
      || report.settlementStatus !== 'not-settled' || report.deviceJournalModified !== false
      || !Array.isArray(rows) || rows.length > 32 || rows.length !== report.recordCount) {
    throw new Error('JOURNAL_REPORT_BINDING');
  }
  const ids = new Set();
  for (const row of rows) {
    if (!receiptIdentifier(row?.commandId) || ids.has(row.commandId) || !isSha256(row.payloadHash)
        || !['prepared', 'completed'].includes(row.devicePhase)
        || ![true, false, null].includes(row.gatewayDelivered) || typeof row.result !== 'string') {
      throw new Error('JOURNAL_REPORT_ROW');
    }
    ids.add(row.commandId);
    if (row.result === 'matched_applied' && (row.devicePhase !== 'completed'
        || typeof row.deviceReadbackState !== 'boolean' || typeof row.gatewayDelivered !== 'boolean'
        || !receiptIdentifier(row.nativeResourceId) || !isNativeTime(row.nativeStoredAt)
        || !isSha256(row.cseReceiptSha256) || row.cseReceiptSha256 !== row.gatewayReceiptSha256)) {
      throw new Error('JOURNAL_REPORT_APPLIED_BINDING');
    }
  }
  if (Object.hasOwn(report, 'selectedCommand')) requireSelectedCommand(report.selectedCommand, rows);
}

export function compareJournalSettlements(report, records) {
  const { gatewayId, deviceId, cseId, cseDeploymentId = null, receiptContainer, gatewayArchiveId,
    deviceSnapshotId, deviceRecordsSha256, recordCount, selectedCommand } = report;
  if (records.length !== recordCount) throw new Error('JOURNAL_INSPECTION_ROW_BINDING');
  const results = report.results.map((row, index) => {
    const central = records[index];
    if (central?.commandId !== row.commandId) throw new Error('JOURNAL_INSPECTION_ROW_BINDING');
    const { nativeRef, inbox, settlement } = central;
    const result = { commandId: row.commandId, nativeRef, journalResult: row.result,
      gatewayDelivered: row.gatewayDelivered, settlementPresent: settlement !== null, inbox };
    if (selectedCommand) result.gatewayAckCode = row.gatewayAckCode ?? null;
    if (row.result !== 'matched_applied') return { ...result, centralResult: 'journal_review_required' };
    if (settlement === null) return { ...result, centralResult: 'settlement_missing' };
    const expected = { version: 1, gatewayId, deviceId, commandId: row.commandId, payloadHash: row.payloadHash,
      receiptSha256: row.cseReceiptSha256, readbackState: row.deviceReadbackState,
      nativeResourceId: row.nativeResourceId, nativeStoredAt: row.nativeStoredAt };
    const mismatchedFields = Object.keys(expected).filter((field) => settlement[field] !== expected[field]);
    if (!receiptIdentifier(settlement.authorizationEventId)) mismatchedFields.push('authorizationEventId');
    const sourceBound = Object.hasOwn(settlement, 'nativeCseKey') || Object.hasOwn(settlement, 'nativeRef');
    if (sourceBound) {
      if (settlement.nativeCseKey !== scopedReceiptCseKey) mismatchedFields.push('nativeCseKey');
      if (settlement.nativeRef !== nativeRef) mismatchedFields.push('nativeRef');
    }
    if (mismatchedFields.length) return { ...result, centralResult: 'settlement_mismatch', mismatchedFields };
    if (!sourceBound) return { ...result, centralResult: 'settlement_source_unbound' };
    return { ...result, centralResult: 'settlement_matched', authorizationEventId: settlement.authorizationEventId };
  });
  const reviewCount = results.filter((row) => row.centralResult !== 'settlement_matched' || !row.gatewayDelivered
    || (selectedCommand && row.gatewayAckCode !== 'APPLIED')).length;
  return { reportVersion: 1, checkedAt: new Date().toISOString(), gatewayId, deviceId, cseId, cseDeploymentId,
    receiptContainer, gatewayArchiveId,
    deviceSnapshotId, deviceRecordsSha256, recordCount, settlementStatus: 'not-settled', deviceJournalModified: false,
    ...(selectedCommand ? { selectedCommand, originalApplicationMatched: results.length === 1 && reviewCount === 0 } : {}),
    matchedCount: results.filter((row) => row.centralResult === 'settlement_matched').length,
    reviewCount, results };
}
