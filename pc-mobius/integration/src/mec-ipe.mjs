import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { approvalHash, recordEnvelope } from './integration-utils.mjs';
import { IntegrationStore } from './integration-store.mjs';
import { MecCipher } from './mec-state.mjs';
import { MecPlatformError, normalizeMecNotification } from './mec-platform-client.mjs';
import { Onem2mHttpClient, m2mTime, parseContent } from './onem2m-http-client.mjs';

/**
 * MEC Interworking Proxy Entity (IPE).
 * oneM2M side: registers an AE, publishes the MEC011 catalog as flexContainers and exposes
 * request containers. MEC side: owns MEC013/MEC012 subscriptions. A request cin written by an
 * authorized AE becomes a MEC subscription; every MEC notification becomes a cin under the
 * device AE (location with loc, rnis), so consumers stay on oneM2M only.
 */
export const MEC_SERVICE_CND = 'org.etsi.mec.ipe.mecService';
export const MEC_IPE_SPECIALIZATIONS = {
  [MEC_SERVICE_CND]: {
    typeName: 'mecSvc', namespacePrefix: 'mec',
    attributes: Object.fromEntries([
      ['serName', 'string'], ['serInstanceId', 'string'], ['mecApi', 'string'], ['version', 'string'], ['apiVersion', 'string'], ['state', 'string'], ['endpoint', 'string'], ['category', 'string'],
      ['scopeOfLocality', 'string'], ['consumed', 'boolean'], ['endpointRebased', 'boolean'], ['discoveredAt', 'string'], ['catalogHash', 'string'], ['simulation', 'boolean'],
    ].map(([name, type]) => [name, { type }])),
  },
};
const RN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TYPES = { Location: ['periodic', 'userTracking', 'zone'], RNIS: ['cellChange'] };
const CONTAINERS = { Location: 'location', RNIS: 'rnis' };
const REQUEST_CONTAINERS = { Location: 'locationRequests', RNIS: 'rnisRequests' };
const digest = approvalHash;
const round = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;

export function parseMecRequest(service, con, { maxDurationSec = 3600 } = {}) {
  if (!con || typeof con !== 'object' || Array.isArray(con)) throw new Error('request-schema');
  const op = con.op ?? 'subscribe';
  if (!['subscribe', 'renew', 'unsubscribe'].includes(op)) throw new Error('request-op');
  if (typeof con.requestId !== 'string' || !REQUEST_ID.test(con.requestId)) throw new Error('request-id');
  const request = { op, requestId: con.requestId };
  if (op !== 'subscribe') return request;
  if (typeof con.deviceAe !== 'string' || !RN.test(con.deviceAe)) throw new Error('request-device');
  if (typeof con.ueAddress !== 'string' || !con.ueAddress || con.ueAddress.length > 128) throw new Error('request-ue');
  const type = con.type ?? TYPES[service][0];
  if (!TYPES[service].includes(type)) throw new Error('request-type');
  const durationSec = con.durationSec ?? 300;
  if (!Number.isInteger(durationSec) || durationSec < 10 || durationSec > maxDurationSec) throw new Error('request-duration');
  const periodSec = con.periodSec ?? 5;
  if (!Number.isInteger(periodSec) || periodSec < 1 || periodSec > 3600) throw new Error('request-period');
  if (type === 'zone' && (typeof con.zoneId !== 'string' || !RN.test(con.zoneId))) throw new Error('request-zone');
  let intent = null;
  if (con.intent !== undefined) {
    const value = con.intent;
    if (!value || typeof value !== 'object' || typeof value.policyId !== 'string' || typeof value.grantId !== 'string' || !Number.isInteger(value.grantRevision) || (value.policyRevision !== undefined && !Number.isInteger(value.policyRevision))) throw new Error('request-intent');
    intent = { policyId: value.policyId, grantId: value.grantId, grantRevision: value.grantRevision, ...(value.policyRevision !== undefined ? { policyRevision: value.policyRevision } : {}) };
  }
  return { ...request, deviceAe: con.deviceAe, ueAddress: con.ueAddress, type, durationSec, periodSec, zoneId: con.zoneId ?? null, intent };
}

export class MecIpe {
  constructor({ cse, originator, aeName = 'mec-ipe', api = 'N.privacy.bubble.mec-ipe', platform, consume = ['Location', 'RNIS'], requesters = {}, readers = [], readerAcop = 35, cipher = null, encryptionKey = null, store = null, authorize = null, clock = () => Date.now(), listen = {}, publicBaseUrl = null, onem2mBaseUrl = null, staleMs = 30000, futureMs = 2000, leaseSec = 120, renewBeforeMs = 10000, renewCheckMs = 5000, maxDurationSec = 3600, locPrecision = 3, retentionMs = 24 * 60 * 60 * 1000, cellLocations = {}, simulation = false, intakeName = 'mec-ipe-intake', watchName = 'mec-ipe-watch', trace = () => {} } = {}) {
    if (!cse?.endpoint || !originator || !platform) throw new Error('MecIpe needs cse.endpoint, originator and platform');
    Object.assign(this, { cse: { cseBase: '/Mobius', cseId: null, ...cse }, originator, aeName, api, platform, consume: consume.filter((name) => TYPES[name]), requesters, readers, readerAcop, authorize, clock, listen: { host: '127.0.0.1', port: 0, ...listen }, publicBaseUrl, onem2mBaseUrl, staleMs, futureMs, leaseSec, renewBeforeMs, renewCheckMs, maxDurationSec, locPrecision, retentionMs, cellLocations, simulation, intakeName, watchName, traceSink: trace });
    this.store = store ?? new IntegrationStore();
    this.cipher = cipher ?? new MecCipher({ store: { path: null }, encryptionKey });
    // cse.fetchImpl lets an IPE on a MEC host reach an HTTPS CSE with a pinned CA (createMecFetch).
    this.client = new Onem2mHttpClient({ endpoint: this.cse.endpoint, cseBase: this.cse.cseBase, originator, ...(this.cse.fetchImpl ? { fetchImpl: this.cse.fetchImpl } : {}) });
    this.queues = new Map(); this.pending = new Set(); this.acps = {}; this.paths = {}; this.secrets = new Map();
  }
  /** UE address and callback token stay sealed (AES-256-GCM) in the IPE state file. */
  secret(record) {
    if (!this.secrets.has(record.key)) this.secrets.set(record.key, this.cipher.open(record.sealed, `ipe-request:${record.key}`));
    return this.secrets.get(record.key);
  }
  iso(ms = this.clock()) { return new Date(ms).toISOString(); }
  trace(step, details = {}) { const entry = { at: this.iso(), actor: 'mec-ipe', step, ...details }; this.traceSink(entry); return entry; }
  async receipt(type, details) { return this.store.append('receipts', recordEnvelope({ type, simulation: this.simulation, ...details }, () => this.iso())); }
  serial(key, task) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => {});
    this.queues.set(key, settled);
    settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return next;
  }
  background(task) {
    const running = Promise.resolve().then(task).catch((error) => this.trace('IPE_TASK_REVIEW', { reason: error.code ?? error.message }));
    this.pending.add(running); running.finally(() => this.pending.delete(running));
    return running;
  }
  async idle() { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  async start() {
    await this.store.init(); await this.cipher.ready;
    this.server = createServer((request, response) => this.route(request, response));
    this.server.listen(this.listen.port, this.listen.host); await once(this.server, 'listening');
    this.baseUrl = `http://${this.listen.host}:${this.server.address().port}`;
    this.mecBase = (this.publicBaseUrl ?? this.baseUrl).replace(/\/+$/, '');
    this.onem2mBase = (this.onem2mBaseUrl ?? this.baseUrl).replace(/\/+$/, '');
    this.ae = await this.client.registerAe({ rn: this.aeName, api: this.api, poa: [this.onem2mBase], lbl: ['pb:mec-ipe'] });
    this.aePath = this.ae.path;
    this.trace('IPE_AE_REGISTERED', { aePath: this.aePath, aei: this.ae.aei, rsc: this.ae.rsc });
    const owner = { acor: [this.originator], acop: 63 };
    const requesterIds = [...new Set(this.consume.flatMap((service) => this.requesters[service] ?? []))];
    this.acps.requests = await this.ensureAcp('mec-requests-acp', [owner, ...(requesterIds.length ? [{ acor: requesterIds, acop: 1 }] : [])]);
    this.acps.catalog = await this.ensureAcp('mec-catalog-acp', [owner, ...(this.readers.length ? [{ acor: this.readers, acop: this.readerAcop }] : [])]);
    this.paths.services = (await this.client.ensure(this.aePath, 3, { 'm2m:cnt': { rn: 'mecServices', acpi: [this.acps.catalog.ri], lbl: ['pb:mec-catalog'] } })).path;
    this.paths.status = (await this.client.ensure(this.aePath, 3, { 'm2m:cnt': { rn: 'requestStatus', acpi: [this.acps.catalog.ri], mni: 500, lbl: ['pb:mec-request-status'] } })).path;
    for (const service of this.consume) {
      this.paths[service] = (await this.client.ensure(this.aePath, 3, { 'm2m:cnt': { rn: REQUEST_CONTAINERS[service], acpi: [this.acps.requests.ri], mni: 200, lbl: [`pb:mec-${service.toLowerCase()}-requests`] } })).path;
    }
    this.catalog = await this.discoverAndPublish();
    if (this.platform.appInstanceId) {
      try { const ready = await this.platform.confirmReady(); this.readyResult = { status: ready?.status ?? null }; this.trace('MEC011_CONFIRM_READY', { status: ready?.status }); }
      catch (error) { this.readyResult = { status: error.status ?? null, reason: error.code ?? error.message }; this.trace('MEC011_CONFIRM_READY_REVIEW', { reason: error.code ?? error.message, status: error.status ?? null }); }
    }
    for (const service of this.consume) await this.subscribe(this.paths[service], this.intakeName, [3, 4], { kind: 'intake', service });
    this.timer = setInterval(() => this.background(() => this.renewDue()), this.renewCheckMs); this.timer.unref?.();
    return { aePath: this.aePath, aei: this.ae.aei, paths: this.paths, catalog: this.catalog };
  }
  async ensureAcp(rn, acr) {
    const pvs = { acr: [{ acor: [this.originator], acop: 63 }] };
    const result = await this.client.ensure(this.aePath, 1, { 'm2m:acp': { rn, pv: { acr }, pvs } });
    if (!result.created) await this.client.update(result.path, { 'm2m:acp': { pv: { acr } } });
    return result;
  }
  /** oneM2M subscription owned by the IPE, bound to an opaque per-subscription route token. */
  async subscribe(parent, rn, net, route) {
    const token = randomBytes(32).toString('base64url');
    const routeHash = digest(token);
    const subscriptionPath = `${this.client.path(parent)}/${rn}`;
    await this.store.put('ipeRoutes', routeHash, { ...route, routeHash, subscriptionPath, state: 'ACTIVE' });
    const body = { 'm2m:sub': { rn, nu: [`${this.onem2mBase}/onem2m/${token}`], enc: { net }, nct: 1 } };
    let created = await this.client.create(parent, 23, body);
    if (created.rsc === 4105) { await this.client.remove(subscriptionPath); created = await this.client.create(parent, 23, body); }
    if (created.rsc !== 2001) { await this.store.put('ipeRoutes', routeHash, { ...route, routeHash, subscriptionPath, state: 'FAILED', rsc: created.rsc }); throw Object.assign(new Error(`subscription ${subscriptionPath} ${created.rsc}`), { code: 'ONEM2M_SUBSCRIPTION_REVIEW', rsc: created.rsc }); }
    this.trace('ONEM2M_SUBSCRIPTION_CREATED', { subscriptionPath, net, kind: route.kind, service: route.service ?? null, rsc: created.rsc });
    return { subscriptionPath, routeHash, rsc: created.rsc };
  }

  /** MEC011 discovery; each service becomes a mec:mecSvc flexContainer (container+cin when the CSE lacks the specialization). */
  async discoverAndPublish() {
    const discovery = await this.platform.discoverServices();
    this.platform.bind(discovery.services);
    const discoveredAt = this.iso();
    const published = []; const used = new Set();
    for (const record of discovery.services) {
      // A catalog can hold several instances of one service (e.g. a restarted MEC service that did not
      // deregister); each instance keeps its own flexContainer.
      let rn = RN.test(record.key) ? record.key : `svc-${digest(record.serName ?? record.key).slice(0, 12)}`;
      if (used.has(rn)) rn = `${rn}-${String(record.serInstanceId ?? digest(record)).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
      used.add(rn);
      const attributes = Object.fromEntries(Object.entries({ serName: record.serName, serInstanceId: record.serInstanceId, mecApi: record.mecApi, version: record.version, apiVersion: record.apiVersion, state: record.state, endpoint: record.endpoint, category: record.category, scopeOfLocality: record.scopeOfLocality, consumed: this.consume.includes(record.key), endpointRebased: record.endpointRebased, discoveredAt, catalogHash: discovery.catalogHash, simulation: this.simulation }).filter(([, value]) => value !== null && value !== undefined));
      const path = `${this.paths.services}/${rn}`;
      let representation = 'flexContainer';
      let response = await this.client.create(this.paths.services, 28, { 'mec:mecSvc': { rn, cnd: MEC_SERVICE_CND, acpi: [this.acps.catalog.ri], lbl: ['pb:mec-service', `mec:${record.mecApi}`], ...attributes } });
      if (response.rsc === 4105) response = await this.client.update(path, { 'mec:mecSvc': attributes });
      if (![2001, 2004].includes(response.rsc)) {
        representation = 'container';
        const container = await this.client.create(this.paths.services, 3, { 'm2m:cnt': { rn, acpi: [this.acps.catalog.ri], mni: 10, lbl: ['pb:mec-service', `mec:${record.mecApi}`] } });
        if (![2001, 4105].includes(container.rsc)) throw Object.assign(new Error(`publish ${rn} ${container.rsc}`), { code: 'ONEM2M_PUBLISH_REVIEW' });
        response = await this.client.create(path, 4, { 'm2m:cin': { cnf: 'application/json', con: attributes } });
      }
      published.push({ key: record.key, rn, path, representation, rsc: response.rsc, mecApi: record.mecApi, state: record.state, consumed: attributes.consumed, endpoint: record.endpoint, apiVersion: record.apiVersion });
      await this.store.put('ipeServices', record.key, { ...record, rn, path, representation, discoveredAt });
    }
    let group = null;
    const members = published.filter((item) => item.representation === 'flexContainer').map((item) => item.path.replace(/^\//, ''));
    if (members.length) {
      const body = { 'm2m:grp': { rn: 'mecServiceGroup', mt: 28, mnm: Math.max(members.length, 16), mid: members, csy: 1, acpi: [this.acps.catalog.ri], lbl: ['pb:mec-catalog-group'] } };
      // A <group> is a child of the AE (Mobius4 refuses it under a <container> with 4108).
      let response = await this.client.create(this.aePath, 9, body);
      if (response.rsc === 4105) response = await this.client.update(`${this.aePath}/mecServiceGroup`, { 'm2m:grp': { mid: members } });
      group = { path: `${this.aePath}/mecServiceGroup`, rsc: response.rsc, members: members.length };
    }
    this.trace('MEC011_DISCOVERY_PUBLISHED', { catalogHash: discovery.catalogHash, services: published.map(({ key, mecApi, representation, rsc, consumed }) => ({ key, mecApi, representation, rsc, consumed })), group });
    await this.receipt('MEC_IPE_DISCOVERY', { catalogHash: discovery.catalogHash, services: published.length });
    return { catalogHash: discovery.catalogHash, httpStatus: discovery.status, services: published, group };
  }

  async route(request, response) {
    const url = new URL(request.url, 'http://ipe');
    const reply = (status, headers = {}, body) => { response.writeHead(status, { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }); response.end(body ? JSON.stringify(body) : undefined); };
    if (request.method !== 'POST') return reply(405);
    let payload;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 65536) return reply(413); chunks.push(chunk); }
      payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    } catch { return reply(400); }
    const onem2m = url.pathname.match(/^\/onem2m\/([A-Za-z0-9_-]{43})$/);
    if (onem2m) {
      const result = await this.onOnem2mNotification(onem2m[1], payload, request.headers);
      return reply(result.ok ? 200 : 403, { 'X-M2M-RSC': result.ok ? '2000' : '4103', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' });
    }
    const mec = url.pathname.match(/^\/mec\/(Location|RNIS)\/([A-Za-z0-9_-]{43})$/);
    if (mec) {
      const result = await this.onMecNotification(mec[1], mec[2], payload);
      return reply(result.httpStatus, {}, result.httpStatus === 204 ? undefined : { status: result.status });
    }
    const extra = await this.extraRoute(url.pathname, payload, request.headers);
    if (extra) return reply(extra.httpStatus ?? 204, {}, extra.body);
    reply(404);
  }

  async onOnem2mNotification(token, body, headers = {}) {
    const route = this.store.get('ipeRoutes', digest(token));
    const signal = body?.['m2m:sgn'];
    if (!route || route.state !== 'ACTIVE' || !signal) return { ok: false };
    if (signal.vrq) return { ok: true, verification: true };
    if (this.cse.cseId && headers['x-m2m-origin'] && headers['x-m2m-origin'] !== this.cse.cseId) return { ok: false };
    const sur = `/${String(signal.sur ?? '').replace(/^\/+/, '')}`;
    if (sur !== route.subscriptionPath) return { ok: false };
    if (signal.sud) { await this.store.put('ipeRoutes', route.routeHash, { ...route, state: 'DELETED' }); return { ok: true }; }
    const net = signal.nev?.net; const rep = signal.nev?.rep ?? {};
    if (route.kind === 'intake' && rep['m2m:cin']) {
      const cin = rep['m2m:cin'];
      if (net === 3) this.background(() => this.onRequestCin(route.service, cin));
      if (net === 4) this.background(() => this.onRequestDeleted(route.service, cin));
    }
    if (route.kind === 'device' && net === 2) this.background(() => this.onDeviceDeleted(route.devicePath));
    if (!['intake', 'device'].includes(route.kind)) this.background(() => this.onRouteNotification(route, net, rep));
    return { ok: true };
  }
  /** Subclass hook: notifications on IPE-owned subscriptions of other kinds. */
  async onRouteNotification() { return null; }
  /** Subclass hook: extra HTTP routes (MEC011/MEC021 callbacks); returns { httpStatus, body } or null. */
  async extraRoute() { return null; }
  /** Subclass hook: fields added to every status and observation cin (e.g. the serving MEC host). */
  observationExtras() { return {}; }

  async writeStatus(entry) {
    const con = { ...entry, ...this.observationExtras(), at: this.iso(), simulation: this.simulation };
    const result = await this.client.create(this.paths.status, 4, { 'm2m:cin': { cnf: 'application/json', con, lbl: ['pb:mec-request-status', `pb:state:${entry.state}`], et: m2mTime(this.clock() + this.retentionMs) } });
    return { rsc: result.rsc, ri: result.payload?.['m2m:cin']?.ri ?? null };
  }

  async onRequestCin(service, cin) {
    const creator = cin.cr ?? null;
    let request;
    try { request = parseMecRequest(service, parseContent(cin.con), { maxDurationSec: this.maxDurationSec }); }
    catch (error) {
      this.trace('ONEM2M_REQUEST_REJECTED', { service, requestRi: cin.ri, reason: error.message });
      return this.writeStatus({ service, requestRi: cin.ri, state: 'REJECTED', reason: error.message });
    }
    if (!creator || !(this.requesters[service] ?? []).includes(creator)) {
      this.trace('ONEM2M_REQUEST_REJECTED', { service, requestId: request.requestId, reason: 'requester-not-authorized' });
      return this.writeStatus({ service, requestId: request.requestId, state: 'REJECTED', reason: 'requester-not-authorized' });
    }
    const key = digest({ service, requestId: request.requestId, creator });
    this.trace('ONEM2M_REQUEST_RECEIVED', { service, op: request.op, requestId: request.requestId, requestRi: cin.ri, creator, type: request.type ?? null });
    return this.serial(key, async () => {
      if (request.op === 'unsubscribe') return this.teardown(key, 'requester-unsubscribe');
      if (request.op === 'renew') return this.renew(key, { force: true });
      const existing = this.store.get('ipeRequests', key);
      if (existing && ['ACTIVE', 'CREATING'].includes(existing.state)) return this.writeStatus({ service, requestId: request.requestId, state: 'DUPLICATE', mecSubscriptionId: existing.mecSubscriptionId });
      const decision = this.authorize ? await this.authorize({ service, request, creator, phase: 'subscribe' }) : { allowed: true };
      if (!decision?.allowed) {
        this.trace('ONEM2M_REQUEST_REJECTED', { service, requestId: request.requestId, reason: decision?.reason ?? 'authorization' });
        return this.writeStatus({ service, requestId: request.requestId, state: 'REJECTED', reason: decision?.reason ?? 'authorization' });
      }
      const devicePath = `${this.client.cseBase}/${request.deviceAe}`;
      const container = `${devicePath}/${CONTAINERS[service]}`;
      const check = await this.client.retrieve(container);
      if (check.rsc !== 2000) return this.writeStatus({ service, requestId: request.requestId, state: 'REJECTED', reason: 'device-container-unavailable', rsc: check.rsc });
      const token = randomBytes(32).toString('base64url');
      const now = this.clock();
      const until = now + request.durationSec * 1000;
      const expiresAtMs = Math.min(now + this.leaseSec * 1000, until);
      const secrets = { address: request.ueAddress, callbackUrl: `${this.mecBase}/mec/${service}/${token}` };
      this.secrets.set(key, secrets);
      const record = { key, service, type: request.type, requestId: request.requestId, creator, deviceId: request.deviceAe, devicePath, container, sealed: this.cipher.seal(secrets, `ipe-request:${key}`), ueRef: digest(request.ueAddress).slice(0, 16), clientCorrelator: `pb-${key.slice(0, 24)}`, periodSec: request.periodSec, zoneId: request.zoneId, intent: request.intent, until: this.iso(until), state: 'CREATING', routeHash: digest(token), requestRi: cin.ri, createdAt: this.iso(now), renewals: 0, recreations: 0 };
      await this.store.put('ipeRoutes', record.routeHash, { kind: 'mec', key, service, routeHash: record.routeHash, state: 'ACTIVE' });
      await this.store.put('ipeRequests', key, record);
      let created;
      try { created = await this.platform.createSubscription(service, record.type, { ...secrets, clientCorrelator: record.clientCorrelator, expiresAtMs, periodSec: record.periodSec, zoneId: record.zoneId }); }
      catch (error) {
        await this.store.put('ipeRequests', key, { ...record, state: 'FAILED', reason: error.code ?? error.message });
        await this.store.put('ipeRoutes', record.routeHash, { kind: 'mec', key, service, routeHash: record.routeHash, state: 'TOMBSTONED' });
        this.trace('MEC_SUBSCRIPTION_CREATE_REVIEW', { service, requestId: request.requestId, reason: error.code ?? error.message, status: error.status ?? null });
        return this.writeStatus({ service, requestId: request.requestId, state: 'REJECTED', reason: error.code ?? 'mec-create' });
      }
      const active = { ...record, state: 'ACTIVE', resourceUrl: created.resourceUrl, mecSubscriptionId: created.subscriptionId, expiresAt: this.iso(expiresAtMs), requestHash: created.requestHash };
      await this.store.put('ipeRequests', key, active);
      this.trace('MEC_SUBSCRIPTION_CREATED', { service, mecApi: service === 'Location' ? 'MEC013' : 'MEC012', type: record.type, requestId: record.requestId, mecSubscriptionId: created.subscriptionId, httpStatus: created.status, expiresAt: active.expiresAt, ueRef: record.ueRef });
      await this.receipt('MEC_IPE_SUBSCRIPTION_CREATED', { service, requestId: record.requestId, mecSubscriptionId: created.subscriptionId, requestHash: created.requestHash });
      await this.watchDevice(devicePath);
      return this.writeStatus({ service, requestId: record.requestId, deviceId: record.deviceId, state: 'ACTIVE', type: record.type, mecSubscriptionId: created.subscriptionId, expiresAt: active.expiresAt, until: active.until, intent: record.intent });
    });
  }
  async onRequestDeleted(service, cin) {
    const record = this.store.list('ipeRequests').find((item) => item.service === service && item.requestRi === cin.ri && item.state === 'ACTIVE');
    if (record) return this.serial(record.key, () => this.teardown(record.key, 'request-deleted'));
    return null;
  }
  async watchDevice(devicePath) {
    return this.serial(`device:${devicePath}`, () => this.ensureDeviceWatch(devicePath));
  }
  async ensureDeviceWatch(devicePath) {
    if (this.store.get('ipeDevices', devicePath)?.state === 'ACTIVE') return;
    try {
      const watch = await this.subscribe(devicePath, this.watchName, [2], { kind: 'device', devicePath });
      await this.store.put('ipeDevices', devicePath, { devicePath, state: 'ACTIVE', subscriptionPath: watch.subscriptionPath });
    } catch (error) {
      await this.store.put('ipeDevices', devicePath, { devicePath, state: 'WATCH_UNAVAILABLE', rsc: error.rsc ?? null });
      this.trace('DEVICE_WATCH_REVIEW', { devicePath, rsc: error.rsc ?? null });
    }
  }
  async onDeviceDeleted(devicePath) {
    this.trace('DEVICE_AE_DEREGISTERED', { devicePath });
    await this.store.put('ipeDevices', devicePath, { devicePath, state: 'DELETED' });
    const affected = this.store.list('ipeRequests').filter((item) => item.devicePath === devicePath && item.state === 'ACTIVE');
    for (const item of affected) await this.serial(item.key, () => this.teardown(item.key, 'device-deregistered'));
    return affected.length;
  }
  async teardown(key, reason, { finalState = 'DELETED' } = {}) {
    const record = this.store.get('ipeRequests', key);
    if (!record || !['ACTIVE', 'CREATING', 'DELETE_REVIEW'].includes(record.state)) return null;
    let providerStatus = null; let state = finalState;
    // Callbacks that arrive while the provider DELETE is in flight are tombstoned at once.
    await this.store.put('ipeRequests', key, { ...record, state: 'DELETING' });
    if (record.resourceUrl) {
      try { providerStatus = (await this.platform.deleteSubscription(record.service, record.type, record.resourceUrl)).status; }
      catch (error) { providerStatus = error.status ?? null; state = 'DELETE_REVIEW'; }
    }
    await this.store.put('ipeRequests', key, { ...record, state, reason, deletedAt: this.iso(), providerStatus });
    if (state === finalState) await this.store.put('ipeRoutes', record.routeHash, { kind: 'mec', key, service: record.service, routeHash: record.routeHash, state: 'TOMBSTONED' });
    this.trace('MEC_SUBSCRIPTION_DELETED', { service: record.service, requestId: record.requestId, mecSubscriptionId: record.mecSubscriptionId, reason, providerStatus, state });
    await this.receipt('MEC_IPE_SUBSCRIPTION_DELETED', { service: record.service, requestId: record.requestId, mecSubscriptionId: record.mecSubscriptionId, reason, providerStatus });
    try { await this.writeStatus({ service: record.service, requestId: record.requestId, deviceId: record.deviceId, state, reason, mecSubscriptionId: record.mecSubscriptionId, providerStatus }); } catch { /* status container may already be gone */ }
    return { state, providerStatus };
  }
  async renewDue() {
    const now = this.clock();
    for (const record of this.store.list('ipeRequests').filter((item) => item.state === 'ACTIVE')) {
      if (Date.parse(record.until) <= now) await this.serial(record.key, () => this.teardown(record.key, 'request-duration-elapsed'));
      else if (Date.parse(record.expiresAt) - now <= this.renewBeforeMs) await this.serial(record.key, () => this.renew(record.key));
    }
  }
  async renew(key, { force = false } = {}) {
    const record = this.store.get('ipeRequests', key);
    if (!record || record.state !== 'ACTIVE') return null;
    const now = this.clock();
    if (!force && Date.parse(record.expiresAt) - now > this.renewBeforeMs) return null;
    if (this.authorize) {
      const decision = await this.authorize({ service: record.service, request: record, creator: record.creator, phase: 'renew' });
      if (!decision?.allowed) return this.teardown(key, decision?.reason ?? 'authorization-revoked');
    }
    const expiresAtMs = Math.min(now + this.leaseSec * 1000, Date.parse(record.until));
    const params = { ...this.secret(record), clientCorrelator: record.clientCorrelator, expiresAtMs, periodSec: record.periodSec, zoneId: record.zoneId };
    let next;
    try {
      const updated = await this.platform.updateSubscription(record.service, record.type, record.resourceUrl, params);
      next = { ...record, expiresAt: this.iso(expiresAtMs), renewals: record.renewals + 1, lastRenewStatus: updated.status };
      this.trace('MEC_SUBSCRIPTION_RENEWED', { service: record.service, requestId: record.requestId, mecSubscriptionId: record.mecSubscriptionId, httpStatus: updated.status, expiresAt: next.expiresAt });
    } catch (error) {
      if (![404, 410].includes(error.status)) { this.trace('MEC_SUBSCRIPTION_RENEW_REVIEW', { service: record.service, requestId: record.requestId, reason: error.code, status: error.status ?? null }); return null; }
      const created = await this.platform.createSubscription(record.service, record.type, params);
      next = { ...record, resourceUrl: created.resourceUrl, mecSubscriptionId: created.subscriptionId, expiresAt: this.iso(expiresAtMs), recreations: record.recreations + 1 };
      this.trace('MEC_SUBSCRIPTION_RECREATED', { service: record.service, requestId: record.requestId, previous: record.mecSubscriptionId, mecSubscriptionId: created.subscriptionId, providerStatus: error.status });
    }
    await this.store.put('ipeRequests', key, next);
    await this.writeStatus({ service: record.service, requestId: record.requestId, deviceId: record.deviceId, state: 'RENEWED', mecSubscriptionId: next.mecSubscriptionId, expiresAt: next.expiresAt });
    return next;
  }

  async onMecNotification(service, token, payload) {
    const routeHash = digest(token);
    const route = this.store.get('ipeRoutes', routeHash);
    if (!route || route.kind !== 'mec' || route.service !== service) { this.trace('MEC_CALLBACK_REVIEW', { service, status: 'UNKNOWN_ROUTE' }); return { httpStatus: 404, status: 'UNKNOWN_ROUTE' }; }
    // Callbacks are ordered on their own per-request queue. A MEC platform can hold a notification
    // request open while it serves our PUT/DELETE on the same subscription (the ETSI MEC Sandbox
    // loc-serv does), so a callback never waits behind a renew or teardown of its own request.
    return this.serial(`notify:${route.key}`, async () => {
      const record = this.store.get('ipeRequests', route.key);
      const review = (status, httpStatus = 204, details = {}) => { this.trace('MEC_CALLBACK_REVIEW', { service, requestId: record?.requestId ?? null, status, ...details }); return { httpStatus, status }; };
      if (!record || record.state !== 'ACTIVE' || route.state !== 'ACTIVE') return review('TOMBSTONE');
      this.trace('MEC_NOTIFICATION_RECEIVED', { service, requestId: record.requestId, mecSubscriptionId: record.mecSubscriptionId, notificationType: payload?.notificationType ?? Object.keys(payload ?? {})[0] ?? null });
      let note;
      try { note = normalizeMecNotification(service, payload); } catch (error) { return review(error.code === 'MEC_BINDING_REVIEW' ? 'BINDING_REVIEW' : 'SCHEMA_REVIEW', 400, { cause: error.code === 'MEC_BINDING_REVIEW' ? 'notification-type' : 'schema' }); }
      // The renewal runs after the callback answers (idle() awaits it), so the platform is not blocked on us.
      if (note.kind === 'expiry') { this.background(() => this.serial(route.key, () => this.renew(route.key, { force: true }))); return review('EXPIRY_RENEWED'); }
      const { address } = this.secret(record);
      if (note.address && note.address !== address) return review('BINDING_REVIEW', 403, { cause: 'address' });
      if (note.subscriptionHref) {
        let normalized = null;
        try { normalized = this.platform.resourceUrl(service, record.type, note.subscriptionHref); } catch { normalized = null; }
        if (normalized !== record.resourceUrl) return review('BINDING_REVIEW', 403, { cause: 'subscription-link', subscriptionId: String(note.subscriptionHref).split('/').at(-1), expectedSubscriptionId: record.mecSubscriptionId });
      }
      if (this.authorize) {
        const decision = await this.authorize({ service, request: record, creator: record.creator, phase: 'notification' });
        if (!decision?.allowed) { this.background(() => this.serial(route.key, () => this.teardown(route.key, decision?.reason ?? 'authorization-revoked'))); return review('REVOKED'); }
      }
      const sourceHash = digest(payload);
      const eventKey = digest({ service, key: route.key, eventId: note.eventId, observedAt: note.observedAt, sourceHash: note.eventId ? null : sourceHash });
      if (this.store.get('ipeDedup', eventKey)) return review('DUPLICATE', 204, { eventKey });
      if (!note.observedAt) return review('TIME_UNKNOWN', 204, { eventKey });
      const now = this.clock(); const age = now - Date.parse(note.observedAt);
      if (age > this.staleMs) return review('STALE', 204, { eventKey, ageMs: age });
      if (-age > this.futureMs) return review('FUTURE', 204, { eventKey, ageMs: age });
      const watermark = this.store.get('ipeWatermarks', route.key);
      if (watermark && Date.parse(note.observedAt) < Date.parse(watermark.observedAt)) return review('OUT_OF_ORDER', 204, { eventKey });
      if (service === 'Location' && !note.location) {
        try { const queried = await this.platform.queryUser(address); if (queried) note = { ...note, location: { lat: queried.lat, lon: queried.lon, accuracyM: queried.accuracyM }, zoneId: note.zoneId ?? queried.zoneId, accessPointId: note.accessPointId ?? queried.accessPointId, locationSource: 'MEC013-query' }; }
        catch { /* the zonal event still lacks coordinates */ }
        if (!note.location) return review('LOCATION_UNAVAILABLE', 204, { eventKey });
      }
      const written = await this.writeObservation(record, note, eventKey, sourceHash);
      if (written.rsc !== 2001) return review('ONEM2M_WRITE_REVIEW', written.rsc >= 5000 || !written.rsc ? 503 : 204, { rsc: written.rsc });
      const expiresAt = this.iso(now + this.retentionMs);
      await this.store.put('ipeDedup', eventKey, { eventKey, expiresAt });
      await this.store.put('ipeWatermarks', route.key, { observedAt: note.observedAt, eventKey, expiresAt });
      return { httpStatus: 204, status: 'ACCEPTED', eventKey };
    });
  }
  async writeObservation(record, note, eventKey, sourceHash) {
    const receivedAt = this.iso();
    const base = { deviceId: record.deviceId, requestId: record.requestId, mecSubscriptionId: record.mecSubscriptionId, eventKey, sourceHash, notificationType: note.notificationType, observedAt: note.observedAt, receivedAt, clockQuality: 'VERIFIED', intent: record.intent, ...this.observationExtras(), simulation: this.simulation };
    let con; let loc = null;
    if (record.service === 'Location') {
      const precise = this.cipher.seal({ lat: note.location.lat, lon: note.location.lon, accuracyM: note.location.accuracyM }, `${record.deviceId}:${eventKey}`);
      loc = { typ: 1, crd: JSON.stringify([round(note.location.lon, this.locPrecision), round(note.location.lat, this.locPrecision)]) };
      con = { schema: 'pb.mec.location.v1', service: 'Location', mecApi: 'MEC013', ...base, event: note.event, zoneId: note.zoneId, accessPointId: note.accessPointId, accuracyM: note.location.accuracyM, locationSource: note.locationSource ?? 'MEC013-notification', locPrecisionDecimals: this.locPrecision, precise };
    } else {
      const cell = this.cellLocations[note.trgCellId];
      if (cell) loc = { typ: 1, crd: JSON.stringify([round(cell.lon, this.locPrecision), round(cell.lat, this.locPrecision)]) };
      con = { schema: 'pb.mec.rnis.v1', service: 'RNIS', mecApi: 'MEC012', ...base, hoStatus: note.hoStatus, srcCellId: note.srcCellId, trgCellId: note.trgCellId, plmn: note.plmn, networkLocation: cell ? 'cell-centroid' : null };
    }
    const result = await this.client.create(record.container, 4, { 'm2m:cin': { cnf: 'application/json', con, ...(loc ? { loc } : {}), lbl: [`pb:mec-${record.service.toLowerCase()}`, `pb:device:${record.deviceId}`], et: m2mTime(this.clock() + this.retentionMs), cr: null } });
    const written = { rsc: result.rsc, ri: result.payload?.['m2m:cin']?.ri ?? null, path: result.payload?.['m2m:cin']?.rn ? `${record.container}/${result.payload['m2m:cin'].rn}` : null, loc };
    if (result.rsc !== 2001) return written;
    this.trace('ONEM2M_OBSERVATION_WRITTEN', { service: record.service, requestId: record.requestId, mecSubscriptionId: record.mecSubscriptionId, eventKey, cinPath: written.path, cinRi: written.ri, rsc: written.rsc, loc, observedAt: note.observedAt, ...(record.service === 'RNIS' ? { hoStatus: note.hoStatus, srcCellId: note.srcCellId, trgCellId: note.trgCellId } : { zoneId: note.zoneId, event: note.event ?? null, locationSource: note.locationSource ?? 'MEC013-notification' }) });
    if (loc) await this.client.update(record.container, { 'm2m:cnt': { loc } });
    return written;
  }
  snapshot() {
    return {
      aePath: this.aePath, aei: this.ae?.aei ?? null,
      requests: this.store.list('ipeRequests').map(({ sealed, routeHash, ...item }) => item),
      services: this.store.list('ipeServices').map(({ key, mecApi, state, representation, apiVersion, endpointRebased }) => ({ key, mecApi, state, representation, apiVersion, endpointRebased })),
      devices: this.store.list('ipeDevices'),
    };
  }
  async stop({ teardown = false } = {}) {
    clearInterval(this.timer); this.timer = null;
    await this.idle();
    if (teardown) for (const record of this.store.list('ipeRequests').filter((item) => item.state === 'ACTIVE')) await this.serial(record.key, () => this.teardown(record.key, 'ipe-shutdown'));
    if (this.server) { this.server.closeAllConnections?.(); await new Promise((resolve) => this.server.close(resolve)); this.server = null; }
    await this.store.close?.();
  }
}

export { MecPlatformError };
