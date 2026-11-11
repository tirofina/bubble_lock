import { generateKeyPairSync } from 'node:crypto';
import { approvalHash } from './integration-utils.mjs';
import { signFlUpdate } from './fl-coordinator.mjs';
import { syntheticDataset, modelBytes, decodeModel, trainModel, evaluateModel, TRAINING, digest } from './fl-numerics.mjs';

/** 로컬 합성 client. 원본 행은 client에서 생성·학습하고 coordinator에는 모델/학습 receipt를 전송한다. */
export async function enrollLocalClient(coordinator, { participantId, taskId, seed = 101, clientIndex = 0, vmId = participantId, datasetId = `${taskId}-${participantId}`, labels = ['privacy'], taskVersion = 1 } = {}) {
  if (coordinator.mode !== 'LOCAL_SIMULATION') throw new Error('FL_LOCAL_CLIENT_MODE');
  const principal = { principalId: `fl:${participantId}`, originator: `CFL-${participantId}`, scopes: ['fl:write'] };
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const dataset = syntheticDataset({ seed, clientIndex, datasetId });
  coordinator.registerVm({ vmId, labels, mode: 'LOCAL_SIMULATION', attested: true });
  await coordinator.registerParticipant({ participantId, taskId, taskVersion, vmId, principal, publicKeyPem, dataset: dataset.metadata });
  await coordinator.setParticipantConsent({ participantId, taskId, principal });
  return { participantId, taskId, vmId, principal, privateKey: keys.privateKey, publicKeyPem, dataset };
}

export function buildLocalUpdate(coordinator, client, round, { sampleCount = 360, model = null } = {}) {
  const base = decodeModel(coordinator.readArtifact(round.baseModelRef, round.baseModelHash));
  const rows = client.dataset.train.slice(0, sampleCount);
  const trained = model ?? trainModel(base, rows, TRAINING);
  const bytes = modelBytes(trained); const artifactDigest = digest(bytes);
  const sampleIds = rows.map((row) => row.id);
  const localTrainReceipt = { datasetVersion: client.dataset.metadata.datasetVersion, splitHash: client.dataset.metadata.splitHash, sampleCount: rows.length, sampleIds, sampleIdsDigest: approvalHash(sampleIds), seed: client.dataset.metadata.seed, training: TRAINING };
  const participant = coordinator.getParticipant(round.taskId, client.participantId);
  const update = { participantId: client.participantId, datasetId: client.dataset.metadata.datasetId, taskId: round.taskId, taskVersion: round.taskVersion, roundId: round.roundId, coordinatorEpoch: round.coordinatorEpoch, baseModelVersion: round.baseModelVersion, baseModelHash: round.baseModelHash, featureSchemaVersion: round.featureSchemaVersion, consentRevision: participant.consent.revision, sampleCount: rows.length, localTrainReceiptHash: approvalHash(localTrainReceipt), artifactDigest, artifactRef: `updates/${round.taskId}/${round.roundId}/${client.participantId}/${artifactDigest}`, localTrainReceipt, artifactBytes: bytes.toString('base64'), metrics: evaluateModel(trained, client.dataset.validation), principal: client.principal };
  update.signature = signFlUpdate(update, client.privateKey); return update;
}

/** ESTIMED 배포 worker의 실제 HTTPS transport. 응답은 coordinator에서 신원·서명·모델로 재검증한다. */
export class EstimedVmAdapter {
  constructor({ endpoint, token, fetchImpl = globalThis.fetch, timeoutMs = 30000, hostId, processId, imageDigest, runtimeMode = 'ESTIMED' } = {}) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || !hostId || !processId || !imageDigest) throw new Error('FL_VM_ATTESTATION');
    this.endpoint = endpoint.replace(/\/$/, ''); this.token = token; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.identity = { hostId, processId, imageDigest }; this.runtimeMode = runtimeMode;
  }
  async request(path, body = null) {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    if (!response.ok) throw new Error(`FL_VM_HTTP_${response.status}`);
    if (Number(response.headers?.get?.('content-length') ?? 0) > 65536) throw new Error('FL_VM_RESPONSE_SIZE');
    const text = await response.text(); if (Buffer.byteLength(text) > 65536) throw new Error('FL_VM_RESPONSE_SIZE'); return JSON.parse(text);
  }
  async probe() { const result = await this.request('/v1/fl/health'); if (result.hostId !== this.identity.hostId || result.processId !== this.identity.processId || result.imageDigest !== this.identity.imageDigest || result.status !== 'HEALTHY' || result.runtimeMode !== this.runtimeMode) throw new Error('FL_VM_IDENTITY'); return { ...result, endpoint: this.endpoint }; }
  async train({ round, participantId, baseModelBytes }) {
    await this.probe();
    return this.request('/v1/fl/train', { ...round, participantId, baseModelBytes, training: TRAINING, rawDataPolicy: 'participant-local', runtimeMode: this.runtimeMode });
  }
}
