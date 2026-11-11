import { sign, verify, createPublicKey } from 'node:crypto';
import { approvalHash, id, nowIso, recordEnvelope, stable, requireString } from './integration-utils.mjs';
import { FEATURE_VERSION, MODEL_FORMAT, TRAINING, digest, modelBytes, decodeModel, initialModel, fedAvg, syntheticDataset } from './fl-numerics.mjs';

const locks = new WeakMap();
const clone = (value) => structuredClone(value);
const fail = (reason) => { const error = new Error(reason); error.code = reason; throw error; };
const partKey = (taskId, participantId) => `${taskId}:${participantId}`;
const same = (a, b) => approvalHash(a) === approvalHash(b);
const hashPattern = /^[a-f0-9]{64}$/;
const scopedId = (value) => { if (!/^[A-Za-z0-9._-]{1,160}$/.test(value ?? '')) fail('FL_SCOPED_ID'); };
const updateFields = ['participantId', 'datasetId', 'taskId', 'taskVersion', 'roundId', 'coordinatorEpoch', 'baseModelVersion', 'baseModelHash', 'featureSchemaVersion', 'consentRevision', 'sampleCount', 'localTrainReceiptHash', 'artifactDigest', 'artifactRef'];
export const updateSigningBytes = (update) => Buffer.from(JSON.stringify(stable(Object.fromEntries(updateFields.map((key) => [key, update[key]])))));
export const signFlUpdate = (update, privateKey) => sign(null, updateSigningBytes(update), privateKey).toString('base64');

/** 동일 IntegrationStore의 task를 직렬화한다. 다중 호스트에는 공유 transaction store가 필요하다. */
export class FlCoordinator {
  constructor({ store, clock = () => new Date().toISOString(), mode = 'LOCAL_SIMULATION', publisher = null, faultHook = null } = {}) {
    if (!store) throw new Error('FlCoordinator requires IntegrationStore');
    if (!['LOCAL_SIMULATION', 'ESTIMED'].includes(mode)) throw new Error('FL_RUNTIME_MODE');
    this.store = store; this.clock = clock; this.mode = mode; this.publisher = publisher; this.faultHook = faultHook;
    this.vms = new Map(store.list('flVms').map((v) => [v.vmId, v])); this.epochs = new Map();
    if (!locks.has(store)) locks.set(store, new Map());
  }

  async locked(taskId, fn) {
    const queue = locks.get(this.store); const previous = queue.get(taskId) ?? Promise.resolve();
    const pending = previous.then(() => this.store.transaction(`fl:${taskId}`, fn)); queue.set(taskId, pending.catch(() => {})); return pending;
  }

  async receipt(type, data = {}) { return this.store.append('receipts', recordEnvelope({ type, runtimeMode: this.mode, ...data }, this.clock)); }
  round(roundId) { const value = this.store.get('flRounds', roundId); if (!value) fail('FL_ROUND_REQUIRED'); return clone(value); }
  task(taskId) { const value = this.store.get('flTasks', taskId); if (!value) fail('FL_TASK_REQUIRED'); return clone(value); }
  getParticipant(taskId, participantId) { return this.store.get('flParticipants', partKey(taskId, participantId)); }
  participantState({ taskId, participantId, roundId, principal }) {
    const participant = this.getParticipant(taskId, participantId); const task = this.task(taskId);
    if (!participant || participant.principalId !== principal?.principalId || participant.originator !== principal?.originator) fail('FL_IDENTITY_SCOPE');
    const round = roundId ? this.round(roundId) : null;
    const trainingContext = round ? { taskId: round.taskId, taskVersion: round.taskVersion, roundId, coordinatorEpoch: round.coordinatorEpoch, baseModelVersion: round.baseModelVersion, baseModelHash: round.baseModelHash, featureSchemaVersion: round.featureSchemaVersion } : null;
    const allowedRound = !round || round.taskId === taskId && round.state === 'RUNNING' && round.coordinatorEpoch === task.coordinatorEpoch && round.baseModelHash === task.modelHash && Date.parse(round.deadline) > Date.parse(nowIso(this.clock)) && round.participants.some((p) => p.participantId === participantId && p.consentRevision === participant.consent?.revision);
    return { taskId, participantId, allowed: this.validConsent(participant, task) && allowedRound, consentRevision: participant.consent?.revision, expiresAt: participant.consent?.expiresAt, status: participant.consent?.status, datasetId: participant.dataset.datasetId, taskVersion: task.taskVersion, trainingContext };
  }
  epoch(task) { if (this.epochs.get(task.taskId) !== task.coordinatorEpoch) fail('FL_COORDINATOR_EPOCH'); }
  async hook(point, value) { if (this.faultHook) await this.faultHook(point, clone(value)); }

  registerVm(vm) {
    requireString(vm?.vmId, 'vmId');
    const mode = vm.mode ?? this.mode;
    if (!['LOCAL_SIMULATION', 'ESTIMED'].includes(mode)) fail('FL_VM_MODE');
    if (mode === 'ESTIMED' && (!vm.endpoint || new URL(vm.endpoint).protocol !== 'https:' || !vm.hostId || !vm.processId || !vm.imageDigest)) fail('FL_VM_ATTESTATION');
    const next = { vmId: vm.vmId, mode, hostId: vm.hostId ?? 'localhost', processId: vm.processId ?? String(process.pid), imageDigest: vm.imageDigest ?? null, edgeId: vm.edgeId ?? null, labels: vm.labels ?? [], capacity: vm.capacity ?? 1, health: vm.health ?? 'HEALTHY', attested: vm.attested === true, endpoint: vm.endpoint ?? null, updatedAt: nowIso(this.clock) };
    this.vms.set(next.vmId, next); this.store.stagePut('flVms', next.vmId, next); return clone(next);
  }

  async registerParticipant({ participantId, principal, taskId, taskVersion = 1, vmId, publicKeyPem, dataset, zone = 'lab', source = 'synthetic' }) {
    requireString(participantId, 'participantId'); requireString(taskId, 'taskId');
    scopedId(participantId); scopedId(taskId); scopedId(dataset?.datasetId);
    if (!principal?.principalId || !principal.originator) fail('FL_IDENTITY_SCOPE');
    if (!this.vms.has(vmId)) fail('FL_VM_REQUIRED');
    if (createPublicKey(publicKeyPem).asymmetricKeyType !== 'ed25519') fail('FL_SIGNATURE_ALGORITHM');
    const fixture = syntheticDataset({ seed: dataset?.seed, clientIndex: dataset?.clientIndex, datasetId: dataset?.datasetId, version: dataset?.datasetVersion });
    if (!same(dataset, fixture.metadata)) fail('FL_DATASET_METADATA');
    return this.locked(taskId, async () => {
      const existing = this.getParticipant(taskId, participantId);
      if (existing) {
        if (existing.principalId !== principal.principalId || existing.originator !== principal.originator || !same(existing.dataset, dataset) || existing.publicKeyPem !== publicKeyPem) fail('FL_PARTICIPANT_BINDING');
        return clone(existing);
      }
      const participant = { participantId, principalId: principal.principalId, originator: principal.originator, taskId, taskVersion, vmId, publicKeyPem, dataset: clone(dataset), zone, source, participationCount: 0, status: 'REGISTERED', registeredAt: nowIso(this.clock), heartbeatAt: nowIso(this.clock), consent: null };
      await this.store.put('flParticipants', partKey(taskId, participantId), participant); return clone(participant);
    });
  }

  async heartbeat({ taskId, participantId, principal }) {
    return this.locked(taskId, async () => { const participant = clone(this.getParticipant(taskId, participantId)); if (!participant || participant.principalId !== principal?.principalId || participant.originator !== principal?.originator) fail('FL_IDENTITY_SCOPE'); participant.heartbeatAt = nowIso(this.clock); await this.store.put('flParticipants', partKey(taskId, participantId), participant); return clone(participant); });
  }

  async setParticipantConsent({ taskId, participantId, principal, status = 'ACTIVE', purpose = 'mobility-research', ttlSec = 3600, sourceConsentId = null }) {
    if (!['ACTIVE', 'REVOKED', 'STOPPED'].includes(status) || !Number.isSafeInteger(ttlSec) || ttlSec <= 0 || ttlSec > 86400) fail('FL_CONSENT_INPUT');
    return this.locked(taskId, async () => {
      const original = this.getParticipant(taskId, participantId); if (!original || original.principalId !== principal?.principalId || original.originator !== principal?.originator) fail('FL_IDENTITY_SCOPE');
      const participant = clone(original); const now = nowIso(this.clock);
      if (sourceConsentId) { const source = this.store.get('consents', sourceConsentId); if (source?.principalId !== principal.principalId || source.status !== 'ACTIVE' || !source.scopes?.includes('fl:train') || Date.parse(source.expiresAt) <= Date.parse(now)) fail('FL_SOURCE_CONSENT'); }
      participant.consent = { taskId, taskVersion: participant.taskVersion, purpose, datasetVersion: participant.dataset.datasetVersion, shareType: 'model-update', validFrom: now, expiresAt: new Date(Date.parse(now) + ttlSec * 1000).toISOString(), status, revision: (participant.consent?.revision ?? 0) + 1, sourceConsentId, sourceConsentRevision: sourceConsentId ? this.store.get('consents', sourceConsentId).revision : null };
      participant.status = status === 'ACTIVE' ? 'ACTIVE' : 'WITHDRAWN';
      this.store.collection('flParticipants')[partKey(taskId, participantId)] = participant;
      const task = this.store.get('flTasks', taskId);
      if (task) {
        task.consentPolicyRevision++;
        if (task.lineageContributors?.includes(participantId)) { task.state = 'SERVING_PAUSED'; task.reviewState = 'REVIEW_REQUIRED'; task.servingGeneration++; }
      }
      await this.store.flush(); await this.receipt('FL_CONSENT', { taskId, participantId, status, revision: participant.consent.revision, servingState: task?.state }); return clone(participant.consent);
    });
  }

  validConsent(participant, task, now = Date.parse(nowIso(this.clock))) {
    const c = participant?.consent;
    if (!c || participant.status !== 'ACTIVE' || c.status !== 'ACTIVE' || c.taskId !== task.taskId || c.taskVersion !== task.taskVersion || c.datasetVersion !== participant.dataset.datasetVersion || c.shareType !== 'model-update' || c.purpose !== task.purpose || Date.parse(c.validFrom) > now || Date.parse(c.expiresAt) <= now) return false;
    if (c.sourceConsentId) { const source = this.store.get('consents', c.sourceConsentId); if (source?.status !== 'ACTIVE' || source.revision !== c.sourceConsentRevision || Date.parse(source.expiresAt) <= now) return false; }
    return true;
  }

  eligible(participant, task, requiredLabels, selectionPolicy) {
    const vm = this.store.get('flVms', participant.vmId) ?? this.vms.get(participant.vmId);
    return this.validConsent(participant, task) && participant.dataset.featureSchemaVersion === FEATURE_VERSION && participant.dataset.trainCount >= 64 && Date.parse(nowIso(this.clock)) - Date.parse(participant.heartbeatAt) <= 30000 && vm?.health === 'HEALTHY' && vm.attested && vm.mode === this.mode && requiredLabels.every((label) => vm.labels.includes(label)) && (!selectionPolicy.zones?.length || selectionPolicy.zones.includes(participant.zone)) && (!selectionPolicy.sources?.length || selectionPolicy.sources.includes(participant.source));
  }

  artifact(bytes, scope, kind) {
    if (bytes.length > 65536) fail('FL_ARTIFACT_SIZE');
    const hash = digest(bytes); const artifactRef = `${scope}/${hash}`;
    this.store.collection('flArtifacts')[artifactRef] ??= { artifactRef, hash, bytes: bytes.length, body: bytes.toString('base64'), kind, createdAt: nowIso(this.clock) };
    return { artifactHash: hash, artifactRef, bytes: bytes.length };
  }

  readArtifact(ref, expectedHash) {
    const artifact = this.store.get('flArtifacts', ref); if (!artifact) fail('FL_ARTIFACT_REQUIRED');
    const bytes = Buffer.from(artifact.body, 'base64'); if (bytes.length !== artifact.bytes || digest(bytes) !== artifact.hash || (expectedHash && artifact.hash !== expectedHash)) fail('FL_ARTIFACT_INTEGRITY'); return bytes;
  }

  async createRound({ taskId, taskVersion = 1, purpose = 'mobility-research', requiredLabels = [], minParticipants = 2, selectionPolicy = {}, seed = 101, deadlineSec = 300 }) {
    requireString(taskId, 'taskId'); if (!Number.isSafeInteger(minParticipants) || minParticipants < 2 || !Number.isFinite(deadlineSec) || deadlineSec <= 0) fail('FL_QUORUM');
    scopedId(taskId);
    return this.locked(taskId, async () => {
      let task = this.store.get('flTasks', taskId);
      if (!task) {
        const initial = this.artifact(modelBytes(initialModel(seed)), `models/${taskId}/initial`, 'model');
        task = { taskId, taskVersion, purpose, seed, coordinatorEpoch: 1, nextRound: 1, modelVersion: 0, modelHash: initial.artifactHash, modelRef: initial.artifactRef, approvedCheckpoint: initial, state: 'ACTIVE', servingGeneration: 0, consentPolicyRevision: 0, lineageContributors: [] };
        this.store.collection('flTasks')[taskId] = task; this.epochs.set(taskId, 1);
      }
      this.epoch(task); if (task.taskVersion !== taskVersion || task.purpose !== purpose) fail('FL_TASK_SCOPE');
      if (task.state === 'SERVING_PAUSED') fail('FL_RETRAIN_APPROVAL_REQUIRED');
      const existing = this.store.list('flRounds').find((r) => r.taskId === taskId && !['COMPLETED', 'ROUND_DEFERRED', 'CANCELLED'].includes(r.state));
      if (existing) return clone(existing);
      const candidates = this.store.list('flParticipants').filter((p) => p.taskId === taskId && this.eligible(p, task, requiredLabels, selectionPolicy)).sort((a, b) => a.participationCount - b.participationCount || a.participantId.localeCompare(b.participantId));
      if (candidates.length < minParticipants) fail('FL_PARTICIPANT_CAPACITY');
      const selected = candidates.slice(0, Math.max(minParticipants, selectionPolicy.maxParticipants ?? candidates.length));
      const roundId = `${taskId}-r${task.nextRound}`;
      const round = { roundId, taskId, taskVersion, state: 'RUNNING', roundNumber: task.nextRound, coordinatorEpoch: task.coordinatorEpoch, baseModelVersion: task.modelVersion, baseModelHash: task.modelHash, baseModelRef: task.modelRef, featureSchemaVersion: FEATURE_VERSION, minParticipants, requiredLabels, selectionPolicy, participants: selected.map((p) => ({ participantId: p.participantId, vmId: p.vmId, status: 'SELECTED', consentRevision: p.consent.revision })), updates: [], createdAt: nowIso(this.clock), deadline: new Date(Date.parse(nowIso(this.clock)) + deadlineSec * 1000).toISOString(), checkpoint: { roundNumber: task.nextRound, participantIds: selected.map((p) => p.participantId) } };
      round.selectionHash = approvalHash(round.participants);
      for (const participant of selected) participant.participationCount++;
      this.store.collection('flRounds')[roundId] = round; await this.store.flush(); await this.receipt('FL_ROUND', { roundId, state: round.state, selectionHash: round.selectionHash, runtimeMode: this.mode }); return clone(round);
    });
  }

  async submitUpdate(input) {
    const initial = this.round(input.roundId);
    try {
      return await this.locked(initial.taskId, async () => {
        const round = this.round(input.roundId); const task = this.task(round.taskId); this.epoch(task);
        const participant = this.getParticipant(round.taskId, input.participantId);
        if (!participant || input.principal?.principalId !== participant.principalId || input.principal?.originator !== participant.originator) fail('FL_IDENTITY_SCOPE');
        if (!round.participants.some((p) => p.participantId === input.participantId)) fail('FL_MEMBERSHIP');
        if (!this.validConsent(participant, task) || input.consentRevision !== participant.consent.revision) fail('FL_CONSENT_CURRENT');
        const replay = round.updates.find((u) => u.participantId === input.participantId);
        for (const field of ['taskId', 'taskVersion', 'roundId', 'coordinatorEpoch', 'baseModelVersion', 'baseModelHash', 'featureSchemaVersion']) if (input[field] !== (field === 'coordinatorEpoch' && replay ? replay.coordinatorEpoch : round[field])) fail(`FL_SCOPE_${field}`);
        if (input.datasetId !== participant.dataset.datasetId) fail('FL_DATASET_SCOPE');
        if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount < 64 || input.sampleCount > 360) fail('FL_SAMPLE_COUNT');
        const bytes = input.model ? modelBytes(input.model) : Buffer.from(input.artifactBytes ?? '', 'base64'); decodeModel(bytes);
        if (bytes.length > 65536 || !hashPattern.test(input.artifactDigest ?? '') || digest(bytes) !== input.artifactDigest) fail('FL_ARTIFACT_DIGEST');
        const expectedRef = `updates/${round.taskId}/${round.roundId}/${participant.participantId}/${input.artifactDigest}`;
        if (input.artifactRef !== expectedRef) fail('FL_ARTIFACT_SCOPE');
        const trainReceipt = input.localTrainReceipt;
        if (!trainReceipt || input.localTrainReceiptHash !== approvalHash(trainReceipt) || trainReceipt.datasetVersion !== participant.dataset.datasetVersion || trainReceipt.splitHash !== participant.dataset.splitHash || trainReceipt.sampleCount !== input.sampleCount || !same(trainReceipt.training, TRAINING)) fail('FL_TRAIN_RECEIPT');
        const fixture = syntheticDataset({ seed: participant.dataset.seed, clientIndex: participant.dataset.clientIndex, datasetId: participant.dataset.datasetId, version: participant.dataset.datasetVersion });
        const sampleIds = trainReceipt.sampleIds;
        if (!Array.isArray(sampleIds) || sampleIds.length !== input.sampleCount || new Set(sampleIds).size !== sampleIds.length || sampleIds.some((sampleId) => !fixture.train.some((row) => row.id === sampleId)) || trainReceipt.sampleIdsDigest !== approvalHash(sampleIds) || trainReceipt.seed !== participant.dataset.seed) fail('FL_SAMPLE_MEMBERSHIP');
        if (!input.signature || !verify(null, updateSigningBytes(input), participant.publicKeyPem, Buffer.from(input.signature, 'base64'))) fail('FL_SIGNATURE');
        const updateHash = approvalHash({ envelope: updateFields.map((k) => input[k]), signature: input.signature });
        const existing = round.updates.find((u) => u.participantId === participant.participantId);
        if (existing) { if (existing.updateHash !== updateHash) fail('FL_DUPLICATE_UPDATE'); return clone({ ...existing, duplicate: true }); }
        if (!['RUNNING', 'WAITING_RESELECTION', 'REBUILD_REQUIRED'].includes(round.state) || Date.parse(round.deadline) <= Date.parse(nowIso(this.clock))) fail('FL_ROUND_STATE');
        this.artifact(bytes, `updates/${round.taskId}/${round.roundId}/${participant.participantId}`, 'update');
        const update = { updateId: id('fl-update'), ...Object.fromEntries(updateFields.map((key) => [key, input[key]])), artifactHash: input.artifactDigest, signature: input.signature, updateHash, localTrainReceipt: clone(trainReceipt), metrics: input.metrics ?? {}, submittedAt: nowIso(this.clock), status: 'VERIFIED_UPDATE' };
        round.updates.push(update); round.participants.find((p) => p.participantId === participant.participantId).status = 'UPDATED';
        this.store.collection('flRounds')[round.roundId] = round; await this.store.flush(); await this.receipt('FL_UPDATE_ACCEPTED', { taskId: round.taskId, roundId: round.roundId, participantId: participant.participantId, updateHash }); return clone(update);
      });
    } catch (error) { await this.receipt('FL_UPDATE_REVIEW', { roundId: input.roundId, participantId: input.participantId, reason: error.code ?? error.message }); throw error; }
  }

  accepted(round, task) {
    return round.updates.filter((u) => { const p = this.getParticipant(task.taskId, u.participantId); return this.validConsent(p, task) && p.consent.revision === u.consentRevision && p.taskVersion === round.taskVersion && p.dataset.featureSchemaVersion === round.featureSchemaVersion; }).sort((a, b) => a.participantId.localeCompare(b.participantId));
  }
  updateSetHash(updates) { return approvalHash(updates.map((u) => ({ participantId: u.participantId, updateHash: u.updateHash, sampleCount: u.sampleCount, consentRevision: u.consentRevision }))); }

  async prepareRound(roundId) {
    const initial = this.round(roundId); await this.hook('beforeArtifact', initial);
    const result = await this.locked(initial.taskId, async () => {
      const round = this.round(roundId); const task = this.task(round.taskId); this.epoch(task);
      if (round.state === 'COMPLETED') return round;
      if (round.state === 'ROUND_DEFERRED') return round;
      if (round.state === 'CANCELLED') fail('FL_ROUND_STATE');
      if (task.state === 'SERVING_PAUSED') fail('FL_RETRAIN_APPROVAL_REQUIRED');
      const accepted = this.accepted(round, task);
      if (accepted.length < round.minParticipants) {
        round.state = Date.parse(round.deadline) <= Date.parse(nowIso(this.clock)) ? 'ROUND_DEFERRED' : 'WAITING_RESELECTION';
        if (round.state === 'ROUND_DEFERRED') { task.nextRound = Math.max(task.nextRound, round.roundNumber + 1); this.store.collection('flTasks')[task.taskId] = task; }
        this.store.collection('flRounds')[roundId] = round; await this.store.flush(); await this.receipt('FL_QUORUM_WAIT', { roundId, state: round.state, accepted: accepted.length }); return round;
      }
      const model = fedAvg(accepted.map((u) => ({ participantId: u.participantId, sampleCount: u.sampleCount, model: decodeModel(this.readArtifact(u.artifactRef, u.artifactHash)) })));
      const artifact = this.artifact(modelBytes(model), `models/${round.taskId}/${round.roundId}`, 'model');
      const updateSetHash = this.updateSetHash(accepted);
      const manifest = { schema: 'urn:privacy-bubble:fl:model:1', taskId: round.taskId, taskVersion: round.taskVersion, roundId, roundNumber: round.roundNumber, modelVersion: task.modelVersion + 1, modelHash: artifact.artifactHash, modelRef: artifact.artifactRef, parentModelHash: round.baseModelHash, baseModelVersion: round.baseModelVersion, selected: round.participants.map((p) => p.participantId), acceptedSet: accepted.map((u) => ({ participantId: u.participantId, updateHash: u.updateHash, artifactDigest: u.artifactDigest, sampleCount: u.sampleCount, consentRevision: u.consentRevision, datasetId: u.datasetId, splitHash: u.localTrainReceipt.splitHash })), updateSetHash, featureSchemaVersion: FEATURE_VERSION, dtype: MODEL_FORMAT.dtype, shape: { W: MODEL_FORMAT.W, b: MODEL_FORMAT.b }, training: TRAINING, aggregation: 'sample-weighted-FedAvg', runtimeMode: this.mode };
      const manifestArtifact = this.artifact(Buffer.from(JSON.stringify(stable(manifest))), `manifests/${round.taskId}/${round.roundId}`, 'manifest');
      round.state = 'PREPARING'; round.prepared = { ...artifact, manifest, manifestHash: manifestArtifact.artifactHash, manifestRef: manifestArtifact.artifactRef, updateSetHash, consentPolicyRevision: task.consentPolicyRevision };
      this.store.collection('flRounds')[roundId] = round; await this.store.flush(); return round;
    });
    await this.hook('afterArtifact', result); return clone(result);
  }

  async finalizeRound(roundId) {
    const prepared = await this.prepareRound(roundId);
    if (prepared.state !== 'PREPARING') return prepared;
    await this.hook('beforeCommit', prepared);
    const result = await this.locked(prepared.taskId, async () => {
      const round = this.round(roundId); const task = this.task(round.taskId); this.epoch(task);
      if (round.state === 'COMPLETED') return round;
      if (round.coordinatorEpoch !== task.coordinatorEpoch || round.baseModelVersion !== task.modelVersion || round.baseModelHash !== task.modelHash) fail('FL_COMMIT_CAS');
      const accepted = this.accepted(round, task);
      if (round.prepared.updateSetHash !== this.updateSetHash(accepted) || round.prepared.consentPolicyRevision !== task.consentPolicyRevision || task.state === 'SERVING_PAUSED') {
        round.state = 'REBUILD_REQUIRED'; this.store.collection('flRounds')[roundId] = round; await this.store.flush(); await this.receipt('FL_REBUILD_REQUIRED', { roundId }); return round;
      }
      this.readArtifact(round.prepared.artifactRef, round.prepared.artifactHash); this.readArtifact(round.prepared.manifestRef, round.prepared.manifestHash);
      const commitKey = `${round.taskId}:${round.roundId}:${round.baseModelVersion}`;
      if (this.store.get('flCommits', commitKey)) fail('FL_COMMIT_CONFLICT');
      round.state = 'COMPLETED'; round.commitState = 'COMMITTED'; round.modelHash = round.prepared.artifactHash; round.manifestHash = round.prepared.manifestHash; round.modelVersion = task.modelVersion + 1; round.completedAt = nowIso(this.clock); round.checkpoint = { ...round.checkpoint, nextRound: round.roundNumber + 1, manifestHash: round.manifestHash };
      task.modelVersion = round.modelVersion; task.modelHash = round.modelHash; task.modelRef = round.prepared.artifactRef; task.manifestHash = round.manifestHash; task.nextRound = round.roundNumber + 1; task.servingGeneration++; task.state = 'ACTIVE'; task.reviewState = task.reviewState === 'RETRAIN_FROM_APPROVED_CHECKPOINT' ? 'NEW_MODEL_VERIFIED' : null;
      task.lineageContributors = [...new Set([...task.lineageContributors, ...accepted.map((u) => u.participantId)])];
      task.lineageConsentRevisions = { ...(task.lineageConsentRevisions ?? {}), ...Object.fromEntries(accepted.map((u) => [u.participantId, u.consentRevision])) };
      const outbox = { outboxId: commitKey, taskId: round.taskId, roundId, modelVersion: round.modelVersion, manifestHash: round.manifestHash, modelHash: round.modelHash, coordinatorEpoch: task.coordinatorEpoch, servingGeneration: task.servingGeneration, consentPolicyRevision: task.consentPolicyRevision, status: 'PENDING' };
      this.store.collection('flCommits')[commitKey] = { commitKey, roundId, modelHash: round.modelHash, manifestHash: round.manifestHash };
      this.store.collection('flTasks')[task.taskId] = task; this.store.collection('flRounds')[roundId] = round; this.store.collection('flPublicationOutbox')[commitKey] = outbox;
      await this.store.flush(); await this.receipt('FL_MODEL_COMMITTED', { ...outbox, state: 'COMPLETED', commitKey, acceptedSet: accepted.map((u) => u.participantId) }); return round;
    });
    await this.hook('afterCommit', result); return clone(result);
  }

  currentLineage(task) { return task.lineageContributors.every((participantId) => { const p = this.getParticipant(task.taskId, participantId); return this.validConsent(p, task) && p.consent.revision === task.lineageConsentRevisions?.[participantId]; }); }

  async publishRound(roundId) {
    const initial = this.round(roundId); await this.hook('beforePublication', initial);
    const result = await this.locked(initial.taskId, async () => {
      const round = this.round(roundId); const task = this.task(round.taskId); this.epoch(task);
      const key = `${round.taskId}:${round.roundId}:${round.baseModelVersion}`; const row = this.store.get('flPublicationOutbox', key);
      if (!row) fail('FL_PUBLICATION_REQUIRED');
      if (row.status === 'PUBLISHED') return clone(row);
      if (row.manifestHash !== task.manifestHash || row.servingGeneration !== task.servingGeneration || row.coordinatorEpoch !== task.coordinatorEpoch || row.consentPolicyRevision !== task.consentPolicyRevision || task.state !== 'ACTIVE' || !this.currentLineage(task)) { row.status = 'SUPERSEDED'; await this.store.flush(); await this.receipt('FL_PUBLICATION_SUPERSEDED', { roundId }); return clone(row); }
      const publication = this.publisher ? await this.publisher({ ...clone(row), resource: `/flAE/tasks/${task.taskId}/results/${row.modelVersion}`, manifest: clone(round.prepared.manifest), artifactBytes: this.readArtifact(round.prepared.artifactRef, row.modelHash).toString('base64') }) : { mode: 'LOCAL_SIMULATION', modelHash: row.modelHash, manifestHash: row.manifestHash };
      if (this.mode === 'ESTIMED' && !this.publisher) fail('FL_PUBLICATION_ADAPTER_REQUIRED');
      if (publication.modelHash !== row.modelHash || publication.manifestHash !== row.manifestHash) fail('FL_PUBLICATION_READBACK');
      row.status = 'PUBLISHED'; row.publishedAt = nowIso(this.clock); row.readback = publication; await this.store.flush(); await this.receipt('FL_MODEL_PUBLISHED', row); return clone(row);
    });
    await this.hook('afterPublication', result); return result;
  }

  async recover(roundId) {
    const initial = this.round(roundId);
    return this.locked(initial.taskId, async () => {
      const round = this.round(roundId); const task = this.task(round.taskId); task.coordinatorEpoch++; this.epochs.set(task.taskId, task.coordinatorEpoch);
      round.coordinatorEpoch = task.coordinatorEpoch; round.recoveredAt = nowIso(this.clock); round.checkpoint = { ...round.checkpoint, resumed: true, nextRound: round.state === 'COMPLETED' ? round.roundNumber + 1 : round.roundNumber };
      if (round.state === 'PREPARING') round.state = 'REBUILD_REQUIRED';
      for (const outbox of this.store.list('flPublicationOutbox')) if (outbox.taskId === task.taskId && outbox.status === 'PENDING' && outbox.manifestHash === task.manifestHash) outbox.coordinatorEpoch = task.coordinatorEpoch;
      this.store.collection('flTasks')[task.taskId] = task; this.store.collection('flRounds')[roundId] = round; await this.store.flush(); await this.receipt('FL_RECOVERED', { roundId, state: round.state, coordinatorEpoch: task.coordinatorEpoch }); return clone(round);
    });
  }

  async reselect(roundId) {
    const initial = this.round(roundId);
    return this.locked(initial.taskId, async () => {
      const round = this.round(roundId); const task = this.task(round.taskId); this.epoch(task);
      if (!['RUNNING', 'WAITING_RESELECTION', 'REBUILD_REQUIRED'].includes(round.state)) fail('FL_ROUND_STATE');
      if (Date.parse(round.deadline) <= Date.parse(nowIso(this.clock))) { round.state = 'ROUND_DEFERRED'; task.nextRound = Math.max(task.nextRound, round.roundNumber + 1); this.store.collection('flTasks')[task.taskId] = task; }
      else {
        const candidates = this.store.list('flParticipants').filter((p) => p.taskId === task.taskId && !round.participants.some((q) => q.participantId === p.participantId) && this.eligible(p, task, round.requiredLabels, round.selectionPolicy)).sort((a, b) => a.participationCount - b.participationCount || a.participantId.localeCompare(b.participantId));
        for (const p of candidates) { round.participants.push({ participantId: p.participantId, vmId: p.vmId, status: 'SELECTED', consentRevision: p.consent.revision }); p.participationCount++; }
        round.state = 'RUNNING'; round.selectionHash = approvalHash(round.participants);
      }
      this.store.collection('flRounds')[roundId] = round; await this.store.flush(); return clone(round);
    });
  }

  async approveRetraining(taskId) {
    return this.locked(taskId, async () => {
      const task = this.task(taskId); this.epoch(task);
      for (const round of this.store.list('flRounds')) if (round.taskId === taskId && round.state !== 'COMPLETED') round.state = 'CANCELLED';
      task.modelHash = task.approvedCheckpoint.artifactHash; task.modelRef = task.approvedCheckpoint.artifactRef; task.state = 'RETRAINING'; task.reviewState = 'RETRAIN_FROM_APPROVED_CHECKPOINT'; task.servingGeneration++; task.lineageContributors = []; task.lineageConsentRevisions = {};
      task.nextRound = Math.max(task.nextRound, ...this.store.list('flRounds').filter((r) => r.taskId === taskId).map((r) => r.roundNumber + 1));
      this.store.collection('flTasks')[taskId] = task; await this.store.flush(); await this.receipt('FL_RETRAIN_APPROVED', { taskId, checkpoint: task.approvedCheckpoint }); return clone(task);
    });
  }

  serveArtifact(roundId, artifactHash) {
    const round = this.round(roundId); const task = this.task(round.taskId);
    if (task.state !== 'ACTIVE' || !this.currentLineage(task) || round.state !== 'COMPLETED' || artifactHash !== task.modelHash || round.modelHash !== task.modelHash || round.manifestHash !== task.manifestHash) fail('FL_SERVING_FENCE');
    const bytes = this.readArtifact(task.modelRef, artifactHash);
    return { roundId, artifactHash, artifactRef: task.modelRef, artifactBytes: bytes.toString('base64'), model: decodeModel(bytes), manifestHash: task.manifestHash, servingGeneration: task.servingGeneration, state: task.state, servedAt: nowIso(this.clock) };
  }

  async cleanupArtifacts() {
    return this.store.transaction('fl-artifact-gc', () => this.cleanupArtifactsOnce());
  }

  async cleanupArtifactsOnce() {
    const refs = new Set();
    for (const task of this.store.list('flTasks')) { refs.add(task.modelRef); refs.add(task.approvedCheckpoint.artifactRef); }
    for (const round of this.store.list('flRounds')) { refs.add(round.baseModelRef); for (const u of round.updates) refs.add(u.artifactRef); if (round.prepared) { refs.add(round.prepared.artifactRef); refs.add(round.prepared.manifestRef); } }
    const removed = [];
    for (const artifact of this.store.list('flArtifacts')) if (!refs.has(artifact.artifactRef) && Date.parse(nowIso(this.clock)) - Date.parse(artifact.createdAt) >= 48 * 3600000) { delete this.store.collection('flArtifacts')[artifact.artifactRef]; removed.push(artifact.artifactRef); }
    await this.store.flush(); await this.receipt('FL_ARTIFACT_GC', { removed }); return removed;
  }
}
