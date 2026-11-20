// oneM2M coordination plane for federated learning (TR-0084 style resource model, own wording).
//
// Resource layout under the CSE base (one FL AE per FL task):
//   <cseBase>/acp-<flAe>                   ACP  coordinator ALL, all DISCOVERY (AE acpi set at creation)
//   <cseBase>/<flAe>                       AE   coordinator application, lbl fl-plane:task:<taskId>
//     acp-coordinator / acp-task-read / acp-inbox / acp-members / acp-r-NNNN
//     participants                          cnt  inbox: registration and consent cin (anyone CREATE, coordinator RETRIEVE)
//     datasets                              cnt  coordinator catalog of admitted dataset metadata (no rows)
//     tasks                                 cnt  signed task definition cin (public RETRIEVE for discovery)
//     currentModel                          cnt  signed global model cin v-NNNN (members RETRIEVE)
//     status                                cnt  signed coordinator status cin (epoch claims, round state)
//     rounds/r-NNNN                         cnt  per round (members RETRIEVE)
//       config                              cin  signed round config: selection, deadline, base model
//       updates                             cnt  per-round ACP: only selected AE-IDs may CREATE
//         u-<participantId>                 cin  signed update: model vector, digest, metrics
//       result                              cin  signed result: accepted set, dropouts, aggregated model
//   <cseBase>/flw-<participantId>           AE   worker application (pre-assigned AE-ID)
//     acp-self, heartbeat                   cnt  worker heartbeat cin (coordinator RETRIEVE only)
import { sign, verify, createPublicKey, generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { approvalHash } from './integration-utils.mjs';
import { createMecFetch } from './mec-platform-client.mjs';
import { MODEL_FORMAT, TRAINING, FEATURE_VERSION, digest, decodeModel, modelBytes } from './fl-numerics.mjs';
import { generateShard } from './fl-shards.mjs';

export const PLANE_VERSION = 'privacy-bubble.fl-onem2m-plane.v1';
export const SCHEMA = Object.freeze({
  task: 'urn:privacy-bubble:fl-plane:task:1',
  registration: 'urn:privacy-bubble:fl-plane:registration:1',
  consent: 'urn:privacy-bubble:fl-plane:consent:1',
  dataset: 'urn:privacy-bubble:fl-plane:dataset:1',
  roundConfig: 'urn:privacy-bubble:fl-plane:round-config:1',
  update: 'urn:privacy-bubble:fl-plane:update:1',
  roundResult: 'urn:privacy-bubble:fl-plane:round-result:1',
  model: 'urn:privacy-bubble:fl-plane:model:1',
  status: 'urn:privacy-bubble:fl-plane:status:1',
  heartbeat: 'urn:privacy-bubble:fl-plane:heartbeat:1',
  enrollment: 'urn:privacy-bubble:fl-plane:enrollment:1',
});
export const LAYOUT = Object.freeze({ participants: 'participants', datasets: 'datasets', tasks: 'tasks', rounds: 'rounds', currentModel: 'currentModel', status: 'status', roundConfig: 'config', roundUpdates: 'updates', roundResult: 'result', workerHeartbeat: 'heartbeat' });
export const ACOP = Object.freeze({ CREATE: 1, RETRIEVE: 2, UPDATE: 4, DELETE: 8, NOTIFY: 16, DISCOVERY: 32, ALL: 63 });
export const ACP_NAMES = Object.freeze({ coordinator: 'acp-coordinator', taskRead: 'acp-task-read', inbox: 'acp-inbox', members: 'acp-members', workerSelf: 'acp-self' });
export const ROOT_KEY = Object.freeze({ 1: 'm2m:acp', 2: 'm2m:ae', 3: 'm2m:cnt', 4: 'm2m:cin', 23: 'm2m:sub' });
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
export const AE_ID_PATTERN = /^C[A-Za-z0-9._-]{1,63}$/;

export class FlPlaneError extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
export const fail = (code, details) => { throw new FlPlaneError(code, details); };

export const pad = (n) => String(n).padStart(4, '0');
export const roundName = (n) => { if (!Number.isSafeInteger(n) || n < 1 || n > 9999) fail('FL_ROUND_NUMBER'); return `r-${pad(n)}`; };
export const roundAcpName = (n) => `acp-${roundName(n)}`;
export const modelName = (version) => { if (!Number.isSafeInteger(version) || version < 0 || version > 9999) fail('FL_MODEL_VERSION'); return `v-${pad(version)}`; };
export const updateName = (participantId) => { if (!ID_PATTERN.test(participantId ?? '')) fail('FL_PARTICIPANT_ID'); return `u-${participantId}`; };
export const workerAeName = (participantId) => { if (!ID_PATTERN.test(participantId ?? '')) fail('FL_PARTICIPANT_ID'); return `flw-${participantId}`; };
export const taskLabel = (taskId) => `fl-plane:task:${taskId}`;

/** oneM2M timestamp (YYYYMMDDTHHmmss, UTC). */
export function toCseTime(date) {
  const iso = new Date(date).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
export function keyFingerprint(publicKeyPem) {
  return createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex');
}

/** Adds payloadHash (sha256 of canonical JSON without signature fields) and an Ed25519 signature over it. */
export function signContent(content, privateKeyPem) {
  const body = { ...content }; delete body.signature; delete body.payloadHash;
  const payloadHash = approvalHash(body);
  return { ...body, payloadHash, signature: sign(null, Buffer.from(payloadHash), privateKeyPem).toString('base64') };
}
export function contentHash(content) { const body = { ...content }; delete body.signature; delete body.payloadHash; return approvalHash(body); }
export function verifyContent(content, publicKeyPem) {
  if (!content || typeof content !== 'object' || typeof content.signature !== 'string' || typeof content.payloadHash !== 'string') return false;
  if (content.payloadHash !== contentHash(content)) return false;
  try { return verify(null, Buffer.from(content.payloadHash), publicKeyPem, Buffer.from(content.signature, 'base64')); } catch { return false; }
}

export function encodeArtifact(model) {
  const bytes = modelBytes(model);
  return { encoding: 'base64', dtype: MODEL_FORMAT.dtype, W: MODEL_FORMAT.W, b: MODEL_FORMAT.b, bytes: bytes.length, digest: digest(bytes), data: bytes.toString('base64') };
}
/** Decodes a base64 float32 model artifact and checks its digest; returns the model. */
export function decodeArtifact(artifact, expectedDigest) {
  if (!artifact || artifact.encoding !== 'base64' || typeof artifact.data !== 'string' || artifact.data.length > 4096) fail('FL_ARTIFACT_FORMAT');
  const bytes = Buffer.from(artifact.data, 'base64');
  if (bytes.length !== MODEL_FORMAT.bytes || bytes.toString('base64') !== artifact.data) fail('FL_ARTIFACT_FORMAT');
  const actual = digest(bytes);
  if (actual !== artifact.digest || (expectedDigest && actual !== expectedDigest)) fail('FL_ARTIFACT_DIGEST');
  return decodeModel(bytes);
}
export const modelNorm = (model) => Math.sqrt([...model.W.flat(), ...model.b].reduce((sum, v) => sum + v * v, 0));

/** Operator-issued enrollment: binds participantId, AE-ID, signing key and task. */
export function issueEnrollment({ operatorPrivateKeyPem, participantId, aeId, publicKeyPem, taskId, ttlSec = 30 * 86400, now = Date.now() }) {
  if (!ID_PATTERN.test(participantId) || !AE_ID_PATTERN.test(aeId) || !ID_PATTERN.test(taskId)) fail('FL_ENROLLMENT_INPUT');
  const payload = { schema: SCHEMA.enrollment, participantId, aeId, publicKeyFingerprint: keyFingerprint(publicKeyPem), taskId, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlSec * 1000).toISOString() };
  return signContent(payload, operatorPrivateKeyPem);
}
export function enrollmentProblem(enrollment, operatorPublicKeyPem, { participantId, aeId, publicKeyPem, taskId, now = Date.now() }) {
  if (!enrollment || enrollment.schema !== SCHEMA.enrollment) return 'ENROLLMENT_SCHEMA';
  if (!verifyContent(enrollment, operatorPublicKeyPem)) return 'ENROLLMENT_SIGNATURE';
  if (enrollment.participantId !== participantId || enrollment.aeId !== aeId || enrollment.taskId !== taskId) return 'ENROLLMENT_SCOPE';
  let fingerprint; try { fingerprint = keyFingerprint(publicKeyPem); } catch { return 'ENROLLMENT_KEY'; }
  if (enrollment.publicKeyFingerprint !== fingerprint) return 'ENROLLMENT_KEY';
  if (!(Date.parse(enrollment.issuedAt) <= now + 300000) || !(Date.parse(enrollment.expiresAt) > now)) return 'ENROLLMENT_EXPIRED';
  return null;
}

/**
 * Provisions operator, coordinator and worker identities for one FL task. Private keys stay in the returned objects.
 * AE-IDs default to Cfl-<runTag>-<role>. `aeIds` pins them instead ({ coordinator, workers: { <participantId>: aeId } }),
 * for a CSE front end that forces X-M2M-Origin per client certificate (the enrollment must name that AE-ID).
 */
export function provisionIdentities({ taskId, participantIds, runTag = randomUUID().slice(0, 8), ttlSec = 30 * 86400, aeIds = {} }) {
  if (!ID_PATTERN.test(taskId) || !/^[a-z0-9]{1,16}$/i.test(runTag)) fail('FL_PROVISION_INPUT');
  const pinned = [aeIds.coordinator, ...Object.values(aeIds.workers ?? {})].filter((value) => value !== undefined);
  if (pinned.some((value) => !AE_ID_PATTERN.test(value ?? '')) || new Set(pinned).size !== pinned.length) fail('FL_PROVISION_AE_ID');
  const operator = generateIdentity();
  const coordinator = { role: 'coordinator', aeId: aeIds.coordinator ?? `Cfl-${runTag}-coordinator`, ...generateIdentity(), operatorPublicKeyPem: operator.publicKeyPem, taskId };
  const workers = participantIds.map((participantId) => {
    const identity = generateIdentity(); const aeId = aeIds.workers?.[participantId] ?? `Cfl-${runTag}-${participantId}`;
    return { role: 'worker', participantId, aeId, ...identity, taskId, coordinatorAeId: coordinator.aeId, coordinatorPublicKeyPem: coordinator.publicKeyPem, enrollment: issueEnrollment({ operatorPrivateKeyPem: operator.privateKeyPem, participantId, aeId, publicKeyPem: identity.publicKeyPem, taskId, ttlSec }) };
  });
  return { runTag, operator, coordinator, workers };
}

/** Loads the worker-local dataset. Rows stay in this process; only metadata is returned for publication. */
export async function loadLocalDataset(spec) {
  if (spec?.source === 'synthetic-shard') return generateShard({ seed: spec.seed, profile: spec.profile, datasetId: spec.datasetId, datasetVersion: spec.datasetVersion ?? 1 });
  if (spec?.source === 'jsonl') {
    if (!ID_PATTERN.test(spec.datasetId ?? '')) fail('FL_DATASET_ID');
    const lines = (await readFile(spec.path, 'utf8')).split(/\r?\n/).filter((line) => line.trim());
    const rows = lines.map((line, index) => {
      const row = JSON.parse(line);
      if (!Array.isArray(row.x) || row.x.length !== 8 || row.x.some((v) => typeof v !== 'number' || !Number.isFinite(v)) || ![0, 1, 2].includes(row.y)) fail('FL_DATASET_ROW', { index });
      return { id: `${spec.datasetId}:${index}`, x: row.x.map(Math.fround), y: row.y };
    });
    if (rows.length < 100) fail('FL_DATASET_SIZE');
    const train = Math.floor(rows.length * 0.6); const validation = Math.floor(rows.length * 0.2);
    const splitHash = digest(Buffer.from(JSON.stringify(rows.map((row) => row.id))));
    return { metadata: { datasetId: spec.datasetId, datasetVersion: spec.datasetVersion ?? 1, featureSchemaVersion: FEATURE_VERSION, taskVersion: 'local-jsonl', trainCount: train, validationCount: validation, testCount: rows.length - train - validation, splitHash, rawDataLocation: 'participant-local' }, train: rows.slice(0, train), validation: rows.slice(train, train + validation), test: rows.slice(train + validation) };
  }
  return fail('FL_DATASET_SOURCE');
}

/**
 * Transport for an FL role from its config file. TLS keys (paths resolve against the config directory):
 *   caFile          PEM trust anchors for the CSE (or its TLS front end); default: the Node trust store
 *   clientCertFile  PEM client certificate for mTLS (an originator-binding proxy maps it to X-M2M-Origin)
 *   clientKeyFile   PEM key of the client certificate
 *   servername      TLS SNI, certificate name check and Host header; default: the cseUrl host
 *   connectHost     address to dial instead of the cseUrl host (no hosts-file entry needed)
 * cseUrl may carry a path prefix (https://cse.example:8443/onem2m); request paths are cseBase-rooted.
 */
export function flCseTransport(config = {}, baseDir = '.') {
  const file = (value, key) => { if (value === undefined || value === null) return null; if (typeof value !== 'string' || !value) fail('FL_CSE_TLS_CONFIG', { key }); return resolvePath(baseDir, value); };
  const caFile = file(config.caFile, 'caFile'); const certFile = file(config.clientCertFile, 'clientCertFile'); const keyFile = file(config.clientKeyFile, 'clientKeyFile');
  if (Boolean(certFile) !== Boolean(keyFile)) fail('FL_CSE_TLS_CONFIG', { key: 'clientCertFile/clientKeyFile' });
  for (const key of ['servername', 'connectHost']) if (config[key] !== undefined && config[key] !== null && (typeof config[key] !== 'string' || !config[key])) fail('FL_CSE_TLS_CONFIG', { key });
  const tlsKeys = { caFile, certFile, keyFile, servername: config.servername ?? null, connectHost: config.connectHost ?? null };
  if ((certFile || caFile || tlsKeys.servername) && new URL(config.cseUrl).protocol !== 'https:') fail('FL_CSE_TLS_CONFIG', { key: 'cseUrl' });
  const fetchImpl = createMecFetch(tlsKeys);
  return { fetchImpl, summary: { scheme: new URL(config.cseUrl).protocol.replace(':', ''), mutualTls: Boolean(certFile), pinnedCa: Boolean(caFile), servername: tlsKeys.servername, connectHost: tlsKeys.connectHost } };
}

/** FlCseClient for one role from its config file (cseUrl, cseBase, TLS keys, allowPlainHttp, timeoutMs). */
export function flCseClientFromConfig(config, { baseDir = '.', originator, trace = null } = {}) {
  const { fetchImpl, summary } = flCseTransport(config, baseDir);
  const client = new FlCseClient({ endpoint: config.cseUrl, cseBase: config.cseBase ?? '/Mobius', originator, fetchImpl, allowPlainHttp: config.allowPlainHttp === true, timeoutMs: config.timeoutMs ?? 5000, trace });
  client.transport = summary;
  return client;
}

/** Minimal oneM2M HTTP client used by both coordinator and workers (one originator per instance). */
export class FlCseClient {
  constructor({ endpoint, cseBase = '/Mobius', originator, fetchImpl = globalThis.fetch, timeoutMs = 5000, allowPlainHttp = false, rvi = '4', trace = null, busyRetries = 3, busyRetryMs = 400 }) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('FL_CSE_ENDPOINT');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !allowPlainHttp) fail('FL_CSE_HTTPS_REQUIRED');
    if (!originator || !/^[CS][A-Za-z0-9._-]{1,63}$/.test(originator)) fail('FL_CSE_ORIGINATOR');
    if (!/^\/[A-Za-z0-9._-]+$/.test(cseBase.replace(/\/$/, ''))) fail('FL_CSE_BASE');
    Object.assign(this, { endpoint: endpoint.replace(/\/+$/, ''), cseBase: cseBase.replace(/\/$/, ''), originator, fetchImpl, timeoutMs, rvi, trace, busyRetries, busyRetryMs });
    this.stats = { requests: 0, byRsc: {}, busyRetries: 0 };
  }
  checkPath(path) {
    if (typeof path !== 'string' || (path !== this.cseBase && !path.startsWith(`${this.cseBase}/`)) || /[?#%\\\s]/.test(path) || path.split('/').some((part) => part === '..' || part === '.')) fail('FL_CSE_PATH', { path });
    return path;
  }
  async request(method, path, { body, ty, query } = {}) {
    const url = new URL(`${this.endpoint}${this.checkPath(path)}`);
    for (const [key, value] of Object.entries(query ?? {})) { if (!['fu', 'ty', 'lbl', 'rcn', 'lim'].includes(key)) fail('FL_CSE_QUERY'); url.searchParams.set(key, String(value)); }
    for (let attempt = 0; ; attempt++) {
      const rqi = randomUUID(); let response;
      try {
        response = await this.fetchImpl(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json', 'X-M2M-Origin': this.originator, 'X-M2M-RI': rqi, 'X-M2M-RVI': this.rvi, ...(body ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch (error) { throw Object.assign(new FlPlaneError('FL_CSE_TRANSPORT', { method, path }), { cause: error }); }
      const text = await response.text();
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) fail('FL_CSE_RESPONSE_SIZE');
      const rscHeader = response.headers.get('X-M2M-RSC');
      // A front end (TLS proxy, rate limiter) may answer by itself: no X-M2M-RSC and an HTML body.
      // That is a refused request (rsc null, httpStatus kept), not a protocol error of the CSE.
      let payload = null; try { payload = text ? JSON.parse(text) : null; } catch { if (rscHeader !== null || response.ok) fail('FL_CSE_RESPONSE_JSON'); }
      const rsc = rscHeader === null ? null : Number(rscHeader);
      // 429 without an RSC comes from the front end's rate limit before the CSE saw the request,
      // so every method (including CREATE) is safe to send again after a short pause.
      if (rsc === null && response.status === 429 && attempt < this.busyRetries) { this.stats.busyRetries++; await new Promise((done) => setTimeout(done, this.busyRetryMs * (attempt + 1))); continue; }
      const echoed = response.headers.get('X-M2M-RI');
      if (echoed && echoed !== rqi) fail('FL_CSE_REQUEST_ID');
      const key = rsc ?? `http-${response.status}`;
      this.stats.requests++; this.stats.byRsc[key] = (this.stats.byRsc[key] ?? 0) + 1;
      const result = { ok: [2000, 2001, 2002, 2004].includes(rsc), status: response.status, rsc, payload, rqi };
      this.trace?.({ method, path, ty: ty ?? null, rsc, httpStatus: response.status, originator: this.originator });
      return result;
    }
  }
  create(parent, ty, resource) { return this.request('POST', parent, { body: resource, ty }); }
  retrieve(path, query) { return this.request('GET', path, { query }); }
  update(path, resource) { return this.request('PUT', path, { body: resource }); }
  remove(path) { return this.request('DELETE', path); }
  latest(path) { return this.retrieve(`${path}/la`); }
  /** Child resources of one type via rcn=4 (attributes and child resources). */
  async children(path, rootKey = 'm2m:cnt', childKey = 'm2m:cin') {
    const result = await this.retrieve(path, { rcn: 4 });
    if (!result.ok) return { ...result, items: [] };
    const items = result.payload?.[rootKey]?.[childKey] ?? [];
    return { ...result, items: Array.isArray(items) ? items : [items] };
  }
  /** Create-if-absent. Existing resources are read back; the caller decides whether they are acceptable. */
  async ensure(parent, ty, resource) {
    const key = ROOT_KEY[ty]; const rn = resource[key]?.rn; const path = `${parent}/${rn}`;
    const created = await this.create(parent, ty, resource);
    if (created.ok) return { path, resource: created.payload?.[key], existed: false, rsc: created.rsc };
    const existing = await this.retrieve(path);
    if (existing.ok) return { path, resource: existing.payload?.[key], existed: true, rsc: created.rsc };
    return fail('FL_CSE_ENSURE', { path, rsc: created.rsc, debug: created.payload?.['m2m:dbg'] ?? null, readRsc: existing.rsc });
  }
}

export const cinContent = (result) => result?.payload?.['m2m:cin']?.con ?? null;
export const plainCin = ({ rn, con, lbl, et, creator = false }) => ({ 'm2m:cin': { ...(rn ? { rn } : {}), cnf: 'application/json:0', con, ...(lbl ? { lbl } : {}), ...(et ? { et } : {}), ...(creator ? { cr: null } : {}) } });
export const trainingMatches = (training) => approvalHash(training) === approvalHash(TRAINING);
