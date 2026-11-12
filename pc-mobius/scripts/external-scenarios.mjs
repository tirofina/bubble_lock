import { randomUUID } from 'node:crypto';
import { requireExternal, ExternalRunError } from './external-config.mjs';

async function grantFor(runtime, scopes) {
  const principal = { principalId: 'external-rehearsal', scopes: ['consent:write', 'grant:write', 'grant:revoke', 'policy:approve'] };
  const consent = await runtime.policyService.createConsent({ principal, subjectId: 'external-rehearsal', purpose: 'external execution', scopes, ttlSec: 3600 });
  const grant = await runtime.policyService.createGrant({ principal, consentId: consent.consentId, scopes, ttlSec: 3600 });
  return { principal, grant };
}

export async function runExternalMec(runtime, plan) {
  const { principal, grant } = await grantFor(runtime, ['mec:location', 'mec:rnis']);
  const policy = await runtime.policyService.approvePolicy({ principal, idempotencyKey: randomUUID(),
    policy: { grantId: grant.grantId, ueId: plan.ueId, geofence: plan.geofence } });
  const services = [];
  const cleanup = [];
  try {
    for (const service of ['Location', 'RNIS']) {
      let timer;
      let unsubscribe;
      const callback = new Promise((accept, reject) => {
        unsubscribe = runtime.mecIngress.onEvent((event) => {
          if (event.service === service && event.ueId === plan.ueId && event.intent?.policyId === policy.policyId) accept({ eventKey: event.eventKey, simulation: event.simulation });
          return {};
        });
        timer = setTimeout(() => reject(new ExternalRunError('MEC_CALLBACK_TIMEOUT')), plan.callbackTimeoutMs);
      });
      try {
        const [result, observed] = await Promise.all([(async () => {
          const adapter = runtime.mecSubscriptions.adapters[service];
          if (adapter.platformRoot) await runtime.mecSubscriptions.discover(service);
          const query = await runtime.mecIngress.query(service, { ueId: plan.ueId });
          requireExternal(query.response !== undefined, 'MEC_QUERY_FAILED');
          const subscription = await runtime.mecSubscriptions.create({ policyId: policy.policyId, service, idempotencyKey: randomUUID() });
          cleanup.push(subscription.key);
          requireExternal(subscription.state === 'ACTIVE', 'MEC_SUBSCRIPTION_PENDING');
          const read = await runtime.mecSubscriptions.read(subscription.key);
          requireExternal(read.status === 200, 'MEC_READ_FAILED');
          if (adapter.capabilities.update) requireExternal((await runtime.mecSubscriptions.update(subscription.key)).providerStatus === 200, 'MEC_UPDATE_FAILED');
          return { service, state: subscription.state, schemaHash: adapter.capabilities.schemaHash ?? null };
        })(), callback]);
        services.push({ ...result, callback: observed });
      } finally { clearTimeout(timer); unsubscribe(); }
    }
  } finally {
    for (const key of cleanup) {
      const cancelled = await runtime.mecSubscriptions.cancel(key);
      services.push({ operation: 'DELETE', state: cancelled.state });
    }
    await runtime.policyService.revokeGrant({ principal, grantId: grant.grantId });
  }
  requireExternal(services.filter((entry) => entry.operation === 'DELETE').every((entry) => entry.state === 'PROVIDER_DELETED'), 'MEC_CLEANUP_PENDING');
  return { services, localFaultSuite: 'M01-M09: run-external-rehearsal.mjs', liveFaultAcceptance: 'PENDING_PROVIDER_FAULT_CONTROL' };
}

export async function runExternalEdge(runtime, plan) {
  const { principal, grant } = await grantFor(runtime, ['mec:location']);
  const coordinator = runtime.handoverCoordinator;
  const edges = [...coordinator.edges.keys()];
  const transitions = [];
  const deployments = [];
  let active;
  try {
    for (const [edgeId, deployer] of coordinator.deployers) {
      const inventory = await deployer.inventory();
      deployments.push({ edgeId, hostId: inventory.hostId, protocol: inventory.protocol });
    }
    active = await coordinator.handover({ ueId: plan.ueId, targetEdgeId: edges[0], grantId: grant.grantId });
    requireExternal(active.state === 'ACTIVE', 'EDGE_BOOTSTRAP_FAILED');
    await runtime.store.transaction('external-observations', async () => {
      for (let sequence = 0; sequence < 1000; sequence++) await coordinator.acceptObservation({
        ueId: plan.ueId, sequence, payload: { sequence, source: 'external-runner-synthetic', simulation: true },
      });
    });
    for (let index = 0; index < 30; index++) {
      active = await coordinator.handover({ ueId: plan.ueId, targetEdgeId: edges[index % 2 ? 0 : 1], grantId: grant.grantId });
      requireExternal(active.state === 'ACTIVE' && active.replay.acceptedCount === 1000, 'EDGE_TRANSITION_FAILED');
      transitions.push({ edgeId: active.edgeId, epoch: active.epoch, durationMs: active.durationMs,
        watermark: active.replay.watermark, deployment: active.deployment });
    }
    const readbacks = [];
    for (const edgeId of edges) {
      const binding = runtime.store.get('logicalBindings', `${plan.ueId}:${edgeId}`);
      const client = coordinator.clients.get(edgeId);
      const identities = new Set();
      for (let sequence = 0; sequence < 1000; sequence++) {
        const payload = await client.read(`${binding.resources.observations.path}/obs-${sequence}`);
        const cin = payload['m2m:cin'];
        requireExternal(Boolean(cin?.ri), 'EDGE_OBSERVATION_READBACK');
        identities.add(cin.ri);
      }
      requireExternal(identities.size === 1000, 'EDGE_OBSERVATION_DUPLICATE');
      readbacks.push({ edgeId, distinctObservations: identities.size });
    }
    const rollback = await coordinator.rollback(plan.ueId);
    requireExternal(rollback.state === 'ROLLED_BACK', 'EDGE_ROLLBACK_FAILED');
    const durations = transitions.map((entry) => entry.durationMs).sort((a, b) => a - b);
    return { simulation: true, observationSource: 'synthetic', deployments, transitions, readbacks, p95Ms: durations[28],
      rollback: { state: rollback.state, edgeId: rollback.edgeId, epoch: rollback.epoch }, partitionAcceptance: 'LOCAL_MOCK_ONLY' };
  } finally {
    await runtime.policyService.revokeGrant({ principal, grantId: grant.grantId });
    // Release only the leases created for this run's UE.
    if (active) for (const deployer of coordinator.deployers.values()) await deployer.release({ ueId: plan.ueId, epoch: coordinator.status(plan.ueId).epoch });
  }
}
