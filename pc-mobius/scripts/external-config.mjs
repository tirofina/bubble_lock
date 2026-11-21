import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadMecDeploymentSchema } from '../integration/src/mec-deployment-schema.mjs';
import { createMtlsFetch } from '../integration/src/fl-worker.mjs';

export class ExternalRunError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function requireExternal(condition, code) {
  if (!condition) throw new ExternalRunError(code);
}

function environment(value) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name) => {
    requireExternal(Boolean(process.env[name]), 'ENV_REQUIRED');
    return process.env[name];
  });
  if (Array.isArray(value)) return value.map(environment);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, environment(entry)]));
  return value;
}

function endpoint(value, external) {
  const url = new URL(value);
  requireExternal(!url.username && !url.password && !url.search && !url.hash
    && (external ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol)), 'HTTPS_ENDPOINT_REQUIRED');
  return url;
}

/** Check never starts a runtime, opens a socket, or contacts discovery. */
export async function loadExternalConfig(path, scenario) {
  const base = dirname(resolve(path));
  const config = environment(JSON.parse(await readFile(path, 'utf8')));
  requireExternal(['EXTERNAL', 'LOCAL_SIMULATION'].includes(config.mode), 'MODE_REQUIRED');
  requireExternal(config.core && config.scenario, 'SCENARIO_CONFIG_REQUIRED');
  const external = config.mode === 'EXTERNAL';
  const plan = config.scenario;
  switch (scenario) {
    case 'mec':
      requireExternal(typeof plan.ueId === 'string' && plan.geofence && Number.isSafeInteger(plan.callbackTimeoutMs)
        && plan.callbackTimeoutMs > 0 && plan.callbackTimeoutMs <= 600000, 'MEC_SCENARIO_REQUIRED');
      endpoint(config.core.mec.callbackBaseUrl, external);
      for (const service of ['Location', 'RNIS']) {
        const adapter = config.core.mec[service];
        requireExternal(adapter, 'MEC_SERVICE_REQUIRED');
        endpoint(adapter.endpoint ?? adapter.platformRoot, external);
        if (external) requireExternal(adapter.simulation === false && adapter.providerId && adapter.providerFingerprint
          && adapter.deploymentSchema && adapter.tls && config.server?.tls, 'MEC_DEPLOYMENT_REQUIRED');
      }
      break;
    case 'edge': {
      const edges = config.core.handover?.edges;
      requireExternal(Array.isArray(edges) && edges.length === 2 && new Set(edges.map((edge) => edge.edgeId)).size === 2, 'EDGE_PAIR_REQUIRED');
      const hosts = edges.map((edge) => endpoint(edge.endpoint, external).hostname);
      requireExternal(typeof plan.ueId === 'string' && config.core.handover.manifests?.some((entry) => entry.ueId === plan.ueId), 'EDGE_MANIFEST_REQUIRED');
      if (external) {
        requireExternal(new Set(hosts).size === 2 && new Set(edges.map((edge) => edge.deployment?.hostId)).size === 2, 'EDGE_INDEPENDENT_HOSTS_REQUIRED');
        for (const edge of edges) {
          requireExternal(edge.simulation === false && edge.tls && edge.deployment?.tls
            && edge.deployment.hostId && edge.deployment.imageDigest && edge.callbackUrl
            && edge.notificationFingerprint && config.server?.tls, 'EDGE_DEPLOYMENT_REQUIRED');
          endpoint(edge.deployment.endpoint, true);
          endpoint(edge.callbackUrl, true);
        }
      }
      break;
    }
    case 'fl': {
      const workers = plan.workers;
      requireExternal(Array.isArray(workers) && workers.length >= 3 && new Set(workers.map((worker) => worker.hostId)).size >= 3, 'FL_THREE_HOSTS_REQUIRED');
      requireExternal(config.core.fl?.mode === 'ESTIMED' && config.core.fl.publication && config.server?.tls, 'FL_DEPLOYMENT_REQUIRED');
      requireExternal(typeof plan.taskPrefix === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(plan.taskPrefix), 'FL_TASK_PREFIX_REQUIRED');
      endpoint(config.core.fl.publication.endpoint, external);
      for (const worker of workers) {
        endpoint(worker.endpoint, true);
        requireExternal(worker.vmId && worker.processId && worker.imageDigest && worker.tls && worker.participants?.length, 'FL_WORKER_REQUIRED');
        for (const participant of worker.participants) {
          requireExternal(participant.participantId && participant.principal?.principalId && participant.principal?.originator
            && participant.principal?.mtlsFingerprint && participant.publicKeyFile && participant.dataset, 'FL_PARTICIPANT_REQUIRED');
          participant.publicKeyPem = await readFile(resolve(base, participant.publicKeyFile), 'utf8');
        }
      }
      const participants = workers.flatMap((worker) => worker.participants);
      requireExternal(new Set(participants.map((entry) => entry.participantId)).size === participants.length
        && participants.filter((entry) => !entry.lateJoin).length >= 3 && participants.some((entry) => entry.lateJoin)
        && workers.some((worker) => worker.vmId === plan.dropoutVmId)
        && workers.filter((worker) => worker.vmId !== plan.dropoutVmId).flatMap((worker) => worker.participants).length >= 3, 'FL_RESILIENCE_PARTICIPANTS_REQUIRED');
      break;
    }
    default: throw new ExternalRunError('SCENARIO_REQUIRED');
  }
  const transports = [];
  try {
    for (const service of ['Location', 'RNIS']) {
      const options = config.core.mec?.[service];
      if (options?.deploymentSchema) config.core.mec[service] = await loadMecDeploymentSchema(options, base);
    }
    const targets = [config.server, config.core.mec?.Location, config.core.mec?.RNIS, config.core.fl?.publication,
      ...(config.core.handover?.edges ?? []).flatMap((edge) => [edge, edge.deployment]), ...(plan.workers ?? [])];
    for (const target of targets) if (target?.tls) {
      const tls = Object.fromEntries(await Promise.all(['ca', 'cert', 'key'].map(async (name) => [name, await readFile(resolve(base, target.tls[name]))])));
      if (target === config.server) target.tls = tls;
      else { target.fetchImpl = createMtlsFetch(tls); transports.push(target.fetchImpl); }
    }
    return { config, transports };
  } catch (error) {
    for (const transport of transports) transport.close();
    throw error;
  }
}
