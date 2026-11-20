// FL worker process for the oneM2M coordination plane. Runs on any host that reaches the CSE.
// Usage: node pc-mobius/scripts/run-fl-onem2m-worker.mjs --config=<worker.config.json>
// Config: { cseUrl, cseBase, credentialsPath, workerId, taskId, flAeName (optional: label discovery when absent),
//           dataset: { source: 'synthetic-shard', seed, profile, datasetId } | { source: 'jsonl', path, datasetId },
//           pollMs, heartbeatMs, trainDelayMs, zone, allowPlainHttp, timeoutMs, exitOnTaskComplete, standbyPollMs,
//           caFile, clientCertFile, clientKeyFile, servername, connectHost }.
// TLS keys: see flCseTransport in fl-onem2m-plane.mjs. exitOnTaskComplete:false keeps a systemd worker in standby.
// stdin commands: "revoke" (withdraw consent), "tamper-next" (integrity fault injection), "exit".
// One-shot withdrawal without stdin (systemd hosts): add --revoke; set consentRevision in config after a re-consent.
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { flCseClientFromConfig, loadLocalDataset } from '../integration/src/fl-onem2m-plane.mjs';
import { FlOneM2mWorker } from '../integration/src/fl-onem2m-worker.mjs';

const configArg = process.argv.find((value) => value.startsWith('--config='))?.slice(9);
if (!configArg) { console.error('--config=<worker.config.json> is required'); process.exit(2); }
const configPath = resolve(configArg); const base = dirname(configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const credentials = JSON.parse(await readFile(resolve(base, config.credentialsPath), 'utf8'));
if (credentials.role !== 'worker' || credentials.participantId !== config.workerId) throw new Error('worker credentials must match workerId');
const emit = (event) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), role: 'worker', workerId: config.workerId, pid: process.pid, ...event })}\n`);
const datasetSpec = config.dataset?.source === 'jsonl' ? { ...config.dataset, path: resolve(base, config.dataset.path) } : config.dataset;
const dataset = await loadLocalDataset(datasetSpec);
const client = flCseClientFromConfig(config, { baseDir: base, originator: credentials.aeId });
const worker = new FlOneM2mWorker({ client, credentials: { ...credentials, consentRevision: config.consentRevision ?? credentials.consentRevision }, dataset, taskId: config.taskId ?? credentials.taskId, flAeName: config.flAeName ?? null, zone: config.zone ?? 'lab', trainDelayMs: config.trainDelayMs ?? 0, heartbeatMs: config.heartbeatMs ?? 1000, exitOnTaskComplete: config.exitOnTaskComplete !== false, standbyPollMs: config.standbyPollMs ?? 30000, log: emit });
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)) {
    if (line === 'revoke') worker.revokeConsent('participant-withdrew-via-local-command').catch((error) => emit({ event: 'CONSENT_REVOKE_FAILED', reason: error.code ?? error.message }));
    else if (line === 'tamper-next') { worker.tamperNext = true; emit({ event: 'TAMPER_ARMED' }); }
    else if (line === 'exit') controller.abort();
  }
});
process.stdin.on('error', () => {});
try {
  const started = await worker.start();
  emit({ event: 'WORKER_STARTED', ...started, transport: client.transport, rawRowsInProcess: dataset.train.length + dataset.validation.length + dataset.test.length });
  if (process.argv.includes('--revoke')) { await worker.revokeConsent('participant-withdrew-via-cli'); controller.abort(); }
  const counters = await worker.run({ pollMs: config.pollMs ?? 250, signal: controller.signal });
  emit({ event: 'WORKER_EXIT', counters, cseRequests: client.stats });
} catch (error) {
  emit({ event: 'WORKER_FAILED', reason: error.code ?? error.message, details: error.details ?? null });
  process.exitCode = 1;
} finally { process.stdin.destroy(); }
