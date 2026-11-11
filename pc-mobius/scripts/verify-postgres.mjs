import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresIntegrationStore } from '../integration/src/postgres-integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { GatewayControl } from '../integration/src/gateway-control.mjs';
import { ReceiptJournal } from '../src/receipt-journal.mjs';
import { FlCoordinator } from '../integration/src/fl-coordinator.mjs';
import { enrollLocalClient, buildLocalUpdate } from '../integration/src/fl-client.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { RetentionService } from '../integration/src/retention-service.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const configPath = resolve(arg('config') ?? join(root, '.local/postgres/connection.json'));
const config = JSON.parse(await readFile(configPath, 'utf8'));
const connectionString = `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.policyDatabase}`;
const namespace = `verification-${Date.now()}-${randomUUID().slice(0, 8)}`;
const output = resolve(arg('output') ?? join(root, '.local/postgres/verification', namespace)); await mkdir(output, { recursive: true });
const journalPath = join(output, 'receipts.jsonl'); const journal = new ReceiptJournal(journalPath);
const store = await new PostgresIntegrationStore({ connectionString, namespace, receiptJournal: journal, autoDrainJournal: false }).init();
const clock = () => store.now(); const policy = new PolicyService({ store, clock });
const gateway = new GatewayControl({ store, policyService: policy, handoverCoordinator: { status: (id) => store.get('handovers', id) }, clock });
const cases = []; const pids = new Set();
const principal = { principalId: 'guardian', scopes: ['consent:write', 'grant:write', 'grant:revoke', 'policy:approve', 'bubble:command'] };
const peer = { principalId: 'gateway', mtlsFingerprint: 'test-certificate' };
const save = async (name, value) => { const path = join(output, name); await writeFile(path, JSON.stringify(value), 'utf8'); return path; };
function worker(action, fixturePath) {
  const child = fork(fileURLToPath(new URL('./postgres-worker.mjs', import.meta.url)), [configPath, namespace, action, fixturePath ?? ''], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); pids.add(child.pid);
  let result; let stderr = ''; let resolveLocked; let resolveReady; let resolveResult; let rejectResult;
  const locked = new Promise((resolve) => { resolveLocked = resolve; });
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const done = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('message', (message) => { if (message.type === 'LOCKED') resolveLocked(); if (message.type === 'READY') resolveReady(); if (message.type === 'RESULT') result = message; });
  child.on('error', rejectResult); child.on('exit', (code, signal) => { if (result) resolveResult(result); else if (signal) resolveResult({ terminated: signal }); else rejectResult(new Error(`Worker exit ${code}: ${stderr.slice(0, 4000)}`)); });
  const timer = setTimeout(() => { child.kill(); rejectResult(new Error('POSTGRES_WORKER_TIMEOUT')); }, 15000); timer.unref(); done.finally(() => clearTimeout(timer)).catch(() => {});
  return { child, locked, ready, done, release: () => child.send({ type: 'RELEASE' }) };
}
async function check(name, fn) { const start = performance.now(); const evidence = await fn(); cases.push({ name, status: 'PASS', durationMs: Math.round(performance.now() - start), ...(evidence ? { evidence } : {}) }); }

let report;
try {
  await gateway.enroll({ gatewayId: 'gw-db', principalId: peer.principalId, fingerprint: peer.mtlsFingerprint, devices: { 'key-db': 'household-db' }, credentialRevision: '1', ownershipEpoch: 1 });
  const consent = await policy.createConsent({ principal, subjectId: 'household-db', purpose: 'postgres-test', scopes: ['bubble:command'] });
  const grant = await policy.createGrant({ principal, consentId: consent.consentId, scopes: ['bubble:command'] });
  const input = { principal, gatewayId: 'gw-db', deviceId: 'key-db', commandId: 'same-command', grantId: grant.grantId, desiredState: { state: true }, deadline: new Date(Date.now() + 300000).toISOString() };
  let command;
  await check('PG01 two-process same-command claim and policy idempotency', async () => {
    const path = await save('claim.json', { input }); const [a, b] = await Promise.all([worker('claim', path).done, worker('claim', path).done]);
    assert.equal(a.error, undefined); assert.equal(b.error, undefined); assert.equal(a.result.claimId, b.result.claimId); command = a.result;
    await store.refresh(); assert.equal(store.list('gatewayCommands').length, 1);
    const claims = await store.pool.query('SELECT count(*)::int AS n FROM privacy_bubble.runtime_claim WHERE namespace=$1', [namespace]); assert.equal(claims.rows[0].n, 1);
    const issued = store.list('receipts').filter((r) => r.type === 'GATEWAY_COMMAND_ISSUED'); assert.equal(issued.length, 1);
    const policyIntent = { principal, policy: { grantId: grant.grantId }, idempotencyKey: 'same-policy' };
    const second = await new PostgresIntegrationStore({ connectionString, namespace, autoDrainJournal: false }).init();
    try { const other = new PolicyService({ store: second, clock: () => second.now() }); const [p, q] = await Promise.all([policy.approvePolicy(policyIntent), other.approvePolicy(policyIntent)]); assert.equal(p.policyId, q.policyId); } finally { await second.close(); }
  });
  await check('PG02 revocation SQL lock precedes concurrent authorization', async () => {
    const binding = { ...Object.fromEntries(['commandId', 'deviceId', 'claimId', 'grantRevision', 'ownershipEpoch'].map((k) => [k, command[k]])), payloadHash: approvalHash(command) };
    const path = await save('revoke.json', { principal, peer, gatewayId: 'gw-db', grantId: grant.grantId, binding });
    const revoke = worker('held-revoke', path); await revoke.locked;
    const authorize = worker('authorize', path); await authorize.ready;
    let lockObserved = false;
    for (let i = 0; i < 100; i++) { const activity = await store.pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1', [`bubble-runtime-${authorize.child.pid}`]); if (activity.rows.some((r) => r.wait_event_type === 'Lock')) { lockObserved = true; break; } await delay(10); }
    revoke.release(); assert.equal(lockObserved, true);
    const [r, a] = await Promise.all([revoke.done, authorize.done]); assert.equal(r.error, undefined); assert.equal(a.result.allowed, false);
    await store.refresh(); assert.equal(store.get('grants', grant.grantId).status, 'REVOKED');
    return { sqlWaitEvent: 'Lock', authorizedAfterRevoke: false };
  });
  await check('PG03 process termination before COMMIT rolls back state and outbox', async () => {
    const before = store.version; const pending = worker('crash-before-commit'); await pending.locked; pending.child.kill(); await pending.done;
    await store.refresh(); assert.equal(store.get('crashMarkers', 'pending'), undefined); assert.equal(store.version, before);
    const rows = await store.pool.query('SELECT count(*)::int AS n FROM privacy_bubble.runtime_receipt_outbox WHERE namespace=$1 AND receipt_id=$2', [namespace, 'crash-uncommitted']); assert.equal(rows.rows[0].n, 0);
  });
  await check('PG04 database commit journal outbox resumes once after append-before-delivery failure', async () => {
    await store.append('receipts', { eventId: 'journal-recovery', type: 'JOURNAL_RECOVERY', timestamp: clock() });
    const resumed = await new PostgresIntegrationStore({ connectionString, namespace, receiptJournal: journal, autoDrainJournal: false }).init(); let injected = false;
    resumed.receiptJournal = { path: journal.path, append: async (receipt) => { await journal.append(receipt); if (!injected) { injected = true; throw new Error('append-before-delivery'); } } };
    try { await assert.rejects(resumed.drainJournal(), /append-before-delivery/); resumed.receiptJournal = journal; await resumed.drainJournal(); await resumed.drainJournal(); }
    finally { await resumed.close(); }
    const records = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse); assert.equal(records.filter((r) => r.eventId === 'journal-recovery').length, 1); assert.equal(new Set(records.map((r) => r.eventId)).size, records.length);
  });
  await check('PG05 FL prepared model versus second-process consent CAS and publication fence', async () => {
    const fl = new FlCoordinator({ store, clock }); const clients = [];
    for (let i = 0; i < 3; i++) clients.push(await enrollLocalClient(fl, { participantId: `p${i}`, taskId: 'pg-model', seed: 101 * (i + 1), clientIndex: i }));
    const round = await fl.createRound({ taskId: 'pg-model' }); for (const client of clients) await fl.submitUpdate(buildLocalUpdate(fl, client, round));
    let withdrew = false; fl.faultHook = async (point) => { if (point === 'afterArtifact' && !withdrew) { withdrew = true; const result = await worker('consent-revoke', await save('withdraw.json', { taskId: 'pg-model', participantId: 'p2' })).done; assert.equal(result.error, undefined); } };
    assert.equal((await fl.finalizeRound(round.roundId)).state, 'REBUILD_REQUIRED'); const committed = await fl.finalizeRound(round.roundId); assert.equal(committed.state, 'COMPLETED');
    const pointer = await store.pool.query('SELECT * FROM privacy_bubble.runtime_model_pointer WHERE namespace=$1 AND task_id=$2', [namespace, 'pg-model']); assert.equal(Number(pointer.rows[0].model_version), 1);
    const commits = await store.pool.query('SELECT count(*)::int AS n FROM privacy_bubble.runtime_fl_commit WHERE namespace=$1', [namespace]); assert.equal(commits.rows[0].n, 1);
    const outbox = await store.pool.query('SELECT count(*)::int AS n FROM privacy_bubble.runtime_delivery_outbox WHERE namespace=$1 AND channel=$2', [namespace, 'flPublicationOutbox']); assert.equal(outbox.rows[0].n, 1);
    const revoked = await worker('consent-revoke', await save('pause.json', { taskId: 'pg-model', participantId: 'p0' })).done; assert.equal(revoked.error, undefined);
    assert.equal((await fl.publishRound(round.roundId)).status, 'SUPERSEDED'); assert.throws(() => fl.serveArtifact(round.roundId, committed.modelHash), /FL_SERVING_FENCE/);
    const snapshot = store.snapshot(); await assert.rejects(store.transaction('generation-regression', async () => { store.collection('flTasks')['pg-model'].servingGeneration = 0; }), /POSTGRES_MODEL_GENERATION_CAS/);
    await store.refresh(); assert.equal(store.get('flTasks', 'pg-model').servingGeneration, snapshot.flTasks['pg-model'].servingGeneration);
  });
  await check('PG06 committed state is restored by a fresh process', async () => {
    const restored = await worker('read').done; assert.equal(restored.error, undefined); assert.equal(restored.result.grants[grant.grantId].status, 'REVOKED'); assert.equal(restored.result.gatewayCommands['same-command'].command.claimId, command.claimId); assert.equal(restored.result.flTasks['pg-model'].state, 'SERVING_PAUSED');
  });
  await check('PG07 two coordinator processes share one FL commit key and monotonic epoch', async () => {
    const fl = new FlCoordinator({ store, clock }); const clients = [];
    for (let i = 0; i < 2; i++) clients.push(await enrollLocalClient(fl, { participantId: `f${i}`, taskId: 'pg-fence', seed: 101 * (i + 1), clientIndex: i }));
    const round = await fl.createRound({ taskId: 'pg-fence' }); for (const client of clients) await fl.submitUpdate(buildLocalUpdate(fl, client, round));
    const path = await save('fl-fence.json', { roundId: round.roundId }); const results = await Promise.all([worker('fl-finalize', path).done, worker('fl-finalize', path).done]);
    assert.ok(results.some((r) => r.result?.state === 'COMPLETED')); assert.ok(results.every((r) => r.result?.state === 'COMPLETED' || r.error === 'FL_COORDINATOR_EPOCH'));
    await store.refresh(); const rows = await store.pool.query('SELECT count(*)::int AS n FROM privacy_bubble.runtime_fl_commit WHERE namespace=$1 AND task_id=$2', [namespace, 'pg-fence']); assert.equal(rows.rows[0].n, 1); assert.equal(store.get('flTasks', 'pg-fence').modelVersion, 1);
    await assert.rejects(fl.finalizeRound(round.roundId), /FL_COORDINATOR_EPOCH/);
  });
  await check('PG08 runtime API joins policy and Gateway SQL transactions', async () => {
    const runtime = await createIntegrationRuntime({ database: { connectionString, namespace }, core: { mec: { encryptionKey: Buffer.alloc(32, 9), autoReconcile: false } } });
    try {
      await runtime.store.transaction('verify-isolation', async () => assert.equal((await runtime.store.transactionContext.getStore().client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'serializable'));
      await runtime.portalService.provisionHousehold({ householdId: 'household-db', name: 'PostgreSQL 시험', ownerId: principal.principalId });
      const polled = await runtime.api.handle({ method: 'GET', path: '/api/v1/gateways/gw-db/commands', principal: peer }); assert.equal(polled.status, 200); assert.deepEqual(polled.body.commands, []);
      const created = await runtime.api.handle({ method: 'POST', path: '/v1/consents', principal, body: { subjectId: 'household-db', purpose: 'postgres-api', scopes: ['bubble:command'] } }); assert.equal(created.status, 201, JSON.stringify(created.body));
      await store.refresh(); assert.equal(store.get('consents', created.body.consentId).purpose, 'postgres-api');
    } finally { await runtime.close(); }
  });
  await check('PG09 expiry removes canonical detail, SQL receipt copies and JSONL with a deletion receipt', async () => {
    const old = { eventId: 'expired-audit', timestamp: new Date(Date.now() - 31 * 86400000).toISOString(), type: 'OLD_AUDIT', detail: 'retention-private-value' };
    await store.append('receipts', old); await journal.append(old);
    await store.put('locationPayloads', 'expired-location', { createdAt: new Date(Date.now() - 86400001).toISOString(), cipher: 'expired-ciphertext' });
    const retention = new RetentionService({ store, receiptJournal: journal, clock }); const result = await retention.runOnce();
    assert.equal(result.counts.locationPayloads, 1); assert.equal(store.get('locationPayloads', 'expired-location'), undefined);
    assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM privacy_bubble.runtime_receipt_outbox WHERE namespace=$1 AND receipt_id=$2', [namespace, old.eventId])).rows[0].n, 0);
    assert.equal((await readFile(journal.path, 'utf8')).includes('retention-private-value'), false);
    assert.ok(store.list('receipts').some((row) => row.type === 'RETENTION_EXPIRED'));
  });
  await check('PG10 two Gateway processes share one lane, generation, dispatch-start and final native receipt', async () => {
    const consent = await policy.createConsent({ principal, subjectId: 'household-db', purpose: 'receipt-test', scopes: ['bubble:command'] });
    const grant = await policy.createGrant({ principal, consentId: consent.consentId, scopes: ['bubble:command'] });
    const command = await gateway.issue({ ...input, commandId: 'receipt-command', grantId: grant.grantId, deadline: new Date(Date.now()+60000).toISOString() });
    const binding = { ...Object.fromEntries(['commandId', 'deviceId', 'claimId', 'grantRevision', 'ownershipEpoch'].map((k) => [k, command[k]])), payloadHash: approvalHash(command) };
    const path = await save('receipt-claim.json', { gatewayId: 'gw-db', peer, binding });
    const claims = await Promise.all([worker('authorize', path).done, worker('authorize', path).done]); assert.ok(claims.every((r) => r.result?.allowed));
    const starts = await Promise.all([worker('dispatch-start', path).done, worker('dispatch-start', path).done]); assert.ok(starts.every((r) => r.result?.allowed));
    await store.refresh(); assert.equal(store.list('dispatchLanes').filter((r) => r.state === 'ADMITTED').length, 1);
    assert.equal(store.list('receipts').filter((r) => r.type === 'GATEWAY_DISPATCH_STARTED' && r.commandId === command.commandId).length, 1);
    assert.equal(store.get('gatewayCommands', command.commandId).executionState, 'IN_FLIGHT');
    await policy.revokeGrant({ principal, grantId: grant.grantId });
    const receipt = { version: 1, gatewayId: 'gw-db', deviceId: command.deviceId, commandId: command.commandId, payloadHash: binding.payloadHash, status: 'APPLIED', ackCode: 'APPLIED', acceptedAt: null, appliedAt: null, receivedAt: new Date().toISOString(), readback: {state:true}, firmwareRevision: 'pg-test', ownershipEpoch: command.ownershipEpoch, grantRevision: command.grantRevision, timestampSource: 'unavailable', detail: null, bootId: 'pg-boot' };
    const receiptPath = await save('native-receipt.json', { gatewayId: 'gw-db', peer, receipt });
    const result = await Promise.all([worker('receipt', receiptPath).done, worker('receipt', receiptPath).done]); assert.deepEqual(result.map((r) => r.result?.status).sort(), ['ACCEPTED','DUPLICATE']);
    await store.refresh(); assert.equal(store.get('gatewayCommands', command.commandId).executionState, 'APPLIED_VERIFIED'); assert.equal(store.list('dispatchLanes').filter((r) => r.state === 'ADMITTED').length, 0);
    const delivery = await store.pool.query('SELECT count(*)::int AS n FROM privacy_bubble.runtime_delivery_outbox WHERE namespace=$1 AND channel=$2', [namespace, 'dispatchOutbox']); assert.equal(delivery.rows[0].n, 1);
    return {serverClaimCount:1,receiptCount:1,physicalExecutionCount:null,desiredGeneration:store.get('gatewayCommands', command.commandId).desiredGeneration};
  });
  await check('PG11 DB clock is sampled after the waiting authority lock is acquired', async () => {
    const hold = worker('held-authority'); await hold.locked;
    const read = worker('clock-read'); await read.ready;
    let locked = false;
    for (let i=0;i<100;i++) { const activity=await store.pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1',[`bubble-runtime-${read.child.pid}`]); if(activity.rows.some((row)=>row.wait_event_type==='Lock')){locked=true;break;} await delay(10); }
    assert.equal(locked,true); await delay(100); const releasedAt=Date.now(); hold.release();
    const [,sample]=await Promise.all([hold.done,read.done]); assert.equal(sample.error,undefined); assert.ok(Date.parse(sample.result.now)>=releasedAt-10);
    return {sqlWaitEvent:'Lock',clockSampleAfterRelease:true};
  });
  const version = (await store.pool.query('SHOW server_version')).rows[0].server_version;
  const commits = (await store.pool.query('SELECT version,lock_key,writer_id,state_sha256 FROM privacy_bubble.runtime_commit WHERE namespace=$1 ORDER BY version', [namespace])).rows;
  report = { generatedAt: new Date().toISOString(), status: 'PASS', runtime: 'actual-postgresql', version, namespace, processIds: [...pids], cases, commitCount: commits.length, commits, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), journalSha256: createHash('sha256').update(await readFile(journalPath)).digest('hex') };
} catch (error) { report = { generatedAt: new Date().toISOString(), status: 'FAIL', namespace, cases, error: error.code ?? error.message, detail: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await store.close(); }
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ status: report.status, database: config.policyDatabase, version: report.version, tests: cases.length, childProcesses: pids.size, reportPath: join(output, 'report.json'), ...(report.error ? { error: report.error } : {}) }, null, 2));
