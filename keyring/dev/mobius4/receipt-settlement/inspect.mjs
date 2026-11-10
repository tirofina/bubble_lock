import { parseArgs } from 'node:util';
import { commandReceiptName } from '../../../integration-candidate/receipt-native-source.mjs';
import { scopedCommandReceiptContainers } from '../scoped-command-receipts.mjs';
import { openScopedReceiptPool } from './scoped-database.mjs';

const cseKey = 'scoped-mobius4';
const query = `
  SELECT
    (SELECT jsonb_build_object('state', state, 'attempts', attempts, 'lastResult', last_result, 'createdAt', created_at)
      FROM privacy_bubble.keyring_receipt_notification WHERE cse_key = $1 AND native_ref = $2) AS inbox,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('source', source, 'firstSeenAt', first_seen_at, 'queuedNew', queued_new)
      ORDER BY first_seen_at, source) FROM privacy_bubble.keyring_receipt_delivery
      WHERE cse_key = $1 AND native_ref = $2), '[]'::jsonb) AS deliveries,
    (SELECT settlement || jsonb_build_object('recordedAt', recorded_at) FROM privacy_bubble.keyring_command_settlement
      WHERE gateway_id = $3 AND command_id = $4) AS settlement`;

async function main() {
  const { values: { gateway, command } } = parseArgs({ options: {
    gateway: { type: 'string' }, command: { type: 'string' },
  } });
  if (!gateway || !Object.hasOwn(scopedCommandReceiptContainers, gateway)) throw new Error('UNKNOWN_SCOPED_GATEWAY');
  const nativeRef = `${scopedCommandReceiptContainers[gateway]}/${commandReceiptName(command)}`;
  const pool = await openScopedReceiptPool('keyring-scoped-receipt-inspection');
  try {
    const { rows: [record] } = await pool.query(query, [cseKey, nativeRef, gateway, command]);
    process.stdout.write(`${JSON.stringify({ gatewayId: gateway, commandId: command, cseKey, nativeRef, ...record }, null, 2)}\n`);
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
