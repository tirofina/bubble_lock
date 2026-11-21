import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadExternalConfig, requireExternal } from './external-config.mjs';

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
let loaded;
try {
  requireExternal(arg('config') && arg('output'), 'CONFIG_AND_OUTPUT_REQUIRED');
  loaded = await loadExternalConfig(arg('config'), 'fl');
  const { scenario } = loaded.config;
  const setup = scenario.workerSetup;
  requireExternal(setup?.coordinatorEndpoint && setup.coordinatorFingerprint && setup.pkiRoot && setup.keyRoot && setup.stateRoot, 'FL_WORKER_SETUP_REQUIRED');
  const output = resolve(arg('output')); await mkdir(output, { recursive: true, mode: 0o700 });
  const taskIds = [101, 202, 303].map((seed) => `${scenario.taskPrefix}-${seed}`);
  for (const worker of scenario.workers) {
    const url = new URL(worker.endpoint);
    const config = {
      host: '0.0.0.0', publicHost: url.hostname, port: Number(url.port || 443), hostId: worker.hostId, runtimeMode: 'ESTIMED',
      statePath: `${setup.stateRoot}/${worker.vmId}.json`,
      tls: { ca: `${setup.pkiRoot}/ca.pem`, cert: `${setup.pkiRoot}/${worker.vmId}-server.pem`, key: `${setup.pkiRoot}/${worker.vmId}-server.key` },
      coordinatorEndpoint: setup.coordinatorEndpoint,
      coordinators: [{ fingerprint: setup.coordinatorFingerprint, taskIds, participantIds: worker.participants.map((entry) => entry.participantId) }],
      participants: worker.participants.flatMap((participant) => taskIds.map((taskId) => ({
        taskId, participantId: participant.participantId, taskVersion: 1, privateKeyFile: `${setup.keyRoot}/${participant.participantId}.pem`,
        upstreamTls: { ca: `${setup.pkiRoot}/central-ca.pem`, cert: `${setup.pkiRoot}/${participant.participantId}.pem`, key: `${setup.pkiRoot}/${participant.participantId}.key` },
        dataset: { ...participant.dataset, datasetVersion: participant.dataset.version ?? 1 },
      }))),
    };
    await writeFile(join(output, `${worker.vmId}.json`), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({ status: 'WORKER_CONFIGS_READY', count: scenario.workers.length, networkRequests: 0 }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', error: /^[A-Z][A-Z0-9_]+$/.test(error?.code) ? error.code : 'WORKER_CONFIG_FAILED' }));
  process.exitCode = 1;
} finally { for (const transport of loaded?.transports ?? []) transport.close(); }
