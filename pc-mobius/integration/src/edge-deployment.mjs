import { createServer } from 'node:https';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { approvalHash } from './integration-utils.mjs';

const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const live = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** 호스트 설정의 고정 application catalog만 실행하는 단일 소유 supervisor. */
export class EdgeSupervisor {
  constructor({ store, hostId, region, zones = [], capacity = 4, applications, healthFetch = globalThis.fetch, startBudgetMs = 15000 }) {
    if (!store || !identifier(hostId) || !identifier(region) || !Array.isArray(zones) || zones.some((zone) => !identifier(zone))
      || !Number.isInteger(capacity) || capacity < 1 || !Array.isArray(applications) || !applications.length) throw Error('EDGE_CONFIGURATION');
    this.store = store; this.identity = { hostId, region, zones, capacity }; this.healthFetch = healthFetch; this.startBudgetMs = startBudgetMs;
    this.applications = new Map(); this.children = new Map(); this.queue = Promise.resolve();
    for (const app of applications) {
      const health = new URL(app.healthUrl);
      if (!identifier(app.appId) || !app.version || !isAbsolute(app.executable) || !isAbsolute(app.cwd)
        || !Array.isArray(app.args) || app.args.some((arg) => typeof arg !== 'string')
        || !Array.isArray(app.artifacts) || !app.artifacts.length || app.artifacts.some((file) => !isAbsolute(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256))
        || !['https:', 'http:'].includes(health.protocol) || (health.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(health.hostname))
        || health.username || health.password || this.applications.has(app.appId)) throw Error('EDGE_APPLICATION_CATALOG');
      const imageDigest = approvalHash(app.artifacts.map(({ path, name, sha256: hash }) => ({ name: name ?? basename(path), sha256: hash })).sort((a, b) => a.name.localeCompare(b.name)));
      this.applications.set(app.appId, { ...app, imageDigest, capabilities: app.capabilities ?? [] });
    }
  }
  exclusive(action) { const pending = this.queue.then(action); this.queue = pending.catch(() => {}); return pending; }
  publicApplication(app) { return { appId: app.appId, version: app.version, imageDigest: app.imageDigest, capabilities: app.capabilities }; }
  async inventory() {
    const deployments = [];
    for (const record of this.store.list('edgeDeployments')) {
      let healthy = false;
      if (record.state === 'RUNNING') healthy = await this.probe(record).catch(() => false);
      deployments.push({ ...this.publicRecord(record), healthy });
    }
    const used = deployments.filter((row) => ['RUNNING', 'STARTING', 'RECOVERY_REQUIRED'].includes(row.state)).length;
    return { ...this.identity, protocol: 'privacy-bubble.edge.v1', status: 'HEALTHY', used, load: used / this.identity.capacity,
      applications: [...this.applications.values()].map((app) => this.publicApplication(app)), deployments };
  }
  publicRecord(record) {
    const { appId, version, imageDigest, instanceId, pid, state, startedAt, leaseEpochs = {} } = record;
    return { hostId: this.identity.hostId, appId, version, imageDigest, instanceId, pid, state, startedAt, leaseCount: Object.keys(leaseEpochs).length };
  }
  async probe(record) {
    if (!Number.isSafeInteger(record.pid) || !live(record.pid)) return false;
    const app = this.applications.get(record.appId); if (!app) return false;
    const response = await this.healthFetch(app.healthUrl, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) return false;
    const text = await response.text(); if (Buffer.byteLength(text) > 8192) return false;
    const value = JSON.parse(text);
    return value.status === 'READY' && value.deployment?.hostId === this.identity.hostId && value.deployment?.instanceId === record.instanceId
      && value.deployment?.imageDigest === record.imageDigest && value.deployment?.pid === record.pid;
  }
  async recoverProcess(record) {
    const app = this.applications.get(record.appId); if (!app) return false;
    const response = await this.healthFetch(app.healthUrl, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) return false;
    const text = await response.text(); if (Buffer.byteLength(text) > 8192) return false;
    const value = JSON.parse(text);
    if (value.status !== 'READY' || value.deployment?.hostId !== this.identity.hostId || value.deployment?.instanceId !== record.instanceId
      || value.deployment?.imageDigest !== record.imageDigest || !Number.isSafeInteger(value.deployment?.pid) || !live(value.deployment.pid)) return false;
    record.pid = value.deployment.pid; record.state = 'RUNNING';
    await this.store.put('edgeDeployments', record.appId, record); return true;
  }
  async verifyArtifacts(app) {
    for (const file of app.artifacts) if (sha256(await readFile(file.path)) !== file.sha256) throw Error('EDGE_ARTIFACT_HASH');
  }
  async receipt(type, record) {
    await this.store.append('receipts', { eventId: randomUUID(), type, timestamp: new Date().toISOString(), ...this.publicRecord(record) });
  }
  ensure(input) { return this.exclusive(() => this.ensureExclusive(input)); }
  async ensureExclusive({ appId, version, imageDigest, ueId, epoch, operationId }) {
    if (!identifier(ueId) || !identifier(operationId) || !Number.isInteger(epoch) || epoch < 1 || epoch > 2147483647) throw Error('EDGE_DEPLOYMENT_INTENT');
    const app = this.applications.get(appId);
    if (!app || app.version !== version || app.imageDigest !== imageDigest) throw Error('EDGE_APPLICATION_BINDING');
    const intentHash = approvalHash({ appId, version, imageDigest, ueId, epoch });
    const priorOperation = this.store.get('edgeOperations', operationId);
    if (priorOperation && priorOperation.intentHash !== intentHash) throw Error('EDGE_OPERATION_BINDING');
    await this.verifyArtifacts(app);
    let record = this.store.get('edgeDeployments', appId);
    if (record && ['STARTING', 'RECOVERY_REQUIRED'].includes(record.state)) {
      if (!await this.recoverProcess(record).catch(() => false)) throw Error('EDGE_PROCESS_RECOVERY_REQUIRED');
    }
    if (record?.leaseEpochs?.[ueId] > epoch) throw Error('EDGE_STALE_EPOCH');
    if (record?.state === 'RUNNING' && await this.probe(record).catch(() => false)) {
      if (record.imageDigest !== imageDigest) throw Error('EDGE_ACTIVE_VERSION');
    } else {
      if (record?.pid && live(record.pid)) {
        await this.store.put('edgeDeployments', appId, { ...record, state: 'RECOVERY_REQUIRED' });
        throw Error('EDGE_PROCESS_IDENTITY_REVIEW');
      }
      const active = this.store.list('edgeDeployments').filter((row) => row.appId !== appId && ['RUNNING', 'STARTING', 'RECOVERY_REQUIRED'].includes(row.state));
      if (active.length >= this.identity.capacity) throw Error('EDGE_CAPACITY');
      const instanceId = randomUUID();
      record = { appId, version, imageDigest, instanceId, state: 'STARTING', startedAt: new Date().toISOString(), leaseEpochs: record?.leaseEpochs ?? {} };
      await this.store.put('edgeDeployments', appId, record);
      const child = spawn(app.executable, app.args, { cwd: app.cwd, env: { ...process.env, ...app.env, BUBBLE_EDGE_HOST_ID: this.identity.hostId,
        BUBBLE_EDGE_INSTANCE_ID: instanceId, BUBBLE_EDGE_IMAGE_DIGEST: imageDigest }, windowsHide: true, stdio: 'ignore', shell: false });
      let processError; child.on('error', (error) => { processError = error; });
      this.children.set(appId, child); record.pid = child.pid ?? null;
      await this.store.put('edgeDeployments', appId, record);
      const deadline = Date.now() + this.startBudgetMs;
      let healthy = false;
      while (!processError && record.pid && live(record.pid) && Date.now() < deadline) {
        if (await this.probe(record).catch(() => false)) { healthy = true; break; }
        await delay(50);
      }
      if (!healthy) {
        if (child.pid && child.exitCode === null) { child.kill(); await this.waitForExit(child.pid); }
        record.state = 'STOPPED'; record.reviewReason = processError?.code ?? 'EDGE_START_HEALTH';
        await this.store.put('edgeDeployments', appId, record); await this.receipt('EDGE_DEPLOYMENT_ROLLED_BACK', record);
        throw Error(record.reviewReason);
      }
      record.state = 'RUNNING'; await this.receipt('EDGE_PROCESS_READY', record);
    }
    record = { ...record, leaseEpochs: { ...record.leaseEpochs, [ueId]: epoch } };
    await this.store.transaction(`edge:${appId}`, async () => {
      await this.store.put('edgeDeployments', appId, record); await this.store.put('edgeOperations', operationId, { intentHash, appId, instanceId: record.instanceId });
    });
    return { ...this.publicRecord(record), healthy: true, operationId };
  }
  async waitForExit(pid) {
    const until = Date.now() + 3000;
    while (live(pid) && Date.now() < until) await delay(25);
    if (live(pid)) throw Error('EDGE_PROCESS_STOP_PENDING');
  }
  release({ appId, ueId, epoch }) { return this.exclusive(async () => {
    const record = this.store.get('edgeDeployments', appId);
    if (!record || record.leaseEpochs?.[ueId] === undefined) return { released: true, stopped: false };
    if (record.leaseEpochs[ueId] !== epoch) throw Error('EDGE_RELEASE_EPOCH');
    const leases = { ...record.leaseEpochs }; delete leases[ueId];
    if (Object.keys(leases).length === 0 && record.pid && live(record.pid)) {
      if (!await this.probe(record).catch(() => false)) throw Error('EDGE_PROCESS_IDENTITY_REVIEW');
      process.kill(record.pid, 'SIGTERM'); await this.waitForExit(record.pid); record.state = 'STOPPED';
    }
    if (Object.keys(leases).length === 0 && (!record.pid || !live(record.pid))) record.state = 'STOPPED';
    record.leaseEpochs = leases; await this.store.put('edgeDeployments', appId, record); await this.receipt('EDGE_LEASE_RELEASED', record);
    return { released: true, stopped: record.state === 'STOPPED' };
  }); }
}

export function createEdgeAgentServer({ supervisor, tls, controllers }) {
  if (!tls?.key || !tls.cert || !tls.ca || !Array.isArray(controllers)) throw Error('EDGE_MTLS_CONFIGURATION');
  return createServer({ ...tls, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true }, async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      const principal = controllers.find((item) => item.fingerprint === request.socket.getPeerCertificate().fingerprint256);
      if (!request.socket.authorized || !principal) return send(403, { error: 'EDGE_CONTROLLER_IDENTITY' });
      if (request.method === 'GET' && request.url === '/v1/edge/inventory') return send(200, await supervisor.inventory());
      if (request.method !== 'POST' || !['/v1/edge/deploy', '/v1/edge/release'].includes(request.url)) return send(404, { error: 'EDGE_ROUTE' });
      if (!String(request.headers['content-type']).startsWith('application/json')) return send(415, { error: 'EDGE_CONTENT_TYPE' });
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 8192) return send(413, { error: 'EDGE_BODY_SIZE' }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!principal.appIds?.includes(body.appId)) return send(403, { error: 'EDGE_APPLICATION_SCOPE' });
      send(200, await (request.url.endsWith('/deploy') ? supervisor.ensure(body) : supervisor.release(body)));
    } catch (error) { send(409, { error: error.code ?? error.message }); }
  });
}

export class EdgeDeploymentClient {
  constructor({ endpoint, hostId, appId, version, imageDigest, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || !identifier(hostId) || !identifier(appId) || !version || !/^[a-f0-9]{64}$/.test(imageDigest)) throw Error('EDGE_ENDPOINT');
    Object.assign(this, { endpoint: endpoint.replace(/\/$/, ''), hostId, appId, version, imageDigest, fetchImpl, timeoutMs });
  }
  async request(path, body) {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    const text = await response.text(); if (Buffer.byteLength(text) > 65536) throw Error('EDGE_RESPONSE_SIZE');
    const value = JSON.parse(text); if (!response.ok) throw Error(`EDGE_HTTP_${response.status}:${value.error ?? 'REVIEW'}`); return value;
  }
  async inventory({ region, zone, capabilities = [] } = {}) {
    const state = await this.request('/v1/edge/inventory');
    const app = state.applications?.find((item) => item.appId === this.appId && item.version === this.version && item.imageDigest === this.imageDigest);
    const existing = state.deployments?.find((item) => item.appId === this.appId && item.imageDigest === this.imageDigest);
    if (state.hostId !== this.hostId || state.protocol !== 'privacy-bubble.edge.v1' || state.status !== 'HEALTHY' || !app
      || !Number.isInteger(state.used) || state.used < 0 || !Number.isInteger(state.capacity) || state.capacity < 1
      || (region && state.region !== region) || (zone && !state.zones?.includes(zone)) || !capabilities.every((value) => app.capabilities?.includes(value))
      || (!existing && state.used >= state.capacity)) throw Error('EDGE_INELIGIBLE');
    return state;
  }
  async ensure({ ueId, epoch, operationId, region, zone, capabilities }) {
    await this.inventory({ region, zone, capabilities });
    const result = await this.request('/v1/edge/deploy', { appId: this.appId, version: this.version, imageDigest: this.imageDigest, ueId, epoch, operationId });
    if (!result.healthy || result.hostId !== this.hostId || result.appId !== this.appId || result.imageDigest !== this.imageDigest || !result.instanceId || !Number.isSafeInteger(result.pid)) throw Error('EDGE_DEPLOYMENT_IDENTITY');
    return result;
  }
  release({ ueId, epoch }) { return this.request('/v1/edge/release', { appId: this.appId, ueId, epoch }); }
}
