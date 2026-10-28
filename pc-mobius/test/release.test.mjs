import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../release/manifest.json', import.meta.url));
const schemaPath = fileURLToPath(new URL('../contracts/gateway-event.schema.json', import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));

test('CORE release manifest maps runtime artifacts and replay commands', () => {
  assert.equal(manifest.role, 'PC-MOBIUS-CORE');
  assert.equal(manifest.docRevision, '2.0.0');
  assert.ok(manifest.artifacts.includes('db/migrations/001_core_receipts.sql'));
  assert.ok(manifest.commands.replayReceipt.includes('replay-receipt.mjs'));
});

test('Gateway event schema preserves BLE-to-Mobius payload contract', () => {
  assert.deepEqual(schema.required, ['deviceId', 'sequence', 'timestamp', 'state', 'batteryPct', 'rssiDbm', 'schemaVersion']);
  assert.equal(schema.properties.schemaVersion.const, '1.0.0');
  assert.equal(schema.properties.sequence.maximum, 4294967295);
});
