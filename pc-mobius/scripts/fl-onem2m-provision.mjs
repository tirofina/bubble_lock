// Provisions operator, coordinator and worker identities plus config templates for the oneM2M FL plane.
// Usage: node pc-mobius/scripts/fl-onem2m-provision.mjs --out=.local/fl-deploy --cse-url=https://cse.example:443
//          --task=privacy-motion --workers=w1,w2,w3 [--fl-ae=fl-privacy-motion] [--run-tag=lab01] [--allow-plain-http]
//          [--coordinator-ae-id=Cpb-fl-coord] [--worker-ae-id-prefix=Cpb-fl-]
// The AE-ID flags pin the AE-IDs to the originators that an mTLS front end forces per client certificate
// (worker AE-ID = prefix + workerId). The config templates carry the TLS keys (caFile, clientCertFile,
// clientKeyFile, servername, connectHost) as null; fill them per host.
// Writes private key material with mode 0600. Keep the output directory under .local/ or another secret store.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { provisionIdentities } from '../integration/src/fl-onem2m-plane.mjs';
import { DEFAULT_TASK } from '../integration/src/fl-onem2m-coordinator.mjs';

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = resolve(arg('out') ?? '.local/fl-onem2m-deploy');
const cseUrl = arg('cse-url'); if (!cseUrl) { console.error('--cse-url is required'); process.exit(2); }
const taskId = arg('task') ?? 'privacy-motion';
const workers = (arg('workers') ?? 'w1,w2,w3').split(',').map((v) => v.trim()).filter(Boolean);
const flAeName = arg('fl-ae') ?? `fl-${taskId}`;
const allowPlainHttp = process.argv.includes('--allow-plain-http');
const prefix = arg('worker-ae-id-prefix');
const aeIds = { ...(arg('coordinator-ae-id') ? { coordinator: arg('coordinator-ae-id') } : {}), ...(prefix ? { workers: Object.fromEntries(workers.map((id) => [id, `${prefix}${id}`])) } : {}) };
const ids = provisionIdentities({ taskId, participantIds: workers, runTag: arg('run-tag') ?? undefined, aeIds });
const tls = { caFile: null, clientCertFile: null, clientKeyFile: null, servername: null, connectHost: null };
await mkdir(out, { recursive: true });
const secret = (name, value) => writeFile(join(out, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
await secret('operator.private.json', { role: 'operator', note: 'Enrollment signing key. Keep offline; not needed at runtime.', ...ids.operator });
await secret('coordinator.credentials.json', ids.coordinator);
await secret('coordinator.config.json', { cseUrl, cseBase: '/Mobius', ...tls, credentialsPath: './coordinator.credentials.json', flAeName, allowPlainHttp, pollMs: 250, task: { ...DEFAULT_TASK, taskId }, notify: null });
for (const worker of ids.workers) {
  await secret(`${worker.participantId}.credentials.json`, worker);
  await secret(`${worker.participantId}.config.json`, { cseUrl, cseBase: '/Mobius', ...tls, credentialsPath: `./${worker.participantId}.credentials.json`, workerId: worker.participantId, taskId, flAeName: null, allowPlainHttp, pollMs: 250, heartbeatMs: 1000, trainDelayMs: 0, zone: 'site', dataset: { source: 'jsonl', path: `./${worker.participantId}.local.jsonl`, datasetId: `${worker.participantId}-local` } });
}
console.log(JSON.stringify({ out, taskId, flAeName, coordinatorAeId: ids.coordinator.aeId, workers: ids.workers.map((w) => ({ participantId: w.participantId, aeId: w.aeId })) }, null, 2));
