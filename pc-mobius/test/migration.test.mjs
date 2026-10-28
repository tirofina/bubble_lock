import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const migrationPath = fileURLToPath(new URL('../db/migrations/001_core_receipts.sql', import.meta.url));
const migration = await readFile(migrationPath, 'utf8');

test('CORE migration defines event, dispatch, receipt and oneM2M binding tables', () => {
  for (const table of ['gateway_event', 'command_dispatch', 'receipt_journal', 'onem2m_binding']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS privacy_bubble\\.${table}`));
  }
  assert.match(migration, /UNIQUE \(device_id, sequence_no\)/);
  assert.match(migration, /receipt_hash\s+CHAR\(64\)/);
  assert.match(migration, /wire_envelope, transport/);
});
