import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { RetentionService, RETENTION_DEFAULTS } from '../integration/src/retention-service.mjs';
import { ReceiptJournal } from '../src/receipt-journal.mjs';
import { FlCoordinator } from '../integration/src/fl-coordinator.mjs';
import { enrollLocalClient, buildLocalUpdate } from '../integration/src/fl-client.mjs';

test('retention expires detailed, abstract, pseudonym and audit rows at independent boundaries', async () => {
  const now = Date.parse('2026-11-10T00:00:00Z'); const store = await new IntegrationStore().init();
  const retention = new RetentionService({ store, clock: () => new Date(now).toISOString(), householdPolicies: { short: { detail: 1000 } } });
  const cases = [['locationPayloads', 'detail'], ['locationLeases', 'detail'], ['relayAssociations', 'pseudonym'], ['abstractStates', 'abstract'], ['pseudonymMappings', 'pseudonym'], ['flWorkerUpdates', 'provenance'], ['deviceButtonStates', 'abstract'], ['deviceIncidentEvents', 'detail'], ['gatewayDeviceReceipts', 'abstract']];
  for (const [collection, category] of cases) {
    await store.put(collection, 'old', { createdAt: new Date(now - RETENTION_DEFAULTS[category]).toISOString(), secret: 'private-value' });
    await store.put(collection, 'fresh', { createdAt: new Date(now - RETENTION_DEFAULTS[category] + 1).toISOString() });
  }
  await store.put('locationPayloads', 'short', { householdId: 'short', createdAt: new Date(now - 1000).toISOString() });
  await store.put('locationLeases', 'lease', { createdAt: new Date(now - 5000).toISOString(), expiresAt: new Date(now).toISOString() });
  await store.put('portalCommandRequests', 'requested', { requestedAt: new Date(now - RETENTION_DEFAULTS.detail).toISOString() });
  await store.put('deviceIncidentEvents', 'observed', { observedAt: new Date(now - RETENTION_DEFAULTS.detail).toISOString() });
  await store.append('receipts', { eventId: 'old-audit', timestamp: new Date(now - RETENTION_DEFAULTS.audit).toISOString() });
  const report = await retention.runOnce(); assert.equal(report.deletedCount, 14);
  assert.equal(store.get('portalCommandRequests', 'requested'), undefined); assert.equal(store.get('deviceIncidentEvents', 'observed'), undefined);
  for (const [collection] of cases) { assert.equal(store.get(collection, 'old'), undefined); assert.ok(store.get(collection, 'fresh')); }
  assert.equal(store.list('receipts').filter((r) => r.type === 'RETENTION_EXPIRED').length, 1);
  assert.equal(JSON.stringify(store.list('receipts')).includes('private-value'), false);
  assert.equal((await retention.runOnce()).deletedCount, 0);
  assert.throws(() => new RetentionService({ store, householdPolicies: { home: { detail: 86400001 } } }), /RETENTION_POLICY_RANGE/);
});

test('expiry survives restart and journal compaction preserves concurrent append and receipt hashes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-retention-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = () => '2026-11-10T00:00:00Z'; const path = join(directory, 'state.json'); const journal = new ReceiptJournal(join(directory, 'receipts.jsonl'), { clock });
  let store = await new IntegrationStore(path, { receiptJournal: journal }).init();
  await store.append('receipts', { eventId: 'expired', timestamp: '2026-09-01T00:00:00Z', detail: 'expired-secret' });
  await store.append('receipts', { eventId: 'retained', timestamp: clock() });
  store = await new IntegrationStore(path, { receiptJournal: journal }).init();
  const retention = new RetentionService({ store, receiptJournal: journal, clock });
  await Promise.all([retention.runOnce(), journal.append({ eventId: 'concurrent', timestamp: clock() })]);
  const content = await readFile(journal.path, 'utf8'); assert.equal(content.includes('expired-secret'), false);
  const receipts = content.trim().split('\n').map(JSON.parse); assert.ok(receipts.some((r) => r.eventId === 'concurrent')); assert.ok(receipts.some((r) => r.eventId === 'retained')); assert.ok(receipts.every((r) => /^[a-f0-9]{64}$/.test(r.receiptHash)));
  const reopened = await new IntegrationStore(path).init(); assert.equal(reopened.list('receipts').some((r) => r.eventId === 'expired'), false);
});

test('thirty-day FL provenance expiry pauses serving and minimizes train receipts while preserving immutable model lineage', async () => {
  let now = '2026-10-01T00:00:00Z'; const clock = () => now; const store = await new IntegrationStore().init(); const fl = new FlCoordinator({ store, clock });
  const clients = []; for (let index = 0; index < 2; index++) clients.push(await enrollLocalClient(fl, { participantId: `p${index}`, taskId: 'retention-task', seed: 101 * (index + 1), clientIndex: index }));
  const round = await fl.createRound({ taskId: 'retention-task' }); for (const client of clients) await fl.submitUpdate(buildLocalUpdate(fl, client, round));
  const complete = await fl.finalizeRound(round.roundId); const manifest = fl.readArtifact(complete.prepared.manifestRef, complete.manifestHash).toString();
  now = '2026-10-31T00:00:00Z'; const retention = new RetentionService({ store, clock }); const result = await retention.runOnce();
  assert.equal(result.counts.flParticipantProvenance, 2); assert.equal(result.counts.flTrainReceipts, 2);
  assert.equal(fl.getParticipant('retention-task', 'p0').dataset.seed, undefined); assert.equal(fl.task('retention-task').state, 'SERVING_PAUSED');
  assert.throws(() => fl.serveArtifact(round.roundId, complete.modelHash), /FL_SERVING_FENCE/);
  assert.equal(fl.readArtifact(complete.prepared.manifestRef, complete.manifestHash).toString(), manifest);
  const generation = fl.task('retention-task').servingGeneration; await retention.runOnce(); assert.equal(fl.task('retention-task').servingGeneration, generation);
});
