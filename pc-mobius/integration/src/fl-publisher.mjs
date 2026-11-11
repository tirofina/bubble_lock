import { OneM2mEdgeClient } from './handover-cse.mjs';
import { approvalHash } from './integration-utils.mjs';
import { digest, decodeModel, MODEL_FORMAT } from './fl-numerics.mjs';

export class FlOneM2mPublisher {
  constructor({ endpoint, originator, cseBase = '/Mobius', aeName = 'privacy-bubble-fl', fetchImpl = globalThis.fetch, headers = {}, timeoutMs = 5000, trace = null } = {}) {
    this.client = new OneM2mEdgeClient({ endpoint, cseBase, originator, fetchImpl, headers, timeoutMs }); this.aeName = aeName; this.trace = trace;
  }
  async ensure(parent, ty, body, options) { const result = await this.client.ensure(parent, ty, body, options); this.trace?.({ operation: 'ENSURE_READBACK', path: result.path, ri: result.ri, duplicate: result.duplicate, payloadHash: approvalHash(result.body) }); return result; }
  async container(parent, rn) { return this.ensure(parent, 3, { 'm2m:cnt': { rn } }, { update: false }); }
  async publish(input) {
    const { taskId, roundId, modelVersion, servingGeneration, modelHash, manifestHash, manifest, artifactBytes } = input;
    if (!Number.isSafeInteger(modelVersion) || modelVersion < 1 || !Number.isSafeInteger(servingGeneration) || servingGeneration < 1 || manifest.taskId !== taskId || manifest.roundId !== roundId || manifest.modelVersion !== modelVersion || manifest.modelHash !== modelHash || approvalHash(manifest) !== manifestHash) throw new Error('FL_PUBLICATION_MANIFEST');
    const bytes = Buffer.from(artifactBytes ?? '', 'base64'); decodeModel(bytes); if (digest(bytes) !== modelHash) throw new Error('FL_PUBLICATION_ARTIFACT');
    const provenanceExpiry = new Date(Date.now() + 30 * 86400000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
    const owner = `pb-owner:${approvalHash(this.aeName).slice(0, 24)}`;
    const ae = await this.ensure(this.client.cseBase, 2, { 'm2m:ae': { rn: this.aeName, api: 'N.privacy.bubble.fl', rr: true, lbl: [owner] } }, { update: false });
    const acp = await this.ensure(ae.path, 1, { 'm2m:acp': { rn: 'fl-model-acp', lbl: [owner], pv: { acr: [{ acor: [this.client.originator], acop: 63 }] }, pvs: { acr: [{ acor: [this.client.originator], acop: 63 }] } } });
    await this.client.request('PUT', ae.path, { 'm2m:ae': { acpi: [acp.path] } });
    const participants = await this.container(ae.path, 'participants'); const datasets = await this.container(ae.path, 'datasets'); const tasks = await this.container(ae.path, 'tasks');
    const task = await this.container(tasks.path, `task-${approvalHash(taskId).slice(0, 24)}`);
    const rounds = await this.container(task.path, 'rounds'); const results = await this.container(task.path, 'results'); const current = await this.container(task.path, 'currentModel');
    const metadata = await this.container(task.path, 'metadata'); const status = await this.container(task.path, 'status');
    await this.ensure(metadata.path, 4, { 'm2m:cin': { rn: `task-v-${manifest.taskVersion}`, con: { schema: 'urn:privacy-bubble:fl:task:1', taskId, taskVersion: manifest.taskVersion, featureSchemaVersion: manifest.featureSchemaVersion, training: manifest.training, aggregation: manifest.aggregation, modelFormat: MODEL_FORMAT, entityPolicy: { owner: this.client.originator, readWrite: 'coordinator-ACP', provenanceRetentionSeconds: 2592000, modelUse: 'central-current-consent-fence' } } } }, { immutable: true });
    const roundNode = await this.container(rounds.path, `round-${manifest.roundNumber}`); const updates = await this.container(roundNode.path, 'updates');
    const latest = await this.client.request('GET', `${current.path}/la`);
    if (!latest.missing && Number(latest.payload?.['m2m:cin']?.con?.servingGeneration) > servingGeneration) throw new Error('FL_PUBLICATION_SUPERSEDED');
    for (const accepted of manifest.acceptedSet) {
      const participant = await this.container(participants.path, `p-${approvalHash(accepted.participantId).slice(0, 24)}`);
      const dataset = await this.container(datasets.path, `d-${approvalHash(accepted.datasetId).slice(0, 24)}`);
      await this.ensure(participant.path, 4, { 'm2m:cin': { rn: `r-${approvalHash(roundId).slice(0, 24)}`, et: provenanceExpiry, con: { schema: 'urn:privacy-bubble:fl:participant:1', taskId, roundId, participantId: accepted.participantId, consentRevision: accepted.consentRevision, updateHash: accepted.updateHash } } }, { immutable: true });
      await this.ensure(dataset.path, 4, { 'm2m:cin': { rn: `split-${accepted.splitHash.slice(0, 24)}`, et: provenanceExpiry, con: { schema: 'urn:privacy-bubble:fl:dataset:1', datasetId: accepted.datasetId, splitHash: accepted.splitHash, rawDataLocation: 'participant-local' } } }, { immutable: true });
      const update = await this.ensure(updates.path, 4, { 'm2m:cin': { rn: `p-${approvalHash(accepted.participantId).slice(0, 24)}`, et: provenanceExpiry, con: { schema: 'urn:privacy-bubble:fl:update:1', taskId, roundId, ...accepted, state: 'VERIFIED_UPDATE', provenanceRetentionSeconds: 2592000 } } }, { immutable: true });
      const readUpdate = (await this.client.read(update.path))?.['m2m:cin']?.con;
      if (readUpdate?.artifactDigest !== accepted.artifactDigest || readUpdate?.updateHash !== accepted.updateHash || readUpdate?.participantId !== accepted.participantId) throw new Error('FL_UPDATE_METADATA_READBACK');
    }
    await this.ensure(rounds.path, 4, { 'm2m:cin': { rn: `r-${manifest.roundNumber}`, con: { schema: 'urn:privacy-bubble:fl:round:1', taskId, roundId, modelVersion, modelHash, manifestHash, acceptedSet: manifest.acceptedSet } } }, { immutable: true });
    const model = await this.ensure(results.path, 4, { 'm2m:cin': { rn: `v-${modelVersion}`, con: { schema: 'urn:privacy-bubble:fl:model:1', taskId, modelVersion, modelHash, manifestHash, manifest, artifact: { ...MODEL_FORMAT, encoding: 'base64', data: artifactBytes } } } }, { immutable: true });
    await this.ensure(current.path, 4, { 'm2m:cin': { rn: `g-${servingGeneration}`, con: { schema: 'urn:privacy-bubble:fl:serving:1', taskId, servingGeneration, modelVersion, modelHash, manifestHash, modelUri: model.path, state: 'ACTIVE' } } }, { immutable: true });
    await this.ensure(status.path, 4, { 'm2m:cin': { rn: `g-${servingGeneration}`, con: { schema: 'urn:privacy-bubble:fl:status:1', taskId, roundId, state: 'COMPLETED', modelVersion, servingGeneration, acceptedParticipants: manifest.acceptedSet.length, modelHash, manifestHash } } }, { immutable: true });
    const readback = await this.client.read(model.path); const value = readback?.['m2m:cin']?.con;
    if (value?.modelHash !== modelHash || value?.manifestHash !== manifestHash || digest(Buffer.from(value?.artifact?.data ?? '', 'base64')) !== modelHash) throw new Error('FL_PUBLICATION_READBACK');
    this.trace?.({ operation: 'MODEL_READBACK', path: model.path, modelHash, manifestHash });
    return { modelHash, manifestHash, modelVersion, servingGeneration, resource: model.path, currentModel: current.path, taskMetadata: metadata.path, roundResource: roundNode.path, updateMetadataCount: manifest.acceptedSet.length, transport: 'oneM2M-HTTP', aeId: ae.aei };
  }
}
