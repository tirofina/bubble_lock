import { readFile } from 'node:fs/promises';
import pg from 'pg';

export async function openScopedReceiptPool(applicationName) {
  const password = (await readFile(new URL('./.local/database-password', import.meta.url), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('INVALID_SCOPED_DATABASE_PASSWORD');
  return new pg.Pool({ host: '127.0.0.1', port: 5544, user: 'keyring_receipt_dev', database: 'keyring_receipt_dev',
    password, ssl: false, application_name: applicationName, max: 3,
    connectionTimeoutMillis: 5000, statement_timeout: 10000 });
}

export async function requireScopedReceiptSchema(pool) {
  const { rows } = await pool.query(`SELECT to_regclass('privacy_bubble.keyring_command_settlement') IS NOT NULL
    AND to_regclass('privacy_bubble.keyring_receipt_notification') IS NOT NULL AS ready`);
  if (rows[0]?.ready !== true) throw new Error('SCOPED_RECEIPT_SCHEMA_REQUIRED');
}
