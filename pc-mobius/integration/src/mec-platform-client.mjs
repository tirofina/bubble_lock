import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { approvalHash } from './integration-utils.mjs';

/** MEC sandbox connection settings. Every value is pluggable through the environment. */
export function mecSandboxConfig(env = process.env) {
  const baseUrl = env.MEC_BASE_URL ? env.MEC_BASE_URL.replace(/\/+$/, '') : null;
  const sandboxName = env.MEC_SANDBOX_NAME || null;
  const mep = env.MEC_MEP ?? 'mep1';
  const platformRoot = (env.MEC_PLATFORM_ROOT || (baseUrl ? [baseUrl, sandboxName, mep].filter(Boolean).join('/') : '')).replace(/\/+$/, '') || null;
  const list = (value, fallback) => (value ?? fallback).split(',').map((item) => item.trim()).filter(Boolean);
  return {
    baseUrl, sandboxName, mep, platformRoot,
    caFile: env.MEC_CA_FILE || null,
    insecureTls: env.MEC_INSECURE_TLS === '1',
    consume: list(env.MEC_SERVICES, 'Location,RNIS'),
    locationVersion: env.MEC_LOCATION_VERSION || 'auto',
    appInstanceId: env.MEC_APP_INSTANCE_ID || null,
    callbackPublicUrl: env.MEC_CALLBACK_PUBLIC_URL ? env.MEC_CALLBACK_PUBLIC_URL.replace(/\/+$/, '') : null,
    allowedOrigins: list(env.MEC_ALLOWED_ORIGINS, ''),
    timeoutMs: Number(env.MEC_TIMEOUT_MS ?? 5000),
    simulation: env.MEC_SIMULATION === '1',
  };
}

/** fetch with a pinned CA bundle (k8s ingress CA) or, for local tests only, TLS verification off. */
export function createMecFetch({ ca = null, caFile = null, insecureTls = false } = {}) {
  const authority = caFile ? readFileSync(caFile) : ca;
  if (!authority && !insecureTls) return globalThis.fetch;
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(input);
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const body = init.body === undefined || init.body === null ? null : Buffer.from(init.body);
    const headers = { ...(init.headers ?? {}) };
    if (body) headers['content-length'] = String(body.length);
    const tls = url.protocol === 'https:' ? { ca: authority ?? undefined, rejectUnauthorized: !insecureTls, minVersion: 'TLSv1.2' } : {};
    const outgoing = transport(url, { method: init.method ?? 'GET', headers, signal: init.signal, ...tls }, (incoming) => {
      const chunks = []; let size = 0;
      incoming.on('data', (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) { outgoing.destroy(new Error('MEC_RESPONSE_SIZE_REVIEW')); return; } chunks.push(chunk); });
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        const status = incoming.statusCode;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
      });
      incoming.on('error', reject);
    });
    outgoing.on('error', (error) => reject(error.name === 'AbortError' || error.name === 'TimeoutError' ? error : Object.assign(new TypeError('fetch failed'), { cause: error })));
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

export class MecPlatformError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}

/** MEC011 catalog entries mapped to the MEC API that each one exposes. */
const CATALOG = [
  { key: 'Location', mecApi: 'MEC013', names: ['locationservice', 'meep-loc-serv', 'loc-serv', 'location'], categories: ['location'], path: /\/location\/(v\d+)/ },
  { key: 'RNIS', mecApi: 'MEC012', names: ['radionetworkinformationservice', 'rniservice', 'meep-rnis', 'rnis', 'rni'], categories: ['rni', 'rnis'], path: /\/rni\/(v\d+)/ },
  { key: 'WAIS', mecApi: 'MEC028', names: ['wlanaccessinformationservice', 'meep-wais', 'wais', 'wai'], categories: ['wai', 'wais'], path: /\/wai\/(v\d+)/ },
  { key: 'AppSupport', mecApi: 'MEC011', names: ['meep-app-enablement', 'mec_app_support', 'appsupport', 'app-enablement'], categories: ['app enablement', 'app support'], path: /\/mec_app_support\/(v\d+)/ },
  { key: 'AMS', mecApi: 'MEC021', names: ['meep-ams', 'ams', 'applicationmobilityservice'], categories: ['ams'], path: /\/amsi\/(v\d+)/ },
  { key: 'VIS', mecApi: 'MEC030', names: ['meep-vis', 'vis', 'v2xinformationservice'], categories: ['v2xi', 'vis'], path: /\/vis\/(v\d+)/ },
];

export function classifyMecService(entry) {
  const name = String(entry?.serName ?? entry?.ser_name ?? '').toLowerCase();
  const category = String(entry?.serCategory?.name ?? '').toLowerCase();
  const endpoint = entry?.transportInfo?.endpoint?.uris?.[0] ?? entry?.transportInfo?.endPoint?.uris?.[0] ?? entry?.transportInfo?.endpoint?.addresses?.[0]?.host ?? entry?.endpoint ?? null;
  const path = endpoint ? (() => { try { return new URL(endpoint).pathname; } catch { return ''; } })() : '';
  const match = CATALOG.find((item) => item.names.includes(name)) ?? CATALOG.find((item) => item.categories.includes(category)) ?? CATALOG.find((item) => item.path.test(path));
  const apiVersion = match?.path.exec(path)?.[1] ?? entry?.serCategory?.version ?? null;
  const fallbackKey = name.replace(/[^a-z0-9-]/g, '').slice(0, 48) || 'unknown';
  return { key: match?.key ?? fallbackKey, mecApi: match?.mecApi ?? 'unknown', serName: entry?.serName ?? entry?.ser_name ?? null, serInstanceId: entry?.serInstanceId ?? null, version: entry?.version ?? null, apiVersion, state: entry?.state ?? null, category: entry?.serCategory?.name ?? null, endpoint, scopeOfLocality: entry?.scopeOfLocality ?? null };
}

const LOCATION_COLLECTIONS = { v2: { userTracking: 'userTracking', periodic: 'periodic', zone: 'zonalTraffic' }, v3: { userTracking: 'users', periodic: 'users', zone: 'zones' } };
const deadline = (ms) => ({ seconds: Math.floor(ms / 1000), nanoSeconds: 0 });

export class MecPlatformClient {
  constructor({ platformRoot, fetchImpl = globalThis.fetch, timeoutMs = 5000, simulation = false, allowedOrigins = [], locationVersion = 'auto', appInstanceId = null } = {}) {
    if (!platformRoot) throw new Error('MEC platformRoot (MEC_BASE_URL/MEC_SANDBOX_NAME/MEC_MEP) is required');
    const root = new URL(platformRoot);
    if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) throw new Error('MEC platformRoot format');
    Object.assign(this, { platformRoot: platformRoot.replace(/\/+$/, ''), fetchImpl, timeoutMs, simulation, locationVersion, appInstanceId });
    this.origins = new Set([root.origin, ...allowedOrigins.map((value) => new URL(value).origin)]);
    this.endpoints = {};
  }
  allowed(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || /%2f|%5c/i.test(url.pathname) || url.pathname.split('/').includes('..')) throw new MecPlatformError('MEC_ENDPOINT_REVIEW');
    if (!this.origins.has(url.origin)) throw new MecPlatformError('MEC_ENDPOINT_REVIEW');
    return url;
  }
  async request(method, value, body, expected = [200]) {
    const url = this.allowed(value);
    let response;
    try {
      response = await this.fetchImpl(url.href, { method, redirect: 'error', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) { throw new MecPlatformError(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'MEC_TIMEOUT' : 'MEC_TRANSPORT_REVIEW'); }
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new MecPlatformError('MEC_RESPONSE_SIZE_REVIEW', response.status);
    if (!expected.includes(response.status)) throw new MecPlatformError('MEC_HTTP_REVIEW', response.status);
    let data = null;
    try { if (text) data = JSON.parse(text); } catch { throw new MecPlatformError('MEC_RESPONSE_SCHEMA_REVIEW', response.status); }
    return { status: response.status, data, location: response.headers.get('location') };
  }
  /** MEC011 service discovery: the whole catalog, classified per MEC API. */
  async discoverServices() {
    const response = await this.request('GET', `${this.platformRoot}/mec_service_mgmt/v1/services`);
    const catalog = Array.isArray(response.data) ? response.data : response.data?.serviceInfo ?? response.data?.services ?? [];
    const services = catalog.map((entry) => {
      const record = classifyMecService(entry);
      let endpointRebased = false;
      if (record.endpoint) {
        try {
          const url = new URL(record.endpoint);
          if (!this.origins.has(url.origin)) { record.endpoint = `${new URL(this.platformRoot).origin}${url.pathname}`; endpointRebased = true; }
          this.allowed(record.endpoint);
          record.endpoint = record.endpoint.replace(/\/+$/, '');
        } catch { record.endpoint = null; }
      }
      return { ...record, endpointRebased, simulation: this.simulation };
    });
    return { status: response.status, services, catalogHash: approvalHash(catalog) };
  }
  bind(services) {
    for (const record of services) if (record.endpoint && ['Location', 'RNIS', 'AppSupport', 'WAIS'].includes(record.key) && record.state !== 'INACTIVE') this.endpoints[record.key] = { endpoint: record.endpoint, apiVersion: record.apiVersion };
    return this.endpoints;
  }
  locationVersionFor() {
    if (this.locationVersion !== 'auto') return this.locationVersion;
    return this.endpoints.Location?.apiVersion === 'v2' ? 'v2' : 'v3';
  }
  apiRoot(service) {
    const bound = this.endpoints[service]?.endpoint;
    if (bound) return bound;
    if (service === 'Location') return `${this.platformRoot}/location/${this.locationVersionFor()}`;
    if (service === 'RNIS') return `${this.platformRoot}/rni/v2`;
    if (service === 'AppSupport') return `${this.platformRoot}/mec_app_support/v2`;
    throw new MecPlatformError('MEC_SERVICE_REVIEW');
  }
  /** MEC011 application support: confirm_ready for a sandbox application instance. */
  async confirmReady(appInstanceId = this.appInstanceId) {
    if (!appInstanceId) return null;
    const response = await this.request('POST', `${this.apiRoot('AppSupport')}/applications/${encodeURIComponent(appInstanceId)}/confirm_ready`, { indication: 'READY' }, [200, 204]);
    return { status: response.status, appInstanceId };
  }
  collectionUrl(service, type) {
    if (service === 'RNIS') return `${this.apiRoot('RNIS')}/subscriptions`;
    const version = this.locationVersionFor();
    const collection = LOCATION_COLLECTIONS[version]?.[type];
    if (!collection) throw new MecPlatformError('MEC_SUBSCRIPTION_TYPE_REVIEW');
    return `${this.apiRoot('Location')}/subscriptions/${collection}`;
  }
  subscriptionBody(service, { type, address, callbackUrl, clientCorrelator, expiresAtMs, periodSec = 5, zoneId = null }) {
    if (service === 'RNIS') return { subscriptionType: 'CellChangeSubscription', callbackReference: callbackUrl, filterCriteriaAssocHo: { ...(this.appInstanceId ? { appInstanceId: this.appInstanceId } : {}), associateId: [{ type: 'UE_IPv4_ADDRESS', value: address }], hoStatus: ['COMPLETED'] }, expiryDeadline: deadline(expiresAtMs) };
    if (this.locationVersionFor() === 'v3') {
      if (type === 'periodic') return { userLocationPeriodicSubscription: { subscriptionType: 'UserLocationPeriodicSubscription', callbackReference: callbackUrl, address, clientCorrelator, periodicEventInfo: { reportingAmount: 1000000, reportingInterval: periodSec }, requestTestNotification: false, expiryDeadline: deadline(expiresAtMs) } };
      if (type === 'zone') return { zoneLocationEventSubscription: { subscriptionType: 'ZoneLocationEventSubscription', callbackReference: callbackUrl, zoneId, addressList: [address], clientCorrelator, locationEventCriteria: ['ENTERING_AREA_EVENT', 'LEAVING_AREA_EVENT'], requestTestNotification: false, expiryDeadline: deadline(expiresAtMs) } };
      return { userLocationEventSubscription: { subscriptionType: 'UserLocationEventSubscription', callbackReference: callbackUrl, address, clientCorrelator, locationEventCriteria: ['ENTERING_AREA_EVENT', 'LEAVING_AREA_EVENT'], requestTestNotification: false, expiryDeadline: deadline(expiresAtMs) } };
    }
    const callbackReference = { notifyURL: callbackUrl, callbackData: clientCorrelator };
    if (type === 'periodic') return { periodicNotificationSubscription: { callbackReference, address: [address], clientCorrelator, frequency: periodSec, requestedAccuracy: 10 } };
    if (type === 'zone') return { zonalTrafficSubscription: { callbackReference, clientCorrelator, zoneId, userEventCriteria: ['Entering', 'Leaving', 'Transferring'] } };
    return { userTrackingSubscription: { callbackReference, clientCorrelator, address, userEventCriteria: ['Entering', 'Leaving', 'Transferring'] } };
  }
  resourceUrl(service, type, value) {
    if (typeof value !== 'string' || !value) throw new MecPlatformError('MEC_CREATE_UNCERTAIN');
    const collection = new URL(this.collectionUrl(service, type));
    const url = new URL(value, `${collection.href}/`);
    this.allowed(url.href);
    const rest = url.pathname.replace(/\/+$/, '').slice(collection.pathname.length + 1);
    if (!url.pathname.startsWith(`${collection.pathname}/`) || !rest || rest.includes('/')) throw new MecPlatformError('MEC_SUBSCRIPTION_LINK_REVIEW');
    return url.href.replace(/\/+$/, '');
  }
  async createSubscription(service, type, params) {
    const body = this.subscriptionBody(service, { type, ...params });
    const response = await this.request('POST', this.collectionUrl(service, type), body, [201]);
    const root = response.data && typeof response.data === 'object' ? Object.values(response.data).find((value) => value && typeof value === 'object' && !Array.isArray(value) && (value.resourceURL || value._links)) ?? response.data : {};
    const link = response.location ?? root.resourceURL?.href ?? root.resourceURL ?? root._links?.self?.href ?? response.data?._links?.self?.href;
    const resourceUrl = this.resourceUrl(service, type, link);
    return { status: response.status, resourceUrl, subscriptionId: decodeURIComponent(resourceUrl.split('/').at(-1)), requestHash: approvalHash(body) };
  }
  async updateSubscription(service, type, resourceUrl, params) {
    const body = this.subscriptionBody(service, { type, ...params });
    const response = await this.request('PUT', this.resourceUrl(service, type, resourceUrl), body, [200, 204]);
    return { status: response.status, requestHash: approvalHash(body) };
  }
  async deleteSubscription(service, type, resourceUrl) {
    const response = await this.request('DELETE', this.resourceUrl(service, type, resourceUrl), undefined, [204, 200, 404, 410]);
    return { status: response.status };
  }
  async listSubscriptions(service, type) {
    const response = await this.request('GET', this.collectionUrl(service, type));
    const data = response.data ?? {};
    return data.notificationSubscriptionList?.subscription ?? data.subscription ?? (Array.isArray(data) ? data : []);
  }
  /** MEC013 user query, used when a notification carries zone/AP only. */
  async queryUser(address) {
    const url = new URL(`${this.apiRoot('Location')}/queries/users`);
    url.searchParams.set('address', address);
    const response = await this.request('GET', url.href);
    const user = response.data?.userList?.user?.[0] ?? response.data?.userInfo;
    const info = user?.locationInfo;
    const lat = Array.isArray(info?.latitude) ? info.latitude[0] : info?.latitude;
    const lon = Array.isArray(info?.longitude) ? info.longitude[0] : info?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, accuracyM: Number.isFinite(info.accuracy) ? info.accuracy : null, zoneId: user.zoneId ?? null, accessPointId: user.accessPointId ?? null, timeStamp: user.timestamp ?? user.timeStamp ?? null };
  }
  /** MEC012 RAB query, used to seed the serving cell before the first cell change. */
  async queryCell(address) {
    const url = new URL(`${this.apiRoot('RNIS')}/queries/rab_info`);
    url.searchParams.set('ue_ipv4_address', address);
    const response = await this.request('GET', url.href);
    const cell = response.data?.cellUserInfo?.[0];
    return cell ? { cellId: cell.ecgi?.cellId ?? null, plmn: cell.ecgi?.plmn ?? null, timeStamp: response.data.timeStamp ?? null } : null;
  }
}

function first(value) { return Array.isArray(value) ? value[0] : value; }
const HO_STATUS = { 1: 'IN_PREPARATION', 2: 'IN_EXECUTION', 3: 'COMPLETED', 4: 'REJECTED', 5: 'CANCELLED' };

export function mecSourceTime(value) {
  if (typeof value === 'string') return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  if (Number.isFinite(value)) return new Date(value).toISOString();
  if (!value || !Number.isSafeInteger(value.seconds) || value.seconds < 0) return null;
  const nanos = Number.isInteger(value.nanoSeconds ?? 0) && (value.nanoSeconds ?? 0) >= 0 && (value.nanoSeconds ?? 0) < 1e9 ? value.nanoSeconds ?? 0 : null;
  if (nanos === null) return null;
  return new Date(value.seconds * 1000 + Math.floor(nanos / 1e6)).toISOString();
}

/** MEC013 v2/v3 and MEC012 v2 notification shapes reduced to one record. */
export function normalizeMecNotification(service, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new MecPlatformError('MEC_SCHEMA_REVIEW');
  if (service === 'Location') {
    const wrappers = ['userLocationEventNotification', 'userLocationPeriodicNotification', 'zoneLocationEventNotification', 'zonalPresenceNotification', 'userTrackingNotification', 'trackingNotification', 'subscriptionNotification', 'zoneStatusNotification', 'expiryNotification'];
    const wrapper = wrappers.find((name) => payload[name] && typeof payload[name] === 'object');
    const body = wrapper ? payload[wrapper] : payload;
    const notificationType = body.notificationType ?? wrapper ?? null;
    if (/expiry/i.test(String(notificationType))) return { kind: 'expiry', service, notificationType, subscriptionHref: body._links?.subscription?.href ?? null };
    if (body.cellChangeNotification || /cell/i.test(String(notificationType))) throw new MecPlatformError('MEC_BINDING_REVIEW');
    const terminal = body.terminalLocation?.[0];
    const info = body.currentLocation ?? terminal?.currentLocation ?? body.locationInfo ?? body.userInfo?.locationInfo;
    const lat = first(info?.latitude); const lon = first(info?.longitude);
    const location = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon, accuracyM: Number.isFinite(info?.accuracy) ? info.accuracy : null } : null;
    return { kind: 'location', service, notificationType, address: body.address ?? terminal?.address ?? body.userInfo?.address ?? null, location, zoneId: body.zoneId ?? null, accessPointId: body.accessPointId ?? body.currentAccessPointId ?? null, event: body.userLocationEvent ?? body.userEventType ?? null, observedAt: mecSourceTime(body.timeStamp ?? body.timestamp ?? info?.timestamp ?? terminal?.currentLocation?.timestamp), subscriptionHref: body._links?.subscription?.href ?? body.link?.find?.((item) => /subscription/i.test(item.rel ?? ''))?.href ?? null, callbackData: body.callbackData ?? null, eventId: typeof body.eventId === 'string' ? body.eventId : null };
  }
  if (service === 'RNIS') {
    const body = payload.cellChangeNotification ?? payload;
    const notificationType = body.notificationType ?? (payload.cellChangeNotification ? 'CellChangeNotification' : null);
    if (/expiry/i.test(String(notificationType))) return { kind: 'expiry', service, notificationType, subscriptionHref: body._links?.subscription?.href ?? null };
    if (notificationType !== 'CellChangeNotification' || payload.userLocationEventNotification || payload.zonalPresenceNotification) throw new MecPlatformError('MEC_BINDING_REVIEW');
    const associate = body.associateId?.find?.((item) => ['UE_IPv4_ADDRESS', 1, '1'].includes(item.type)) ?? body.associateId?.[0];
    const target = Array.isArray(body.trgEcgi) ? body.trgEcgi[0] : body.trgEcgi;
    return { kind: 'cellChange', service, notificationType, address: associate?.value ?? null, hoStatus: HO_STATUS[body.hoStatus] ?? body.hoStatus ?? null, srcCellId: body.srcEcgi?.cellId ?? null, trgCellId: target?.cellId ?? null, plmn: target?.plmn ?? body.srcEcgi?.plmn ?? null, observedAt: mecSourceTime(body.timeStamp), subscriptionHref: body._links?.subscription?.href ?? null, eventId: typeof body.eventId === 'string' ? body.eventId : null };
  }
  throw new MecPlatformError('MEC_SERVICE_REVIEW');
}
