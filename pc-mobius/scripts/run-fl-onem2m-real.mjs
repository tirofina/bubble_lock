// R14 real run: oneM2M as the FL coordination plane on a real local Mobius4 (PostgreSQL) with separate
// coordinator and worker OS processes talking HTTP to the CSE.
// Fault schedule: late joiner (round 3-4), coordinator kill + restart that resumes from CSE state (round 5),
// worker kill mid-round handled by deadline/quorum (round 6), consent revocation (after round 7),
// dropped worker restart (after round 8), tampered update (round 10), rogue registrations (round 2).
// Usage: node pc-mobius/scripts/run-fl-onem2m-real.mjs [--rounds=12] [--keep-cse]
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalMobius4, repositoryRoot } from './mobius4-local.mjs';
import { FlCseClient, provisionIdentities, generateIdentity, issueEnrollment, signContent, decodeArtifact, cinContent, plainCin, SCHEMA, LAYOUT, PLANE_VERSION, roundName, workerAeName, taskLabel } from '../integration/src/fl-onem2m-plane.mjs';
import { generateShard, SHARD_TASK, SHARD_PROFILES } from '../integration/src/fl-shards.mjs';
import { initialModel, trainModel, evaluateModel, fedAvg, TRAINING } from '../integration/src/fl-numerics.mjs';
import { DEFAULT_TASK } from '../integration/src/fl-onem2m-coordinator.mjs';
import { readbackFlPlane, roundRows } from '../integration/src/fl-onem2m-readback.mjs';

const root = repositoryRoot;
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const targetRounds = Number(arg('rounds') ?? 12);
const runTag = randomBytes(3).toString('hex');
const taskId = 'privacy-motion';
const flAeName = `fl-${taskId}-${runTag}`;
const out = join(root, '.local', 'fl-onem2m', `${Date.now()}-${runTag}`);
const receiptPath = join(root, 'docs', 'verification-evidence', '2026-11-19', 'fl-onem2m-real-cse.json');
const workerPlan = {
  w1: { profile: 'home-dwell', seed: 7001 },
  w2: { profile: 'commute', seed: 7132 },
  w3: { profile: 'relay-sparse', seed: 7263 },
  w4: { profile: 'new-device', seed: 7394 },
};
const task = { ...DEFAULT_TASK, taskId, targetRounds, roundDeadlineMs: 6000, heartbeatTtlMs: 4000 };
const bus = new EventEmitter(); bus.setMaxListeners(100);
const events = []; const processes = []; const lifetimes = [];
const started = Date.now();
const fileHash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

function spawnRole(label, script, configPath) {
  const child = spawn(process.execPath, [join(root, 'pc-mobius/scripts', script), `--config=${configPath}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lifetime = { label, pid: child.pid, startedAt: new Date().toISOString(), exitedAt: null, exitCode: null, killed: false };
  lifetimes.push(lifetime); processes.push(child);
  child.stdin.on('error', () => {});
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const event = { proc: label, ...JSON.parse(line) }; events.push(event); bus.emit('event', event); } catch { events.push({ proc: label, raw: line.slice(0, 400) }); }
    }
  });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  child.on('exit', (code, signal) => { lifetime.exitedAt = new Date().toISOString(); lifetime.exitCode = code; lifetime.signal = signal; if (stderr.trim()) lifetime.stderrTail = stderr.trim().slice(-1500); bus.emit('exit', { label, code }); });
  child.lifetime = lifetime;
  return child;
}
function waitFor(predicate, timeoutMs, description) {
  const found = events.find(predicate); if (found) return Promise.resolve(found);
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => { bus.off('event', listener); reject(new Error(`timeout waiting for ${description}`)); }, timeoutMs);
    const listener = (event) => { if (predicate(event)) { clearTimeout(timer); bus.off('event', listener); resolveWait(event); } };
    bus.on('event', listener);
  });
}
const isCoord = (name, extra = () => true) => (e) => e.role === 'coordinator' && e.event === name && extra(e);
async function kill(child) { child.lifetime.killed = true; const exited = new Promise((done) => child.once('exit', done)); child.kill('SIGKILL'); await Promise.race([exited, delay(5000)]); }

let cse; const faults = {}; let status = 'FAIL'; let failure = null; let report = null;
try {
  await mkdir(out, { recursive: true });
  cse = await startLocalMobius4({ label: 'fl_onem2m', workDirectory: join(root, '.local', 'fl-onem2m-cse') });
  const ids = provisionIdentities({ taskId, participantIds: Object.keys(workerPlan), runTag });
  const write = (name, value) => writeFile(join(out, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await write('coordinator.credentials.json', ids.coordinator);
  await write('coordinator.config.json', { cseUrl: cse.endpoint, cseBase: cse.cseBase, credentialsPath: './coordinator.credentials.json', flAeName, task, notify: { listenHost: '127.0.0.1', listenPort: 0 }, pollMs: 200, inboxPollMs: 1000 });
  for (const worker of ids.workers) {
    const plan = workerPlan[worker.participantId];
    await write(`${worker.participantId}.credentials.json`, worker);
    await write(`${worker.participantId}.config.json`, { cseUrl: cse.endpoint, cseBase: cse.cseBase, credentialsPath: `./${worker.participantId}.credentials.json`, workerId: worker.participantId, taskId, flAeName: worker.participantId === 'w4' ? null : flAeName, pollMs: 200, heartbeatMs: 1000, trainDelayMs: 800, zone: 'lab', dataset: { source: 'synthetic-shard', seed: plan.seed, profile: plan.profile, datasetId: `${worker.participantId}-local` } });
  }
  const cfg = (name) => join(out, `${name}.config.json`);
  const workers = {};
  let coordinator = spawnRole('coordinator#1', 'run-fl-onem2m-coordinator.mjs', cfg('coordinator'));
  await waitFor(isCoord('BOOTSTRAPPED'), 30000, 'coordinator bootstrap');
  for (const id of ['w1', 'w2', 'w3']) workers[id] = spawnRole(`${id}#1`, 'run-fl-onem2m-worker.mjs', cfg(id));

  // Rogue registrations: unenrolled key, and a forged participantId with another AE-ID.
  await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber === 2), 60000, 'round 2');
  const rogueIdentity = generateIdentity(); const rogueAe = `Cfl-${runTag}-rogue`;
  const rogue = new FlCseClient({ endpoint: cse.endpoint, cseBase: cse.cseBase, originator: rogueAe });
  const rogueOperator = generateIdentity();
  const rogueRegistration = (participantId) => signContent({ schema: SCHEMA.registration, planeVersion: PLANE_VERSION, taskId, participantId, aeId: rogueAe, publicKeyPem: rogueIdentity.publicKeyPem, enrollment: issueEnrollment({ operatorPrivateKeyPem: rogueOperator.privateKeyPem, participantId, aeId: rogueAe, publicKeyPem: rogueIdentity.publicKeyPem, taskId }), workerAePath: `${cse.cseBase}/${workerAeName(participantId)}`, heartbeatPath: `${cse.cseBase}/${workerAeName(participantId)}/heartbeat`, dataset: { datasetId: 'rogue', datasetVersion: 1, featureSchemaVersion: SHARD_TASK.featureSchemaVersion, taskVersion: SHARD_TASK.version, trainCount: 360, validationCount: 120, testCount: 120, splitHash: 'a'.repeat(64), rawDataLocation: 'participant-local' }, consent: { status: 'ACTIVE', purpose: task.purpose, revision: 1, validUntil: new Date(Date.now() + 3600000).toISOString() }, issuedAt: new Date().toISOString(), nonce: runTag }, rogueIdentity.privateKeyPem);
  await rogue.create(cse.cseBase, 2, { 'm2m:ae': { rn: `fl-rogue-${runTag}`, api: 'N.privacy.bubble.rogue', rr: true, srv: ['4'] } });
  const roguePosts = [];
  for (const participantId of ['rogue1', 'w1']) roguePosts.push({ participantId, rsc: (await rogue.create(`${cse.cseBase}/${flAeName}/${LAYOUT.participants}`, 4, plainCin({ con: rogueRegistration(participantId), creator: true }))).rsc });
  faults.rogueRegistrations = { posts: roguePosts, rejections: await Promise.all(['rogue1', 'w1'].map((participantId) => waitFor((e) => e.role === 'coordinator' && e.event === 'INBOX_REJECTED' && e.participantId === participantId && e.creator === rogueAe, 15000, `rogue ${participantId} rejection`).then((e) => ({ participantId, reason: e.reason })))) };

  // Late joiner registers during round 3 and joins round 4 by label discovery.
  await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber === 3), 60000, 'round 3');
  workers.w4 = spawnRole('w4#1', 'run-fl-onem2m-worker.mjs', cfg('w4'));
  const admitted = await waitFor(isCoord('ADMITTED', (e) => e.participantId === 'w4'), 30000, 'w4 admission');
  const firstW4 = await waitFor(isCoord('ROUND_OPENED', (e) => e.selected.includes('w4')), 60000, 'w4 selected');
  faults.lateJoin = { participantId: 'w4', spawnedDuringRound: 3, admittedAt: admitted.t, firstSelectedRound: firstW4.roundNumber, discoveredBy: (await waitFor((e) => e.proc === 'w4#1' && e.event === 'REGISTERED', 10000, 'w4 registered')).discoveredBy };

  // Coordinator crash mid-round 5 after at least one update reached the CSE, then restart.
  await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber === 5), 60000, 'round 5');
  const firstUpdate5 = await waitFor((e) => e.role === 'worker' && e.event === 'UPDATE_WRITTEN' && e.roundNumber === 5, 20000, 'first round-5 update');
  await kill(coordinator); const killedAt = new Date().toISOString();
  const completedBeforeKill = events.some(isCoord('ROUND_COMPLETED', (e) => e.roundNumber === 5));
  await delay(1500);
  coordinator = spawnRole('coordinator#2', 'run-fl-onem2m-coordinator.mjs', cfg('coordinator'));
  const resumed = await waitFor((e) => e.proc === 'coordinator#2' && e.event === 'RESUMED', 30000, 'coordinator resume');
  const round5 = await waitFor(isCoord('ROUND_COMPLETED', (e) => e.roundNumber === 5), 30000, 'round 5 completion after resume');
  faults.coordinatorRestart = { killedAt, killedAfterUpdateFrom: firstUpdate5.workerId, completedBeforeKill, resumedEvent: { previousEpoch: resumed.previousEpoch, coordinatorEpoch: resumed.coordinatorEpoch, openRound: resumed.openRound, completedRounds: resumed.completedRounds, modelVersion: resumed.modelVersion, members: resumed.members }, round5CompletedBy: round5.proc, round5Accepted: round5.accepted, round5Trigger: round5.trigger, round5ResumedRound: round5.resumedRound };

  // Worker dropout: kill a selected worker after it fetched the round-6 model, before it writes the update.
  const open6 = await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber === 6), 60000, 'round 6');
  const victimId = open6.selected.find((id) => ['w1', 'w2', 'w3'].includes(id));
  await waitFor((e) => e.proc === `${victimId}#1` && e.event === 'TRAINING_STARTED' && e.roundNumber === 6, 15000, 'victim training start');
  await kill(workers[victimId]); const victimKilledAt = new Date().toISOString();
  const round6 = await waitFor(isCoord('ROUND_COMPLETED', (e) => e.roundNumber === 6) , 30000, 'round 6 close');
  const open7 = await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber === 7), 30000, 'round 7');
  faults.dropout = { participantId: victimId, killedAt: victimKilledAt, round: 6, roundTrigger: round6.trigger, roundAccepted: round6.accepted, roundMissing: round6.missing, round7Excluded: open7.excluded.filter((x) => x.participantId === victimId) };

  // Consent revocation after round 7 by a live original worker.
  await waitFor(isCoord('ROUND_COMPLETED', (e) => e.roundNumber === 7), 30000, 'round 7 close');
  const revokerId = ['w3', 'w1', 'w2'].find((id) => id !== victimId);
  workers[revokerId].stdin.write('revoke\n');
  const revoked = await waitFor(isCoord('CONSENT_REVOKED', (e) => e.participantId === revokerId), 20000, 'consent revocation');
  const afterRevocation = await waitFor(isCoord('ROUND_OPENED', (e) => Date.parse(e.t) > Date.parse(revoked.t)), 30000, 'round after revocation');
  faults.consentRevocation = { participantId: revokerId, consentRevision: revoked.consentRevision, contributedRoundsBeforeRevocation: revoked.contributedRounds, nextRound: afterRevocation.roundNumber, nextRoundSelected: afterRevocation.selected, nextRoundExcluded: afterRevocation.excluded.filter((x) => x.participantId === revokerId) };

  // Dropped worker restarts with the same credentials after round 8 and rejoins.
  await waitFor(isCoord('ROUND_COMPLETED', (e) => e.roundNumber === 8), 30000, 'round 8 close');
  workers[victimId] = spawnRole(`${victimId}#2`, 'run-fl-onem2m-worker.mjs', cfg(victimId));
  const rejoin = await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber >= 9 && e.selected.includes(victimId)), 60000, 'victim rejoin');
  faults.dropout.restartedAndReselectedRound = rejoin.roundNumber;

  // Integrity fault: one selected worker writes an update whose artifact does not match its digest.
  const open10 = await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber >= 10), 60000, 'round 10');
  const tamperId = open10.selected.find((id) => id !== revokerId && workers[id]?.exitCode === null);
  workers[tamperId].stdin.write('tamper-next\n');
  const tamperRejected = await waitFor(isCoord('UPDATE_REJECTED', (e) => e.participantId === tamperId && e.roundNumber === open10.roundNumber), 20000, 'tamper rejection');
  const tamperRound = await waitFor((e) => e.role === 'coordinator' && ['ROUND_COMPLETED', 'ROUND_DEFERRED'].includes(e.event) && e.roundNumber === open10.roundNumber, 30000, 'tamper round close');
  faults.tamperedUpdate = { participantId: tamperId, round: open10.roundNumber, reason: tamperRejected.reason, roundState: tamperRound.event, accepted: tamperRound.accepted };

  const done = await waitFor(isCoord('TASK_COMPLETED'), 120000, 'task completion');
  await Promise.race([Promise.all(Object.values(workers).filter((w) => w.exitCode === null).map((w) => new Promise((r) => w.once('exit', r)))), delay(8000)]);
  for (const child of processes) if (child.exitCode === null) { child.stdin.write('exit\n'); }
  await delay(500);

  // ---------- Post-run verification by reading the CSE ----------
  const C = ids.coordinator;
  const reader = new FlCseClient({ endpoint: cse.endpoint, cseBase: cse.cseBase, originator: C.aeId });
  const ae = `${cse.cseBase}/${flAeName}`;
  const read = async (path) => { const r = await reader.retrieve(path); return r.ok ? cinContent(r) : null; };
  const shards = Object.fromEntries(Object.entries(workerPlan).map(([id, p]) => [id, generateShard({ seed: p.seed, profile: p.profile, datasetId: `${id}-local` })]));
  const pooledTest = Object.values(shards).flatMap((s) => s.test);
  const evalSummary = (model, rows) => { const m = evaluateModel(model, rows); return { accuracy: Number((1 - m.errorRate).toFixed(4)), crossEntropy: Number(m.crossEntropy.toFixed(4)), macroF1: Number(m.macroF1.toFixed(4)) }; };
  const readback = await readbackFlPlane({ client: reader, aePath: ae, coordinatorPublicKeyPem: C.publicKeyPem, rowIdPattern: /w\d-local:\d+/ });
  const { taskDefinition, current, catalog, integrity } = readback;
  const rounds = roundRows(readback.rounds).map((row, i) => { const model = readback.rounds[i].model; return { ...row, oracleEvaluationOfRoundModel: model ? { pooledTest: evalSummary(model, pooledTest), newDeviceTest: evalSummary(model, shards.w4.test) } : null }; });
  const completed = rounds.filter((r) => r.state === 'COMPLETED');
  const cli = spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/fl-onem2m-readback.mjs'), `--config=${cfg('coordinator')}`, `--out=${join(out, 'readback-cli.json')}`, '--runtime-mode=LOCAL_HOST_REAL_CSE_MULTIPROCESS', '--hosts=1'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let readbackCli = null; try { readbackCli = { exitCode: cli.status, ...JSON.parse(cli.stdout) }; delete readbackCli.out; } catch { readbackCli = { exitCode: cli.status, stderr: (cli.stderr ?? '').slice(-500) }; }

  // ACP probes with real originators.
  const as = (id) => new FlCseClient({ endpoint: cse.endpoint, cseBase: cse.cseBase, originator: ids.workers.find((w) => w.participantId === id).aeId });
  const liveId = ['w1', 'w2', 'w3', 'w4'].find((id) => id !== revokerId);
  const lastRound = rounds.at(-1).roundNumber;
  const probe = async (name, client, method, path, expected, body, ty) => { const r = method === 'GET' ? await client.retrieve(path) : await client.create(path, ty, body); return { name, originatorRole: name.split(':')[0], method, path, expectedRsc: expected, rsc: r.rsc, pass: r.rsc === expected }; };
  const acpProbes = [
    await probe('member:read-currentModel', as(liveId), 'GET', `${ae}/${LAYOUT.currentModel}/la`, 2000),
    await probe('revoked:read-status', as(revokerId), 'GET', `${ae}/${LAYOUT.status}/la`, 4103),
    await probe('revoked:read-currentModel', as(revokerId), 'GET', `${ae}/${LAYOUT.currentModel}/la`, 4103),
    await probe('revoked:write-update-closed-round', as(revokerId), 'POST', `${ae}/${LAYOUT.rounds}/${roundName(lastRound)}/${LAYOUT.roundUpdates}`, 4103, plainCin({ rn: `u-${revokerId}-late`, con: { probe: true }, creator: true }), 4),
    await probe('member:write-update-closed-round', as(liveId), 'POST', `${ae}/${LAYOUT.rounds}/${roundName(lastRound)}/${LAYOUT.roundUpdates}`, 4103, plainCin({ rn: `u-${liveId}-late`, con: { probe: true }, creator: true }), 4),
    await probe('member:read-inbox', as(liveId), 'GET', `${ae}/${LAYOUT.participants}/la`, 4103),
    await probe('member:read-other-heartbeat', as(liveId), 'GET', `${cse.cseBase}/${workerAeName(revokerId === 'w4' ? 'w1' : 'w4')}/heartbeat/la`, 4103),
    await probe('rogue:read-currentModel', rogue, 'GET', `${ae}/${LAYOUT.currentModel}/la`, 4103),
    await probe('rogue:read-public-task', rogue, 'GET', `${ae}/${LAYOUT.tasks}/task-v1`, 2000),
    await probe('rogue:read-datasets-catalog', rogue, 'GET', `${ae}/${LAYOUT.datasets}/la`, 4103),
  ];
  const discovery = await rogue.retrieve(cse.cseBase, { fu: 1, ty: 2, lbl: taskLabel(taskId) });

  // Baselines on the same split with the same numerics (computed in this harness process).
  const order = ['w1', 'w2', 'w3', 'w4'];
  let central = initialModel(task.seed); let staticIdeal = initialModel(task.seed); let staticFaults = initialModel(task.seed);
  const pooledTrain = order.flatMap((id) => shards[id].train);
  const baselineRounds = [];
  for (const r of completed) {
    central = trainModel(central, pooledTrain, TRAINING);
    staticIdeal = fedAvg(['w1', 'w2', 'w3'].map((id) => ({ participantId: id, sampleCount: shards[id].train.length, model: trainModel(staticIdeal, shards[id].train, TRAINING) })));
    const missingIds = new Set(r.missing.map((m) => m.participantId).concat(r.rejected.map((x) => x.participantId)));
    const cohort = ['w1', 'w2', 'w3'].filter((id) => r.eligible.includes(id) && !missingIds.has(id));
    if (cohort.length >= task.minUpdates) staticFaults = fedAvg(cohort.map((id) => ({ participantId: id, sampleCount: shards[id].train.length, model: trainModel(staticFaults, shards[id].train, TRAINING) })));
    baselineRounds.push({ roundNumber: r.roundNumber, modelVersion: r.modelVersion, dynamicOneM2M: r.oracleEvaluationOfRoundModel, centralized: { pooledTest: evalSummary(central, pooledTest), newDeviceTest: evalSummary(central, shards.w4.test) }, staticSelectionIdeal: { cohort: ['w1', 'w2', 'w3'], pooledTest: evalSummary(staticIdeal, pooledTest), newDeviceTest: evalSummary(staticIdeal, shards.w4.test) }, staticSelectionSameFaults: { cohort, aggregated: cohort.length >= task.minUpdates, pooledTest: evalSummary(staticFaults, pooledTest), newDeviceTest: evalSummary(staticFaults, shards.w4.test) } });
  }
  const finalRow = baselineRounds.at(-1);

  // Paired exact McNemar test on the same test rows (final dynamic model read from the CSE vs each baseline).
  const f32 = Math.fround;
  const predict = (model, x) => { const logits = model.b.map((b, c) => x.reduce((s, v, i) => f32(s + f32(v * model.W[i][c])), b)); return logits.indexOf(Math.max(...logits)); };
  const binom = (n, k) => { let value = 1; for (let i = 1; i <= k; i++) value = value * (n - k + i) / i; return value; };
  const mcnemar = (a, b, rows) => {
    let aOnly = 0; let bOnly = 0;
    for (const row of rows) { const ca = predict(a, row.x) === row.y; const cb = predict(b, row.x) === row.y; if (ca && !cb) aOnly++; else if (!ca && cb) bOnly++; }
    const n = aOnly + bOnly; let tail = 0; for (let k = 0; k <= Math.min(aOnly, bOnly); k++) tail += binom(n, k) / 2 ** n;
    return { dynamicOnlyCorrect: aOnly, baselineOnlyCorrect: bOnly, discordant: n, exactTwoSidedP: Number((n ? Math.min(1, 2 * tail) : 1).toFixed(4)) };
  };
  const lastResult = await read(`${ae}/${LAYOUT.rounds}/${roundName(completed.at(-1).roundNumber)}/result`);
  const dynamicFinal = decodeArtifact(lastResult.artifact, lastResult.model.hash);
  const paired = Object.fromEntries([['centralized', central], ['staticSelectionIdeal', staticIdeal], ['staticSelectionSameFaults', staticFaults]].map(([name, model]) => [name, { pooledTest: mcnemar(dynamicFinal, model, pooledTest), newDeviceTest: mcnemar(dynamicFinal, model, shards.w4.test) }]));

  // Sensitivity: replay the real participation schedule in-process on 10 alternative shard seed sets.
  const schedule = completed.map((r) => ({ accepted: r.accepted, cohort: baselineRounds.find((b) => b.roundNumber === r.roundNumber).staticSelectionSameFaults.cohort }));
  const arms = ['dynamicSchedule', 'centralized', 'staticSelectionIdeal', 'staticSelectionSameFaults']; const trials = [];
  for (let offset = 1; offset <= 10; offset++) {
    const alt = Object.fromEntries(order.map((id) => [id, generateShard({ seed: workerPlan[id].seed + offset * 1009, profile: workerPlan[id].profile, datasetId: `${id}-alt${offset}` })]));
    const altPooled = order.flatMap((id) => alt[id].test); const altTrain = order.flatMap((id) => alt[id].train);
    const avg = (model, ids) => fedAvg(ids.map((id) => ({ participantId: id, sampleCount: alt[id].train.length, model: trainModel(model, alt[id].train, TRAINING) })));
    let m = Object.fromEntries(arms.map((arm) => [arm, initialModel(task.seed)]));
    for (const step of schedule) m = { dynamicSchedule: avg(m.dynamicSchedule, step.accepted), centralized: trainModel(m.centralized, altTrain, TRAINING), staticSelectionIdeal: avg(m.staticSelectionIdeal, ['w1', 'w2', 'w3']), staticSelectionSameFaults: step.cohort.length >= task.minUpdates ? avg(m.staticSelectionSameFaults, step.cohort) : m.staticSelectionSameFaults };
    trials.push(Object.fromEntries(arms.map((arm) => [arm, { pooled: 1 - evaluateModel(m[arm], altPooled).errorRate, newDevice: 1 - evaluateModel(m[arm], alt.w4.test).errorRate }])));
  }
  const stats = (values) => { const mean = values.reduce((s, v) => s + v, 0) / values.length; const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)); return { mean: Number(mean.toFixed(4)), sd: Number(sd.toFixed(4)), min: Number(Math.min(...values).toFixed(4)), max: Number(Math.max(...values).toFixed(4)) }; };
  const sensitivity = { method: 'in-process replay of the real run participation schedule (accepted sets per completed round) on 10 alternative shard seed sets; same numerics; not a CSE run', trials: trials.length,
    accuracy: Object.fromEntries(arms.map((arm) => [arm, { pooledTest: stats(trials.map((t) => t[arm].pooled)), newDeviceTest: stats(trials.map((t) => t[arm].newDevice)) }])),
    dynamicMinusStaticIdeal: { pooledTest: stats(trials.map((t) => t.dynamicSchedule.pooled - t.staticSelectionIdeal.pooled)), newDeviceTest: stats(trials.map((t) => t.dynamicSchedule.newDevice - t.staticSelectionIdeal.newDevice)), dynamicAtLeastStaticOnNewDevice: trials.filter((t) => t.dynamicSchedule.newDevice >= t.staticSelectionIdeal.newDevice).length },
    dynamicMinusStaticSameFaults: { pooledTest: stats(trials.map((t) => t.dynamicSchedule.pooled - t.staticSelectionSameFaults.pooled)), newDeviceTest: stats(trials.map((t) => t.dynamicSchedule.newDevice - t.staticSelectionSameFaults.newDevice)) },
    dynamicMinusCentralized: { pooledTest: stats(trials.map((t) => t.dynamicSchedule.pooled - t.centralized.pooled)) } };

  const checks = {
    completedRoundsAtLeast10: completed.length >= 10,
    workerProcessesAtLeast3: new Set(lifetimes.filter((l) => l.label.startsWith('w')).map((l) => l.label.split('#')[0])).size >= 3,
    dynamicSelectionVaried: new Set(rounds.map((r) => r.selected.join(','))).size > 1,
    lateJoinerSelected: Boolean(faults.lateJoin?.firstSelectedRound),
    dropoutHandledByDeadlineQuorum: faults.dropout?.roundTrigger === 'DEADLINE' && faults.dropout.roundMissing.some((m) => m.participantId === victimId && m.reason === 'NO_UPDATE_BY_DEADLINE'),
    droppedWorkerExcludedNextRound: faults.dropout?.round7Excluded.some((x) => x.reason === 'HEARTBEAT_STALE'),
    coordinatorResumedFromCse: faults.coordinatorRestart?.resumedEvent.openRound === 5 && faults.coordinatorRestart.round5CompletedBy === 'coordinator#2' && faults.coordinatorRestart.resumedEvent.coordinatorEpoch > faults.coordinatorRestart.resumedEvent.previousEpoch,
    revokedParticipantRemoved: rounds.filter((r) => r.roundNumber >= faults.consentRevocation.nextRound).every((r) => !r.selected.includes(revokerId)) && acpProbes.filter((p) => p.name.startsWith('revoked:')).every((p) => p.pass),
    tamperedUpdateRejected: faults.tamperedUpdate?.reason === 'FL_ARTIFACT_DIGEST',
    rogueRegistrationsRejected: faults.rogueRegistrations.rejections.length === 2,
    acpProbesPass: acpProbes.every((p) => p.pass),
    signaturesValid: integrity.signatureFailures === 0,
    reaggregationMatches: integrity.reaggregationMismatches === 0 && integrity.reaggregationMatches === completed.length,
    lineageUnbroken: integrity.lineageBreaks === 0,
    currentModelMatchesLastRound: current?.modelHash === completed.at(-1)?.modelHash,
    noRawRowsInCse: readback.checks.noRawRowsInCse,
    labelDiscoveryUsed: faults.lateJoin?.discoveredBy === 'label-discovery',
    readbackCliPass: readbackCli?.exitCode === 0 && readbackCli.status === 'PASS' && readbackCli.completedRounds === completed.length,
  };
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
  const roleSummary = (prefix) => events.filter((e) => e.event === 'COORDINATOR_EXIT' || e.event === 'WORKER_EXIT').filter((e) => e.proc.startsWith(prefix)).map((e) => ({ proc: e.proc, ...(e.summary ? { notifications: e.summary.notifications, completedRounds: e.summary.completedRounds } : { counters: e.counters }), cseRequests: e.cseRequests }));
  report = {
    status, rubric: 'R14', reference: 'oneM2M TR-0084 (FL resource model; own wording)', docRevision: '2.0.0', generatedAt: new Date().toISOString(),
    runtimeMode: 'LOCAL_HOST_REAL_CSE_MULTIPROCESS', simulation: false, syntheticData: true, estimedExecution: false,
    simulatedComponents: ['dataset: documented synthetic task privacy-motion-8-heterogeneous-v1 (worker-private seeds)', 'compute time: trainDelayMs=800 per selected round to open a deterministic dropout window'],
    transport: 'oneM2M HTTP binding to a real Mobius4 CSE over loopback (X-M2M-Origin/RI/RVI, rsc checked)',
    cse: { implementation: 'Mobius4', cseVersion: cse.cseVersion, sourceRevision: cse.sourceRevision, cseId: cse.cseId, postgres: cse.postgresVersion.split(',')[0], databaseDroppedAfterRun: true },
    hostCount: 1, host: { platform: process.platform, node: process.version },
    processes: { coordinatorLifetimes: lifetimes.filter((l) => l.label.startsWith('coordinator')).length, workerLifetimes: lifetimes.filter((l) => l.label.startsWith('w')).length, distinctWorkers: new Set(lifetimes.filter((l) => l.label.startsWith('w')).map((l) => l.label.split('#')[0])).size, lifetimes: lifetimes.map(({ stderrTail, ...rest }) => rest) },
    task: { taskId, flAePath: ae, targetRounds, definitionPayloadHash: taskDefinition?.payloadHash ?? null, selectionPolicy: taskDefinition?.selectionPolicy ?? null, maxParticipants: task.maxParticipants, minUpdates: task.minUpdates, roundDeadlineMs: task.roundDeadlineMs, heartbeatTtlMs: task.heartbeatTtlMs, training: TRAINING, aggregation: 'sample-weighted-FedAvg' },
    dataset: { task: SHARD_TASK.version, features: 8, classes: SHARD_TASK.classes, std: SHARD_TASK.std, labelNoise: SHARD_TASK.labelNoise, split: SHARD_TASK.split, workers: Object.fromEntries(order.map((id) => [id, { profile: workerPlan[id].profile, classProportions: SHARD_PROFILES[workerPlan[id].profile].proportions, covariateShift: workerPlan[id].profile === 'new-device', splitHash: shards[id].metadata.splitHash }])), rawDataLocation: 'participant-local (seed stays in worker config)', oracleEvaluation: 'harness regenerates shards from provisioned seeds only for the comparison table; the coordinator never receives seeds or rows' },
    resourceLayout: { ae, cseBaseAcp: `${cse.cseBase}/acp-${flAeName} (coordinator ALL, all DISCOVERY; AE acpi from creation)`, children: ['acp-coordinator', 'acp-task-read', 'acp-inbox', 'acp-members', 'acp-r-NNNN (per round)', 'participants (cnt, inbox, mni 1000)', 'datasets (cnt, catalog)', 'tasks (cnt, public read)', 'currentModel (cnt, mni 5)', 'status (cnt, mni 200)', 'rounds/r-NNNN/{config cin, updates cnt, result cin}'], workerAe: `${cse.cseBase}/flw-<participantId>/{acp-self, heartbeat cnt mni 5}` },
    rounds, baselines: { note: 'same pooled test split (4 x 120 rows) and same numerics, computed in the harness process; centralized pools all 4 train splits (needs raw data transfer, reference upper bound); static ideal fixes w1-w3 with no faults; static same-faults fixes w1-w3 and drops members that were ineligible, missing or rejected in the real round', perRound: baselineRounds, final: finalRow, pairedMcNemar: paired, sensitivity },
    faults, acpProbes, discovery: { rsc: discovery.rsc, found: (discovery.payload?.['m2m:uril'] ?? []).length, byOriginator: 'unregistered rogue AE (discovery-only ACP)' },
    integrity, dataLocality: readback.dataLocality, readbackCli,
    epochs: readback.epochs,
    catalog: catalog.map((c) => ({ participantId: c.participantId, state: c.state, consentRevision: c.consentRevision, datasetId: c.datasetId })),
    roles: { coordinator: roleSummary('coordinator'), workers: roleSummary('w') },
    checks, durationSeconds: Math.round((Date.now() - started) / 100) / 10,
    reproduce: 'MOBIUS4_ROOT=<mobius4> node pc-mobius/scripts/run-fl-onem2m-real.mjs',
    sourceSHA256: Object.fromEntries(await Promise.all(['pc-mobius/integration/src/fl-onem2m-plane.mjs', 'pc-mobius/integration/src/fl-onem2m-coordinator.mjs', 'pc-mobius/integration/src/fl-onem2m-worker.mjs', 'pc-mobius/integration/src/fl-shards.mjs', 'pc-mobius/integration/src/fl-onem2m-readback.mjs', 'pc-mobius/scripts/run-fl-onem2m-real.mjs'].map(async (path) => [path, await fileHash(join(root, path))]))),
  };
  if (status !== 'PASS') failure = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name).join(', ');
} catch (error) {
  failure = error.stack ?? String(error);
} finally {
  for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(out, 'lifetimes.json'), `${JSON.stringify(lifetimes, null, 2)}\n`);
  if (cse && !process.argv.includes('--keep-cse')) await cse.stop();
}
if (report) {
  report.localEvidenceDirectory = out.replace(root, '').replaceAll('\\', '/').replace(/^\//, '');
  await mkdir(join(root, 'docs', 'verification-evidence', '2026-11-19'), { recursive: true });
  if (status === 'PASS' || process.argv.includes('--write-failed')) await writeFile(receiptPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ status, failure: failure ? cse?.sanitize?.(failure) ?? failure : null, completedRounds: report?.rounds.filter((r) => r.state === 'COMPLETED').length ?? 0, checks: report?.checks ?? null, final: report?.baselines.final ?? null, pairedMcNemar: report?.baselines.pairedMcNemar ?? null, sensitivity: report?.baselines.sensitivity ?? null, receipt: status === 'PASS' ? receiptPath : join(out, 'report.json') }, null, 2));
process.exitCode = status === 'PASS' ? 0 : 1;
