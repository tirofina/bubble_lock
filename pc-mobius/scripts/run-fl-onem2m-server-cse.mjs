// R14 run on the team's server CSE (Mobius /bubble-cse behind the nginx mTLS originator-binding route):
// coordinator process on this PC, three worker processes on the MEC sandbox VM as transient systemd units
// (bubble-fl-worker-<id>, started by ~/bubble-fl/start-worker.sh). One resilience event: a selected worker is
// stopped with systemctl stop while it trains (no update), the round closes by deadline and quorum, the next
// round excludes it as HEARTBEAT_STALE, and the worker is started again and selected in a later round.
// Usage: node pc-mobius/scripts/run-fl-onem2m-server-cse.mjs --deploy=<dir with coordinator.config.json and vm/*.config.json>
//          [--vm=mec@192.0.2.103] [--ssh-key=<path>] [--known-hosts=<path>] [--victim=w2]
// Writes docs/verification-evidence/2026-11-20/fl-server-cse.json and fl-server-cse-trace.jsonl. No secrets are read
// into the receipt: the deploy dir holds them, the VM keeps the client certificates in place.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { hostname, release, version, arch } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { flCseClientFromConfig } from '../integration/src/fl-onem2m-plane.mjs';
import { readbackFlPlane, roundRows } from '../integration/src/fl-onem2m-readback.mjs';
import { generateShard } from '../integration/src/fl-shards.mjs';
import { evaluateModel } from '../integration/src/fl-numerics.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const arg = (name, fallback = null) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const deploy = resolve(arg('deploy') ?? '');
const vm = arg('vm', 'mec@192.0.2.103');
const sshArgs = ['-i', arg('ssh-key', 'C:/Users/user/VMs/mec-sandbox/id_ed25519'), '-o', `UserKnownHostsFile=${arg('known-hosts', 'C:/Users/user/VMs/mec-sandbox/known_hosts')}`, '-o', 'BatchMode=yes', vm];
const victim = arg('victim', 'w2');
const evidenceDir = join(root, 'docs', 'verification-evidence', '2026-11-20');
const receiptPath = join(evidenceDir, 'fl-server-cse.json'); const tracePath = join(evidenceDir, 'fl-server-cse-trace.jsonl');
const workers = ['w1', 'w2', 'w3'];
const bus = new EventEmitter(); bus.setMaxListeners(100);
const events = []; const started = Date.now();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const record = (event) => { events.push(event); bus.emit('event', event); };
const action = (name, extra = {}) => record({ t: new Date().toISOString(), role: 'harness', event: name, ...extra });

function ssh(command, { timeoutMs = 30000 } = {}) {
  return new Promise((done, reject) => {
    const child = spawn('ssh', [...sshArgs, command], { windowsHide: true }); let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ssh timeout: ${command}`)); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => { clearTimeout(timer); if (code === 0) done(out.trim()); else reject(new Error(`ssh ${command}: ${code} ${err.slice(-300)}`)); });
  });
}
function waitFor(predicate, timeoutMs, description) {
  const found = events.find(predicate); if (found) return Promise.resolve(found);
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { bus.off('event', listener); reject(new Error(`timeout waiting for ${description}`)); }, timeoutMs);
    const listener = (e) => { if (predicate(e)) { clearTimeout(timer); bus.off('event', listener); done(e); } };
    bus.on('event', listener);
  });
}
const isCoord = (name, extra = () => true) => (e) => e.role === 'coordinator' && e.event === name && extra(e);
const isWorker = (id, name, extra = () => true) => (e) => e.role === 'worker' && e.workerId === id && e.event === name && extra(e);
function lines(stream, onLine) { let buffer = ''; stream.on('data', (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) onLine(line); } }); }

// Host fingerprints (hostname only as sha256) and the PC-VM clock offset (heartbeat TTL is judged across hosts).
const pcHost = { role: 'coordinator', hostnameSha256: sha256(hostname()), os: version(), kernel: release(), arch: arch(), node: process.version };
const vmFacts = JSON.parse(await ssh(`printf '{"hostnameSha256":"%s","os":"%s","kernel":"%s","arch":"%s","node":"%s","ntpSynchronized":"%s"}' "$(hostname | tr -d '\\n' | sha256sum | cut -d' ' -f1)" "$(. /etc/os-release; echo $PRETTY_NAME)" "$(uname -r)" "$(uname -m)" "$($(ls -d $HOME/.nvm/versions/node/v*/bin/node | sort -V | tail -1) -v)" "$(timedatectl show -p NTPSynchronized --value)"`));
const offsets = [];
for (let i = 0; i < 5; i++) { const t0 = Date.now(); const remote = Number(await ssh('date +%s%3N')); const t1 = Date.now(); offsets.push({ rttMs: t1 - t0, offsetMs: remote - (t0 + t1) / 2 }); }
const clock = offsets.sort((a, b) => a.rttMs - b.rttMs)[0];
const vmHost = { role: 'workers', ...vmFacts, units: workers.map((id) => `bubble-fl-worker-${id} (transient systemd unit, user mec)`), clockOffsetVsPcMs: Math.round(clock.offsetMs), clockOffsetRttMs: clock.rttMs };

// Worker events from the VM journal (MESSAGE is the worker's JSON line; systemd lines record stop/start).
const journal = spawn('ssh', [...sshArgs, `journalctl -f -n 0 -o json ${workers.map((id) => `-u bubble-fl-worker-${id}`).join(' ')}`], { windowsHide: true });
lines(journal.stdout, (line) => {
  let entry; try { entry = JSON.parse(line); } catch { return; }
  const message = Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString('utf8') : String(entry.MESSAGE ?? '');
  try { const e = JSON.parse(message); if (e && e.role === 'worker') { record({ proc: `vm:${e.workerId}`, ...e }); return; } } catch { /* systemd line */ }
  record({ t: new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000).toISOString(), role: 'systemd', unit: entry.UNIT ?? entry._SYSTEMD_UNIT ?? null, message: message.slice(0, 200) });
});
await delay(1500);

let coordinator = null; const lifetimes = [];
function spawnCoordinator(label) {
  const child = spawn(process.execPath, [join(root, 'pc-mobius/scripts/run-fl-onem2m-coordinator.mjs'), `--config=${join(deploy, 'coordinator.config.json')}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lifetime = { label, host: 'pc', startedAt: new Date().toISOString(), exitCode: null }; lifetimes.push(lifetime);
  lines(child.stdout, (line) => { try { record({ proc: `pc:${label}`, ...JSON.parse(line) }); } catch { record({ proc: `pc:${label}`, raw: line.slice(0, 300) }); } });
  let stderr = ''; child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
  child.on('exit', (code) => { lifetime.exitCode = code; lifetime.exitedAt = new Date().toISOString(); if (stderr.trim()) lifetime.stderrTail = stderr.trim().slice(-600); bus.emit('event', { role: 'harness', event: 'COORDINATOR_PROCESS_EXIT', code }); });
  return child;
}

let status = 'FAIL'; let failure = null; let resilience = null; let receipt = null;
try {
  coordinator = spawnCoordinator('coordinator#1');
  const boot = await waitFor((e) => isCoord('BOOTSTRAPPED')(e) || isCoord('RESUMED')(e) || isCoord('COORDINATOR_FAILED')(e), 60000, 'coordinator bootstrap');
  if (boot.event === 'COORDINATOR_FAILED') throw new Error(`coordinator failed: ${boot.reason} ${JSON.stringify(boot.details)}`);
  for (const id of workers) { await ssh(`~/bubble-fl/start-worker.sh ${id}`); action('WORKER_UNIT_STARTED', { workerId: id, command: `start-worker.sh ${id} (systemd-run)` }); }

  // Resilience: stop the victim while it trains in the first round it is selected in from round 3 on.
  const open = await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber >= 3 && e.selected.includes(victim)), 180000, 'round with the victim selected');
  await waitFor(isWorker(victim, 'TRAINING_STARTED', (e) => e.roundNumber === open.roundNumber), 30000, 'victim training');
  await ssh(`sudo systemctl stop bubble-fl-worker-${victim}`); action('WORKER_UNIT_STOPPED', { workerId: victim, roundNumber: open.roundNumber, command: `systemctl stop bubble-fl-worker-${victim}` });
  const abandoned = await waitFor(isWorker(victim, 'ROUND_ABANDONED'), 20000, 'victim abandons the round');
  const closed = await waitFor(isCoord('ROUND_COMPLETED', (e) => e.roundNumber === open.roundNumber), 40000, 'dropout round close');
  const next = await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber === open.roundNumber + 1), 30000, 'round after dropout');
  await ssh(`~/bubble-fl/start-worker.sh ${victim}`); action('WORKER_UNIT_RESTARTED', { workerId: victim, duringRound: next.roundNumber, command: `start-worker.sh ${victim} (systemd-run)` });
  const back = await waitFor(isCoord('ROUND_OPENED', (e) => e.roundNumber > next.roundNumber && e.selected.includes(victim)), 120000, 'victim selected again');
  resilience = { kind: 'worker stopped mid-round and started again (systemctl stop, systemd-run)', participantId: victim, stoppedInRound: open.roundNumber, stoppedAt: events.find((e) => e.event === 'WORKER_UNIT_STOPPED').t, workerEvent: { event: abandoned.event, reason: abandoned.reason, roundNumber: abandoned.roundNumber }, roundTrigger: closed.trigger, roundAccepted: closed.accepted, roundMissing: closed.missing, nextRound: next.roundNumber, nextRoundSelected: next.selected, nextRoundExcluded: next.excluded.filter((x) => x.participantId === victim), restartedDuringRound: next.roundNumber, selectedAgainInRound: back.roundNumber };

  const done = await waitFor(isCoord('TASK_COMPLETED'), 240000, 'task completion');
  await Promise.all(workers.map((id) => waitFor(isWorker(id, 'TASK_COMPLETED'), 20000, `${id} standby`).catch(() => null)));
  await waitFor((e) => e.event === 'COORDINATOR_PROCESS_EXIT', 15000, 'coordinator exit').catch(() => null);

  // Readback over the same mTLS route with the coordinator identity.
  const config = JSON.parse(await readFile(join(deploy, 'coordinator.config.json'), 'utf8'));
  const credentials = JSON.parse(await readFile(join(deploy, config.credentialsPath), 'utf8'));
  const client = flCseClientFromConfig(config, { baseDir: deploy, originator: credentials.aeId });
  const aePath = `${client.cseBase}/${config.flAeName}`;
  const readback = await readbackFlPlane({ client, aePath, coordinatorPublicKeyPem: credentials.publicKeyPem, rowIdPattern: /w\d-local:\d+/ });
  const plans = Object.fromEntries(await Promise.all(workers.map(async (id) => [id, JSON.parse(await readFile(join(deploy, 'vm', `${id}.config.json`), 'utf8')).dataset])));
  const shards = Object.fromEntries(workers.map((id) => [id, generateShard(plans[id])]));
  const pooled = workers.flatMap((id) => shards[id].test);
  const earlierPool = [...pooled, ...generateShard({ seed: 7394, profile: 'new-device', datasetId: 'w4-local' }).test];
  const ev = (model, rows) => { const m = evaluateModel(model, rows); return { accuracy: Number((1 - m.errorRate).toFixed(4)), crossEntropy: Number(m.crossEntropy.toFixed(4)) }; };
  const rows = roundRows(readback.rounds).map((row, i) => ({ roundNumber: row.roundNumber, state: row.state, trigger: row.trigger, selected: row.selected, accepted: row.accepted, dropped: [...row.missing, ...row.rejected], excluded: row.excluded, federatedEvaluationOfBaseModel: row.federatedEvaluationOfBaseModel, oracleOfRoundModel: readback.rounds[i].model ? ev(readback.rounds[i].model, pooled) : null, updateCreators: Object.fromEntries(readback.rounds[i].updates.map((u) => [u.con?.participantId, u.cr ?? null])) }));
  const completed = readback.rounds.filter((r) => r.result?.state === 'COMPLETED');
  const finalModel = completed.at(-1)?.model;
  const earlier = JSON.parse(await readFile(join(root, 'docs/verification-evidence/2026-11-19/fl-onem2m-real-cse.json'), 'utf8'));
  const earlierRound = (n) => earlier.rounds.find((r) => r.roundNumber === n)?.oracleEvaluationOfRoundModel?.pooledTest ?? null;
  const frontEnd = { cseBaseGet: (await client.retrieve(client.cseBase)).status, cseBaseAcpGet: (await client.retrieve(`${client.cseBase}/acp-${config.flAeName}`)).status };
  const trace = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const checks = {
    completedRounds6: completed.length === 6,
    signaturesValid: readback.checks.signaturesValid, fedAvgReadbackMatches: readback.checks.reaggregationMatches, lineageUnbroken: readback.checks.lineageUnbroken,
    currentModelMatchesLastRound: readback.checks.currentModelMatchesLastRound, noRawRowsInCse: readback.checks.noRawRowsInCse,
    updateCreatorsAreForcedOriginators: rows.every((r) => Object.entries(r.updateCreators).every(([pid, cr]) => cr === `Cpb-fl-${pid}`)),
    dropoutClosedByDeadlineQuorum: resilience.roundTrigger === 'DEADLINE' && resilience.roundMissing.some((m) => m.participantId === victim),
    stoppedWorkerExcludedNextRound: resilience.nextRoundExcluded.some((x) => x.reason === 'HEARTBEAT_STALE'),
    restartedWorkerSelectedAgain: resilience.selectedAgainInRound > resilience.nextRound,
  };
  status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
  receipt = {
    status, rubric: 'R14', docRevision: '2.0.0', generatedAt: new Date().toISOString(),
    runtimeMode: 'LOCAL_STF685_VM_SERVER_CSE', simulation: false, syntheticData: true, estimedExecution: false,
    simulatedComponents: ['dataset: documented synthetic task privacy-motion-8-heterogeneous-v1 (worker-private seeds)', 'compute time: trainDelayMs=3000 per selected round (stop window)'],
    hosts: [pcHost, vmHost], hostCount: 2,
    cse: { cseId: '/bubble-cse', implementation: 'Mobius (Mobius4 4.25.0 image of the server owner)', baseUrl: config.cseUrl, cseBase: config.cseBase, transport: 'oneM2M HTTP binding over HTTPS with mTLS to the nginx originator-binding route (X-M2M-Origin forced per client certificate, Authorization cleared)', coordinatorTls: client.transport, workerTls: { servername: '<SERVER_DOMAIN>', connectHost: '127.0.0.1', clientCertificates: 'deployment CA, RSA 2048, clientAuth, read in place on the VM' }, forcedOriginators: { coordinator: 'Cpb-fl-coord', workers: workers.map((id) => `Cpb-fl-${id}`) }, frontEndRefusals: frontEnd, notifications: 'none (polling only)' },
    task: { taskId: 'privacy-motion', flAePath: aePath, targetRounds: 6, maxParticipants: 3, minUpdates: 2, roundDeadlineMs: config.task.roundDeadlineMs, heartbeatTtlMs: config.task.heartbeatTtlMs, workers: Object.fromEntries(workers.map((id) => [id, { profile: plans[id].profile, splitHash: shards[id].metadata.splitHash }])) },
    rounds: rows, resilience,
    finalAccuracy: { pooledTestW1W3: finalModel ? ev(finalModel, pooled) : null, earlierPool480Rows: finalModel ? ev(finalModel, earlierPool) : null, earlierLocalRun: { receipt: 'docs/verification-evidence/2026-11-19/fl-onem2m-real-cse.json', round6PooledTest: earlierRound(6), round12PooledTest: earlierRound(12), pool: '480 rows (w1-w4 test splits); w1-w3 seeds and profiles are the same here' } },
    fedAvgReadback: { ...readback.integrity, check: readback.checks.reaggregationMatches },
    dataLocality: readback.dataLocality, epochs: readback.epochs, lifetimes: lifetimes.map(({ stderrTail, ...rest }) => rest),
    checks, durationSeconds: Math.round((Date.now() - started) / 100) / 10,
    trace: { path: 'docs/verification-evidence/2026-11-20/fl-server-cse-trace.jsonl', sha256: sha256(trace), events: events.length },
    reproduce: 'node pc-mobius/scripts/run-fl-onem2m-server-cse.mjs --deploy=<deploy dir>',
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(tracePath, trace);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  if (status !== 'PASS') failure = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k).join(', ');
} catch (error) {
  failure = error.stack ?? String(error);
  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(join(deploy, 'failed-trace.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
} finally {
  if (coordinator && coordinator.exitCode === null) coordinator.kill();
  journal.kill();
}
console.log(JSON.stringify({ status, failure, rounds: receipt?.rounds.map((r) => ({ n: r.roundNumber, selected: r.selected, accepted: r.accepted, acc: r.oracleOfRoundModel?.accuracy })) ?? null, finalAccuracy: receipt?.finalAccuracy ?? null, checks: receipt?.checks ?? null, lifetimes }, null, 2));
process.exit(status === 'PASS' ? 0 : 1);
