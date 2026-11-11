import { randomUUID } from 'node:crypto';
import { approvalHash } from './integration-utils.mjs';

const resourceName = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('CSE 자원 이름을 확인하세요.');
  return value;
};
const rootAttributes = (body) => Object.values(body ?? {})[0];
const metadata = new Set(['ty', 'ri', 'pi', 'ct', 'lt', 'st', 'cs', 'cni', 'cbs', 'aei', 'cnm', 'mtv', 'cr']);
function clean(body) { return Object.fromEntries(Object.entries(body).map(([tag, value]) => [tag, Object.fromEntries(Object.entries(value).filter(([name]) => !metadata.has(name)))])); }
function remap(value, mapping) {
  if (Array.isArray(value)) return value.map((item) => remap(item, mapping));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, mapping)]));
  if (typeof value === 'string') return value.replace(/\{\{([^}]+)\}\}/g, (_, key) => { if (!(key in mapping)) throw new Error('복원 자원 URI 연결을 확인하세요.'); return mapping[key]; });
  return value;
}

export class OneM2mEdgeClient {
  constructor({ endpoint, cseBase = '/Mobius', cseId, originator, fetchImpl = globalThis.fetch, timeoutMs = 3000, rvi = '4', callbackUrl, simulation = false, headers = {} }) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('CSE endpoint를 확인하세요.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('원격 CSE에는 HTTPS를 설정하세요.');
    if (!originator) throw new Error('CSE originator를 설정하세요.');
    Object.assign(this, { endpoint: endpoint.replace(/\/$/, ''), cseBase: cseBase.replace(/\/$/, ''), cseId, originator, fetchImpl, timeoutMs, rvi, callbackUrl, simulation, headers });
  }
  url(path) {
    if (typeof path !== 'string' || !path.startsWith(`${this.cseBase}/`) && path !== this.cseBase || /[?#%\\]/.test(path) || path.split('/').some((part) => part === '..' || part === '.')) throw new Error('CSE 자원 경로 범위를 확인하세요.');
    return `${this.endpoint}${path}`;
  }
  async request(method, path, body, ty, query) {
    const rqi = randomUUID();
    const url = new URL(this.url(path));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (!['fu', 'ty', 'cnd'].includes(key)) throw new Error('oneM2M discovery filter를 확인하세요.');
      url.searchParams.set(key, String(value));
    }
    let response;
    try { response = await this.fetchImpl(url.href, { method, redirect: 'error', headers: { accept: 'application/json', 'X-M2M-Origin': method === 'POST' && ty === 2 ? 'C' : this.originator, 'X-M2M-RI': rqi, 'X-M2M-RVI': this.rvi, ...(body ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}), ...this.headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch { throw Object.assign(new Error('CSE transport 응답을 확인하세요.'), { code: 'CSE_TRANSPORT_REVIEW' }); }
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('CSE 응답 크기를 확인하세요.');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { throw new Error('CSE JSON 응답을 확인하세요.'); }
    const rsc = Number(response.headers.get('X-M2M-RSC'));
    if (response.status === 409 || rsc === 4105) return { conflict: true, status: response.status, rsc };
    if (response.status === 404 || rsc === 4004) return { missing: true, status: response.status, rsc };
    if (!response.ok || ![2000, 2001, 2002, 2004].includes(rsc) || response.headers.get('X-M2M-RI') !== rqi) throw Object.assign(new Error(`CSE 응답 ${response.status}/${rsc}: ${typeof payload?.['m2m:dbg'] === 'string' ? payload['m2m:dbg'].slice(0, 500) : '응답·요청 식별자를 확인하세요.'}`), { code: 'CSE_RESPONSE_REVIEW', status: response.status, rsc });
    return { payload, status: response.status, rsc, rqi, path, payloadHash: approvalHash(payload) };
  }
  async health() {
    const result = await this.request('GET', this.cseBase);
    if (!result.payload?.['m2m:cb']) throw new Error('CSE base 상태를 확인하세요.');
    return { cseId: result.payload['m2m:cb'].csi ?? this.cseId, status: 'HEALTHY', simulation: this.simulation };
  }
  async discover(parent, { ty = 28, cnd } = {}) {
    if (!Number.isInteger(ty) || typeof cnd !== 'string' || !cnd) throw new Error('resourceType·containerDefinition filter를 확인하세요.');
    return this.request('GET', parent, undefined, undefined, { fu: 1, ty, cnd });
  }
  async read(path) {
    const result = await this.request('GET', path);
    if (result.missing) throw Object.assign(new Error('복원 원본 자원 상태를 확인하세요.'), { code: 'CSE_RESOURCE_REQUIRED' });
    return result.payload;
  }
  async ensure(parent, ty, body, { immutable = false, update = true } = {}) {
    const attributes = rootAttributes(body);
    const path = `${parent}/${resourceName(attributes?.rn)}`;
    const created = await this.request('POST', parent, body, ty);
    if (created.missing) throw new Error('CSE 부모 자원을 확인하세요.');
    let payload = created.payload;
    if (created.conflict) {
      payload = await this.read(path);
      const current = rootAttributes(payload);
      if (attributes.lbl?.some((label) => label.startsWith('pb-owner:') && !current.lbl?.includes(label))) throw new Error('CSE 자원 소유 label을 확인하세요.');
      if (immutable && approvalHash(current.con) !== approvalHash(attributes.con)) throw new Error('동일 관측 sequence의 원문 hash를 확인하세요.');
      if (!immutable && update) {
        const patch = clean(body); delete rootAttributes(patch).rn;
        if (ty === 28) delete rootAttributes(patch).cnd;
        if (ty === 9) { delete rootAttributes(patch).mt; delete rootAttributes(patch).csy; }
        if (ty === 2) { delete rootAttributes(patch).api; delete rootAttributes(patch).rr; }
        const updated = await this.request('PUT', path, patch);
        if (updated.missing) throw new Error('CSE 수정 자원을 확인하세요.');
        payload = await this.read(path);
      }
    }
    const actual = rootAttributes(payload);
    if (!actual?.ri || (ty === 2 && !actual.aei)) throw new Error('CSE 등록 RI·AE-ID receipt를 확인하세요.');
    return { path, ri: actual.ri, aei: actual.aei ?? null, ty, body: payload, duplicate: Boolean(created.conflict) };
  }
  async register({ ueId, manifest }) {
    const owner = `pb-owner:${approvalHash(ueId).slice(0, 24)}`;
    const ae = await this.ensure(this.cseBase, 2, { 'm2m:ae': { rn: resourceName(manifest.aeName), api: manifest.appId ?? 'N.privacy.bubble', rr: true, lbl: [owner] } }, { update: false });
    const acp = await this.ensure(ae.path, 1, { 'm2m:acp': { rn: 'handover-acp', lbl: [owner], pv: { acr: [{ acor: [this.originator, ae.aei], acop: 63 }] }, pvs: { acr: [{ acor: [this.originator], acop: 63 }] } } });
    await this.request('PUT', ae.path, { 'm2m:ae': { acpi: [acp.ri] } });
    return { edgeId: manifest.edgeId, cseId: this.cseId, aePath: ae.path, aeId: ae.aei, aeRi: ae.ri, acpPath: acp.path, acpRi: acp.ri, ownerLabel: owner, resources: {}, subscriptions: [], groups: [], simulation: this.simulation };
  }
  async restore({ binding, manifest, snapshot = {} }) {
    const mapping = { aei: binding.aeId, ae: binding.aePath, acp: binding.acpRi, callbackUrl: this.callbackUrl ?? '', cseId: this.cseId ?? '' };
    const restored = structuredClone(binding);
    for (const resource of manifest.resources ?? []) {
      const parent = resource.parentLogicalId ? mapping[`resource:${resource.parentLogicalId}`] : binding.aePath;
      if (!parent) throw new Error('부모 자원 복원 순서를 확인하세요.');
      const original = snapshot[resource.logicalId] ? clean(snapshot[resource.logicalId]) : resource.body;
      const body = remap(structuredClone(original), mapping);
      const attributes = rootAttributes(body);
      attributes.rn = rootAttributes(resource.body).rn;
      attributes.lbl = [...new Set([...(attributes.lbl ?? []), binding.ownerLabel])];
      attributes.acpi = [binding.acpRi];
      const result = await this.ensure(parent, resource.ty, body);
      restored.resources[resource.logicalId] = { path: result.path, ri: result.ri, ty: result.ty };
      mapping[`resource:${resource.logicalId}`] = result.path;
    }
    for (const group of manifest.groups ?? []) {
      const mid = group.memberLogicalIds.map((logicalId) => mapping[`resource:${logicalId}`]?.replace(/^\//, ''));
      if (mid.some((path) => !path)) throw new Error('Group 멤버 자원 연결을 확인하세요.');
      const result = await this.ensure(binding.aePath, 9, { 'm2m:grp': { rn: resourceName(group.rn), lbl: [binding.ownerLabel], acpi: [binding.acpRi], mt: group.memberType ?? 28, mnm: Math.max(1, mid.length), mid, csy: 1 } });
      restored.groups.push({ logicalId: group.logicalId, path: result.path, ri: result.ri, memberUris: mid });
    }
    for (const subscription of manifest.subscriptions ?? []) {
      const parent = subscription.parentLogicalId ? mapping[`resource:${subscription.parentLogicalId}`] : binding.aePath;
      let notificationUri = remap(subscription.notificationUri ?? '{{callbackUrl}}', mapping);
      if (!/^https?:\/\//.test(notificationUri)) throw new Error('대상 CSE notification callback을 설정하세요.');
      const notificationUrl = new URL(notificationUri);
      notificationUrl.searchParams.set('subscription', `${parent}/${resourceName(subscription.rn)}`);
      notificationUri = notificationUrl.href;
      const result = await this.ensure(parent, 23, { 'm2m:sub': { rn: resourceName(subscription.rn), lbl: [binding.ownerLabel], acpi: [binding.acpRi], enc: { net: subscription.events ?? [1] }, nu: [notificationUri], nct: 1 } });
      restored.subscriptions.push({ logicalId: subscription.logicalId, path: result.path, ri: result.ri, notificationUri });
    }
    return restored;
  }
  async snapshot(binding, manifest) {
    const snapshot = {};
    for (const resource of manifest.resources ?? []) if (binding.resources?.[resource.logicalId]) snapshot[resource.logicalId] = await this.read(binding.resources[resource.logicalId].path);
    return snapshot;
  }
  async applyObservation(binding, observation, logicalId = 'observations') {
    if(!['encrypted-location-reference','encrypted-observation-reference'].includes(observation.payload?.type)||typeof observation.payload.payloadRef!=='string')throw Error('CSE 관측은 암호화 payload 참조로 전달하세요.');
    const parent = binding.resources?.[logicalId]?.path;
    if (!parent) throw new Error('관측 container 복원을 확인하세요.');
    const expiry=Date.parse(observation.payload.expiresAt);
    if(!Number.isFinite(expiry))throw Error('암호화 관측 참조의 만료 시각을 확인하세요.');
    const et=new Date(expiry).toISOString().replaceAll('-','').replaceAll(':','').replace(/\.\d{3}Z$/,'');
    const body = { 'm2m:cin': { rn: `obs-${observation.sequence}`, lbl: [binding.ownerLabel], cnf: 'application/json',et, con: observation.payload } };
    const result = await this.ensure(parent, 4, body, { immutable: true });
    const readback = rootAttributes(await this.read(result.path));
    if (approvalHash(readback.con) !== observation.payloadHash) throw new Error('관측 readback hash를 확인하세요.');
    return { path: result.path, ri: result.ri, duplicate: result.duplicate, payloadHash: observation.payloadHash };
  }
  async fence(binding) {
    const result = await this.request('PUT', binding.acpPath, { 'm2m:acp': { pv: { acr: [{ acor: [this.originator], acop: 63 }, { acor: [binding.aeId], acop: 2 }] } } });
    if (result.missing) throw new Error('출발 CSE ACP 정산을 확인하세요.');
    const readback = rootAttributes(await this.read(binding.acpPath));
    if (readback.pv?.acr?.some((rule) => rule.acor?.includes(binding.aeId) && (rule.acop & 4))) throw new Error('출발 CSE UPDATE 권한 정산을 확인하세요.');
    return { fenced: true, acpPath: binding.acpPath, readbackHash: approvalHash(readback.pv) };
  }
  async probeNotifications(binding) {
    for (const subscription of binding.subscriptions ?? []) {
      const parent = subscription.path.slice(0, subscription.path.lastIndexOf('/'));
      const resource = await this.read(parent); const tag = Object.keys(resource)[0];
      const labels = (attributesForProbe(resource).lbl ?? []).filter((label) => !label.startsWith('pb-notify-probe:'));
      await this.request('PUT', parent, { [tag]: { lbl: [...labels, `pb-notify-probe:${randomUUID().slice(0, 8)}`] } });
    }
  }
  async release(binding) {
    const removed = [];
    for (const subscription of binding.subscriptions ?? []) { const result = await this.request('DELETE', subscription.path); removed.push({ path: subscription.path, rsc: result.rsc }); }
    return { subscriptions: removed, credentialState: 'READ_ONLY' };
  }
}

function attributesForProbe(body) { return Object.values(body)[0]; }
