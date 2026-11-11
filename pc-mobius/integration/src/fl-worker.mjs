import { createServer, request as httpsRequest, Agent } from 'node:https';
import { createPrivateKey } from 'node:crypto';
import { approvalHash } from './integration-utils.mjs';
import { decodeModel, digest, syntheticDataset, TRAINING, FEATURE_VERSION } from './fl-numerics.mjs';
import { buildLocalUpdate } from './fl-client.mjs';

export function createMtlsFetch({ ca, cert, key, maxBytes = 1048576, timeoutMs = 10000 }) {
  const agent = new Agent({ ca, cert, key, minVersion: 'TLSv1.3', rejectUnauthorized: true, keepAlive: true });
  const fetchImpl = (url, options = {}) => new Promise((resolve, reject) => {
    const endpoint = new URL(url); if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return reject(new Error('FL_HTTPS_REQUIRED'));
    const request = httpsRequest(endpoint, { method: options.method ?? 'GET', headers: options.headers, agent, signal: options.signal }, (response) => {
      const chunks = []; let length = 0;
      response.on('data', (chunk) => { length += chunk.length; if (length > maxBytes) { response.destroy(new Error('FL_RESPONSE_SIZE')); return; } chunks.push(chunk); });
      response.on('error', reject); response.on('end', () => {
        try {
          const body = options.method === 'HEAD' || [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status: response.statusCode, headers: Object.entries(response.headers).flatMap(([k, v]) => v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v]]) }));
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('FL_HTTPS_TIMEOUT'))); request.on('error', reject); if (options.body) request.write(options.body); request.end();
  });
  fetchImpl.close = () => agent.destroy(); return fetchImpl;
}

export class FlTrainingWorker {
  constructor({ store, participants, authorizeTraining, identity, runtimeMode = 'ESTIMED' }) {
    if (!store || !Array.isArray(participants) || !participants.length || typeof authorizeTraining !== 'function' || !identity?.hostId || !identity.processId || !identity.imageDigest) throw new Error('FL_WORKER_CONFIGURATION');
    if (!['ESTIMED', 'LOCAL_SIMULATION'].includes(runtimeMode)) throw new Error('FL_RUNTIME_MODE');
    this.store = store; this.authorizeTraining = authorizeTraining; this.identity = identity; this.runtimeMode = runtimeMode;
    this.clients = participants.map((p) => ({ ...p, privateKey: createPrivateKey(p.privateKeyPem), dataset: syntheticDataset({ seed: p.dataset.seed, clientIndex: p.dataset.clientIndex, datasetId: p.dataset.datasetId, version: p.dataset.datasetVersion }) }));
  }
  health() { return { ...this.identity, status: 'HEALTHY', runtimeMode: this.runtimeMode, protocol: 'privacy-bubble.fl-numeric.v1', participantIds: this.clients.map((c) => c.participantId) }; }
  async train(body, coordinator) {
    const client = this.clients.find((p) => p.participantId === body?.participantId && p.taskId === body?.taskId);
    if (!client || !coordinator?.taskIds?.includes(body.taskId) || !coordinator.participantIds?.includes(body.participantId)) throw new Error('FL_WORKER_IDENTITY_SCOPE');
    if (body.taskVersion !== (client.taskVersion ?? 1) || body.featureSchemaVersion !== FEATURE_VERSION || body.runtimeMode !== this.runtimeMode || approvalHash(body.training) !== approvalHash(TRAINING)) throw new Error('FL_WORKER_TRAINING_SCOPE');
    const member = body.participants?.find((p) => p.participantId === body.participantId);
    if (!member) throw new Error('FL_WORKER_MEMBERSHIP');
    const query = { taskId: body.taskId, participantId: client.participantId, roundId: body.roundId, principal: client.principal, coordinator };
    const consent = await this.authorizeTraining(query);
    if (!consent?.allowed || consent.consentRevision !== member.consentRevision || Date.parse(consent.expiresAt) <= Date.now()) throw new Error('FL_WORKER_CURRENT_CONSENT');
    const expectedContext = Object.fromEntries(['taskId', 'taskVersion', 'roundId', 'coordinatorEpoch', 'baseModelVersion', 'baseModelHash', 'featureSchemaVersion'].map((key) => [key, body[key]]));
    if (approvalHash(consent.trainingContext) !== approvalHash(expectedContext) || consent.datasetId !== client.dataset.metadata.datasetId) throw new Error('FL_WORKER_ROUND_FENCE');
    const bytes = Buffer.from(body.baseModelBytes ?? '', 'base64'); decodeModel(bytes);
    if (digest(bytes) !== body.baseModelHash || !Number.isSafeInteger(body.coordinatorEpoch) || body.coordinatorEpoch < 1 || !Number.isSafeInteger(body.baseModelVersion) || body.baseModelVersion < 0) throw new Error('FL_WORKER_BASE_MODEL');
    const operationKey = `${body.taskId}:${body.roundId}:${client.participantId}:${body.coordinatorEpoch}`;
    const intentHash = approvalHash({ ...expectedContext, operationKey, consentRevision: consent.consentRevision, training: body.training });
    return this.store.transaction(`worker:${operationKey}`, async () => {
      const prior = this.store.get('flWorkerUpdates', operationKey);
      if (prior) { if (prior.intentHash !== intentHash) throw new Error('FL_WORKER_IDEMPOTENCY'); return prior.update; }
      const facade = { readArtifact: () => bytes, getParticipant: () => ({ consent: { revision: consent.consentRevision } }) };
      const update = buildLocalUpdate(facade, client, body); delete update.principal;
      const current = await this.authorizeTraining(query);
      if (!current.allowed || current.consentRevision !== consent.consentRevision || approvalHash(current.trainingContext) !== approvalHash(expectedContext) || Date.parse(current.expiresAt) <= Date.now()) throw new Error('FL_WORKER_CURRENT_CONSENT');
      await this.store.put('flWorkerUpdates', operationKey, { intentHash, update, createdAt: new Date().toISOString() });
      await this.store.append('receipts', { eventId: `worker-${approvalHash(operationKey)}`, type: 'FL_WORKER_TRAINED', timestamp: new Date().toISOString(), taskId: body.taskId, roundId: body.roundId, participantId: client.participantId, artifactDigest: update.artifactDigest, runtimeMode: this.runtimeMode }); return update;
    });
  }
}

export function createFlWorkerServer({ worker, tls, coordinators, maxBodyBytes = 65536 }) {
  if (!tls?.key || !tls.cert || !tls.ca || !Array.isArray(coordinators) || !coordinators.length) throw new Error('FL_WORKER_MTLS_REQUIRED');
  return createServer({ ...tls, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true }, async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      const certificate = request.socket.getPeerCertificate(); const coordinator = coordinators.find((p) => p.fingerprint === certificate.fingerprint256);
      if (!request.socket.authorized || !coordinator) return send(403, { error: 'FL_COORDINATOR_IDENTITY' });
      const path = new URL(request.url, 'https://localhost').pathname;
      if (request.method === 'GET' && path === '/v1/fl/health') return send(200, worker.health());
      if (request.method !== 'POST' || path !== '/v1/fl/train') return send(404, { error: 'FL_WORKER_ROUTE' });
      if (!String(request.headers['content-type']).startsWith('application/json')) return send(415, { error: 'FL_WORKER_CONTENT_TYPE' });
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > maxBodyBytes) return send(413, { error: 'FL_WORKER_BODY_SIZE' }); chunks.push(chunk); }
      const result = await worker.train(JSON.parse(Buffer.concat(chunks).toString('utf8')), coordinator); return send(200, result);
    } catch (error) { return send(403, { error: error.code ?? error.message }); }
  });
}
