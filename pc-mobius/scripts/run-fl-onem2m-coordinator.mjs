// FL coordinator process for the oneM2M coordination plane.
// Usage: node pc-mobius/scripts/run-fl-onem2m-coordinator.mjs --config=<coordinator.config.json>
// Config: { cseUrl, cseBase, credentialsPath, flAeName, task: {...}, notify: { listenHost, listenPort, publicUrl } | null,
//           pollMs, inboxPollMs, allowPlainHttp, timeoutMs,
//           caFile, clientCertFile, clientKeyFile, servername, connectHost }. Relative paths resolve against the config file directory.
// TLS keys: see flCseTransport in fl-onem2m-plane.mjs (mTLS to an originator-binding front end; cseUrl may carry /onem2m).
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { once } from 'node:events';
import { flCseClientFromConfig } from '../integration/src/fl-onem2m-plane.mjs';
import { FlOneM2mCoordinator, createNotificationServer } from '../integration/src/fl-onem2m-coordinator.mjs';

const configArg = process.argv.find((value) => value.startsWith('--config='))?.slice(9);
if (!configArg) { console.error('--config=<coordinator.config.json> is required'); process.exit(2); }
const configPath = resolve(configArg); const base = dirname(configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const credentials = JSON.parse(await readFile(resolve(base, config.credentialsPath), 'utf8'));
if (credentials.role !== 'coordinator') throw new Error('coordinator credentials required');
const emit = (event) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), role: 'coordinator', pid: process.pid, ...event })}\n`);
const client = flCseClientFromConfig(config, { baseDir: base, originator: credentials.aeId });
let server = null; let notifyUrl = null;
const coordinator = new FlOneM2mCoordinator({ client, identity: credentials, operatorPublicKeyPem: credentials.operatorPublicKeyPem, flAeName: config.flAeName, task: { ...config.task, taskId: config.task?.taskId ?? credentials.taskId }, log: emit, inboxPollMs: config.inboxPollMs ?? 1000 });
if (config.notify) {
  server = createNotificationServer({ coordinator, aePathPrefix: coordinator.aePath });
  server.listen(config.notify.listenPort ?? 0, config.notify.listenHost ?? '127.0.0.1'); await once(server, 'listening');
  notifyUrl = config.notify.publicUrl ?? `http://${config.notify.listenHost ?? '127.0.0.1'}:${server.address().port}/fl-coordinator`;
  coordinator.notifyUrl = notifyUrl;
}
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
try {
  await coordinator.bootstrap();
  emit({ event: 'NOTIFY_ENDPOINT', notifyUrl, transport: client.transport });
  const summary = await coordinator.run({ pollMs: config.pollMs ?? 250, signal: controller.signal });
  emit({ event: 'COORDINATOR_EXIT', summary, cseRequests: client.stats });
} catch (error) {
  emit({ event: 'COORDINATOR_FAILED', reason: error.code ?? error.message, details: error.details ?? null });
  process.exitCode = 1;
} finally { server?.closeAllConnections(); server?.close(); }
