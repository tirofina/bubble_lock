// FL participant that discovers its task through oneM2M, pulls the round config and global model
// from the CSE, trains on its local shard and writes a signed update cin. Raw rows never leave it.
import { randomUUID, createHash } from 'node:crypto';
import { hostname, platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { approvalHash } from './integration-utils.mjs';
import { TRAINING, FEATURE_VERSION, MODEL_FORMAT, trainModel, evaluateModel } from './fl-numerics.mjs';
import { SCHEMA, LAYOUT, ACOP, ACP_NAMES, PLANE_VERSION, fail, roundName, updateName, workerAeName, taskLabel, toCseTime, signContent, verifyContent, encodeArtifact, decodeArtifact, cinContent, plainCin, trainingMatches } from './fl-onem2m-plane.mjs';

const summary = (m) => ({ samples: m.samples, accuracy: 1 - m.errorRate, crossEntropy: m.crossEntropy, macroF1: m.macroF1 });
export const hostTag = () => createHash('sha256').update(hostname()).digest('hex').slice(0, 12);

export class FlOneM2mWorker {
  // exitOnTaskComplete=false keeps a service worker (systemd) running after the task completes: it
  // stays registered, polls the status every standbyPollMs and keeps a STANDBY heartbeat at that pace.
  constructor({ client, credentials, dataset, taskId, flAeName = null, zone = 'lab', trainDelayMs = 0, heartbeatMs = 1000, consentTtlSec = 86400, retentionDays = 30, exitOnTaskComplete = true, standbyPollMs = 30000, log = () => {}, now = () => Date.now() }) {
    const c = credentials ?? {};
    if (!client || !c.participantId || !c.aeId || !c.privateKeyPem || !c.publicKeyPem || !c.enrollment || !c.coordinatorAeId || !c.coordinatorPublicKeyPem) fail('FL_WORKER_CREDENTIALS');
    if (client.originator !== c.aeId) fail('FL_WORKER_ORIGINATOR');
    if (!dataset?.metadata || !dataset.train?.length || !dataset.test?.length) fail('FL_WORKER_DATASET');
    Object.assign(this, { client, credentials: c, dataset, taskId, flAeName, zone, trainDelayMs, heartbeatMs, consentTtlSec, retentionDays, exitOnTaskComplete, standbyPollMs, log, now });
    this.participantId = c.participantId; this.aePath = `${client.cseBase}/${workerAeName(c.participantId)}`; this.heartbeatPath = `${this.aePath}/${LAYOUT.workerHeartbeat}`;
    this.consentRevision = c.consentRevision ?? 1; this.handled = new Set(); this.seq = 0; this.lastHeartbeat = 0; this.admitted = false; this.revoked = false; this.training = false; this.tamperNext = false; this.lastState = null; this.lastRound = null; this.standby = false; this.signal = null;
    this.counters = { updatesWritten: 0, updatesDenied: 0, notSelected: 0, heartbeats: 0, statusDenied: 0 };
  }

  iso() { return new Date(this.now()).toISOString(); }
  logState(state, extra = {}) { if (this.lastState !== state) { this.lastState = state; this.log({ event: state, participantId: this.participantId, ...extra }); } }
  coordinatorSigned(content) { return verifyContent(content, this.credentials.coordinatorPublicKeyPem) && content.coordinatorAeId === this.credentials.coordinatorAeId; }

  async start() {
    const { aeId, coordinatorAeId } = this.credentials;
    const ae = await this.client.create(this.client.cseBase, 2, { 'm2m:ae': { rn: workerAeName(this.participantId), api: 'N.privacy.bubble.flworker', rr: true, srv: ['4'], lbl: ['fl-plane:worker', taskLabel(this.taskId)] } });
    if (!ae.ok) { const read = await this.client.retrieve(this.aePath); if (!read.ok || read.payload?.['m2m:ae']?.aei !== aeId) fail('FL_WORKER_AE', { rsc: ae.rsc, readRsc: read.rsc }); }
    const acp = await this.client.ensure(this.aePath, 1, { 'm2m:acp': { rn: ACP_NAMES.workerSelf, pv: { acr: [{ acor: [aeId], acop: ACOP.ALL }, { acor: [coordinatorAeId], acop: ACOP.RETRIEVE }] }, pvs: { acr: [{ acor: [aeId], acop: ACOP.ALL }] } } });
    await this.client.ensure(this.aePath, 3, { 'm2m:cnt': { rn: LAYOUT.workerHeartbeat, acpi: [acp.resource.ri], mni: 5, lbl: ['fl-plane:heartbeat', taskLabel(this.taskId)] } });
    this.flAePath = await this.discover();
    const taskRead = await this.client.latest(`${this.flAePath}/${LAYOUT.tasks}`);
    const task = cinContent(taskRead);
    if (!taskRead.ok || task?.schema !== SCHEMA.task || !this.coordinatorSigned(task) || task.taskId !== this.taskId) fail('FL_WORKER_TASK_VERIFY', { rsc: taskRead.rsc });
    if (task.featureSchemaVersion !== FEATURE_VERSION || task.modelFormat?.bytes !== MODEL_FORMAT.bytes || !trainingMatches(task.training)) fail('FL_WORKER_TASK_INCOMPATIBLE');
    this.task = task; this.paths = task.paths;
    await this.heartbeat('REGISTERING');
    await this.register();
    return { flAePath: this.flAePath, discoveredBy: this.discoveredBy, taskVersion: task.taskVersion };
  }

  async discover() {
    if (this.flAeName) { this.discoveredBy = 'config'; return `${this.client.cseBase}/${this.flAeName}`; }
    const found = await this.client.retrieve(this.client.cseBase, { fu: 1, ty: 2, lbl: taskLabel(this.taskId) });
    const uris = (found.payload?.['m2m:uril'] ?? []).map((u) => (u.startsWith('/') ? u : `/${u}`)).filter((u) => u !== this.aePath && !u.split('/').pop().startsWith('flw-'));
    for (const uri of uris) {
      const task = cinContent(await this.client.latest(`${uri}/${LAYOUT.tasks}`));
      if (task && this.coordinatorSigned(task) && task.taskId === this.taskId) { this.discoveredBy = 'label-discovery'; return uri; }
    }
    return fail('FL_WORKER_TASK_NOT_FOUND', { rsc: found.rsc, candidates: uris.length });
  }

  async register() {
    const { participantId, aeId, publicKeyPem, enrollment, privateKeyPem } = this.credentials;
    const con = signContent({ schema: SCHEMA.registration, planeVersion: PLANE_VERSION, taskId: this.taskId, participantId, aeId, publicKeyPem, enrollment, workerAePath: this.aePath, heartbeatPath: this.heartbeatPath, dataset: this.dataset.metadata, consent: { status: 'ACTIVE', purpose: this.task.purpose, revision: this.consentRevision, validUntil: new Date(this.now() + this.consentTtlSec * 1000).toISOString() }, zone: this.zone, runtime: { hostTag: hostTag(), platform: platform(), node: process.version, pid: process.pid }, issuedAt: this.iso(), nonce: randomUUID() }, privateKeyPem);
    const written = await this.client.create(this.paths.participants, 4, plainCin({ con, creator: true, lbl: ['fl-plane:registration', taskLabel(this.taskId)] }));
    if (!written.ok) fail('FL_WORKER_REGISTRATION', { rsc: written.rsc });
    this.log({ event: 'REGISTERED', participantId, aeId, flAePath: this.flAePath, discoveredBy: this.discoveredBy, datasetId: this.dataset.metadata.datasetId, trainCount: this.dataset.metadata.trainCount });
  }

  async heartbeat(state) {
    this.seq++;
    const con = signContent({ schema: SCHEMA.heartbeat, participantId: this.participantId, seq: this.seq, state, lastRound: this.lastRound, at: this.iso() }, this.credentials.privateKeyPem);
    const written = await this.client.create(this.heartbeatPath, 4, plainCin({ con }));
    this.lastHeartbeat = this.now(); if (written.ok) this.counters.heartbeats++;
    return written.ok;
  }

  async revokeConsent(reason = 'participant-withdrew') {
    const { participantId, aeId, privateKeyPem } = this.credentials;
    const con = signContent({ schema: SCHEMA.consent, planeVersion: PLANE_VERSION, taskId: this.taskId, participantId, aeId, status: 'REVOKED', revision: this.consentRevision + 1, purpose: this.task.purpose, reason, issuedAt: this.iso() }, privateKeyPem);
    const written = await this.client.create(this.paths.participants, 4, plainCin({ con, creator: true, lbl: ['fl-plane:consent', taskLabel(this.taskId)] }));
    if (!written.ok) fail('FL_WORKER_CONSENT_WRITE', { rsc: written.rsc });
    this.consentRevision++; this.revoked = true; await this.heartbeat('REVOKED');
    this.log({ event: 'CONSENT_REVOKED_SENT', participantId, consentRevision: this.consentRevision, reason });
  }

  async tick() {
    if (this.revoked) return { done: true };
    if (this.now() - this.lastHeartbeat >= this.heartbeatMs) await this.heartbeat(this.training ? 'TRAINING' : this.standby ? 'STANDBY' : 'IDLE');
    const read = await this.client.latest(this.paths.status);
    if (!read.ok) {
      if (read.rsc === 4103) this.counters.statusDenied++;
      this.logState(read.rsc === 4103 ? (this.admitted ? 'ACCESS_DENIED_AFTER_ADMISSION' : 'WAITING_ADMISSION') : 'STATUS_UNAVAILABLE', { rsc: read.rsc });
      return { done: false };
    }
    const status = cinContent(read);
    if (!this.coordinatorSigned(status)) { this.logState('STATUS_SIGNATURE_INVALID'); return { done: false }; }
    if (!this.admitted) { this.admitted = true; this.log({ event: 'ADMISSION_OBSERVED', participantId: this.participantId, coordinatorEpoch: status.coordinatorEpoch }); }
    if (status.state === 'COMPLETED') {
      this.logState('TASK_COMPLETED', { modelVersion: status.modelVersion, standby: !this.exitOnTaskComplete });
      if (this.exitOnTaskComplete) return { done: true };
      this.standby = true; return { done: false, standby: true };
    }
    this.standby = false;
    const n = status.openRound?.roundNumber;
    if (Number.isSafeInteger(n) && !this.handled.has(n)) {
      this.handled.add(n);
      try { await this.handleRound(n); } catch (error) { if (error.code === 'FL_CSE_TRANSPORT') this.handled.delete(n); this.log({ event: 'ROUND_ERROR', participantId: this.participantId, roundNumber: n, reason: error.code ?? error.message }); }
    } else this.logState('IDLE', { coordinatorEpoch: status.coordinatorEpoch });
    return { done: false };
  }

  async handleRound(n) {
    const roundPath = `${this.paths.rounds}/${roundName(n)}`;
    const read = await this.client.retrieve(`${roundPath}/${LAYOUT.roundConfig}`);
    if (!read.ok) { this.handled.delete(n); return null; }
    const config = cinContent(read);
    if (config?.schema !== SCHEMA.roundConfig || !this.coordinatorSigned(config) || config.taskId !== this.taskId || config.roundNumber !== n) fail('FL_WORKER_ROUND_CONFIG');
    const me = config.selected.find((s) => s.participantId === this.participantId);
    if (!me) { this.counters.notSelected++; this.lastState = null; this.log({ event: 'NOT_SELECTED', participantId: this.participantId, roundNumber: n }); return null; }
    if (me.aeId !== this.credentials.aeId) fail('FL_WORKER_SELECTION_BINDING');
    if (Date.parse(config.deadline) <= this.now()) { this.log({ event: 'ROUND_EXPIRED', participantId: this.participantId, roundNumber: n }); return null; }
    const modelRead = await this.client.retrieve(config.baseModel.path);
    const published = cinContent(modelRead);
    if (!modelRead.ok || published?.schema !== SCHEMA.model || !verifyContent(published, this.credentials.coordinatorPublicKeyPem) || published.modelHash !== config.baseModel.hash || published.modelVersion !== config.baseModel.version) fail('FL_WORKER_BASE_MODEL', { rsc: modelRead.rsc });
    const base = decodeArtifact(published.artifact, config.baseModel.hash);
    this.training = true; this.lastRound = n; this.lastState = null;
    this.log({ event: 'TRAINING_STARTED', participantId: this.participantId, roundNumber: n, baseModelVersion: config.baseModel.version });
    await this.heartbeat('TRAINING');
    if (this.trainDelayMs > 0) await delay(this.trainDelayMs, undefined, this.signal ? { signal: this.signal } : undefined).catch(() => {});
    // A stop request (SIGTERM from systemctl stop) during local work abandons the round: no update is
    // written, so the coordinator closes the round by deadline and quorum without this participant.
    if (this.signal?.aborted) { this.training = false; this.log({ event: 'ROUND_ABANDONED', participantId: this.participantId, roundNumber: n, reason: 'STOP_REQUESTED' }); return 'ROUND_ABANDONED'; }
    const startedAt = this.iso();
    const baseTest = summary(evaluateModel(base, this.dataset.test));
    const trained = trainModel(base, this.dataset.train, TRAINING);
    const localValidation = summary(evaluateModel(trained, this.dataset.validation));
    let artifact = encodeArtifact(trained);
    const tampered = this.tamperNext;
    if (tampered) { this.tamperNext = false; const bytes = Buffer.from(artifact.data, 'base64'); bytes.writeFloatLE(bytes.readFloatLE(0) + 0.5, 0); artifact = { ...artifact, data: bytes.toString('base64') }; }
    const meta = this.dataset.metadata;
    const con = signContent({ schema: SCHEMA.update, planeVersion: PLANE_VERSION, taskId: this.taskId, roundNumber: n, roundId: config.roundId, roundConfigHash: config.payloadHash, coordinatorEpoch: config.coordinatorEpoch, participantId: this.participantId, aeId: this.credentials.aeId, datasetId: meta.datasetId, consentRevision: this.consentRevision, baseModelVersion: config.baseModel.version, baseModelHash: config.baseModel.hash, sampleCount: this.dataset.train.length, artifactDigest: artifact.digest, artifact, localTrainReceipt: { datasetVersion: meta.datasetVersion, splitHash: meta.splitHash, sampleCount: this.dataset.train.length, sampleIdsDigest: approvalHash(this.dataset.train.map((row) => row.id)), training: TRAINING, startedAt, finishedAt: this.iso() }, metrics: { baseTest, localValidation }, rawDataShared: false, submittedAt: this.iso() }, this.credentials.privateKeyPem);
    const written = await this.client.create(config.updatePath, 4, plainCin({ rn: updateName(this.participantId), con, creator: true, et: toCseTime(this.now() + this.retentionDays * 86400000), lbl: [taskLabel(this.taskId), `fl-plane:round:${n}`, 'fl-plane:update'] }));
    this.training = false;
    const outcome = written.ok ? 'UPDATE_WRITTEN' : written.rsc === 4105 ? 'UPDATE_ALREADY_PRESENT' : written.rsc === 4103 ? 'UPDATE_DENIED_BY_ACP' : 'UPDATE_WRITE_FAILED';
    if (written.ok) this.counters.updatesWritten++; else if (written.rsc === 4103) this.counters.updatesDenied++;
    this.log({ event: outcome, participantId: this.participantId, roundNumber: n, rsc: written.rsc, tampered, payloadHash: con.payloadHash, artifactDigest: con.artifactDigest, updateBytes: Buffer.byteLength(JSON.stringify(con)), baseTest });
    return outcome;
  }

  async run({ pollMs = 250, signal } = {}) {
    this.signal = signal ?? null;
    while (!signal?.aborted) {
      let done = false; let standby = false;
      try { ({ done, standby = false } = await this.tick()); } catch (error) { this.log({ event: 'TICK_ERROR', participantId: this.participantId, reason: error.code ?? error.message }); }
      if (done) return this.counters;
      await delay(standby ? this.standbyPollMs : pollMs, undefined, signal ? { signal } : undefined).catch(() => {});
    }
    return this.counters;
  }
}
