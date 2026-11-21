import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { createIntegrationServer } from '../integration/src/api-server.mjs';
import { loadExternalConfig, requireExternal, ExternalRunError } from './external-config.mjs';
import { runExternalMec, runExternalEdge } from './external-scenarios.mjs';
import { runExternalFl } from './external-fl.mjs';
import { createExternalEdgeCallback } from './external-edge-callback.mjs';

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
let loaded;
let runtime;
let server;
let output;
const report = { generatedAt: new Date().toISOString(), status: 'FAIL', scenario: arg('scenario'), externalAcceptance: false };
try {
  requireExternal(['mec', 'edge', 'fl'].includes(arg('scenario')), 'SCENARIO_REQUIRED');
  requireExternal(Boolean(arg('config')), 'CONFIG_REQUIRED');
  loaded = await loadExternalConfig(resolve(arg('config')), arg('scenario'));
  const { config } = loaded;
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ status: 'CONFIG_READY', scenario: arg('scenario'), mode: config.mode, networkRequests: 0 }));
  } else {
    requireExternal(!process.env.BUBBLE_DATABASE_URL, 'USE_EXPLICIT_DATABASE_CONFIG');
    output = resolve(arg('output') ?? `.local/external-runs/${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(output, { recursive: true, mode: 0o700 });
    runtime = await createIntegrationRuntime({
      statePath: join(output, 'state.json'), receiptPath: join(output, 'receipts.jsonl'), database: config.database ?? null,
      core: { ...config.core, mec: { ...config.core.mec, autoReconcile: false }, retention: { autoPrune: false } },
    });
    if (config.server) {
      server = arg('scenario') === 'edge' ? createExternalEdgeCallback(runtime, config) : createIntegrationServer({ api: runtime.api, tls: config.server.tls, principals: [
        ...(config.server.principals ?? []),
        ...(config.scenario.workers ?? []).flatMap((worker) => worker.participants.map((participant) => ({ ...participant.principal, scopes: ['fl:write'] }))),
      ] });
      server.listen(config.server.port, config.server.host); await once(server, 'listening');
    }
    switch (arg('scenario')) {
      case 'mec': report.result = await runExternalMec(runtime, config.scenario); break;
      case 'edge': report.result = await runExternalEdge(runtime, config.scenario); break;
      case 'fl': report.result = await runExternalFl(runtime, config.scenario, output); break;
      default: throw new ExternalRunError('SCENARIO_REQUIRED');
    }
    report.status = 'PASS';
    report.mode = config.mode;
    report.configHash = createHash('sha256').update(await readFile(resolve(arg('config')))).digest('hex');
    console.log(JSON.stringify({ status: report.status, scenario: report.scenario, mode: config.mode, report: join(output, 'report.json') }));
  }
} catch (error) {
  // CLI boundary: record a stable code, never provider bodies, URLs, credentials or raw config.
  report.error = error instanceof ExternalRunError ? error.code
    : /^[A-Z][A-Z0-9_]{2,120}$/.test(error?.code ?? error?.message) ? error.code ?? error.message : 'EXECUTION_FAILED';
  console.error(JSON.stringify({ status: 'FAIL', error: report.error }));
  process.exitCode = 1;
} finally {
  if (server?.listening) { server.closeAllConnections(); await new Promise((close) => server.close(close)); }
  if (runtime) await runtime.close();
  for (const transport of loaded?.transports ?? []) transport.close();
  if (output) await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
