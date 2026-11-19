import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { startFakeCse } from './helpers/fake-onem2m-cse.mjs';
import { FlCseClient, provisionIdentities, generateIdentity, issueEnrollment, enrollmentProblem, signContent, verifyContent, loadLocalDataset, encodeArtifact, decodeArtifact, cinContent, plainCin, SCHEMA, LAYOUT, PLANE_VERSION, roundName } from '../integration/src/fl-onem2m-plane.mjs';
import { FlOneM2mCoordinator } from '../integration/src/fl-onem2m-coordinator.mjs';
import { FlOneM2mWorker } from '../integration/src/fl-onem2m-worker.mjs';
import { generateShard } from '../integration/src/fl-shards.mjs';
import { initialModel, fedAvg, digest, modelBytes } from '../integration/src/fl-numerics.mjs';

const PROFILES = ['home-dwell', 'commute', 'relay-sparse', 'new-device'];
async function setup(t, { workers = ['w1', 'w2', 'w3'], task = {} } = {}) {
  const cse = await startFakeCse(); t.after(() => cse.close());
  let clock = Date.now(); const now = () => clock;
  const ids = provisionIdentities({ taskId: 'pm', participantIds: workers, runTag: 'test' });
  const events = [];
  const client = (originator) => new FlCseClient({ endpoint: cse.endpoint, originator });
  const coordinator = (who = 'c') => new FlOneM2mCoordinator({ client: client(ids.coordinator.aeId), identity: ids.coordinator, operatorPublicKeyPem: ids.coordinator.operatorPublicKeyPem, flAeName: 'fl-pm', task: { taskId: 'pm', targetRounds: 3, roundDeadlineMs: 2000, heartbeatTtlMs: 3000, ...task }, now, log: (e) => events.push({ who, ...e }), inboxPollMs: 0 });
  const w = Object.fromEntries(workers.map((id, i) => [id, new FlOneM2mWorker({ client: client(ids.workers[i].aeId), credentials: ids.workers[i], dataset: generateShard({ seed: 9000 + i * 17, profile: PROFILES[i % 4], datasetId: `${id}-local` }), taskId: 'pm', flAeName: i === workers.length - 1 ? null : 'fl-pm', heartbeatMs: 0, now, log: (e) => events.push({ who: id, ...e }) })]));
  const ae = '/Mobius/fl-pm';
  const read = async (path) => cinContent(await client(ids.coordinator.aeId).retrieve(path));
  return { cse, ids, now, advance: (ms) => { clock += ms; }, events, client, coordinator, w, ae, read, tickAll: async (list = Object.values(w)) => { for (const worker of list) await worker.tick(); } };
}

test('FLP01 oneM2M is the coordination plane: discovery, round config, model pull, signed updates, FedAvg result and lineage', async (t) => {
  const f = await setup(t); const c = f.coordinator();
  await c.bootstrap(); for (const worker of Object.values(f.w)) await worker.start();
  assert.equal(f.w.w3.discoveredBy, 'label-discovery');
  for (let i = 0; i < 20 && !c.finished; i++) { await c.tick(); await f.tickAll(); }
  assert.equal(c.completedRounds, 3); assert.equal(c.finished, true);
  let parent = digest(modelBytes(initialModel(101)));
  for (let n = 1; n <= 3; n++) {
    const config = await f.read(`${f.ae}/rounds/${roundName(n)}/config`); const result = await f.read(`${f.ae}/rounds/${roundName(n)}/result`);
    assert.ok(verifyContent(config, f.ids.coordinator.publicKeyPem) && verifyContent(result, f.ids.coordinator.publicKeyPem));
    assert.equal(result.state, 'COMPLETED'); assert.equal(config.baseModel.hash, parent); assert.equal(result.model.parentHash, parent);
    const updates = (await f.client(f.ids.coordinator.aeId).children(`${f.ae}/rounds/${roundName(n)}/updates`)).items;
    assert.equal(updates.length, result.acceptedSet.length);
    for (const u of updates) { assert.equal(u.cr, f.ids.workers.find((x) => x.participantId === u.con.participantId).aeId); assert.equal(digest(Buffer.from(u.con.artifact.data, 'base64')), u.con.artifactDigest); }
    const again = fedAvg(result.acceptedSet.map((a) => ({ participantId: a.participantId, sampleCount: a.sampleCount, model: decodeArtifact(updates.find((u) => u.con.participantId === a.participantId).con.artifact) })));
    assert.equal(digest(modelBytes(again)), result.model.hash); parent = result.model.hash;
  }
  assert.equal((await f.read(`${f.ae}/currentModel/la`)).modelHash, parent);
  const stored = f.cse.contents().map((x) => JSON.stringify(x.con));
  assert.ok(stored.every((text) => !text.includes('"x":[') && !/w\d-local:\d+/.test(text)), 'no feature rows or row ids reach the CSE');
  assert.ok(f.cse.contents().every((x) => !JSON.stringify(x.con ?? {}).includes('"seed":9')), 'worker seeds stay local');
  t.diagnostic(`fake CSE requests: ${f.cse.log.length}`);
});

test('FLP02 dynamic selection is enforced by the per-round ACP; consent revocation removes CSE access and selection', async (t) => {
  const f = await setup(t, { workers: ['w1', 'w2', 'w3', 'w4'], task: { maxParticipants: 2, targetRounds: 2 } }); const c = f.coordinator();
  await c.bootstrap(); for (const worker of Object.values(f.w)) await worker.start();
  await c.tick(); assert.deepEqual(c.current.config.selected.map((s) => s.participantId), ['w1', 'w2']);
  const intruder = await f.client(f.ids.workers[2].aeId).create(`${f.ae}/rounds/r-0001/updates`, 4, plainCin({ rn: 'u-w3', con: { probe: true }, creator: true }));
  assert.equal(intruder.rsc, 4103, 'non-selected participant cannot write an update');
  await f.tickAll(); await c.tick(); assert.equal(c.completedRounds, 1);
  assert.equal((await f.client(f.ids.workers[0].aeId).latest(`${f.ae}/status`)).rsc, 2000);
  await f.w.w1.revokeConsent('test');
  await c.tick();
  assert.ok(f.events.some((e) => e.event === 'CONSENT_REVOKED' && e.participantId === 'w1'));
  assert.ok(!c.current.config.selected.some((s) => s.participantId === 'w1'));
  assert.deepEqual(c.current.config.selection.excluded.find((x) => x.participantId === 'w1'), { participantId: 'w1', reason: 'CONSENT_REVOKED' });
  assert.equal((await f.client(f.ids.workers[0].aeId).latest(`${f.ae}/status`)).rsc, 4103, 'revoked participant loses read access');
  assert.equal((await f.client(f.ids.workers[0].aeId).latest(`${f.ae}/currentModel`)).rsc, 4103);
  assert.deepEqual(await f.w.w1.tick(), { done: true });
  const catalog = (await f.client(f.ids.coordinator.aeId).children(`${f.ae}/datasets`)).items.map((x) => x.con);
  assert.ok(catalog.some((x) => x.participantId === 'w1' && x.state === 'REVOKED'));
});

test('FLP03 dropout is closed by deadline and quorum, then the stale participant is excluded', async (t) => {
  const f = await setup(t, { task: { targetRounds: 2 } }); const c = f.coordinator();
  await c.bootstrap(); for (const worker of Object.values(f.w)) await worker.start();
  await c.tick(); assert.equal(c.current.config.selected.length, 3);
  await f.tickAll([f.w.w1, f.w.w2]); await c.tick(); assert.ok(c.current, 'round waits for the missing participant before the deadline');
  f.advance(2500); await c.tick();
  const result = await f.read(`${f.ae}/rounds/r-0001/result`);
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.trigger, 'DEADLINE');
  assert.deepEqual(result.missing, [{ participantId: 'w3', reason: 'NO_UPDATE_BY_DEADLINE' }]);
  assert.equal((await f.client(f.ids.workers[2].aeId).create(`${f.ae}/rounds/r-0001/updates`, 4, plainCin({ rn: 'u-w3', con: { late: true }, creator: true }))).rsc, 4103, 'closed round rejects late writes');
  f.advance(1000); await f.tickAll([f.w.w1, f.w.w2]); await c.tick();
  assert.deepEqual(c.current.config.selected.map((s) => s.participantId).sort(), ['w1', 'w2']);
  assert.equal(c.current.config.selection.excluded[0].reason, 'HEARTBEAT_STALE');
});

test('FLP04 coordinator restart resumes the open round from CSE state and fences the older instance', async (t) => {
  const f = await setup(t, { task: { targetRounds: 2 } }); const a = f.coordinator('A');
  await a.bootstrap(); for (const worker of Object.values(f.w)) await worker.start();
  await a.tick(); assert.equal(a.current.roundNumber, 1); await f.tickAll();
  const b = f.coordinator('B'); const summary = await b.bootstrap();
  assert.equal(summary.resumed, true); assert.equal(summary.previousEpoch, 1); assert.equal(summary.coordinatorEpoch, 2); assert.equal(summary.openRound, 1); assert.deepEqual(summary.members.sort(), ['w1', 'w2', 'w3']);
  await assert.rejects(a.tick(), (error) => error.code === 'FL_COORDINATOR_FENCED');
  await b.tick();
  const result = await f.read(`${f.ae}/rounds/r-0001/result`);
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.coordinatorEpoch, 2); assert.equal(result.configEpoch, 1); assert.equal(result.acceptedSet.length, 3);
  const epochs = (await f.client(f.ids.coordinator.aeId).children(`${f.ae}/status`)).items.filter((x) => x.rn.startsWith('epoch-')).map((x) => x.rn).sort();
  assert.deepEqual(epochs, ['epoch-0001', 'epoch-0002']);
  for (let i = 0; i < 6 && !b.finished; i++) { await f.tickAll(); await b.tick(); }
  assert.equal(b.completedRounds, 2);
});

test('FLP05 integrity: tampered artifact, replayed update, replayed registration and unenrolled registration are rejected', async (t) => {
  const f = await setup(t, { task: { targetRounds: 3 } }); const c = f.coordinator();
  await c.bootstrap(); for (const worker of Object.values(f.w)) await worker.start();
  const rogueKey = generateIdentity(); const rogueOperator = generateIdentity(); const rogueAe = 'Cfl-test-rogue';
  const rogue = f.client(rogueAe); await rogue.create('/Mobius', 2, { 'm2m:ae': { rn: 'rogue', api: 'N.rogue', rr: true, srv: ['4'] } });
  const registration = signContent({ schema: SCHEMA.registration, planeVersion: PLANE_VERSION, taskId: 'pm', participantId: 'rogue1', aeId: rogueAe, publicKeyPem: rogueKey.publicKeyPem, enrollment: issueEnrollment({ operatorPrivateKeyPem: rogueOperator.privateKeyPem, participantId: 'rogue1', aeId: rogueAe, publicKeyPem: rogueKey.publicKeyPem, taskId: 'pm' }), workerAePath: '/Mobius/flw-rogue1', heartbeatPath: '/Mobius/flw-rogue1/heartbeat', dataset: f.w.w1.dataset.metadata, consent: { status: 'ACTIVE', purpose: 'mobility-research', revision: 1, validUntil: new Date(Date.now() + 3600000).toISOString() }, issuedAt: new Date().toISOString(), nonce: 'n' }, rogueKey.privateKeyPem);
  await rogue.create(`${f.ae}/participants`, 4, plainCin({ con: registration, creator: true }));
  const genuine = f.cse.contents().find((x) => x.con?.schema === SCHEMA.registration && x.con.participantId === 'w1').con;
  await rogue.create(`${f.ae}/participants`, 4, plainCin({ con: genuine, creator: true }));
  f.w.w1.tamperNext = true;
  await c.tick(); await f.tickAll(); await c.tick();
  const reasons = f.events.filter((e) => e.event === 'INBOX_REJECTED').map((e) => e.reason).sort();
  assert.deepEqual(reasons, ['ENROLLMENT_SIGNATURE', 'REGISTRATION_CREATOR']);
  const r1 = await f.read(`${f.ae}/rounds/r-0001/result`);
  assert.equal(r1.state, 'COMPLETED'); assert.deepEqual(r1.rejected.map((x) => [x.participantId, x.reason]), [['w1', 'FL_ARTIFACT_DIGEST']]);
  await c.tick(); assert.equal(c.current.roundNumber, 2);
  const old = (await f.client(f.ids.coordinator.aeId).retrieve(`${f.ae}/rounds/r-0001/updates/u-w2`)).payload['m2m:cin'].con;
  assert.equal((await f.client(f.ids.workers[1].aeId).create(`${f.ae}/rounds/r-0002/updates`, 4, plainCin({ rn: 'u-w2', con: old, creator: true }))).rsc, 2001);
  await f.tickAll(); await c.tick();
  const r2 = await f.read(`${f.ae}/rounds/r-0002/result`);
  assert.deepEqual(r2.rejected.map((x) => [x.participantId, x.reason]), [['w2', 'UPDATE_ROUND_SCOPE']]);
  assert.ok(f.events.some((e) => e.who === 'w2' && e.event === 'UPDATE_ALREADY_PRESENT'));
  assert.equal(r2.state, 'COMPLETED'); assert.deepEqual(r2.acceptedSet.map((a) => a.participantId), ['w1', 'w3']);
});

test('FLP06 signing, enrollment, artifact and client guards', () => {
  const ids = provisionIdentities({ taskId: 'pm', participantIds: ['w1'], runTag: 'unit' }); const w = ids.workers[0];
  const signed = signContent({ a: 1, b: [1, 2] }, w.privateKeyPem);
  assert.ok(verifyContent(signed, w.publicKeyPem)); assert.ok(!verifyContent({ ...signed, a: 2 }, w.publicKeyPem)); assert.ok(!verifyContent(signed, ids.coordinator.publicKeyPem));
  assert.equal(enrollmentProblem(w.enrollment, ids.coordinator.operatorPublicKeyPem, { participantId: 'w1', aeId: w.aeId, publicKeyPem: w.publicKeyPem, taskId: 'pm' }), null);
  assert.equal(enrollmentProblem(w.enrollment, ids.coordinator.operatorPublicKeyPem, { participantId: 'w1', aeId: w.aeId, publicKeyPem: ids.coordinator.publicKeyPem, taskId: 'pm' }), 'ENROLLMENT_KEY');
  assert.equal(enrollmentProblem(w.enrollment, ids.coordinator.operatorPublicKeyPem, { participantId: 'w1', aeId: w.aeId, publicKeyPem: w.publicKeyPem, taskId: 'pm', now: Date.now() + 40 * 86400000 }), 'ENROLLMENT_EXPIRED');
  assert.equal(enrollmentProblem(w.enrollment, ids.coordinator.operatorPublicKeyPem, { participantId: 'w2', aeId: w.aeId, publicKeyPem: w.publicKeyPem, taskId: 'pm' }), 'ENROLLMENT_SCOPE');
  const artifact = encodeArtifact(initialModel(5));
  assert.throws(() => decodeArtifact({ ...artifact, digest: '0'.repeat(64) }), (e) => e.code === 'FL_ARTIFACT_DIGEST');
  assert.throws(() => decodeArtifact({ ...artifact, data: Buffer.alloc(12).toString('base64') }), (e) => e.code === 'FL_ARTIFACT_FORMAT');
  assert.throws(() => new FlCseClient({ endpoint: 'http://192.0.2.10:7599', originator: 'Cx1' }), (e) => e.code === 'FL_CSE_HTTPS_REQUIRED');
  assert.ok(new FlCseClient({ endpoint: 'http://192.0.2.10:7599', originator: 'Cx1', allowPlainHttp: true }));
  const client = new FlCseClient({ endpoint: 'https://cse.example', originator: 'Cx1' });
  for (const path of ['/Other/x', '/Mobius/../x', '/Mobius/a?b', '/Mobius/a%2f']) assert.throws(() => client.checkPath(path), (e) => e.code === 'FL_CSE_PATH');
});

test('FLP07 worker-local datasets: deterministic shards, metadata only, JSONL loader', async (t) => {
  const a = generateShard({ seed: 11, profile: 'commute', datasetId: 'd1' }); const b = generateShard({ seed: 11, profile: 'commute', datasetId: 'd1' }); const other = generateShard({ seed: 12, profile: 'commute', datasetId: 'd1' });
  assert.equal(a.metadata.splitHash, b.metadata.splitHash); assert.deepEqual(a.train[5], b.train[5]); assert.notDeepEqual(a.train[5].x, other.train[5].x);
  assert.deepEqual([a.train.length, a.validation.length, a.test.length], [360, 120, 120]);
  assert.ok(!('seed' in a.metadata) && !('profile' in a.metadata));
  assert.throws(() => generateShard({ seed: 1, profile: 'unknown', datasetId: 'd' }), /FL_SHARD_PROFILE/);
  const directory = await mkdtemp(join(tmpdir(), 'bubble-fl-plane-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'local.jsonl');
  await writeFile(path, a.train.slice(0, 150).map((row) => JSON.stringify({ x: row.x, y: row.y })).join('\n'));
  const local = await loadLocalDataset({ source: 'jsonl', path, datasetId: 'site-a' });
  assert.deepEqual([local.train.length, local.validation.length, local.test.length], [90, 30, 30]); assert.equal(local.metadata.rawDataLocation, 'participant-local');
  await writeFile(path, `${JSON.stringify({ x: [1, 2], y: 0 })}\n`);
  await assert.rejects(loadLocalDataset({ source: 'jsonl', path, datasetId: 'site-a' }), (e) => e.code === 'FL_DATASET_ROW');
});

test('FLP08 stored cin content matches the fl-onem2m-plane.v1 contract schemas', async (t) => {
  const contract = JSON.parse(await readFile(new URL('../contracts/fl-onem2m-plane.v1.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const common = ajv.compile(contract.contentSchemas.common);
  const key = { task: 'task', registration: 'registration', consent: 'consent', 'round-config': 'roundConfig', update: 'update', 'round-result': 'roundResult', model: 'model', status: 'status', dataset: 'dataset', heartbeat: 'heartbeat' };
  const validators = Object.fromEntries(Object.entries(key).map(([kind, name]) => [kind, ajv.compile(contract.contentSchemas[name])]));
  const f = await setup(t, { task: { targetRounds: 2 } }); const c = f.coordinator();
  await c.bootstrap(); for (const worker of Object.values(f.w)) await worker.start();
  for (let i = 0; i < 10 && !c.finished; i++) { await c.tick(); await f.tickAll(); }
  await f.w.w1.revokeConsent('contract');
  const seen = new Set();
  for (const { con, path } of f.cse.contents()) {
    const kind = /^urn:privacy-bubble:fl-plane:([a-z-]+):1$/.exec(con?.schema ?? '')?.[1]; assert.ok(kind, path);
    assert.ok(common(con), `${path} ${JSON.stringify(common.errors)}`); assert.ok(validators[kind](con), `${path} ${JSON.stringify(validators[kind].errors)}`); seen.add(kind);
  }
  assert.deepEqual([...seen].sort(), Object.keys(key).sort());
  assert.equal(contract.resourceLayout.containers.participants.mni, 1000);
  assert.ok(Object.values(LAYOUT).includes('currentModel'));
});
