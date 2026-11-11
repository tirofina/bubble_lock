import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { IntegrationStore } from '../../pc-mobius/integration/src/integration-store.mjs';
import { FlCoordinator } from '../../pc-mobius/integration/src/fl-coordinator.mjs';
import { enrollLocalClient, EstimedVmAdapter } from '../../pc-mobius/integration/src/fl-client.mjs';
import { createMtlsFetch } from '../../pc-mobius/integration/src/fl-worker.mjs';
import { PolicyService } from '../../pc-mobius/integration/src/policy-service.mjs';
import { IntegrationApiGateway } from '../../pc-mobius/integration/src/api-gateway.mjs';
import { createIntegrationServer } from '../../pc-mobius/integration/src/api-server.mjs';
import { TRAINING } from '../../pc-mobius/integration/src/fl-numerics.mjs';

const pki = process.argv[2]; const root = fileURLToPath(new URL('../..', import.meta.url));
const output = join(root, '.local/fl-worker-verification', `${Date.now()}-${randomUUID().slice(0, 8)}`); await mkdir(output, { recursive: true });
const tls = async (name) => ({ ca: await readFile(join(pki, 'trusted.pem')), cert: await readFile(join(pki, `${name}.pem`)), key: await readFile(join(pki, `${name}.key`)) });
const fingerprint = async (name) => new X509Certificate(await readFile(join(pki, `${name}.pem`))).fingerprint256;
const store = await new IntegrationStore(join(output, 'central-state.json')).init(); const fl = new FlCoordinator({ store });
const taskId = 'tls-worker-task'; const clients = [];
for (let index = 0; index < 2; index++) clients.push(await enrollLocalClient(fl, { taskId, participantId: `client-${index + 1}`, clientIndex: index, seed: (index + 1) * 101 }));
let round = await fl.createRound({ taskId });
const api = new IntegrationApiGateway({ policyService: new PolicyService({ store }), flCoordinator: fl });
const principals = await Promise.all(clients.map(async (client, index) => ({ ...client.principal, mtlsFingerprint: await fingerprint(index ? 'client-2' : 'client') })));
const central = createIntegrationServer({ api, tls: await tls('server'), principals }); await new Promise((resolve) => central.listen(0, '127.0.0.1', resolve));
const coordinatorEndpoint = `https://127.0.0.1:${central.address().port}`; const coordinatorFingerprint = await fingerprint('client');
const config = { host: '127.0.0.1', port: 0, hostId: 'local-deployed-worker', runtimeMode: 'LOCAL_SIMULATION', statePath: join(output, 'worker-state.json'), coordinatorEndpoint,
  tls: { ca: join(pki, 'trusted.pem'), cert: join(pki, 'server.pem'), key: join(pki, 'server.key') }, coordinators: [{ fingerprint: coordinatorFingerprint, taskIds: [taskId], participantIds: clients.map((client) => client.participantId) }], participants: [] };
for (let index = 0; index < clients.length; index++) {
  const client = clients[index]; const key = join(pki, `fl-${index}.key`); await writeFile(key, client.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const name = index ? 'client-2' : 'client';
  config.participants.push({ participantId: client.participantId, taskId, dataset: client.dataset.metadata, privateKeyFile: key, upstreamTls: { ca: join(pki, 'trusted.pem'), cert: join(pki, `${name}.pem`), key: join(pki, `${name}.key`) } });
}
const configPath = join(pki, 'worker.json'); await writeFile(configPath, JSON.stringify(config));
const transports = []; const transport = (options) => { const client = createMtlsFetch(options); transports.push(client); return client; };
const coordinatorFetch = transport(await tls('client')); const checks = []; const pass = (name) => checks.push(name);
let child; let ready; let adapter; let centralClosed = false; const pids = [];
const start = async () => {
  child = spawn(process.execPath, [join(root, 'pc-mobius/scripts/run-fl-worker.mjs'), `--config=${configPath}`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  ready = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`worker startup timeout ${stderr}`)), 10000); let text = ''; child.stdout.on('data', (chunk) => { text += chunk; if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0])); } }); child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`worker exit ${code}: ${stderr}`)); }); });
  pids.push(ready.processId); adapter = new EstimedVmAdapter({ ...ready, fetchImpl: coordinatorFetch });
};
const stop = async () => { if (!child || child.exitCode !== null) return; const process = child; const exit = once(process, 'exit'); process.stdin.end('close\n'); const timer = setTimeout(() => process.kill(), 5000); await exit; clearTimeout(timer); assert.equal(process.exitCode, 0); };
const train = (client, changes = {}) => adapter.train({ round: { ...round, ...changes }, participantId: client.participantId, baseModelBytes: fl.readArtifact(round.baseModelRef, round.baseModelHash).toString('base64') });
try {
  await start(); assert.equal((await adapter.probe()).runtimeMode, 'LOCAL_SIMULATION'); pass('actual-worker-process-health');
  const first = await train(clients[0]); assert.equal(first.sampleCount, 360); pass('mtls-central-authorized-training');
  assert.deepEqual(await train(clients[0]), first); pass('durable-idempotent-training-retry');
  await assert.rejects(train(clients[0], { baseModelHash: '0'.repeat(64) }), /FL_VM_HTTP_403/); pass('authoritative-base-model-fence');
  await assert.rejects(train(clients[0], { taskId: 'foreign-task' }), /FL_VM_HTTP_403/); pass('coordinator-task-scope');
  await assert.rejects(train(clients[0], { participants: round.participants.map((p) => ({ ...p, consentRevision: 99 })) }), /FL_VM_HTTP_403/); pass('current-consent-revision-fence');
  const foreign = transport(await tls('client-2')); assert.equal((await foreign(`${ready.endpoint}/v1/fl/health`)).status, 403); pass('enrolled-coordinator-fingerprint');
  const rogue = transport(await tls('rogue-client')); await assert.rejects(rogue(`${ready.endpoint}/v1/fl/health`)); pass('untrusted-client-ca');
  const wrongCa = transport({ ...await tls('client'), ca: await readFile(join(pki, 'rogue.pem')) }); await assert.rejects(wrongCa(`${ready.endpoint}/v1/fl/health`)); pass('trusted-server-ca');
  const body = { ...round, participantId: clients[0].participantId, baseModelBytes: fl.readArtifact(round.baseModelRef, round.baseModelHash).toString('base64'), training: TRAINING, runtimeMode: 'ESTIMED' };
  assert.equal((await coordinatorFetch(`${ready.endpoint}/v1/fl/train`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403); pass('explicit-local-runtime-mode');
  await stop(); await start(); assert.deepEqual(await train(clients[0]), first); assert.equal(JSON.parse(await readFile(config.statePath, 'utf8')).receipts.length, 1); pass('worker-process-restart-replay');
  await fl.recover(round.roundId); await assert.rejects(train(clients[0]), /FL_VM_HTTP_403/); round = fl.round(round.roundId); pass('coordinator-epoch-fence');
  for (let index = 0; index < clients.length; index++) {
    const update = await train(clients[index]); const upstream = transport(await tls(index ? 'client-2' : 'client'));
    const response = await upstream(`${coordinatorEndpoint}/v1/fl/updates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) }); assert.equal(response.status, 202, JSON.stringify(await response.json()));
  }
  const complete = await fl.finalizeRound(round.roundId); assert.equal(complete.state, 'COMPLETED'); pass('signed-http-updates-numerical-fedavg');
  await fl.setParticipantConsent({ taskId, participantId: clients[0].participantId, principal: clients[0].principal, status: 'STOPPED' });
  await assert.rejects(train(clients[0]), /FL_VM_HTTP_403/); assert.throws(() => fl.serveArtifact(round.roundId, complete.modelHash), /FL_/); pass('stopped-consent-training-and-serving-fence');
  const report = { status: 'PASS', generatedAt: new Date().toISOString(), runtimeMode: 'LOCAL_SIMULATION', transport: 'actual-TLS1.3-mTLS', workerProcessIds: pids, imageDigest: ready.imageDigest, modelHash: complete.modelHash, checks, externalGate: 'ESTIMED 계정·VM 할당 receipt 연결' };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: 'PASS', checks: checks.length, reportPath: join(output, 'report.json') }));
} finally { await stop(); for (const client of transports) client.close(); if (!centralClosed) { central.closeAllConnections(); await new Promise((resolve) => central.close(resolve)); centralClosed = true; } await store.close(); }
