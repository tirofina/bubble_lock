import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, X509Certificate, randomUUID } from 'node:crypto';
import { IntegrationStore } from '../../pc-mobius/integration/src/integration-store.mjs';
import { EdgeSupervisor, EdgeDeploymentClient, createEdgeAgentServer } from '../../pc-mobius/integration/src/edge-deployment.mjs';
import { createMtlsFetch } from '../../pc-mobius/integration/src/fl-worker.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url)); const pki = process.argv[2];
const output = join(root, '.local/edge-deployment-verification', `${Date.now()}-${randomUUID().slice(0, 8)}`); await mkdir(output, { recursive: true });
const tls = async (name) => ({ ca: await readFile(join(pki, 'trusted.pem')), cert: await readFile(join(pki, `${name}.pem`)), key: await readFile(join(pki, `${name}.key`)) });
const fingerprint = new X509Certificate(await readFile(join(pki, 'client.pem'))).fingerprint256;
const runner = join(root, 'pc-mobius/scripts/run-integration-api.mjs');
const runnerHash = createHash('sha256').update(await readFile(runner)).digest('hex');
const transport = createMtlsFetch(await tls('client')); const outsider = createMtlsFetch(await tls('client-2'));
const freePort = async () => { const server = netServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; };
const checks = []; const pass = (name) => checks.push(name); const edges = [];
async function serve(edge) {
  edge.supervisor = new EdgeSupervisor({ ...edge.options, store: await new IntegrationStore(edge.statePath).init() });
  edge.server = createEdgeAgentServer({ supervisor: edge.supervisor, tls: await tls('server'), controllers: [{ fingerprint, appIds: ['integration-api'] }] });
  await new Promise((resolve) => edge.server.listen(0, '127.0.0.1', resolve));
  edge.endpoint = `https://127.0.0.1:${edge.server.address().port}`;
  const app = edge.supervisor.publicApplication(edge.supervisor.applications.get('integration-api'));
  edge.client = new EdgeDeploymentClient({ ...app, endpoint: edge.endpoint, hostId: edge.options.hostId, fetchImpl: transport });
}
async function stopServer(edge) { edge.server.closeAllConnections(); await new Promise((resolve) => edge.server.close(resolve)); }
try {
  for (const label of ['A', 'B']) {
    const port = await freePort(); const configPath = join(output, `runtime-${label}.json`);
    await writeFile(configPath, JSON.stringify({ statePath: join(output, `runtime-${label}-state.json`), receiptPath: join(output, `runtime-${label}.jsonl`) }));
    const options = { hostId: `edge-${label}`, region: 'seoul', zones: ['home'], capacity: 1, startBudgetMs: 7000,
      applications: [{ appId: 'integration-api', version: '1.0.0', executable: process.execPath, cwd: root, args: [runner],
        env: { PRIVACY_BUBBLE_API_CONFIG: configPath, PRIVACY_BUBBLE_INTEGRATION_PORT: String(port) }, healthUrl: `http://127.0.0.1:${port}/healthz`,
        artifacts: [{ name: 'run-integration-api.mjs', path: runner, sha256: runnerHash }], capabilities: ['policy', 'handover'] }] };
    const edge = { options, statePath: join(output, `edge-${label}.json`) }; await serve(edge); edges.push(edge);
  }
  const [a, b] = edges;
  assert.equal((await a.client.inventory({ region: 'seoul', zone: 'home', capabilities: ['policy'] })).hostId, 'edge-A'); pass('mTLS host inventory and pinned application');
  assert.equal((await outsider(`${a.endpoint}/v1/edge/inventory`)).status, 403); pass('unregistered controller certificate');
  await assert.rejects(a.client.inventory({ zone: 'foreign' }), /EDGE_INELIGIBLE/); pass('zone eligibility');
  await assert.rejects(a.client.inventory({ capabilities: ['unknown'] }), /EDGE_INELIGIBLE/); pass('capability eligibility');
  const intent = { ueId: 'keyring-1', epoch: 1, operationId: 'deploy-A', region: 'seoul', zone: 'home', capabilities: ['policy'] };
  const first = await a.client.ensure(intent); assert.equal(first.state, 'RUNNING'); assert.ok(first.pid > 0); pass('actual integration API process deployment and identity health');
  const replay = await a.client.ensure(intent); assert.equal(replay.pid, first.pid); assert.equal(replay.instanceId, first.instanceId); pass('same intent uses existing process');
  await assert.rejects(a.client.ensure({ ...intent, epoch: 2 }), /EDGE_OPERATION_BINDING/); pass('operation intent hash binding');
  await stopServer(a); await serve(a);
  const recovered = await a.client.ensure(intent); assert.equal(recovered.pid, first.pid); pass('supervisor restart adopts exact process identity');
  const second = await b.client.ensure({ ...intent, epoch: 2, operationId: 'deploy-B' }); assert.notEqual(second.pid, first.pid); pass('second host agent starts independent process');
  assert.equal((await a.client.release({ ueId: intent.ueId, epoch: 1 })).stopped, true); pass('source process release after target readiness');
  await assert.rejects(b.client.release({ ueId: intent.ueId, epoch: 1 }), /EDGE_RELEASE_EPOCH/); pass('old epoch release fence');
  assert.equal((await b.client.inventory()).deployments[0].healthy, true); pass('current target remains healthy');
  const current = b.supervisor.store.get('edgeDeployments', 'integration-api');
  await b.supervisor.store.put('edgeDeployments', 'integration-api', { ...current, instanceId: 'wrong-instance' });
  try { await assert.rejects(b.client.ensure({ ...intent, epoch: 3, operationId: 'identity-review' }), /EDGE_PROCESS_IDENTITY_REVIEW/); pass('PID reuse or foreign health identity fence'); }
  finally { await b.supervisor.store.put('edgeDeployments', 'integration-api', current); }
  const entry = b.supervisor.applications.get('integration-api'); const saved = entry.artifacts[0].sha256; entry.artifacts[0].sha256 = '0'.repeat(64);
  await assert.rejects(b.client.ensure({ ...intent, epoch: 3, operationId: 'hash-review' }), /EDGE_ARTIFACT_HASH/); entry.artifacts[0].sha256 = saved; pass('on-host artifact verification');
  await b.client.release({ ueId: intent.ueId, epoch: 2 });
  const bad = a.supervisor.applications.get('integration-api'); const originalHealth = bad.healthUrl; bad.healthUrl = 'http://127.0.0.1:1/healthz';
  a.supervisor.startBudgetMs = 300;
  await assert.rejects(a.client.ensure({ ...intent, epoch: 3, operationId: 'start-failure' }), /EDGE_START_HEALTH/);
  bad.healthUrl = originalHealth;
  assert.equal(a.supervisor.store.get('edgeDeployments', 'integration-api').state, 'STOPPED'); pass('failed target startup stops child and records rollback');
  const report = { status: 'PASS', measurementScope: 'LOCAL_TWO_TLS_AGENTS_REAL_NODE_PROCESSES', physicalHosts: 1, virtualEdgeAgents: 2, checks, processIds: [first.pid, second.pid], measuredAt: new Date().toISOString() };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: 'PASS', checks: checks.length, report: join(output, 'report.json') }));
} finally {
  for (const edge of edges) {
    for (const row of edge.supervisor.store.list('edgeDeployments')) for (const [ueId, epoch] of Object.entries(row.leaseEpochs ?? {})) await edge.supervisor.release({ appId: row.appId, ueId, epoch }).catch(() => {});
    await stopServer(edge).catch(() => {});
  }
  transport.close(); outsider.close();
}
