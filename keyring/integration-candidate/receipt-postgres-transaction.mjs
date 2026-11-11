/** Return only after PostgreSQL confirms the commit on this connection. */
export async function commitReceiptTransaction(pool, work) {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query('SET LOCAL synchronous_commit = on');
    const value = await work(client);
    const result = await client.query('COMMIT');
    if (result.command !== 'COMMIT') throw new Error('SETTLEMENT_COMMIT_UNCONFIRMED');
    return value;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
