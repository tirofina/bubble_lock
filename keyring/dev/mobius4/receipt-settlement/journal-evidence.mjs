import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { receiptIdentifier } from '../../../integration-candidate/receipt-authorization.mjs';

const maxReportBytes = 64 * 1024;
const exact = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const isSha256 = (value) => exact(/^[a-f0-9]{64}$/, value);
const isNativeTime = (value) => exact(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/, value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

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
}

export function compareJournalSettlements(report, records) {
  const { gatewayId, deviceId, cseId, receiptContainer, gatewayArchiveId,
    deviceSnapshotId, deviceRecordsSha256, recordCount } = report;
  if (records.length !== recordCount) throw new Error('JOURNAL_INSPECTION_ROW_BINDING');
  const results = report.results.map((row, index) => {
    const central = records[index];
    if (central?.commandId !== row.commandId) throw new Error('JOURNAL_INSPECTION_ROW_BINDING');
    const { nativeRef, inbox, settlement } = central;
    const result = { commandId: row.commandId, nativeRef, journalResult: row.result,
      gatewayDelivered: row.gatewayDelivered, settlementPresent: settlement !== null, inbox };
    if (row.result !== 'matched_applied') return { ...result, centralResult: 'journal_review_required' };
    if (settlement === null) return { ...result, centralResult: 'settlement_missing' };
    const expected = { version: 1, gatewayId, deviceId, commandId: row.commandId, payloadHash: row.payloadHash,
      receiptSha256: row.cseReceiptSha256, readbackState: row.deviceReadbackState,
      nativeResourceId: row.nativeResourceId, nativeStoredAt: row.nativeStoredAt };
    const mismatchedFields = Object.keys(expected).filter((field) => settlement[field] !== expected[field]);
    if (!receiptIdentifier(settlement.authorizationEventId)) mismatchedFields.push('authorizationEventId');
    if (mismatchedFields.length) return { ...result, centralResult: 'settlement_mismatch', mismatchedFields };
    return { ...result, centralResult: 'settlement_matched', authorizationEventId: settlement.authorizationEventId };
  });
  return { reportVersion: 1, checkedAt: new Date().toISOString(), gatewayId, deviceId, cseId, receiptContainer, gatewayArchiveId,
    deviceSnapshotId, deviceRecordsSha256, recordCount, settlementStatus: 'not-settled', deviceJournalModified: false,
    matchedCount: results.filter((row) => row.centralResult === 'settlement_matched').length,
    reviewCount: results.filter((row) => row.centralResult !== 'settlement_matched' || !row.gatewayDelivered).length,
    results };
}
