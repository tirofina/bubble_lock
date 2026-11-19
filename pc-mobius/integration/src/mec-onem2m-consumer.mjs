import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { approvalHash } from './integration-utils.mjs';
import { Onem2mHttpClient, parseContent } from './onem2m-http-client.mjs';

const digest = approvalHash;

/** GeoJSON polygon ring for a bbox or circle geofence, [lon, lat] order as used by oneM2M loc. */
export function geofencePolygon(geofence, segments = 16) {
  if (geofence?.type === 'bbox') return [[[geofence.minLon, geofence.minLat], [geofence.maxLon, geofence.minLat], [geofence.maxLon, geofence.maxLat], [geofence.minLon, geofence.maxLat], [geofence.minLon, geofence.minLat]]];
  if (geofence?.type === 'circle') {
    const ring = [];
    const dLat = geofence.radiusM / 111320; const dLon = geofence.radiusM / (111320 * Math.cos(geofence.lat * Math.PI / 180));
    for (let index = 0; index < segments; index++) { const angle = 2 * Math.PI * index / segments; ring.push([geofence.lon + dLon * Math.cos(angle), geofence.lat + dLat * Math.sin(angle)]); }
    ring.push(ring[0]);
    return [ring];
  }
  throw new Error('geofence type');
}

/**
 * Policy-side consumer that reads MEC-derived observations from oneM2M only.
 * It subscribes to <device-AE>/location and <device-AE>/rnis, fuses MEC013 position with the
 * MEC012 serving cell, and drives MecPolicyReconciler (geofence + handover trigger).
 */
export class MecOneM2mConsumer {
  constructor({ cse, originator, aeName = 'mec-policy', api = 'N.privacy.bubble.mec-policy', ipeOriginator, cipher, reconciler, store, handoverCoordinator = null, clock = () => Date.now(), listen = {}, onem2mBaseUrl = null, networkMaxAgeMs = 120000, trace = () => {} } = {}) {
    if (!cse?.endpoint || !originator || !ipeOriginator || !cipher || !reconciler || !store) throw new Error('MecOneM2mConsumer needs cse, originator, ipeOriginator, cipher, reconciler and store');
    Object.assign(this, { cse: { cseBase: '/Mobius', cseId: null, ...cse }, originator, aeName, api, ipeOriginator, cipher, reconciler, store, handoverCoordinator, clock, listen: { host: '127.0.0.1', port: 0, ...listen }, onem2mBaseUrl, networkMaxAgeMs, traceSink: trace });
    this.client = new Onem2mHttpClient({ endpoint: this.cse.endpoint, cseBase: this.cse.cseBase, originator });
    this.routes = new Map(); this.network = new Map(); this.decisions = []; this.pending = new Set(); this.queue = Promise.resolve();
  }
  iso(ms = this.clock()) { return new Date(ms).toISOString(); }
  trace(step, details = {}) { const entry = { at: this.iso(), actor: 'mec-policy', step, ...details }; this.traceSink(entry); return entry; }
  async start() {
    this.server = createServer((request, response) => this.route(request, response));
    this.server.listen(this.listen.port, this.listen.host); await once(this.server, 'listening');
    this.baseUrl = (this.onem2mBaseUrl ?? `http://${this.listen.host}:${this.server.address().port}`).replace(/\/+$/, '');
    this.ae = await this.client.registerAe({ rn: this.aeName, api: this.api, poa: [this.baseUrl], lbl: ['pb:mec-policy'] });
    this.trace('POLICY_AE_REGISTERED', { aePath: this.ae.path, aei: this.ae.aei, rsc: this.ae.rsc });
    return this.ae;
  }
  async watchDevice({ deviceId, devicePath }) {
    const results = [];
    for (const [service, container] of [['Location', 'location'], ['RNIS', 'rnis']]) {
      const token = randomBytes(32).toString('base64url');
      const parent = `${this.client.path(devicePath)}/${container}`;
      const subscriptionPath = `${parent}/mec-policy-sub`;
      this.routes.set(digest(token), { service, deviceId, devicePath: this.client.path(devicePath), subscriptionPath });
      const body = { 'm2m:sub': { rn: 'mec-policy-sub', nu: [`${this.baseUrl}/onem2m/${token}`], enc: { net: [3] }, nct: 1 } };
      let created = await this.client.create(parent, 23, body);
      if (created.rsc === 4105) { await this.client.remove(subscriptionPath); created = await this.client.create(parent, 23, body); }
      if (created.rsc !== 2001) throw Object.assign(new Error(`policy subscription ${subscriptionPath} ${created.rsc}`), { code: 'ONEM2M_SUBSCRIPTION_REVIEW', rsc: created.rsc });
      this.trace('ONEM2M_SUBSCRIPTION_CREATED', { subscriptionPath, service, rsc: created.rsc });
      results.push({ service, subscriptionPath, rsc: created.rsc });
    }
    return results;
  }
  async route(request, response) {
    const match = new URL(request.url, 'http://policy').pathname.match(/^\/onem2m\/([A-Za-z0-9_-]{43})$/);
    let body = null;
    try { const chunks = []; for await (const chunk of request) chunks.push(chunk); body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
    const ok = request.method === 'POST' && match && this.accept(match[1], body, request.headers);
    response.writeHead(ok ? 200 : 403, { 'X-M2M-RSC': ok ? '2000' : '4103', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' });
    response.end();
  }
  accept(token, body, headers) {
    const route = this.routes.get(digest(token));
    const signal = body?.['m2m:sgn'];
    if (!route || !signal) return false;
    if (signal.vrq) return true;
    if (this.cse.cseId && headers['x-m2m-origin'] && headers['x-m2m-origin'] !== this.cse.cseId) return false;
    if (`/${String(signal.sur ?? '').replace(/^\/+/, '')}` !== route.subscriptionPath) return false;
    const cin = signal.nev?.rep?.['m2m:cin'];
    if (signal.nev?.net === 3 && cin) {
      const task = this.queue.then(() => this.handleCin(route, cin)).catch((error) => this.trace('POLICY_TASK_REVIEW', { reason: error.message }));
      this.queue = task; this.pending.add(task); task.finally(() => this.pending.delete(task));
    }
    return true;
  }
  async idle() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  record(decision) { const entry = { at: this.iso(), ...decision }; this.decisions.push(entry); this.trace('POLICY_DECISION', decision); return entry; }
  approvedPolicies(deviceId, intent) {
    return this.store.list('policies').filter((item) => item.status === 'APPROVED' && item.policy?.ueId === deviceId && (!intent?.policyId || item.policyId === intent.policyId));
  }
  networkHealth(deviceId, policy) {
    const cells = policy.policy.servingCells;
    if (!Array.isArray(cells)) return { status: 'HEALTHY', source: 'policy-default' };
    const network = this.network.get(deviceId);
    if (!network) return { status: 'UNKNOWN', source: 'RNIS', reason: 'network-unknown' };
    if (this.clock() - Date.parse(network.observedAt) > this.networkMaxAgeMs) return { status: 'UNKNOWN', source: 'RNIS', reason: 'network-stale', cellId: network.cellId };
    if (network.hoStatus !== 'COMPLETED' || !cells.includes(network.cellId)) return { status: 'UNHEALTHY', source: 'RNIS', reason: 'cell-outside-target', cellId: network.cellId };
    return { status: 'HEALTHY', source: 'RNIS', cellId: network.cellId };
  }
  async handleCin(route, cin) {
    const con = parseContent(cin.con);
    const base = { service: route.service, deviceId: route.deviceId, cinRi: cin.ri, eventKey: con?.eventKey ?? null };
    if (cin.cr !== this.ipeOriginator) return this.record({ ...base, allowed: false, reason: 'creator-review' });
    if (!con || con.deviceId !== route.deviceId || con.service !== route.service) return this.record({ ...base, allowed: false, reason: 'content-binding-review' });
    if (route.service === 'RNIS') {
      const previous = this.network.get(route.deviceId);
      if (previous && Date.parse(previous.observedAt) > Date.parse(con.observedAt)) return this.record({ ...base, allowed: false, reason: 'network-out-of-order' });
      this.network.set(route.deviceId, { cellId: con.trgCellId, srcCellId: con.srcCellId, hoStatus: con.hoStatus, observedAt: con.observedAt, eventKey: con.eventKey });
      const outcomes = [];
      for (const policy of this.approvedPolicies(route.deviceId, con.intent)) {
        const health = this.networkHealth(route.deviceId, policy);
        if (health.status !== 'HEALTHY' && policy.policy.targetEdgeId && this.handoverCoordinator?.resetTrigger) await this.handoverCoordinator.resetTrigger({ ueId: route.deviceId, targetEdgeId: policy.policy.targetEdgeId, kind: policy.policy.trigger?.kind ?? 'zone', observedAt: con.observedAt });
        outcomes.push(this.record({ ...base, policyId: policy.policyId, allowed: health.status === 'HEALTHY', reason: health.status === 'HEALTHY' ? 'network-corroborates-target' : `network-${health.reason}`, network: { cellId: con.trgCellId, srcCellId: con.srcCellId, hoStatus: con.hoStatus }, health }));
      }
      return outcomes;
    }
    let precise;
    try { precise = this.cipher.open(con.precise, `${route.deviceId}:${con.eventKey}`); }
    catch { return this.record({ ...base, allowed: false, reason: 'decrypt-review' }); }
    const outcomes = [];
    for (const policy of this.approvedPolicies(route.deviceId, con.intent)) {
      const health = this.networkHealth(route.deviceId, policy);
      const event = { eventId: con.eventKey, eventKey: digest({ eventKey: con.eventKey, policyId: policy.policyId }), service: 'Location', ueId: route.deviceId, observedAt: con.observedAt, clockQuality: con.clockQuality, location: { lat: precise.lat, lon: precise.lon, ...(Number.isFinite(precise.accuracyM) ? { accuracyM: precise.accuracyM } : {}) }, health, uncertainty: { accuracyM: precise.accuracyM ?? null }, simulation: con.simulation === true, subscriptionId: con.mecSubscriptionId, intent: { policyId: policy.policyId, grantId: con.intent?.grantId ?? policy.policy.grantId, grantRevision: con.intent?.grantRevision, policyRevision: con.intent?.policyRevision ?? policy.revision } };
      const outcome = await this.reconciler.reconcileApprovedIntent(event);
      outcomes.push(this.record({ ...base, policyId: policy.policyId, allowed: outcome.allowed, reason: outcome.reason, triggerState: outcome.triggerState ?? null, triggerReason: outcome.triggerReason ?? null, handoverId: outcome.handoverId ?? null, health, observedAt: con.observedAt, mecSubscriptionId: con.mecSubscriptionId }));
    }
    return outcomes;
  }
  /** oneM2M geo-query: location containers whose current loc lies within the zone polygon. */
  async devicesInZone(polygon, { parent = this.client.cseBase, ty = 3, client = this.client } = {}) {
    const response = await client.retrieve(parent, { fu: 1, ty, gmty: 3, gsf: 1, geom: polygon });
    const uris = response.payload?.['m2m:uril'] ?? [];
    const devices = [...new Set(uris.map((uri) => String(uri).replace(/^\/+/, '')).filter((uri) => ty !== 3 || /\/location$/.test(uri)).map((uri) => uri.split('/').slice(0, 2).join('/')))];
    return { rsc: response.rsc, status: response.status, uris, devices };
  }
  async stop() {
    await this.idle();
    if (this.server) { this.server.closeAllConnections?.(); await new Promise((resolve) => this.server.close(resolve)); this.server = null; }
  }
}
