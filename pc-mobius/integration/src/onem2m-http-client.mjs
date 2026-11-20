import { randomUUID } from 'node:crypto';

const QUERY_KEYS = new Set(['fu', 'ty', 'cnd', 'gmty', 'gsf', 'geom', 'lbl', 'lim', 'rcn', 'drt']);

/**
 * Minimal oneM2M HTTP binding client acting as one originator (AE-ID). The endpoint may carry a path
 * prefix of a reverse proxy: endpoint https://cse.example:8443/onem2m with cseBase /Mobius addresses
 * https://cse.example:8443/onem2m/Mobius/...; resource paths and notification `sur` stay CSE-relative.
 */
export class Onem2mHttpClient {
  constructor({ endpoint, cseBase = '/Mobius', originator, fetchImpl = globalThis.fetch, timeoutMs = 5000, rvi = '4' } = {}) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('oneM2M endpoint format');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('remote CSE requires HTTPS');
    if (!originator) throw new Error('oneM2M originator is required');
    Object.assign(this, { endpoint: endpoint.replace(/\/+$/, ''), cseBase: `/${cseBase.replace(/^\/+|\/+$/g, '')}`, originator, fetchImpl, timeoutMs, rvi });
  }
  path(target) {
    const value = `/${String(target).replace(/^\/+/, '')}`;
    if (!(value === this.cseBase || value.startsWith(`${this.cseBase}/`)) || /[?#%\\]/.test(value) || value.split('/').some((part) => part === '..' || part === '.')) throw new Error('oneM2M target outside CSE base');
    return value;
  }
  async request(method, target, { body, ty, query, originator } = {}) {
    const url = new URL(`${this.endpoint}${this.path(target)}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (!QUERY_KEYS.has(key)) throw new Error(`oneM2M filter ${key}`);
      url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    const rqi = `pb-${randomUUID()}`;
    const headers = { accept: 'application/json', 'X-M2M-Origin': originator ?? this.originator, 'X-M2M-RI': rqi, 'X-M2M-RVI': this.rvi, ...(body ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}) };
    let response;
    try { response = await this.fetchImpl(url.href, { method, redirect: 'error', headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch (error) { throw Object.assign(new Error('oneM2M transport'), { code: 'CSE_TRANSPORT_REVIEW', cause: error }); }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    return { status: response.status, rsc: Number(response.headers.get('X-M2M-RSC')), rqi, rqiMatches: response.headers.get('X-M2M-RI') === rqi, payload, path: this.path(target) };
  }
  async create(parent, ty, body) { return this.request('POST', parent, { body, ty }); }
  async retrieve(target, query) { return this.request('GET', target, { query }); }
  async update(target, body) { return this.request('PUT', target, { body }); }
  async remove(target) { return this.request('DELETE', target); }
  /** Register an AE with a chosen originator; an existing registration is read back. */
  async registerAe({ rn, api, poa = [], lbl = [], rr = true, loc } = {}) {
    const created = await this.request('POST', this.cseBase, { ty: 2, body: { 'm2m:ae': { rn, api, rr, poa, lbl, ...(loc ? { loc } : {}) } } });
    if (created.rsc === 2001) return { path: `${this.cseBase}/${rn}`, aei: created.payload?.['m2m:ae']?.aei ?? this.originator, ri: created.payload?.['m2m:ae']?.ri, created: true, rsc: created.rsc };
    if ([4105, 4106].includes(created.rsc)) {
      const existing = await this.retrieve(`${this.cseBase}/${rn}`);
      const ae = existing.payload?.['m2m:ae'];
      if (existing.rsc !== 2000 || ae?.aei !== this.originator) throw Object.assign(new Error(`AE ${rn} is registered to another originator`), { code: 'AE_IDENTITY_REVIEW', rsc: existing.rsc });
      if (poa.length) await this.update(`${this.cseBase}/${rn}`, { 'm2m:ae': { poa } });
      return { path: `${this.cseBase}/${rn}`, aei: ae.aei, ri: ae.ri, created: false, rsc: created.rsc };
    }
    throw Object.assign(new Error(`AE registration ${created.status}/${created.rsc}: ${JSON.stringify(created.payload)?.slice(0, 300)}`), { code: 'AE_REGISTRATION_REVIEW', rsc: created.rsc });
  }
  /** Create-or-reuse a child resource by name; returns its path and ri. */
  async ensure(parent, ty, body) {
    const tag = Object.keys(body)[0];
    const rn = body[tag].rn;
    const path = `${this.path(parent)}/${rn}`;
    const created = await this.create(parent, ty, body);
    if (created.rsc === 2001) return { path, ri: created.payload?.[tag]?.ri, created: true, rsc: created.rsc, payload: created.payload };
    if (created.rsc === 4105) {
      const current = await this.retrieve(path);
      if (current.rsc === 2000) return { path, ri: current.payload?.[tag]?.ri ?? Object.values(current.payload ?? {})[0]?.ri, created: false, rsc: created.rsc, payload: current.payload };
    }
    throw Object.assign(new Error(`create ${path} ${created.status}/${created.rsc}: ${JSON.stringify(created.payload)?.slice(0, 300)}`), { code: 'CSE_CREATE_REVIEW', rsc: created.rsc });
  }
}

/** oneM2M absolute time without separators, e.g. 20261119T120000. */
export function m2mTime(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

export function parseContent(con) {
  if (con && typeof con === 'object') return con;
  if (typeof con !== 'string') return null;
  try { return JSON.parse(con); } catch { return null; }
}
