import { commitReceiptTransaction } from './receipt-postgres-transaction.mjs';

const insert = `
  INSERT INTO privacy_bubble.keyring_command_settlement (gateway_id, command_id, settlement)
  VALUES ($1, $2, $3::jsonb)
  ON CONFLICT (gateway_id, command_id) DO NOTHING
  RETURNING settlement`;
const select = `
  SELECT settlement FROM privacy_bubble.keyring_command_settlement
  WHERE gateway_id = $1 AND command_id = $2`;

/** Commit the unique record using a dedicated connection checked out from a pg.Pool. */
export function createPostgresSettlementCommit(pool) {
  return async function commitIfAbsent(key, candidate) {
    if (!Array.isArray(key) || key.length !== 2 || !candidate
        || key[0] !== candidate.gatewayId || key[1] !== candidate.commandId) {
      throw new Error('SETTLEMENT_KEY_MISMATCH');
    }

    return commitReceiptTransaction(pool, async (client) => {
      const inserted = await client.query(insert, [...key, JSON.stringify(candidate)]);
      const created = inserted.rows.length === 1;
      // A concurrent winner can be invisible to the INSERT snapshot. Read it in a new statement.
      const rows = created ? inserted.rows : (await client.query(select, key)).rows;
      if (rows.length !== 1 || !rows[0].settlement) throw new Error('SETTLEMENT_ROW_UNAVAILABLE');
      return { created, record: rows[0].settlement };
    });
  };
}
