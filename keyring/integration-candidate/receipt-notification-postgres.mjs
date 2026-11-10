import { randomUUID } from 'node:crypto';
import { commitReceiptTransaction } from './receipt-postgres-transaction.mjs';

const enqueueSql = `
  INSERT INTO privacy_bubble.keyring_receipt_notification (cse_key, native_ref)
  VALUES ($1, $2) ON CONFLICT (cse_key, native_ref) DO NOTHING`;
const hasSql = `
  SELECT 1 FROM privacy_bubble.keyring_receipt_notification WHERE cse_key = $1 AND native_ref = $2`;

const claimSql = `
  WITH next_job AS (
    SELECT cse_key, native_ref FROM privacy_bubble.keyring_receipt_notification
    WHERE state = 'PENDING' AND next_attempt_at <= clock_timestamp()
      AND (lease_until IS NULL OR lease_until <= clock_timestamp())
    ORDER BY next_attempt_at, created_at, cse_key, native_ref
    LIMIT 1 FOR UPDATE SKIP LOCKED
  )
  UPDATE privacy_bubble.keyring_receipt_notification AS queue
  SET lease_token = $1::uuid, lease_until = clock_timestamp() + ($2::int * INTERVAL '1 second'),
      attempts = queue.attempts + 1
  FROM next_job
  WHERE queue.cse_key = next_job.cse_key AND queue.native_ref = next_job.native_ref
  RETURNING queue.cse_key AS "cseKey", queue.native_ref AS "nativeRef", queue.attempts,
            queue.lease_token AS "leaseToken"`;

const finishSql = `
  UPDATE privacy_bubble.keyring_receipt_notification
  SET state = $4, last_result = $5, lease_token = NULL, lease_until = NULL,
      next_attempt_at = clock_timestamp() + ($6::int * INTERVAL '1 second')
  WHERE cse_key = $1 AND native_ref = $2 AND state = 'PENDING'
    AND lease_token = $3::uuid AND lease_until > clock_timestamp()`;

export function createPostgresReceiptInbox(pool) {
  return {
    enqueue({ cseKey, nativeRef }) {
      return commitReceiptTransaction(pool, async (client) => (await client.query(enqueueSql, [cseKey, nativeRef])).rowCount === 1);
    },
    async has({ cseKey, nativeRef }) {
      return (await pool.query(hasSql, [cseKey, nativeRef])).rowCount === 1;
    },
    async claim(leaseSeconds) {
      const { rows } = await pool.query(claimSql, [randomUUID(), leaseSeconds]);
      return rows[0] ?? null;
    },
    async finish({ cseKey, nativeRef, leaseToken }, { state, reason, delaySeconds = 0 }) {
      const { rowCount } = await pool.query(finishSql, [cseKey, nativeRef, leaseToken, state, reason, delaySeconds]);
      return rowCount === 1;
    },
  };
}
