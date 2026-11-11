import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { FlCoordinator, signFlUpdate } from '../integration/src/fl-coordinator.mjs';
import { IntegrationApiGateway } from '../integration/src/api-gateway.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { enrollLocalClient, buildLocalUpdate, EstimedVmAdapter } from '../integration/src/fl-client.mjs';
import { modelBytes, decodeModel, digest, fedAvg, initialModel, trainModel, syntheticDataset, evaluateModel } from '../integration/src/fl-numerics.mjs';

async function fixture(t, count = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-fl-test-'));
  t.after(async () => { const path = resolve(directory); assert.ok(path.startsWith(resolve(tmpdir()) + sep) && basename(path).startsWith('bubble-fl-test-')); await rm(path, { recursive: true, force: true }); });
  const statePath = join(directory, 'state.json'); const store = await new IntegrationStore(statePath).init();
  let instant = Date.parse('2026-11-10T09:00:00Z'); const clock = () => new Date(instant).toISOString();
  const fl = new FlCoordinator({ store, clock }); const clients = [];
  for (let i = 0; i < count; i++) clients.push(await enrollLocalClient(fl, { participantId: `client-${i + 1}`, taskId: 'mobility', seed: (i + 1) * 101, clientIndex: i }));
  const round = await fl.createRound({ taskId: 'mobility', minParticipants: 2 });
  return { fl, store, clients, round, clock, statePath, advance: (ms) => { instant += ms; } };
}
async function submitAll(f, clients = f.clients) { for (const client of clients) await f.fl.submitUpdate(buildLocalUpdate(f.fl, client, f.round)); }
const revoke = (f, client) => f.fl.setParticipantConsent({ taskId: 'mobility', participantId: client.participantId, principal: client.principal, status: 'REVOKED' });

test('F01 participant principal, originator, task, dataset, signature scope are bound', async (t) => {
  const f = await fixture(t); const input = buildLocalUpdate(f.fl, f.clients[0], f.round);
  for (const changes of [{ principal: f.clients[1].principal }, { principal: { ...f.clients[0].principal, originator: 'forged' } }, { taskId: 'another' }, { datasetId: 'another' }, { artifactRef: 'https://example.test/update' }, { signature: Buffer.alloc(64).toString('base64') }]) await assert.rejects(f.fl.submitUpdate({ ...input, ...changes }), /FL_/);
  assert.equal(f.store.get('flRounds', f.round.roundId).updates.length, 0);
  assert.equal(f.store.list('receipts').filter((r) => r.type === 'FL_UPDATE_REVIEW').length, 6);
});

test('F02 invalid count, finite/shape, base version, repeated sample and duplicate updates', async (t) => {
  const f = await fixture(t); const input = buildLocalUpdate(f.fl, f.clients[0], f.round);
  for (const changes of [{ sampleCount: 361 }, { sampleCount: 63 }, { baseModelHash: '0'.repeat(64) }, { model: { W: [[1]], b: [0, 0, 0] } }, { model: { W: Array.from({ length: 8 }, () => [NaN, 0, 0]), b: [0, 0, 0] } }, { artifactBytes: Buffer.alloc(12).toString('base64') }]) await assert.rejects(f.fl.submitUpdate({ ...input, ...changes }), /FL_/);
  const first = await f.fl.submitUpdate(input); const again = await f.fl.submitUpdate(input);
  assert.equal(again.updateId, first.updateId); assert.equal(again.duplicate, true);
  const altered = buildLocalUpdate(f.fl, f.clients[0], f.round, { sampleCount: 64 });
  await assert.rejects(f.fl.submitUpdate(altered), /FL_DUPLICATE_UPDATE/);
  assert.equal((await f.fl.finalizeRound(f.round.roundId)).state, 'WAITING_RESELECTION');
});

test('F03/F04 consent revoke and stopped membership fence update and aggregation; reselect recovers quorum', async (t) => {
  const f = await fixture(t, 2); await f.fl.submitUpdate(buildLocalUpdate(f.fl, f.clients[0], f.round));
  await revoke(f, f.clients[1]); await assert.rejects(f.fl.submitUpdate(buildLocalUpdate(f.fl, f.clients[1], f.round)), /FL_CONSENT_CURRENT/);
  assert.equal((await f.fl.finalizeRound(f.round.roundId)).state, 'WAITING_RESELECTION');
  const late = await enrollLocalClient(f.fl, { participantId: 'client-3', taskId: 'mobility', seed: 303, clientIndex: 2 });
  f.round = await f.fl.reselect(f.round.roundId); await f.fl.submitUpdate(buildLocalUpdate(f.fl, late, f.round));
  const result = await f.fl.finalizeRound(f.round.roundId); assert.equal(result.state, 'COMPLETED'); assert.equal(result.prepared.manifest.acceptedSet.length, 2);
  const g = await fixture(t, 2); await submitAll(g); await g.fl.setParticipantConsent({ taskId: 'mobility', participantId: g.clients[1].participantId, principal: g.clients[1].principal, status: 'STOPPED' });
  assert.equal((await g.fl.finalizeRound(g.round.roundId)).state, 'WAITING_RESELECTION'); g.advance(301000); assert.equal((await g.fl.reselect(g.round.roundId)).state, 'ROUND_DEFERRED');
});

test('F09 numeric sample-weighted FedAvg uses exact model bytes and reproducible training', async (t) => {
  const model = (v) => ({ W: Array.from({ length: 8 }, () => [v, v, v]), b: [v, v, v] });
  const aggregate = fedAvg([{ participantId: 'b', sampleCount: 128, model: model(3) }, { participantId: 'a', sampleCount: 64, model: model(1) }]);
  assert.ok(Math.abs(aggregate.b[0] - 7 / 3) < 1e-6);
  const rows = syntheticDataset().train; assert.equal(digest(modelBytes(trainModel(initialModel(), rows))), digest(modelBytes(trainModel(initialModel(), rows))));
  const f = await fixture(t, 2); await submitAll(f); const result = await f.fl.finalizeRound(f.round.roundId);
  assert.equal(result.modelHash, digest(f.fl.readArtifact(result.prepared.artifactRef)));
  assert.equal(result.manifestHash, digest(f.fl.readArtifact(result.prepared.manifestRef)));
  const decoded = decodeModel(f.fl.readArtifact(result.prepared.artifactRef)); assert.equal(decoded.W.length, 8); assert.equal(decoded.b.length, 3);
  assert.ok(evaluateModel(decoded, syntheticDataset().test).macroF1 > 0.4);
});

test('F10 prepared consent CAS requires a new accepted set and immutable manifest', async (t) => {
  const f = await fixture(t); await submitAll(f); let changed = false; let oldHash;
  f.fl.faultHook = async (point, round) => { if (point === 'afterArtifact' && !changed) { changed = true; oldHash = round.prepared.manifestHash; await revoke(f, f.clients[2]); } };
  const review = await f.fl.finalizeRound(f.round.roundId); assert.equal(review.state, 'REBUILD_REQUIRED');
  const completed = await f.fl.finalizeRound(f.round.roundId); assert.equal(completed.state, 'COMPLETED'); assert.notEqual(completed.manifestHash, oldHash); assert.equal(completed.prepared.manifest.acceptedSet.length, 2);
  assert.ok(f.store.list('flArtifacts').some((a) => a.hash === oldHash));
});

test('F05/F11 revoke after commit supersedes delayed publication, pauses reads, and approves clean retraining', async (t) => {
  const f = await fixture(t); await submitAll(f); const completed = await f.fl.finalizeRound(f.round.roundId);
  await revoke(f, f.clients[0]); assert.equal(f.fl.task('mobility').state, 'SERVING_PAUSED');
  assert.equal((await f.fl.publishRound(f.round.roundId)).status, 'SUPERSEDED'); assert.throws(() => f.fl.serveArtifact(f.round.roundId, completed.modelHash), /FL_SERVING_FENCE/);
  await assert.rejects(f.fl.createRound({ taskId: 'mobility' }), /FL_RETRAIN_APPROVAL_REQUIRED/);
  await f.fl.approveRetraining('mobility'); f.round = await f.fl.createRound({ taskId: 'mobility' }); await submitAll(f, f.clients.slice(1));
  const replacement = await f.fl.finalizeRound(f.round.roundId); assert.equal(f.fl.task('mobility').reviewState, 'NEW_MODEL_VERIFIED');
  assert.deepEqual(replacement.prepared.manifest.acceptedSet.map((u) => u.participantId), ['client-2', 'client-3']);
  assert.equal((await f.fl.publishRound(f.round.roundId)).status, 'PUBLISHED'); assert.equal(f.fl.serveArtifact(f.round.roundId, replacement.modelHash).state, 'ACTIVE');
});

test('F06 restart at artifact, commit and publication boundaries preserves one model commit', async (t) => {
  for (const point of ['beforeArtifact', 'afterArtifact', 'beforeCommit', 'afterCommit', 'beforePublication', 'afterPublication']) {
    const f = await fixture(t, 2); await submitAll(f); let crashed = false;
    f.fl.faultHook = async (where) => { if (where === point && !crashed) { crashed = true; throw new Error(`crash:${point}`); } };
    try { await f.fl.finalizeRound(f.round.roundId); await f.fl.publishRound(f.round.roundId); } catch (error) { assert.match(error.message, /crash:/); }
    assert.equal(crashed, true);
    const store = await new IntegrationStore(f.statePath).init(); const resumed = new FlCoordinator({ store, clock: f.clock }); await resumed.recover(f.round.roundId);
    const result = await resumed.finalizeRound(f.round.roundId); assert.equal(result.state, 'COMPLETED', point);
    const publication = await resumed.publishRound(f.round.roundId); assert.equal(publication.status, 'PUBLISHED', point);
    assert.equal(store.list('flCommits').length, 1, point); assert.equal(resumed.task('mobility').nextRound, 2, point);
  }
});

test('F07 coordinator epoch CAS and simultaneous finalize produce one committed model', async (t) => {
  const f = await fixture(t, 2); const original = buildLocalUpdate(f.fl, f.clients[0], f.round); await submitAll(f); const second = new FlCoordinator({ store: f.store, clock: f.clock }); await second.recover(f.round.roundId);
  await assert.rejects(f.fl.finalizeRound(f.round.roundId), /FL_COORDINATOR_EPOCH/);
  const results = await Promise.all([second.finalizeRound(f.round.roundId), second.finalizeRound(f.round.roundId)]);
  assert.equal(results[0].modelHash, results[1].modelHash); assert.equal(f.store.list('flCommits').length, 1);
  assert.equal((await second.submitUpdate(original)).duplicate, true);
});

test('F08 partial artifact integrity, heartbeat freshness, and referenced/staged artifact GC', async (t) => {
  const f = await fixture(t, 2); await submitAll(f); const completed = await f.fl.finalizeRound(f.round.roundId);
  const artifact = f.store.get('flArtifacts', completed.prepared.artifactRef); const original = artifact.body; artifact.body = Buffer.alloc(4).toString('base64');
  assert.throws(() => f.fl.serveArtifact(f.round.roundId, completed.modelHash), /FL_ARTIFACT_INTEGRITY/); artifact.body = original;
  f.fl.artifact(Buffer.from('unreferenced staging'), 'staging/orphan', 'staging'); f.advance(49 * 3600000);
  assert.equal((await f.fl.cleanupArtifacts()).length, 1); assert.ok(f.store.get('flArtifacts', completed.prepared.artifactRef));
  await assert.rejects(f.fl.createRound({ taskId: 'mobility' }), /FL_PARTICIPANT_CAPACITY/);
});

test('A13/A14 ten numeric rounds, round-three late join, dropout and persisted coordinator recovery', async (t) => {
  const f = await fixture(t); let fl = f.fl; let round = f.round; const hashes = [];
  for (let n = 1; n <= 10; n++) {
    if (n === 3) f.clients.push(await enrollLocalClient(fl, { participantId: 'client-4', taskId: 'mobility', seed: 404, clientIndex: 3 }));
    if (n === 5) fl.registerVm({ vmId: f.clients[1].vmId, attested: true, health: 'UNHEALTHY' });
    for (const client of f.clients) await fl.heartbeat({ taskId: 'mobility', participantId: client.participantId, principal: client.principal });
    if (n > 1) round = await fl.createRound({ taskId: 'mobility', selectionPolicy: { maxParticipants: 3 } });
    if (n === 3) assert.ok(round.participants.some((p) => p.participantId === 'client-4'));
    if (n >= 5) assert.ok(round.participants.every((p) => p.participantId !== 'client-2'));
    for (const selected of round.participants) { const client = f.clients.find((c) => c.participantId === selected.participantId); await fl.submitUpdate(buildLocalUpdate(fl, client, round)); }
    const result = await fl.finalizeRound(round.roundId); assert.equal(result.state, 'COMPLETED'); await fl.publishRound(round.roundId); hashes.push(result.modelHash);
    if (n === 5) { const restored = await new IntegrationStore(f.statePath).init(); fl = new FlCoordinator({ store: restored, clock: f.clock }); await fl.recover(round.roundId); }
  }
  assert.equal(fl.task('mobility').nextRound, 11); assert.equal(new Set(hashes).size, 10);
  assert.ok(evaluateModel(fl.serveArtifact(round.roundId, hashes[9]).model, f.clients.flatMap((c) => c.dataset.test)).macroF1 > 0.85);
});

test('ESTIMED transport requires HTTPS host/process/image identity and bounded response', async () => {
  assert.throws(() => new EstimedVmAdapter({ endpoint: 'http://example.test', hostId: 'h', processId: 'p', imageDigest: 'd' }), /FL_VM_ATTESTATION/);
  const identity = { hostId: 'h', processId: 'p', imageDigest: 'sha256:d' }; const calls = [];
  const adapter = new EstimedVmAdapter({ endpoint: 'https://vm.example.test', ...identity, fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(url.endsWith('/health') ? { ...identity, status: 'HEALTHY', runtimeMode: 'ESTIMED' } : { artifactDigest: 'signed-worker-result' })); } });
  assert.equal((await adapter.train({ round: { roundId: 'r1' }, participantId: 'p1', baseModelBytes: 'base' })).artifactDigest, 'signed-worker-result');
  assert.equal(calls.length, 2); assert.equal(JSON.parse(calls[1].options.body).runtimeMode, 'ESTIMED');
  adapter.fetchImpl = async () => new Response('x'.repeat(65537)); await assert.rejects(adapter.probe(), /FL_VM_RESPONSE_SIZE/);
});

test('FL HTTP routes use verified transport identity and isolate administrative controls', async (t) => {
  const f = await fixture(t, 2); const policyService = new PolicyService({ store: f.store, clock: f.clock }); const api = new IntegrationApiGateway({ policyService, flCoordinator: f.fl });
  const input = buildLocalUpdate(f.fl, f.clients[0], f.round);
  const forged = await api.handle({ method: 'POST', path: '/v1/fl/updates', principal: f.clients[1].principal, body: input });
  assert.equal(forged.status, 403); assert.equal(f.store.get('flRounds', f.round.roundId).updates.length, 0);
  const accepted = await api.handle({ method: 'POST', path: '/v1/fl/updates', principal: f.clients[0].principal, body: input }); assert.equal(accepted.status, 202);
  const takeover = await api.handle({ method: 'POST', path: '/v1/fl/recover', principal: f.clients[0].principal, body: { roundId: f.round.roundId } }); assert.equal(takeover.status, 403);
  const bodySpoof = await api.handle({ method: 'POST', path: '/v1/fl/consents', principal: f.clients[1].principal, body: { taskId: 'mobility', participantId: f.clients[0].participantId, principal: f.clients[0].principal, status: 'REVOKED' } }); assert.equal(bodySpoof.status, 403);
});
