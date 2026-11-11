import { recordEnvelope, requireString } from './integration-utils.mjs';
import { serviceNames, digest } from './mec-state.mjs';
import { mecOperation } from './mec-deployment-schema.mjs';

const definitions = {
  Location: { name: 'LocationService', root: '/location/v2', collection: '/subscriptions/userTracking', query: '/queries/users' },
  RNIS: { name: 'RadioNetworkInformationService', root: '/rni/v2', collection: '/subscriptions', query: '/queries/rab_info' },
};
const safeHttp = (value) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('MEC endpoint 형식을 확인하세요.');
  return url;
};

export class MecHttpError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}

export class MecAdapter {
  constructor({ serviceName, endpoint, platformRoot, allowedEndpoints = [], providerId = 'mec-provider', providerFingerprint, queryImpl = null, fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), timeoutMs = 5000, capabilities = {}, headers = {}, simulation = false } = {}) {
    if (!serviceNames.has(serviceName)) throw new Error('Location 또는 RNIS 서비스를 선택하세요.');
    Object.assign(this, { serviceName, endpoint, platformRoot, providerId, providerFingerprint, queryImpl, fetchImpl, clock, timeoutMs, headers, simulation });
    this.definition = definitions[serviceName];
    this.capabilities = { list: false, listComplete: false, update: false, verifiedSourceTime: false, deploymentVerified: false, endpointVersion: 'v2', schemaHash: digest({ service: serviceName, contract: 'normalized-callback-v1' }), ...capabilities };
    this.allowedEndpoints = [...new Set([endpoint, platformRoot, ...allowedEndpoints].filter(Boolean))].map((value) => safeHttp(value).href.replace(/\/$/, ''));
    if (endpoint) safeHttp(endpoint);
  }
  get apiRoot() {
    if (!this.endpoint) throw new Error('MEC 서비스 검색 또는 endpoint 설정을 완료하세요.');
    const root = this.endpoint.replace(/\/$/, '');
    return root.endsWith(this.definition.root) ? root : `${root}${this.definition.root}`;
  }
  get collectionUrl() { return `${this.apiRoot}${this.definition.collection}`; }
  allowedUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || /%2f|%5c/i.test(url.pathname)) throw new MecHttpError('ENDPOINT_REVIEW');
    if (!this.allowedEndpoints.some((allowed) => { const boundary = new URL(allowed); return url.origin === boundary.origin && (url.pathname === boundary.pathname || url.pathname.startsWith(`${boundary.pathname.replace(/\/$/, '')}/`)); })) throw new MecHttpError('ENDPOINT_REVIEW');
    return url.href;
  }
  resourceUrl(value) {
    requireString(value, 'subscription resource');
    const url = new URL(value, `${this.collectionUrl}/`);
    this.allowedUrl(url.href);
    if (url.search || !url.pathname.startsWith(`${new URL(this.collectionUrl).pathname}/`) || url.pathname.slice(new URL(this.collectionUrl).pathname.length + 1).includes('/')) throw new MecHttpError('SUBSCRIPTION_LINK_REVIEW');
    return url.href;
  }
  async request(method, url, body, expected = [200], binding = 'service') {
    this.allowedUrl(url);
    const operationId = binding === 'service' ? mecOperation(this.capabilities, method, url) : null;
    let response;
    try {
      response = await this.fetchImpl(url, { method, redirect: 'error', headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...this.headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) { throw new MecHttpError(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'MEC_TIMEOUT' : 'MEC_TRANSPORT_REVIEW'); }
    if (!expected.includes(response.status)) { await response.body?.cancel(); throw new MecHttpError('MEC_HTTP_REVIEW', response.status); }
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new MecHttpError('MEC_RESPONSE_SIZE_REVIEW'); }
      chunks.push(Buffer.from(item.value));
    }
    const text = Buffer.concat(chunks).toString();
    let data = null;
    try { if (text) data = JSON.parse(text); } catch { throw new MecHttpError('MEC_RESPONSE_SCHEMA_REVIEW'); }
    return { status: response.status, data, location: response.headers.get('location'), ...(operationId ? { operationId, schemaHash: this.capabilities.schemaHash } : {}) };
  }
  async discover() {
    if (!this.platformRoot) throw new Error('MEC platformRoot를 설정하세요.');
    const url = new URL(`${this.platformRoot.replace(/\/$/, '')}/mec_service_mgmt/v1/services`);
    url.searchParams.set('ser_name', this.definition.name);
    const response = await this.request('GET', url.href, undefined, [200], 'platform');
    const catalog = Array.isArray(response.data) ? response.data : response.data?.services;
    const entry = catalog?.find((item) => item.serName === this.definition.name || item.ser_name === this.definition.name);
    const endpoint = entry?.transportInfo?.endPoint?.uris?.[0] ?? entry?.endpoint;
    if (!endpoint) throw new MecHttpError('SERVICE_DISCOVERY_REVIEW');
    this.allowedUrl(endpoint); safeHttp(endpoint);
    this.endpoint = endpoint.replace(/\/$/, '');
    return recordEnvelope({ type: 'MEC_DISCOVERY', serviceName: this.serviceName, providerId: this.providerId, serviceInstanceId: entry.serInstanceId ?? null, endpoint: this.endpoint, catalogHash: digest(catalog), simulation: this.simulation }, this.clock);
  }
  subscriptionPayload({ callbackUrl, ueSubject, clientCorrelator, appInstanceId = 'privacy-bubble', filterCriteriaAssocHo }) {
    if (this.serviceName === 'Location') return { userTrackingSubscription: { clientCorrelator, callbackReference: { notifyURL: callbackUrl, callbackData: clientCorrelator }, address: ueSubject } };
    return { subscriptionType: 'CellChangeSubscription', callbackReference: callbackUrl, filterCriteriaAssocHo: { appInstanceId, associateId: [{ type: 1, value: ueSubject }], hoStatus: [3], ...filterCriteriaAssocHo } };
  }
  async createSubscription(body) {
    const response = await this.request('POST', this.collectionUrl, body, [201]);
    const resource = response.location ?? response.data?.resourceURL ?? response.data?.userTrackingSubscription?.resourceURL ?? response.data?._links?.self?.href;
    if (!resource) throw new MecHttpError('MEC_CREATE_UNCERTAIN');
    return { ...response, resourceUrl: this.resourceUrl(resource) };
  }
  async readSubscription(resource) { return this.request('GET', this.resourceUrl(resource)); }
  async updateSubscription(resource, body) {
    if (!this.capabilities.update) throw new MecHttpError('UPDATE_CAPABILITY_REVIEW');
    return this.request('PUT', this.resourceUrl(resource), body, [200, 204]);
  }
  async deleteSubscription(resource) { return this.request('DELETE', this.resourceUrl(resource), undefined, [204, 404, 410]); }
  async listSubscriptions() {
    if (!this.capabilities.list) throw new MecHttpError('LIST_CAPABILITY_REVIEW');
    const response = await this.request('GET', this.collectionUrl);
    return Array.isArray(response.data) ? response.data : response.data?.subscriptions ?? response.data?.userTrackingSubscriptionList?.userTrackingSubscription ?? [];
  }
  async query(request = {}) {
    if (this.queryImpl) return recordEnvelope({ type: 'MEC_QUERY', serviceName: this.serviceName, simulation: true, response: await this.queryImpl(request) }, this.clock);
    const url = new URL(`${this.apiRoot}${this.definition.query}`);
    const parameters = request.parameters ?? { [this.serviceName === 'Location' ? 'address' : 'ue_ipv4_address']: requireString(request.ueId, 'ueId') };
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    const response = await this.request('GET', url.href);
    return recordEnvelope({ type: 'MEC_QUERY', serviceName: this.serviceName, simulation: this.simulation, endpoint: url.origin + url.pathname, status: response.status, response: response.data }, this.clock);
  }
}
