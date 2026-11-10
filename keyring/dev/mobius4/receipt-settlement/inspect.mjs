import { parseArgs } from 'node:util';
import { commandReceiptName } from '../../../integration-candidate/receipt-native-source.mjs';
import { scopedCommandReceiptContainers } from '../scoped-command-receipts.mjs';
import { compareJournalSettlements, readJournalReport, requireScopedJournalReport } from './journal-evidence.mjs';
import { openScopedReceiptPool } from './scoped-database.mjs';

const cseKey = 'scoped-mobius4';
const query = `
  SELECT
    requested.command_id AS "commandId", requested.native_ref AS "nativeRef",
    (SELECT jsonb_build_object('state', state, 'attempts', attempts, 'lastResult', last_result, 'createdAt', created_at)
      FROM privacy_bubble.keyring_receipt_notification WHERE cse_key = $1 AND native_ref = requested.native_ref) AS inbox,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('source', source, 'firstSeenAt', first_seen_at, 'queuedNew', queued_new)
      ORDER BY first_seen_at, source) FROM privacy_bubble.keyring_receipt_delivery
      WHERE cse_key = $1 AND native_ref = requested.native_ref), '[]'::jsonb) AS deliveries,
    (SELECT settlement || jsonb_build_object('recordedAt', recorded_at) FROM privacy_bubble.keyring_command_settlement
      WHERE gateway_id = $3 AND command_id = requested.command_id) AS settlement
  FROM unnest($2::text[], $4::text[]) WITH ORDINALITY AS requested(native_ref, command_id, position)
  ORDER BY requested.position`;

async function main() {
  const { values: { gateway, command, 'journal-report': journalPath } } = parseArgs({ options: {
    gateway: { type: 'string' }, command: { type: 'string' },
    'journal-report': { type: 'string' },
  } });
  if (!gateway || !Object.hasOwn(scopedCommandReceiptContainers, gateway)) throw new Error('UNKNOWN_SCOPED_GATEWAY');
  if ((command === undefined) === (journalPath === undefined)) throw new Error('SELECT_COMMAND_OR_JOURNAL_REPORT');
  const container = scopedCommandReceiptContainers[gateway];
  const journal = journalPath === undefined ? null : await readJournalReport(journalPath);
  if (journal) requireScopedJournalReport(journal.report, gateway, container);
  const commands = journal ? journal.report.results.map((row) => row.commandId) : [command];
  const nativeRefs = commands.map((id) => `${container}/${commandReceiptName(id)}`);
  const pool = await openScopedReceiptPool('keyring-scoped-receipt-inspection');
  try {
    const { rows } = await pool.query(query, [cseKey, nativeRefs, gateway, commands]);
    const result = journal
      ? { journalReportSha256: journal.sha256, ...compareJournalSettlements(journal.report, rows) }
      : rows[0];
    process.stdout.write(`${JSON.stringify({ gatewayId: gateway, cseKey, ...result }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  const code = [error?.code, error?.message].find((value) => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value));
  console.error(JSON.stringify({ status: 'ERROR', code: code ?? 'SCOPED_RECEIPT_INSPECTION_FAILED' }));
  process.exitCode = 1;
}
