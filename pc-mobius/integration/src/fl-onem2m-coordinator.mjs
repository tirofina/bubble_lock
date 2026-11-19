// FL coordinator whose durable state lives in the oneM2M CSE.
// A restarted coordinator rebuilds membership, selection counts, the open round and the current
// model from the CSE resources, claims a higher coordinatorEpoch with a create-if-absent status
// cin, and fences older instances.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MODEL_FORMAT, TRAINING, FEATURE_VERSION, initialModel, fedAvg } from './fl-numerics.mjs';
import {
  SCHEMA, LAYOUT, ACOP, ACP_NAMES, PLANE_VERSION, ID_PATTERN, AE_ID_PATTERN, FlPlaneError, fail, pad,
  roundName, roundAcpName, modelName, updateName, workerAeName, taskLabel, signContent, verifyContent,
  encodeArtifact, decodeArtifact, modelNorm, enrollmentProblem, cinContent, plainCin, trainingMatches,
} from './fl-onem2m-plane.mjs';

export const DEFAULT_TASK = Object.freeze({ taskVersion: 1, purpose: 'mobility-research', targetRounds: 12, maxParticipants: 3, minUpdates: 2, roundDeadlineMs: 6000, heartbeatTtlMs: 4000, seed: 101, maxUpdateNorm: 50 });
const TASK_KEYS = ['taskVersion', 'purpose', 'targetRounds', 'maxParticipants', 'minUpdates', 'roundDeadlineMs', 'heartbeatTtlMs', 'seed', 'maxUpdateNorm'];
const DATASET_KEYS = new Set(['datasetId', 'datasetVersion', 'featureSchemaVersion', 'taskVersion', 'trainCount', 'validationCount', 'testCount', 'splitHash', 'rawDataLocation']);
const metric = (m) => m && Number.isSafeInteger(m.samples) && m.samples > 0 && m.accuracy >= 0 && m.accuracy <= 1 && Number.isFinite(m.crossEntropy) && m.crossEntropy >= 0;
const weighted = (items, pick) => {
  const rows = items.map(pick).filter(metric); const samples = rows.reduce((s, m) => s + m.samples, 0);
  if (!samples) return null;
  return { samples, accuracy: rows.reduce((s, m) => s + m.accuracy * m.samples, 0) / samples, crossEntropy: rows.reduce((s, m) => s + m.crossEntropy * m.samples, 0) / samples, participants: rows.length };
};
const lossKey = (p) => p.lastBaseLoss ?? Number.POSITIVE_INFINITY;

export class FlOneM2mCoordinator {
  constructor({ client, identity, operatorPublicKeyPem, flAeName, task, notifyUrl = null, log = () => {}, now = () => Date.now(), instanceId = randomUUID(), inboxPollMs = 1000 }) {
    if (!client || !identity?.aeId || !identity.privateKeyPem || !identity.publicKeyPem || !operatorPublicKeyPem) fail('FL_COORDINATOR_CONFIG');
    if (!AE_ID_PATTERN.test(identity.aeId) || client.originator !== identity.aeId) fail('FL_COORDINATOR_ORIGINATOR');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(flAeName ?? '') || !ID_PATTERN.test(task?.taskId ?? '')) fail('FL_COORDINATOR_TASK');
    this.client = client; this.identity = identity; this.operatorPublicKeyPem = operatorPublicKeyPem; this.flAeName = flAeName;
    this.task = { ...DEFAULT_TASK, ...task }; this.notifyUrl = notifyUrl; this.log = log; this.now = now; this.instanceId = instanceId; this.inboxPollMs = inboxPollMs;
    const ae = `${client.cseBase}/${flAeName}`; this.aePath = ae;
    this.paths = { participants: `${ae}/${LAYOUT.participants}`, datasets: `${ae}/${LAYOUT.datasets}`, tasks: `${ae}/${LAYOUT.tasks}`, rounds: `${ae}/${LAYOUT.rounds}`, currentModel: `${ae}/${LAYOUT.currentModel}`, status: `${ae}/${LAYOUT.status}` };
    this.participants = new Map(); this.processedInbox = new Set(); this.inboxRejections = []; this.acp = {};
    this.epoch = 0; this.statusSeq = 0; this.current = null; this.model = null; this.completedRounds = 0; this.lastRoundNumber = 0;
    this.history = []; this.loggedUpdates = new Set(); this.waitingLogged = false; this.finished = false; this.replaying = false;
    this.inboxDirty = true; this.lastInboxAt = 0; this.notifications = 0; this.wake = null;
  }

  iso() { return new Date(this.now()).toISOString(); }
  signed(content) { return signContent(content, this.identity.privateKeyPem); }
  mine(content) { return verifyContent(content, this.identity.publicKeyPem); }

  async ensureAcp(rn, extra) {
    const C = this.identity.aeId;
    const body = { 'm2m:acp': { rn, pv: { acr: [{ acor: [C], acop: ACOP.ALL }, ...extra] }, pvs: { acr: [{ acor: [C], acop: ACOP.ALL }] } } };
    const result = await this.client.ensure(this.aePath, 1, body);
    return { path: result.path, ri: result.resource.ri, existed: result.existed };
  }
  async ensureContainer(parent, rn, acpi, extra = {}) {
    const result = await this.client.ensure(parent, 3, { 'm2m:cnt': { rn, acpi, lbl: [taskLabel(this.task.taskId), `fl-plane:${rn}`], ...extra } });
    return result.path;
  }
  async ensureSubscription(parent, rn) {
    if (!this.notifyUrl) return null;
    const body = { 'm2m:sub': { rn, nu: [this.notifyUrl], enc: { net: [3] }, nct: 1 } };
    const created = await this.client.create(parent, 23, body);
    if (created.ok) return `${parent}/${rn}`;
    if (created.rsc === 4105) { const updated = await this.client.update(`${parent}/${rn}`, { 'm2m:sub': { nu: [this.notifyUrl] } }); if (updated.ok) return `${parent}/${rn}`; }
    return fail('FL_SUBSCRIPTION', { parent, rsc: created.rsc });
  }

  /** Creates or adopts the FL resource tree and rebuilds coordinator state from the CSE. */
  async bootstrap() {
    const C = this.identity.aeId; const { taskId } = this.task;
    // The AE carries acpi from creation: a CSEBase-level ACP grants the coordinator full access and
    // everyone DISCOVERY only, so workers can find the task by label. (Mobius4 4.24.5 cannot add
    // acpi to a resource that was created without one unless the request comes from the CSE admin.)
    const discovery = await this.client.create(this.client.cseBase, 1, { 'm2m:acp': { rn: `acp-${this.flAeName}`, pv: { acr: [{ acor: [C], acop: ACOP.ALL }, { acor: ['all'], acop: ACOP.DISCOVERY }] }, pvs: { acr: [{ acor: [C], acop: ACOP.ALL }] } } });
    const discoveryRead = discovery.ok ? discovery : await this.client.retrieve(`${this.client.cseBase}/acp-${this.flAeName}`);
    this.acp.discovery = discoveryRead.ok ? { path: `${this.client.cseBase}/acp-${this.flAeName}`, ri: discoveryRead.payload['m2m:acp'].ri } : null;
    const ae = await this.client.create(this.client.cseBase, 2, { 'm2m:ae': { rn: this.flAeName, api: 'N.privacy.bubble.fl', rr: true, srv: ['4'], lbl: ['fl-plane:coordinator', taskLabel(taskId)], ...(this.acp.discovery ? { acpi: [this.acp.discovery.ri] } : {}) } });
    if (!ae.ok) { const read = await this.client.retrieve(this.aePath); if (!read.ok || read.payload?.['m2m:ae']?.aei !== C) fail('FL_AE_OWNERSHIP', { rsc: ae.rsc, readRsc: read.rsc }); }
    this.acp.coordinator = await this.ensureAcp(ACP_NAMES.coordinator, []);
    this.acp.taskRead = await this.ensureAcp(ACP_NAMES.taskRead, [{ acor: ['all'], acop: ACOP.RETRIEVE | ACOP.DISCOVERY }]);
    this.acp.inbox = await this.ensureAcp(ACP_NAMES.inbox, [{ acor: ['all'], acop: ACOP.CREATE }]);
    this.acp.members = await this.ensureAcp(ACP_NAMES.members, []);
    await this.ensureContainer(this.aePath, LAYOUT.participants, [this.acp.inbox.ri], { mni: 1000 });
    await this.ensureContainer(this.aePath, LAYOUT.datasets, [this.acp.coordinator.ri], { mni: 1000 });
    await this.ensureContainer(this.aePath, LAYOUT.tasks, [this.acp.taskRead.ri]);
    await this.ensureContainer(this.aePath, LAYOUT.currentModel, [this.acp.members.ri], { mni: 5 });
    await this.ensureContainer(this.aePath, LAYOUT.status, [this.acp.members.ri], { mni: 200 });
    await this.ensureContainer(this.aePath, LAYOUT.rounds, [this.acp.members.ri]);

    // Epoch claim: create-if-absent on status/epoch-NNNN is the CSE-side compare-and-set.
    const last = await this.client.latest(this.paths.status);
    const previous = last.ok && this.mine(cinContent(last)) ? cinContent(last) : null;
    let epoch = (previous?.coordinatorEpoch ?? 0) + 1;
    for (let attempt = 0; ; attempt++) {
      const claim = await this.client.create(this.paths.status, 4, plainCin({ rn: `epoch-${pad(epoch)}`, con: this.signed({ schema: SCHEMA.status, planeVersion: PLANE_VERSION, taskId, coordinatorAeId: C, coordinatorEpoch: epoch, instanceId: this.instanceId, seq: 0, state: 'EPOCH_CLAIMED', openRound: null, at: this.iso() }) }));
      if (claim.ok) break;
      if (claim.rsc !== 4105 || attempt > 8) fail('FL_EPOCH_CLAIM', { rsc: claim.rsc }); epoch++;
    }
    this.epoch = epoch;

    const taskRn = `task-v${this.task.taskVersion}`;
    const definition = this.signed({ schema: SCHEMA.task, planeVersion: PLANE_VERSION, taskId, ...Object.fromEntries(TASK_KEYS.map((k) => [k, this.task[k]])), featureSchemaVersion: FEATURE_VERSION, modelFormat: MODEL_FORMAT, training: TRAINING, aggregation: 'sample-weighted-FedAvg', selectionPolicy: 'eligible = enrolled + consent ACTIVE + signed heartbeat fresh; order = least selected, then highest last base loss, then participantId; take maxParticipants; close at all updates or deadline; quorum minUpdates', coordinatorAeId: C, coordinatorPublicKeyPem: this.identity.publicKeyPem, paths: this.paths, dataPolicy: { rawData: 'participant-local', shared: ['model vector (float32 8x3+3)', 'sample count', 'evaluation metrics', 'dataset metadata (counts, split hash)'] }, createdAt: this.iso() });
    const created = await this.client.create(this.paths.tasks, 4, plainCin({ rn: taskRn, con: definition, lbl: [taskLabel(taskId), 'fl-plane:task-definition'] }));
    if (created.ok) this.definition = definition;
    else {
      const stored = cinContent(await this.client.retrieve(`${this.paths.tasks}/${taskRn}`));
      if (!this.mine(stored) || stored.taskId !== taskId) fail('FL_TASK_DEFINITION', { rsc: created.rsc });
      this.definition = stored; for (const key of TASK_KEYS) this.task[key] = stored[key];
    }

    const latestModel = await this.client.latest(this.paths.currentModel);
    if (latestModel.ok) {
      const con = cinContent(latestModel); if (!this.mine(con)) fail('FL_MODEL_SIGNATURE');
      this.model = { version: con.modelVersion, hash: con.modelHash, model: decodeArtifact(con.artifact, con.modelHash), path: `${this.paths.currentModel}/${modelName(con.modelVersion)}`, roundNumber: con.roundNumber };
    } else await this.publishModel({ version: 0, model: initialModel(this.task.seed), roundNumber: 0, parentHash: null, contributors: [] });

    this.replaying = Boolean(previous);
    await this.processInbox(); this.replaying = false;
    const resumed = await this.rebuildRounds();
    await this.ensureSubscription(this.paths.participants, 'sub-coordinator');
    if (this.current) await this.ensureSubscription(this.current.updatesPath, 'sub-updates');
    const summary = { resumed: Boolean(previous), previousEpoch: previous?.coordinatorEpoch ?? null, coordinatorEpoch: this.epoch, completedRounds: this.completedRounds, lastRoundNumber: this.lastRoundNumber, openRound: this.current?.roundNumber ?? null, modelVersion: this.model.version, members: [...this.participants.values()].filter((p) => !p.revoked).map((p) => p.participantId), ...resumed };
    await this.writeStatus(previous ? 'RESUMED' : 'BOOTSTRAPPED', { resume: summary });
    this.log({ event: previous ? 'RESUMED' : 'BOOTSTRAPPED', ...summary });
    return summary;
  }

  async rebuildRounds() {
    let repaired = false;
    for (let n = 1; n <= 9999; n++) {
      const roundPath = `${this.paths.rounds}/${roundName(n)}`;
      const configRead = await this.client.retrieve(`${roundPath}/${LAYOUT.roundConfig}`);
      if (!configRead.ok) { if ((await this.client.retrieve(roundPath)).ok) this.halfOpen = n; break; }
      const config = cinContent(configRead); if (!this.mine(config)) fail('FL_ROUND_CONFIG_SIGNATURE', { round: n });
      this.lastRoundNumber = n;
      for (const s of config.selected) { const p = this.participants.get(s.participantId); if (p) p.selectedCount++; }
      const resultRead = await this.client.retrieve(`${roundPath}/${LAYOUT.roundResult}`);
      if (resultRead.ok) {
        const result = cinContent(resultRead); if (!this.mine(result)) fail('FL_ROUND_RESULT_SIGNATURE', { round: n });
        this.applyResult(result);
        if (result.state === 'COMPLETED' && result.model.version > this.model.version) { await this.publishModel({ version: result.model.version, model: decodeArtifact(result.artifact, result.model.hash), roundNumber: n, parentHash: result.model.parentHash, contributors: result.acceptedSet.map((a) => a.participantId) }); repaired = true; }
      } else this.current = { roundNumber: n, config, configHash: config.payloadHash, roundPath, updatesPath: `${roundPath}/${LAYOUT.roundUpdates}`, acpPath: `${this.aePath}/${roundAcpName(n)}`, resumed: true };
    }
    return { repairedCurrentModel: repaired, halfOpenRound: this.halfOpen ?? null };
  }

  applyResult(result) {
    if (result.state === 'COMPLETED') {
      this.completedRounds++;
      for (const a of result.acceptedSet) { const p = this.participants.get(a.participantId); if (p) { p.lastBaseLoss = a.baseTest?.crossEntropy ?? p.lastBaseLoss; p.contributedRounds.push(result.roundNumber); } }
    }
    this.history.push({ roundNumber: result.roundNumber, state: result.state, accepted: result.acceptedSet.map((a) => a.participantId), missing: result.missing, rejected: result.rejected, modelVersion: result.model?.version ?? null, coordinatorEpoch: result.coordinatorEpoch });
  }

  async publishModel({ version, model, roundNumber, parentHash, contributors }) {
    const artifact = encodeArtifact(model); const path = `${this.paths.currentModel}/${modelName(version)}`;
    const con = this.signed({ schema: SCHEMA.model, planeVersion: PLANE_VERSION, taskId: this.task.taskId, modelVersion: version, modelHash: artifact.digest, parentModelHash: parentHash, roundNumber, contributors, coordinatorEpoch: this.epoch, artifact, publishedAt: this.iso() });
    const created = await this.client.create(this.paths.currentModel, 4, plainCin({ rn: modelName(version), con, lbl: [taskLabel(this.task.taskId), `fl-plane:model:${version}`] }));
    if (!created.ok) {
      const stored = cinContent(await this.client.retrieve(path));
      if (created.rsc !== 4105 || !this.mine(stored) || stored.modelHash !== artifact.digest) fail('FL_MODEL_CONFLICT', { rsc: created.rsc });
    }
    this.model = { version, hash: artifact.digest, model, path, roundNumber };
  }

  async writeStatus(state, extra = {}) {
    this.statusSeq++;
    const open = this.current ? { roundNumber: this.current.roundNumber, roundPath: this.current.roundPath, deadline: this.current.config.deadline, selected: this.current.config.selected.map((s) => s.participantId) } : null;
    const con = this.signed({ schema: SCHEMA.status, planeVersion: PLANE_VERSION, taskId: this.task.taskId, coordinatorAeId: this.identity.aeId, coordinatorEpoch: this.epoch, instanceId: this.instanceId, seq: this.statusSeq, state, openRound: open, modelVersion: this.model?.version ?? null, modelHash: this.model?.hash ?? null, completedRounds: this.completedRounds, targetRounds: this.task.targetRounds, at: this.iso(), ...extra });
    const written = await this.client.create(this.paths.status, 4, plainCin({ rn: `e${pad(this.epoch)}-s${String(this.statusSeq).padStart(5, '0')}`, con }));
    if (!written.ok) fail('FL_STATUS_WRITE', { rsc: written.rsc });
  }

  async assertNotFenced() {
    const last = await this.client.latest(this.paths.status);
    const con = last.ok ? cinContent(last) : null;
    if (con && this.mine(con) && con.coordinatorEpoch > this.epoch) fail('FL_COORDINATOR_FENCED', { epoch: this.epoch, observed: con.coordinatorEpoch });
  }

  async processInbox() {
    this.inboxDirty = false; this.lastInboxAt = this.now();
    const listing = await this.client.children(this.paths.participants);
    if (!listing.ok) fail('FL_INBOX_READ', { rsc: listing.rsc });
    const fresh = listing.items.filter((cin) => !this.processedInbox.has(cin.ri)).sort((a, b) => (a.st ?? 0) - (b.st ?? 0) || String(a.ct).localeCompare(String(b.ct)));
    let changed = false;
    for (const cin of fresh) {
      this.processedInbox.add(cin.ri);
      try {
        if (cin.con?.schema === SCHEMA.registration) changed = (await this.handleRegistration(cin, cin.con)) || changed;
        else if (cin.con?.schema === SCHEMA.consent) changed = (await this.handleConsent(cin, cin.con)) || changed;
        else fail('INBOX_SCHEMA');
      } catch (error) {
        const rejection = { ri: cin.ri, participantId: typeof cin.con?.participantId === 'string' ? cin.con.participantId.slice(0, 48) : null, creator: cin.cr ?? null, reason: error.code ?? 'INBOX_ERROR' };
        this.inboxRejections.push(rejection); this.log({ event: 'INBOX_REJECTED', ...rejection });
      }
    }
    if (changed) await this.syncMemberAcp();
    return fresh.length;
  }

  async handleRegistration(cin, con) {
    const { participantId, aeId, publicKeyPem } = con;
    if (!ID_PATTERN.test(participantId ?? '') || !AE_ID_PATTERN.test(aeId ?? '')) fail('REGISTRATION_IDENTITY');
    if (cin.cr !== aeId) fail('REGISTRATION_CREATOR');
    if (con.taskId !== this.task.taskId) fail('REGISTRATION_TASK');
    if (!verifyContent(con, publicKeyPem)) fail('REGISTRATION_SIGNATURE');
    const problem = enrollmentProblem(con.enrollment, this.operatorPublicKeyPem, { participantId, aeId, publicKeyPem, taskId: this.task.taskId, now: this.now() }); if (problem) fail(problem);
    const d = con.dataset;
    if (!d || Object.keys(d).some((k) => !DATASET_KEYS.has(k)) || d.featureSchemaVersion !== FEATURE_VERSION || !Number.isSafeInteger(d.trainCount) || d.trainCount < 64 || d.trainCount > 100000 || !/^[a-f0-9]{64}$/.test(d.splitHash ?? '') || d.rawDataLocation !== 'participant-local' || !ID_PATTERN.test(d.datasetId ?? '')) fail('REGISTRATION_DATASET');
    const c = con.consent;
    if (c?.status !== 'ACTIVE' || c.purpose !== this.task.purpose || !Number.isSafeInteger(c.revision) || c.revision < 1 || !(Date.parse(c.validUntil) > this.now())) fail('REGISTRATION_CONSENT');
    const workerAePath = `${this.client.cseBase}/${workerAeName(participantId)}`;
    if (con.workerAePath !== workerAePath || con.heartbeatPath !== `${workerAePath}/${LAYOUT.workerHeartbeat}`) fail('REGISTRATION_PATHS');
    const existing = this.participants.get(participantId);
    if (existing) {
      if (existing.publicKeyPem !== publicKeyPem || existing.aeId !== aeId) fail('PARTICIPANT_BINDING');
      existing.registrations++;
      if (existing.revoked) {
        if (c.revision <= existing.consent.revision) { this.log({ event: 'REGISTRATION_IGNORED_REVOKED', participantId }); return false; }
        Object.assign(existing, { revoked: false, consent: c, dataset: d }); await this.writeCatalog(existing, 'RE_CONSENTED');
        this.log({ event: 'RE_CONSENTED', participantId, consentRevision: c.revision }); return true;
      }
      if (!this.replaying) this.log({ event: 'RE_REGISTERED', participantId, registrations: existing.registrations });
      return false;
    }
    const participant = { participantId, aeId, publicKeyPem, dataset: d, consent: c, workerAePath, heartbeatPath: con.heartbeatPath, zone: typeof con.zone === 'string' ? con.zone.slice(0, 32) : null, admittedAt: this.iso(), revoked: false, selectedCount: 0, lastBaseLoss: null, contributedRounds: [], registrations: 1 };
    this.participants.set(participantId, participant);
    await this.writeCatalog(participant, 'ADMITTED');
    this.log({ event: this.replaying ? 'MEMBER_RESTORED' : 'ADMITTED', participantId, aeId, datasetId: d.datasetId, trainCount: d.trainCount });
    return true;
  }

  async handleConsent(cin, con) {
    const p = this.participants.get(con.participantId); if (!p) fail('CONSENT_UNKNOWN_PARTICIPANT');
    if (cin.cr !== p.aeId || con.aeId !== p.aeId || con.taskId !== this.task.taskId) fail('CONSENT_CREATOR');
    if (!verifyContent(con, p.publicKeyPem)) fail('CONSENT_SIGNATURE');
    if (!Number.isSafeInteger(con.revision) || con.revision <= p.consent.revision) { this.log({ event: 'CONSENT_STALE', participantId: p.participantId }); return false; }
    if (con.status === 'REVOKED') {
      p.revoked = true; p.consent = { ...p.consent, status: 'REVOKED', revision: con.revision, revokedAt: con.issuedAt };
      await this.writeCatalog(p, 'REVOKED');
      if (this.current?.config.selected.some((s) => s.participantId === p.participantId)) await this.setRoundAcl(this.current, this.current.config.selected.map((s) => s.participantId).filter((id) => !this.participants.get(id)?.revoked));
      this.log({ event: 'CONSENT_REVOKED', participantId: p.participantId, consentRevision: con.revision, contributedRounds: p.contributedRounds }); return true;
    }
    if (con.status === 'ACTIVE' && p.revoked && con.purpose === this.task.purpose && Date.parse(con.validUntil) > this.now()) {
      p.revoked = false; p.consent = { ...p.consent, status: 'ACTIVE', revision: con.revision, validUntil: con.validUntil };
      await this.writeCatalog(p, 'RE_CONSENTED'); this.log({ event: 'RE_CONSENTED', participantId: p.participantId, consentRevision: con.revision }); return true;
    }
    return fail('CONSENT_STATUS');
  }

  async writeCatalog(p, state) {
    const con = this.signed({ schema: SCHEMA.dataset, planeVersion: PLANE_VERSION, taskId: this.task.taskId, participantId: p.participantId, aeId: p.aeId, datasetId: p.dataset.datasetId, metadata: p.dataset, consentRevision: p.consent.revision, state, at: this.iso() });
    const written = await this.client.create(this.paths.datasets, 4, plainCin({ rn: `d-${p.participantId}-c${pad(p.consent.revision)}`, con, lbl: [taskLabel(this.task.taskId), `fl-plane:dataset:${state}`] }));
    if (!written.ok && written.rsc !== 4105) fail('FL_CATALOG_WRITE', { rsc: written.rsc });
  }

  async syncMemberAcp() {
    const members = [...this.participants.values()].filter((p) => !p.revoked).map((p) => p.aeId).sort();
    const acr = [{ acor: [this.identity.aeId], acop: ACOP.ALL }, ...(members.length ? [{ acor: members, acop: ACOP.RETRIEVE | ACOP.DISCOVERY }] : [])];
    const updated = await this.client.update(this.acp.members.path, { 'm2m:acp': { pv: { acr } } });
    if (!updated.ok) fail('FL_ACP_MEMBERS', { rsc: updated.rsc });
    this.memberAcl = members;
  }

  async setRoundAcl(round, participantIds) {
    const writers = participantIds.map((id) => this.participants.get(id)?.aeId).filter(Boolean).sort();
    const acr = [{ acor: [this.identity.aeId], acop: ACOP.ALL }, ...(writers.length ? [{ acor: writers, acop: ACOP.CREATE }] : [])];
    const updated = await this.client.update(round.acpPath, { 'm2m:acp': { pv: { acr } } });
    if (!updated.ok) fail('FL_ACP_ROUND', { rsc: updated.rsc });
  }

  async eligibility() {
    const eligible = []; const excluded = [];
    for (const p of [...this.participants.values()].sort((a, b) => a.participantId.localeCompare(b.participantId))) {
      if (p.revoked) { excluded.push({ participantId: p.participantId, reason: 'CONSENT_REVOKED' }); continue; }
      if (!(Date.parse(p.consent.validUntil) > this.now())) { excluded.push({ participantId: p.participantId, reason: 'CONSENT_EXPIRED' }); continue; }
      const read = await this.client.latest(p.heartbeatPath);
      const hb = read.ok ? cinContent(read) : null;
      if (!hb) { excluded.push({ participantId: p.participantId, reason: 'HEARTBEAT_UNREADABLE', rsc: read.rsc }); continue; }
      if (hb.schema !== SCHEMA.heartbeat || hb.participantId !== p.participantId || !verifyContent(hb, p.publicKeyPem)) { excluded.push({ participantId: p.participantId, reason: 'HEARTBEAT_INVALID' }); continue; }
      const ageMs = this.now() - Date.parse(hb.at);
      if (!(ageMs <= this.task.heartbeatTtlMs) || hb.state === 'REVOKED') { excluded.push({ participantId: p.participantId, reason: hb.state === 'REVOKED' ? 'CONSENT_REVOKED' : 'HEARTBEAT_STALE', ageMs: Math.round(ageMs) }); continue; }
      eligible.push(p);
    }
    eligible.sort((a, b) => a.selectedCount - b.selectedCount || (lossKey(a) === lossKey(b) ? 0 : lossKey(b) > lossKey(a) ? 1 : -1) || a.participantId.localeCompare(b.participantId));
    return { eligible, excluded };
  }

  async openRound() {
    const n = this.halfOpen ?? this.lastRoundNumber + 1;
    const { eligible, excluded } = await this.eligibility();
    if (eligible.length < this.task.minUpdates) {
      if (!this.waitingLogged) { this.waitingLogged = true; await this.writeStatus('WAITING_PARTICIPANTS', { eligible: eligible.map((p) => p.participantId), excluded }); this.log({ event: 'WAITING_PARTICIPANTS', roundNumber: n, eligible: eligible.length, excluded }); }
      return null;
    }
    this.waitingLogged = false;
    const selected = eligible.slice(0, this.task.maxParticipants);
    const roundPath = `${this.paths.rounds}/${roundName(n)}`; const updatesPath = `${roundPath}/${LAYOUT.roundUpdates}`;
    const acp = await this.ensureAcp(roundAcpName(n), [{ acor: selected.map((p) => p.aeId).sort(), acop: ACOP.CREATE }]);
    const round = { roundNumber: n, roundPath, updatesPath, acpPath: acp.path };
    if (acp.existed) await this.setRoundAcl(round, selected.map((p) => p.participantId));
    await this.ensureContainer(this.paths.rounds, roundName(n), [this.acp.members.ri]);
    await this.ensureContainer(roundPath, LAYOUT.roundUpdates, [acp.ri], { mni: 100 });
    const openedAt = this.now();
    let config = this.signed({ schema: SCHEMA.roundConfig, planeVersion: PLANE_VERSION, taskId: this.task.taskId, roundNumber: n, roundId: `${this.task.taskId}-${roundName(n)}`, coordinatorAeId: this.identity.aeId, coordinatorEpoch: this.epoch, openedAt: new Date(openedAt).toISOString(), deadline: new Date(openedAt + this.task.roundDeadlineMs).toISOString(), baseModel: { version: this.model.version, hash: this.model.hash, path: this.model.path }, selected: selected.map((p) => ({ participantId: p.participantId, aeId: p.aeId })), minUpdates: this.task.minUpdates, training: TRAINING, modelFormat: MODEL_FORMAT, updatePath: updatesPath, selection: { eligible: eligible.map((p) => ({ participantId: p.participantId, selectedCount: p.selectedCount, lastBaseLoss: p.lastBaseLoss })), excluded, maxParticipants: this.task.maxParticipants } });
    const written = await this.client.create(roundPath, 4, plainCin({ rn: LAYOUT.roundConfig, con: config, lbl: [taskLabel(this.task.taskId), `fl-plane:round:${n}`, 'fl-plane:round-config'] }));
    if (!written.ok) {
      const stored = cinContent(await this.client.retrieve(`${roundPath}/${LAYOUT.roundConfig}`));
      if (written.rsc !== 4105 || !this.mine(stored)) fail('FL_ROUND_CONFIG_WRITE', { rsc: written.rsc });
      config = stored; await this.setRoundAcl(round, config.selected.map((s) => s.participantId));
    }
    for (const s of config.selected) { const p = this.participants.get(s.participantId); if (p) p.selectedCount++; }
    this.current = { ...round, config, configHash: config.payloadHash, resumed: false };
    this.lastRoundNumber = n; this.halfOpen = null;
    await this.ensureSubscription(updatesPath, 'sub-updates');
    await this.writeStatus('ROUND_OPEN');
    this.log({ event: 'ROUND_OPENED', roundNumber: n, selected: config.selected.map((s) => s.participantId), eligible: eligible.map((p) => p.participantId), excluded, baseModelVersion: config.baseModel.version, deadline: config.deadline, coordinatorEpoch: this.epoch });
    return this.current;
  }

  validateUpdate(cin, round) {
    const con = cin.con; const reject = (reason) => ({ ok: false, reason });
    if (con?.schema !== SCHEMA.update) return reject('UPDATE_SCHEMA');
    const member = round.config.selected.find((s) => s.participantId === con.participantId);
    if (!member) return reject('UPDATE_NOT_SELECTED');
    const p = this.participants.get(con.participantId); if (!p) return reject('UPDATE_UNKNOWN_PARTICIPANT');
    if (cin.rn !== updateName(p.participantId)) return reject('UPDATE_NAME');
    if (cin.cr !== p.aeId || con.aeId !== p.aeId || member.aeId !== p.aeId) return reject('UPDATE_CREATOR');
    if (p.revoked) return reject('CONSENT_REVOKED');
    if (con.consentRevision !== p.consent.revision) return reject('CONSENT_REVISION');
    if (con.taskId !== this.task.taskId || con.roundNumber !== round.roundNumber || con.roundId !== round.config.roundId || con.roundConfigHash !== round.configHash) return reject('UPDATE_ROUND_SCOPE');
    if (con.baseModelVersion !== round.config.baseModel.version || con.baseModelHash !== round.config.baseModel.hash) return reject('UPDATE_BASE_MODEL');
    if (!verifyContent(con, p.publicKeyPem)) return reject('UPDATE_SIGNATURE');
    if (con.datasetId !== p.dataset.datasetId || con.localTrainReceipt?.splitHash !== p.dataset.splitHash) return reject('UPDATE_DATASET');
    if (con.sampleCount !== p.dataset.trainCount || con.localTrainReceipt?.sampleCount !== con.sampleCount) return reject('UPDATE_SAMPLE_COUNT');
    if (!trainingMatches(con.localTrainReceipt?.training)) return reject('UPDATE_TRAINING');
    let model; try { model = decodeArtifact(con.artifact, con.artifactDigest); } catch (error) { return reject(error.code ?? 'FL_ARTIFACT_FORMAT'); }
    if (modelNorm(model) > this.task.maxUpdateNorm) return reject('UPDATE_NORM_BOUND');
    if (!metric(con.metrics?.baseTest)) return reject('UPDATE_METRICS');
    return { ok: true, update: { participantId: p.participantId, aeId: p.aeId, updatePath: `${round.updatesPath}/${cin.rn}`, ri: cin.ri, payloadHash: con.payloadHash, artifactDigest: con.artifactDigest, sampleCount: con.sampleCount, consentRevision: con.consentRevision, baseTest: con.metrics.baseTest, localValidation: metric(con.metrics.localValidation) ? con.metrics.localValidation : null, model } };
  }

  async progressRound() {
    const round = this.current;
    const listing = await this.client.children(round.updatesPath);
    if (!listing.ok) fail('FL_UPDATES_READ', { rsc: listing.rsc });
    const valid = new Set();
    for (const cin of listing.items) {
      const verdict = this.validateUpdate(cin, round);
      if (!this.loggedUpdates.has(cin.ri)) { this.loggedUpdates.add(cin.ri); this.log({ event: verdict.ok ? 'UPDATE_VERIFIED' : 'UPDATE_REJECTED', roundNumber: round.roundNumber, participantId: cin.con?.participantId ?? null, reason: verdict.reason ?? null, payloadHash: cin.con?.payloadHash ?? null }); }
      if (verdict.ok) valid.add(verdict.update.participantId);
      else if (cin.con?.participantId) valid.add(`rejected:${cin.con.participantId}`);
    }
    const pending = round.config.selected.filter((s) => !this.participants.get(s.participantId)?.revoked && !valid.has(s.participantId) && !valid.has(`rejected:${s.participantId}`));
    const expired = this.now() >= Date.parse(round.config.deadline);
    if (!pending.length || expired) return this.closeRound(pending.length ? 'DEADLINE' : 'ALL_SELECTED_RESPONDED');
    return null;
  }

  async closeRound(trigger) {
    await this.assertNotFenced();
    const round = this.current; const { config } = round;
    await this.setRoundAcl(round, []);
    const listing = await this.client.children(round.updatesPath);
    if (!listing.ok) fail('FL_UPDATES_READ', { rsc: listing.rsc });
    const accepted = []; const rejected = [];
    for (const cin of listing.items) {
      const verdict = this.validateUpdate(cin, round);
      if (verdict.ok && !accepted.some((a) => a.participantId === verdict.update.participantId)) accepted.push(verdict.update);
      else if (!verdict.ok) rejected.push({ participantId: typeof cin.con?.participantId === 'string' ? cin.con.participantId.slice(0, 48) : null, rn: cin.rn, creator: cin.cr ?? null, reason: verdict.reason });
    }
    accepted.sort((a, b) => a.participantId.localeCompare(b.participantId));
    const missing = config.selected.filter((s) => !accepted.some((a) => a.participantId === s.participantId) && !rejected.some((r) => r.participantId === s.participantId)).map((s) => ({ participantId: s.participantId, reason: this.participants.get(s.participantId)?.revoked ? 'CONSENT_REVOKED' : 'NO_UPDATE_BY_DEADLINE' }));
    const closedAt = this.now();
    const base = { schema: SCHEMA.roundResult, planeVersion: PLANE_VERSION, taskId: this.task.taskId, roundNumber: round.roundNumber, roundId: config.roundId, roundConfigHash: round.configHash, coordinatorEpoch: this.epoch, configEpoch: config.coordinatorEpoch, trigger, openedAt: config.openedAt, closedAt: new Date(closedAt).toISOString(), durationMs: closedAt - Date.parse(config.openedAt), baseModel: config.baseModel, selected: config.selected.map((s) => s.participantId), acceptedSet: accepted.map(({ model, ...rest }) => rest), rejected, missing, aggregation: 'sample-weighted-FedAvg', federatedEvaluation: { baseModelVersion: config.baseModel.version, test: weighted(accepted, (a) => a.baseTest), localValidation: weighted(accepted, (a) => a.localValidation) } };
    let result;
    if (accepted.length >= this.task.minUpdates) {
      const artifact = encodeArtifact(fedAvg(accepted.map((a) => ({ participantId: a.participantId, sampleCount: a.sampleCount, model: a.model }))));
      const version = this.model.version + 1;
      result = this.signed({ ...base, state: 'COMPLETED', model: { version, hash: artifact.digest, parentHash: this.model.hash, path: `${this.paths.currentModel}/${modelName(version)}` }, artifact });
    } else result = this.signed({ ...base, state: 'DEFERRED', reason: 'QUORUM_NOT_MET', model: null });
    const written = await this.client.create(round.roundPath, 4, plainCin({ rn: LAYOUT.roundResult, con: result, lbl: [taskLabel(this.task.taskId), `fl-plane:round:${round.roundNumber}`, 'fl-plane:round-result'] }));
    if (!written.ok) {
      const stored = cinContent(await this.client.retrieve(`${round.roundPath}/${LAYOUT.roundResult}`));
      if (written.rsc !== 4105 || !this.mine(stored)) fail('FL_RESULT_WRITE', { rsc: written.rsc });
      result = stored;
    }
    if (result.state === 'COMPLETED') await this.publishModel({ version: result.model.version, model: decodeArtifact(result.artifact, result.model.hash), roundNumber: round.roundNumber, parentHash: result.model.parentHash, contributors: result.acceptedSet.map((a) => a.participantId) });
    this.applyResult(result);
    this.current = null;
    if (this.notifyUrl) await this.client.remove(`${round.updatesPath}/sub-updates`);
    await this.writeStatus(result.state === 'COMPLETED' ? 'ROUND_COMPLETED' : 'ROUND_DEFERRED', { lastRound: { roundNumber: round.roundNumber, state: result.state, accepted: result.acceptedSet.length, missing: result.missing.length, rejected: result.rejected.length } });
    this.log({ event: result.state === 'COMPLETED' ? 'ROUND_COMPLETED' : 'ROUND_DEFERRED', roundNumber: round.roundNumber, trigger, accepted: result.acceptedSet.map((a) => a.participantId), missing: result.missing, rejected: result.rejected, modelVersion: result.model?.version ?? null, modelHash: result.model?.hash ?? null, federatedTest: result.federatedEvaluation.test, durationMs: result.durationMs, coordinatorEpoch: this.epoch, resumedRound: Boolean(round.resumed), notifications: this.notifications });
    return result;
  }

  async tick() {
    await this.assertNotFenced();
    if (this.inboxDirty || this.now() - this.lastInboxAt >= this.inboxPollMs) await this.processInbox();
    if (this.current) { await this.progressRound(); return { done: false }; }
    if (this.completedRounds >= this.task.targetRounds) {
      if (!this.finished) { this.finished = true; await this.writeStatus('COMPLETED'); this.log({ event: 'TASK_COMPLETED', completedRounds: this.completedRounds, modelVersion: this.model.version, modelHash: this.model.hash, coordinatorEpoch: this.epoch, notifications: this.notifications }); }
      return { done: true };
    }
    await this.openRound();
    return { done: false };
  }

  notify(signal) { this.notifications++; this.inboxDirty = true; this.wake?.(); return signal; }

  async run({ pollMs = 250, signal } = {}) {
    while (!signal?.aborted) {
      const { done } = await this.tick();
      if (done) return this.summary();
      await new Promise((resolve) => { const timer = setTimeout(resolve, pollMs); this.wake = () => { clearTimeout(timer); resolve(); }; });
      this.wake = null;
    }
    return this.summary();
  }

  summary() {
    return { coordinatorEpoch: this.epoch, completedRounds: this.completedRounds, lastRoundNumber: this.lastRoundNumber, modelVersion: this.model?.version ?? null, modelHash: this.model?.hash ?? null, notifications: this.notifications, inboxRejections: this.inboxRejections, history: this.history, participants: [...this.participants.values()].map((p) => ({ participantId: p.participantId, aeId: p.aeId, revoked: p.revoked, selectedCount: p.selectedCount, contributedRounds: p.contributedRounds })) };
  }
}

/** HTTP receiver for CSE notifications. Notifications only wake the coordinator; state is always re-read from the CSE. */
export function createNotificationServer({ coordinator, aePathPrefix }) {
  const prefix = aePathPrefix.replace(/^\//, '');
  return createServer(async (request, response) => {
    const chunks = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 262144) { response.writeHead(413); response.end(); return; } chunks.push(chunk); }
    let signal = null; try { signal = JSON.parse(Buffer.concat(chunks).toString('utf8'))['m2m:sgn']; } catch { /* rejected below */ }
    const sur = typeof signal?.sur === 'string' ? signal.sur.replace(/^\//, '') : '';
    const accepted = request.method === 'POST' && (signal?.vrq === true || sur.startsWith(`${prefix}/`));
    if (accepted && !signal?.vrq) coordinator.notify(signal);
    response.writeHead(accepted ? 200 : 400, { 'X-M2M-RSC': accepted ? '2000' : '4000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' });
    response.end();
  });
}

export { FlPlaneError };
