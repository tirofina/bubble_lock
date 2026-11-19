import { randomBytes } from 'node:crypto';
import { approvalHash } from './integration-utils.mjs';
import { MecIpe, parseMecRequest } from './mec-ipe.mjs';
import { m2mTime, parseContent } from './onem2m-http-client.mjs';

/**
 * oneM2M MEC IPE deployed as a MEC application instance that can be relocated between MEC hosts.
 *
 * - Ownership: the orchestrator writes epoch-numbered cin records into <IPE AE>/ownership. Only the
 *   instance named by the highest epoch holds MEC013/MEC012 subscriptions and writes observations;
 *   every other instance defers request cins and fences late MEC callbacks (FENCED).
 * - Hand-over: on gaining ownership an instance rebuilds the active request set from the oneM2M
 *   request containers (the CSE is the shared state) and re-creates the MEC subscriptions on its own
 *   MEP; on losing ownership it deletes its MEC subscriptions (state HANDED_OVER).
 * - MEC011: confirm_ready (base class), own service registration, AppTermination subscription and
 *   confirm_termination when the sandbox removes the instance.
 * - MEC021: registers the served UEs with the Application Mobility Service and subscribes to
 *   MobilityProcedure notifications; a notification becomes a lifecycle cin for the orchestrator.
 * Every status and observation cin carries servedBy { mep, appInstanceId, epoch }.
 */
export const IPE_LIFECYCLE_SCHEMA = 'pb.mec.ipe.lifecycle.v1';
export const IPE_OWNERSHIP_SCHEMA = 'pb.mec.ipe.ownership.v1';
const digest = approvalHash;

/** Active request set from request cins: the latest op per (service, creator, requestId) wins. */
export function activeRequestSet(entries, { now = Date.now() } = {}) {
  const ordered = [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const latest = new Map();
  for (const entry of ordered) {
    const con = parseContent(entry.cin?.con);
    if (!con || typeof con.requestId !== 'string') continue;
    const key = `${entry.service}|${entry.cin.cr ?? ''}|${con.requestId}`;
    if (con.op === 'unsubscribe') { latest.delete(key); continue; }
    if ((con.op ?? 'subscribe') !== 'subscribe') continue;
    latest.set(key, entry);
  }
  const active = [];
  for (const entry of latest.values()) {
    const con = parseContent(entry.cin.con);
    const createdMs = entry.createdMs ?? now;
    const durationSec = Number.isInteger(con.durationSec) ? con.durationSec : 300;
    const remainingSec = Math.floor((createdMs + durationSec * 1000 - now) / 1000);
    if (remainingSec < 10) continue;
    active.push({ ...entry, remainingSec, requestId: con.requestId, ueAddress: con.ueAddress ?? null });
  }
  return active;
}

/** oneM2M ct (YYYYMMDDTHHMMSS, UTC) to epoch ms. */
export function m2mTimeMs(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:[.,](\d{1,6}))?/.exec(String(value ?? ''));
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0);
}

export class RelocatableMecIpe extends MecIpe {
  constructor({ instance, orchestrators = [], amsRoot = null, serviceName = 'pb-onem2m-ipe', registerService = true, ...options } = {}) {
    if (!instance?.mep || !instance?.appInstanceId) throw new Error('RelocatableMecIpe needs instance.mep and instance.appInstanceId');
    super({ ...options, intakeName: `mec-ipe-intake-${instance.mep}`, watchName: `mec-ipe-watch-${instance.mep}` });
    Object.assign(this, { instance: { mep: instance.mep, appInstanceId: instance.appInstanceId }, orchestrators, amsRoot: amsRoot ? amsRoot.replace(/\/+$/, '') : null, serviceName, registerService });
    this.epoch = 0; this.owner = false; this.ownership = null; this.callbackTokens = {}; this.mec = { service: null, termination: null, ams: null, amsSubscription: null };
    this.terminating = false;
  }
  observationExtras() { return { servedBy: { mep: this.instance.mep, appInstanceId: this.instance.appInstanceId, epoch: this.epoch } }; }

  async start() {
    const started = await super.start();
    const orchestration = await this.ensureAcp('mec-orchestration-acp', [{ acor: [this.originator], acop: 63 }, ...(this.orchestrators.length ? [{ acor: this.orchestrators, acop: 35 }] : [])]);
    this.acps.orchestration = orchestration;
    this.paths.ownership = (await this.client.ensure(this.aePath, 3, { 'm2m:cnt': { rn: 'ownership', acpi: [orchestration.ri], mni: 100, lbl: ['pb:mec-ipe-ownership'] } })).path;
    this.paths.lifecycle = (await this.client.ensure(this.aePath, 3, { 'm2m:cnt': { rn: 'lifecycle', acpi: [orchestration.ri], mni: 500, lbl: ['pb:mec-ipe-lifecycle'] } })).path;
    await this.subscribe(this.paths.ownership, `mec-ipe-ownership-${this.instance.mep}`, [3], { kind: 'ownership' });
    if (this.registerService) await this.registerMecService();
    await this.subscribeTermination();
    await this.amsSync();
    await this.lifecycle('READY', { confirmReady: this.readyResult ?? null, mecService: this.mec.service ? { serInstanceId: this.mec.service.serInstanceId, httpStatus: this.mec.service.httpStatus } : null, termination: this.mec.termination ? { httpStatus: this.mec.termination.httpStatus } : null, ams: this.mec.ams ? { appMobilityServiceId: this.mec.ams.id, devices: this.mec.ams.devices, httpStatus: this.mec.ams.httpStatus } : null, amsSubscription: this.mec.amsSubscription ? { httpStatus: this.mec.amsSubscription.httpStatus } : null, catalogHash: started.catalog.catalogHash });
    const latest = await this.client.retrieve(`${this.paths.ownership}/la`);
    if (latest.rsc === 2000) await this.serial('ownership', () => this.applyOwnership(latest.payload?.['m2m:cin']));
    return { ...started, paths: this.paths };
  }

  /** The catalog in oneM2M follows the owner's MEP; a standby only binds its own endpoints. */
  async discoverAndPublish() {
    if (this.owner) return super.discoverAndPublish();
    const discovery = await this.platform.discoverServices();
    this.platform.bind(discovery.services);
    this.trace('MEC011_DISCOVERY_BOUND', { mep: this.instance.mep, catalogHash: discovery.catalogHash, services: discovery.services.map(({ key, mecApi, state }) => ({ key, mecApi, state })) });
    return { catalogHash: discovery.catalogHash, httpStatus: discovery.status, services: [], group: null, published: false };
  }

  async lifecycle(event, details = {}) {
    const con = { schema: IPE_LIFECYCLE_SCHEMA, event, mep: this.instance.mep, appInstanceId: this.instance.appInstanceId, epoch: this.epoch, owner: this.owner, at: this.iso(), ...details };
    const result = await this.client.create(this.paths.lifecycle, 4, { 'm2m:cin': { cnf: 'application/json', con, lbl: ['pb:mec-ipe-lifecycle', `pb:event:${event}`, `pb:mep:${this.instance.mep}`], et: m2mTime(this.clock() + this.retentionMs), cr: null } });
    this.trace('IPE_LIFECYCLE', { event, mep: this.instance.mep, epoch: this.epoch, rsc: result.rsc });
    return result;
  }

  async onRouteNotification(route, net, rep) {
    if (route.kind === 'ownership' && net === 3 && rep?.['m2m:cin']) return this.serial('ownership', () => this.applyOwnership(rep['m2m:cin']));
    return null;
  }

  async applyOwnership(cin) {
    const con = parseContent(cin?.con);
    if (!cin || !this.orchestrators.includes(cin.cr) || con?.schema !== IPE_OWNERSHIP_SCHEMA || !Number.isInteger(con.epoch) || typeof con.owner !== 'string') { this.trace('IPE_OWNERSHIP_REVIEW', { creator: cin?.cr ?? null, epoch: con?.epoch ?? null }); return null; }
    if (con.epoch <= this.epoch) { this.trace('IPE_OWNERSHIP_STALE', { epoch: con.epoch, current: this.epoch }); return null; }
    const wasOwner = this.owner; const mine = con.owner === this.instance.appInstanceId;
    this.epoch = con.epoch; this.owner = mine; this.ownership = { ...con, ri: cin.ri };
    if (mine && !wasOwner) {
      const acquiredAt = this.clock();
      this.trace('IPE_OWNERSHIP_ACQUIRED', { epoch: con.epoch, decisionId: con.decisionId ?? null });
      await this.lifecycle('OWNER', { decisionId: con.decisionId ?? null, ownershipRi: cin.ri });
      this.catalog = await this.discoverAndPublish();
      const resumed = await this.resume();
      await this.amsSync({ contextTransferState: con.epoch > 1 ? 'USER_CONTEXT_TRANSFER_COMPLETED' : 'NOT_TRANSFERRED' });
      await this.lifecycle('RESUMED', { decisionId: con.decisionId ?? null, requests: resumed, resumeMs: this.clock() - acquiredAt });
      return { acquired: true, resumed };
    }
    if (!mine && wasOwner) {
      const releasedAt = this.clock();
      this.trace('IPE_OWNERSHIP_RELEASED', { epoch: con.epoch, newOwner: con.owner });
      const drained = await this.drain('relocated');
      // MEC021: the source instance reports the user context transfer as completed.
      await this.amsSync({ contextTransferState: 'USER_CONTEXT_TRANSFER_COMPLETED' });
      await this.lifecycle('DRAINED', { decisionId: con.decisionId ?? null, newOwner: con.owner, newMep: con.mep ?? null, requests: drained, drainMs: this.clock() - releasedAt });
      return { released: true, drained };
    }
    this.trace('IPE_OWNERSHIP_OBSERVED', { epoch: con.epoch, owner: con.owner, mine });
    return { observed: true };
  }

  /** Request cins under the request containers, oldest first. */
  async requestCins() {
    const entries = [];
    for (const service of this.consume) {
      const listed = await this.client.retrieve(this.paths[service], { fu: 1, ty: 4 });
      const uris = listed.payload?.['m2m:uril'] ?? [];
      let index = 0;
      for (const uri of uris) {
        const item = await this.client.retrieve(`/${String(uri).replace(/^\/+/, '')}`);
        const cin = item.payload?.['m2m:cin'];
        if (item.rsc !== 2000 || !cin) continue;
        const createdMs = m2mTimeMs(cin.ct);
        entries.push({ service, cin, createdMs, order: (createdMs ?? 0) * 1000 + index++ });
      }
    }
    return entries;
  }
  async activeRequests() { return activeRequestSet(await this.requestCins(), { now: this.clock() }); }

  /** New owner: re-create the MEC subscriptions of every active request on this MEP. */
  async resume() {
    const results = [];
    for (const entry of await this.activeRequests()) {
      const con = { ...parseContent(entry.cin.con), durationSec: entry.remainingSec };
      try { parseMecRequest(entry.service, con, { maxDurationSec: this.maxDurationSec }); } catch (error) { results.push({ service: entry.service, requestId: entry.requestId, state: 'REJECTED', reason: error.message }); continue; }
      this.trace('IPE_REQUEST_RESUMED', { service: entry.service, requestId: entry.requestId, requestRi: entry.cin.ri, remainingSec: entry.remainingSec });
      await super.onRequestCin(entry.service, { ...entry.cin, con });
      const record = this.store.list('ipeRequests').find((item) => item.service === entry.service && item.requestId === entry.requestId && item.creator === entry.cin.cr);
      results.push({ service: entry.service, requestId: entry.requestId, state: record?.state ?? null, mecSubscriptionId: record?.mecSubscriptionId ?? null, type: record?.type ?? null });
    }
    return results;
  }
  /** Former owner: delete its MEC subscriptions; the requests stay active in oneM2M for the new owner. */
  async drain(reason = 'relocated') {
    const results = [];
    for (const record of this.store.list('ipeRequests').filter((item) => ['ACTIVE', 'CREATING'].includes(item.state))) {
      const outcome = await this.serial(record.key, () => this.teardown(record.key, reason, { finalState: 'HANDED_OVER' }));
      results.push({ service: record.service, requestId: record.requestId, mecSubscriptionId: record.mecSubscriptionId, providerStatus: outcome?.providerStatus ?? null, state: outcome?.state ?? null });
    }
    return results;
  }

  async onRequestCin(service, cin) {
    if (!this.owner) { this.trace('ONEM2M_REQUEST_DEFERRED', { service, requestRi: cin?.ri ?? null, epoch: this.epoch }); return null; }
    const result = await super.onRequestCin(service, cin);
    this.background(() => this.amsSync());
    return result;
  }
  async writeObservation(record, note, eventKey, sourceHash) {
    if (!this.owner) { this.trace('MEC_OBSERVATION_FENCED', { service: record.service, requestId: record.requestId, epoch: this.epoch }); return { rsc: 4103, fenced: true }; }
    return super.writeObservation(record, note, eventKey, sourceHash);
  }

  callbackUrl(kind) {
    const token = this.callbackTokens[kind] ?? (this.callbackTokens[kind] = randomBytes(32).toString('base64url'));
    return `${this.mecBase}/${kind}/${token}`;
  }
  async extraRoute(pathname, payload) {
    const match = /^\/(mec011|ams)\/([A-Za-z0-9_-]{43})$/.exec(pathname);
    if (!match || this.callbackTokens[match[1]] !== match[2]) return null;
    if (match[1] === 'mec011') { this.background(() => this.onAppTermination(payload)); return { httpStatus: 204 }; }
    this.background(() => this.onMobilityProcedure(payload));
    return { httpStatus: 204 };
  }

  /** MEC011: advertise the IPE as a MEC service on its own MEP. */
  async registerMecService() {
    // A restarted container keeps its app instance id: drop the service records of the previous container first.
    const servicesUrl = `${this.platform.platformRoot}/mec_service_mgmt/v1/applications/${encodeURIComponent(this.instance.appInstanceId)}/services`;
    try {
      const stale = (await this.platform.request('GET', servicesUrl, undefined, [200])).data ?? [];
      for (const item of Array.isArray(stale) ? stale : []) if (item?.serInstanceId) await this.platform.request('DELETE', `${servicesUrl}/${encodeURIComponent(item.serInstanceId)}`, undefined, [200, 204, 404]);
      if (Array.isArray(stale) && stale.length) this.trace('MEC011_STALE_SERVICES_REMOVED', { count: stale.length });
    } catch { /* nothing registered yet */ }
    const body = { serName: this.serviceName, serCategory: { href: 'https://www.onem2m.org', id: 'onem2m-ipe', name: 'oneM2M IPE', version: 'v1' }, version: '1.0.0', state: 'ACTIVE', transportInfo: { id: `pb-ipe-${this.instance.mep}`, name: 'oneM2M HTTP binding', type: 'REST_HTTP', protocol: 'HTTP', version: '1.1', endpoint: { uris: [`${this.onem2mBase}/`] }, security: {} }, serializer: 'JSON', scopeOfLocality: 'MEC_HOST', consumedLocalOnly: false, isLocal: true };
    try {
      const response = await this.platform.request('POST', `${this.platform.platformRoot}/mec_service_mgmt/v1/applications/${encodeURIComponent(this.instance.appInstanceId)}/services`, body, [200, 201]);
      this.mec.service = { serInstanceId: response.data?.serInstanceId ?? null, httpStatus: response.status };
      this.trace('MEC011_SERVICE_REGISTERED', { mep: this.instance.mep, serInstanceId: this.mec.service.serInstanceId, httpStatus: response.status });
    } catch (error) { this.mec.service = { serInstanceId: null, httpStatus: error.status ?? null, reason: error.code ?? error.message }; this.trace('MEC011_SERVICE_REVIEW', { reason: error.code ?? error.message, status: error.status ?? null }); }
  }
  async subscribeTermination() {
    const body = { subscriptionType: 'AppTerminationNotificationSubscription', callbackReference: this.callbackUrl('mec011'), appInstanceId: this.instance.appInstanceId };
    try {
      const response = await this.platform.request('POST', `${this.platform.apiRoot('AppSupport')}/applications/${encodeURIComponent(this.instance.appInstanceId)}/subscriptions`, body, [200, 201]);
      this.mec.termination = { href: response.data?._links?.self?.href ?? response.location ?? null, httpStatus: response.status };
      this.trace('MEC011_TERMINATION_SUBSCRIBED', { httpStatus: response.status });
    } catch (error) { this.mec.termination = { httpStatus: error.status ?? null, reason: error.code ?? error.message }; this.trace('MEC011_TERMINATION_REVIEW', { reason: error.code ?? error.message, status: error.status ?? null }); }
  }

  /** MEC021: register the UEs that the bridge serves and listen for mobility procedures of this instance. */
  async amsSync(options = {}) { return this.serial('ams', () => this.amsSyncNow(options)); }
  /** A restarted container keeps its app instance id: remove MEC021 registrations and subscriptions left by the previous one. */
  async amsCleanup() {
    const removed = { registrations: 0, subscriptions: 0 };
    try {
      const registrations = (await this.platform.request('GET', `${this.amsRoot}/app_mobility_services`, undefined, [200])).data ?? [];
      for (const item of Array.isArray(registrations) ? registrations : []) if (item?.serviceConsumerId?.appInstanceId === this.instance.appInstanceId && item.appMobilityServiceId) { await this.platform.request('DELETE', `${this.amsRoot}/app_mobility_services/${encodeURIComponent(item.appMobilityServiceId)}`, undefined, [200, 204, 404]); removed.registrations += 1; }
      const links = (await this.platform.request('GET', `${this.amsRoot}/subscriptions`, undefined, [200])).data?._links?.subscription ?? [];
      for (const link of links) {
        if (!link?.href) continue;
        const data = (await this.platform.request('GET', link.href, undefined, [200, 404])).data;
        const subscription = data?.filterCriteria ? data : Object.values(data ?? {}).find((value) => value?.filterCriteria);
        if (subscription?.filterCriteria?.appInstanceId === this.instance.appInstanceId) { await this.platform.request('DELETE', link.href, undefined, [200, 204, 404]); removed.subscriptions += 1; }
      }
    } catch (error) { this.trace('MEC021_CLEANUP_REVIEW', { reason: error.code ?? error.message, status: error.status ?? null }); }
    if (removed.registrations || removed.subscriptions) this.trace('MEC021_STALE_REMOVED', removed);
    return removed;
  }
  async amsSyncNow({ contextTransferState = 'NOT_TRANSFERRED' } = {}) {
    if (!this.amsRoot || this.terminating) return null;
    if (!this.amsCleaned) { this.amsCleaned = true; await this.amsCleanup(); }
    let addresses;
    try { addresses = [...new Set((await this.activeRequests()).map((item) => item.ueAddress).filter(Boolean))].sort(); }
    catch (error) { this.trace('MEC021_AMS_REVIEW', { reason: error.code ?? error.message }); return null; }
    const devices = addresses.map((value) => ({ associateId: { type: 'UE_IPv4_ADDRESS', value }, appMobilityServiceLevel: 'APP_MOBILITY_WITH_CONFIRMATION', contextTransferState }));
    const body = { serviceConsumerId: { appInstanceId: this.instance.appInstanceId }, deviceInformation: devices };
    try {
      let response;
      if (this.mec.ams?.id) response = await this.platform.request('PUT', `${this.amsRoot}/app_mobility_services/${encodeURIComponent(this.mec.ams.id)}`, { ...body, appMobilityServiceId: this.mec.ams.id }, [200, 204]);
      else response = await this.platform.request('POST', `${this.amsRoot}/app_mobility_services`, body, [200, 201]);
      this.mec.ams = { id: this.mec.ams?.id ?? response.data?.appMobilityServiceId ?? null, devices: addresses.map((value) => digest(value).slice(0, 16)), contextTransferState, httpStatus: response.status };
      this.trace('MEC021_AMS_REGISTERED', { appMobilityServiceId: this.mec.ams.id, devices: this.mec.ams.devices, contextTransferState, httpStatus: response.status });
    } catch (error) { this.trace('MEC021_AMS_REVIEW', { reason: error.code ?? error.message, status: error.status ?? null }); return null; }
    if (!this.mec.amsSubscription?.href && addresses.length) {
      const subscription = { subscriptionType: 'MobilityProcedureSubscription', callbackReference: this.callbackUrl('ams'), filterCriteria: { appInstanceId: this.instance.appInstanceId, associateId: addresses.map((value) => ({ type: 'UE_IPv4_ADDRESS', value })), mobilityStatus: ['INTERHOST_MOVEOUT_TRIGGERED'] } };
      try {
        const response = await this.platform.request('POST', `${this.amsRoot}/subscriptions`, subscription, [200, 201]);
        this.mec.amsSubscription = { href: response.data?._links?.self?.href ?? response.location ?? null, httpStatus: response.status };
        this.trace('MEC021_MOBILITY_SUBSCRIBED', { httpStatus: response.status });
      } catch (error) { this.mec.amsSubscription = { href: null, httpStatus: error.status ?? null }; this.trace('MEC021_SUBSCRIPTION_REVIEW', { reason: error.code ?? error.message, status: error.status ?? null }); }
    }
    return this.mec.ams;
  }
  async onMobilityProcedure(payload) {
    const notification = payload?.mobilityProcedureNotification ?? payload ?? {};
    const addresses = (notification.associateId ?? []).map((item) => item?.value).filter(Boolean);
    const details = { mobilityStatus: notification.mobilityStatus ?? null, targetAppInstanceId: notification.targetAppInfo?.appInstanceId ?? null, ueRefs: addresses.map((value) => digest(value).slice(0, 16)), observedAt: notification.timeStamp?.seconds ? new Date(notification.timeStamp.seconds * 1000).toISOString() : null };
    this.trace('MEC021_MOBILITY_PROCEDURE', details);
    await this.lifecycle('AMS_MOBILITY_PROCEDURE', details);
  }

  /** MEC011 AppTermination: hand back the MEC resources, deregister, then confirm termination. */
  async onAppTermination(payload) {
    if (this.terminating) return;
    this.terminating = true;
    const startedAt = this.clock();
    this.trace('MEC011_APP_TERMINATION', { operationAction: payload?.operationAction ?? null, maxGracefulTimeout: payload?.maxGracefulTimeout ?? null });
    try { await this.lifecycle('TERMINATING', { operationAction: payload?.operationAction ?? null }); } catch { /* CSE may be gone */ }
    const drained = await this.drain('app-termination');
    const outcome = { drained: drained.length };
    const attempt = async (label, task) => { try { outcome[label] = (await task())?.status ?? 'ok'; } catch (error) { outcome[label] = error.status ?? error.code ?? 'error'; } };
    if (this.mec.service?.serInstanceId) await attempt('serviceDelete', () => this.platform.request('DELETE', `${this.platform.platformRoot}/mec_service_mgmt/v1/applications/${encodeURIComponent(this.instance.appInstanceId)}/services/${encodeURIComponent(this.mec.service.serInstanceId)}`, undefined, [200, 204, 404]));
    if (this.mec.amsSubscription?.href) await attempt('amsSubscriptionDelete', () => this.platform.request('DELETE', this.mec.amsSubscription.href, undefined, [200, 204, 404]));
    if (this.mec.ams?.id) await attempt('amsDelete', () => this.platform.request('DELETE', `${this.amsRoot}/app_mobility_services/${encodeURIComponent(this.mec.ams.id)}`, undefined, [200, 204, 404]));
    await attempt('confirmTermination', () => this.platform.request('POST', `${this.platform.apiRoot('AppSupport')}/applications/${encodeURIComponent(this.instance.appInstanceId)}/confirm_termination`, { operationAction: 'TERMINATING' }, [200, 204]));
    this.trace('MEC011_TERMINATION_CONFIRMED', outcome);
    try { await this.lifecycle('TERMINATED', { ...outcome, terminationMs: this.clock() - startedAt }); } catch { /* CSE may be gone */ }
  }
}
