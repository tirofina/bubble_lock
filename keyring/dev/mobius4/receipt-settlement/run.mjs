import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { scopedCommandReceiptContainers } from '../scoped-command-receipts.mjs';
import { createPostgresSettlementCommit } from '../../../integration-candidate/receipt-settlement-postgres.mjs';
import { createPostgresReceiptInbox } from '../../../integration-candidate/receipt-notification-postgres.mjs';
import { createReceiptNotificationSweep } from '../../../integration-candidate/receipt-notification-recovery.mjs';
import { createReceiptNotificationWorker } from '../../../integration-candidate/receipt-notification-worker.mjs';
import { loadScopedReceiptContext } from './scoped-io.mjs';

const cseKey = 'scoped-mobius4';
const log = (status, details = {}) => process.stdout.write(`${JSON.stringify({ status, ...details })}\n`);

async function main() {
  const local = new URL('../.local/scoped/command-api/', import.meta.url);
  const { values } = parseArgs({ options: {
    'lookback-minutes': { type: 'string', default: '120' }, once: { type: 'boolean' },
  } });
  const minutes = Number(values['lookback-minutes']);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('INVALID_RECOVERY_LOOKBACK');
  const password = (await readFile(new URL('./.local/database-password', import.meta.url), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('INVALID_SCOPED_DATABASE_PASSWORD');
  const context = await loadScopedReceiptContext({ teamRoot: fileURLToPath(new URL('team-source/', local)),
    state: new URL('runtime.json', local) });
  const pool = new pg.Pool({ host: '127.0.0.1', port: 5544, user: 'keyring_receipt_dev', database: 'keyring_receipt_dev',
    password, ssl: false, application_name: 'keyring-scoped-receipt', max: 3,
    connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  pool.on('error', () => log('DATABASE_CONNECTION_LOST'));
  const stop = new AbortController();
  const requestStop = () => stop.abort();
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  try {
    const { rows } = await pool.query(`SELECT to_regclass('privacy_bubble.keyring_command_settlement') IS NOT NULL
      AND to_regclass('privacy_bubble.keyring_receipt_notification') IS NOT NULL AS ready`);
    if (rows[0]?.ready !== true) throw new Error('SCOPED_RECEIPT_SCHEMA_REQUIRED');
    const inbox = createPostgresReceiptInbox(pool);
    const commit = createPostgresSettlementCommit(pool);
    const drainOne = createReceiptNotificationWorker({ inbox, resolveSettlement: async (key) => key === cseKey
      ? context.settleForSnapshot(await context.readSnapshot(), commit) : null });
    const resolveRoute = ({ gatewayId }) => Object.hasOwn(scopedCommandReceiptContainers, gatewayId)
      ? { cseKey, receiptContainer: scopedCommandReceiptContainers[gatewayId], readNativeReceipt: context.readNativeReceipt }
      : null;
    let initialSnapshot = await context.readSnapshot();
    let sweep;
    let after = null;
    log('SCOPED_RECEIPT_PROCESS_READY');
    do {
      try {
        if (!sweep) {
          const snapshot = initialSnapshot ?? await context.readSnapshot();
          initialSnapshot = null;
          const now = Date.now();
          sweep = createReceiptNotificationSweep({ snapshot, inbox, resolveRoute, hashPayload: context.hashPayload,
            from: new Date(now - minutes * 60000).toISOString(), until: new Date(now).toISOString() });
        }
        const page = await sweep({ after, limit: 5 });
        after = page.next;
        if (!after) sweep = null;
        if (page.checked) {
          const gaps = {};
          for (const { reason } of page.gaps) gaps[reason] = (gaps[reason] ?? 0) + 1;
          log('RECOVERY_PAGE', { checked: page.checked, queued: page.queued, alreadyQueued: page.alreadyQueued, gaps });
        }
      } catch (error) {
        log('RECOVERY_RETRY', { code: safeCode(error) });
        if (values.once) throw error;
      }
      for (let count = 0; count < 10 && !stop.signal.aborted; count++) {
        try {
          const result = await drainOne();
          if (result.status === 'IDLE') break;
          log('INBOX_PROGRESS', result);
        } catch (error) {
          log('INBOX_RETRY', { code: safeCode(error) });
          if (values.once) throw error;
          break;
        }
      }
      if (!values.once && !stop.signal.aborted) {
        try { await delay(5000, undefined, { signal: stop.signal }); }
        catch (error) { if (error.name !== 'AbortError') throw error; }
      }
    } while (!values.once && !stop.signal.aborted);
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
    await pool.end();
  }
}

function safeCode(error) {
  return [error?.code, error?.message].find((value) => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value))
    ?? 'SCOPED_RECEIPT_PROCESS_FAILED';
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'ERROR', code: safeCode(error) })}\n`);
  process.exitCode = 1;
}
