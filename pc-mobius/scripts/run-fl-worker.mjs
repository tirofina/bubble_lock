import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { RetentionService } from '../integration/src/retention-service.mjs';
import { FlTrainingWorker, createFlWorkerServer, createMtlsFetch } from '../integration/src/fl-worker.mjs';

const configArg = process.argv.find((value) => value.startsWith('--config='))?.slice(9);
if (!configArg) throw new Error('FL worker --config 경로를 설정하세요.');
const configPath = resolve(configArg); const root = dirname(configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const readTls = async (input) => Object.fromEntries(await Promise.all(['ca', 'cert', 'key'].map(async (key) => [key, await readFile(resolve(root, input[key]))])));
const coordinatorEndpoint = new URL(config.coordinatorEndpoint);
if (coordinatorEndpoint.protocol !== 'https:' || coordinatorEndpoint.username || coordinatorEndpoint.password || coordinatorEndpoint.pathname !== '/' || coordinatorEndpoint.search || coordinatorEndpoint.hash) throw new Error('FL 중앙 HTTPS endpoint를 설정하세요.');
const clients = new Map();
const participants = await Promise.all(config.participants.map(async (participant) => {
  clients.set(participant.participantId, createMtlsFetch(await readTls(participant.upstreamTls ?? config.upstreamTls)));
  return { ...participant, privateKeyPem: await readFile(resolve(root, participant.privateKeyFile), 'utf8') };
}));
const files = [import.meta.url, '../integration/src/fl-worker.mjs', '../integration/src/fl-client.mjs', '../integration/src/fl-numerics.mjs'].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const hash = createHash('sha256'); for (const path of files) hash.update(await readFile(path));
const identity = { hostId: config.hostId, processId: String(process.pid), imageDigest: `sha256:${hash.digest('hex')}` };
const store = await new IntegrationStore(resolve(root, config.statePath)).init();
const retention = new RetentionService({ store }); await retention.runOnce(); retention.start();
const worker = new FlTrainingWorker({ store, participants, identity, runtimeMode: config.runtimeMode ?? 'ESTIMED', authorizeTraining: async ({ taskId, participantId, roundId }) => {
  const url = new URL('/v1/fl/participant-state', coordinatorEndpoint); url.search = new URLSearchParams({ taskId, participantId, roundId });
  const response = await clients.get(participantId)(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`FL_CENTRAL_AUTHORIZATION_${response.status}`); return response.json();
} });
const server = createFlWorkerServer({ worker, tls: await readTls(config.tls), coordinators: config.coordinators });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port ?? 9443, config.host ?? '127.0.0.1', resolve); });
console.log(JSON.stringify({ ...worker.health(), endpoint: `https://${config.publicHost ?? '127.0.0.1'}:${server.address().port}` }));
let closing = false;
const close = async () => { if (closing) return; closing = true; retention.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); for (const client of clients.values()) client.close(); await store.close(); };
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => close().then(() => process.exit(0)));
process.stdin.setEncoding('utf8'); process.stdin.on('data', (data) => { if (data.trim() === 'close') close().then(() => process.exit(0)); });
