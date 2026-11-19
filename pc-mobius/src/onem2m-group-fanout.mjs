import { randomUUID } from 'node:crypto';
import { encodeBinarySwitch, SDT_PROFILES, CANONICAL_SDT_PROFILE } from './sdt-adapter.mjs';

// oneM2M <group> fanOutPoint client for binarySwitch flexContainer members.
// TS-0001 9.6.13/9.6.14 and TS-0004 7.4.14.2.4: one request to <grp>/fopt is fanned out by the
// group-hosting CSE, and each member answer comes back inside m2m:agr/m2m:rsp with its own rsc
// and the member identifier in fr. This client never throws on a member failure: the caller
// receives every member rsc and decides which members to retry.

const RN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MEMBER_OK = new Set([2000, 2004]);
const GROUP_KEYS = new Set(['rn', 'mid', 'macp', 'acpi', 'et', 'lbl', 'mnm']);

export const memberKey = (value) => String(value ?? '').replace(/^\/+/, '');

/** ISO 8601 -> oneM2M basic timestamp (YYYYMMDDTHHMMSS, UTC). */
export function toOneM2mTime(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('oneM2M expirationTime requires a valid timestamp');
  return new Date(parsed).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

export class OneM2mGroupFanout {
  constructor({ endpoint, cseBase = '/Mobius', originator, fetchImpl = globalThis.fetch, timeoutMs = 5000, rvi = '4', sdtProfile = CANONICAL_SDT_PROFILE } = {}) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Group fan-out CSE endpoint를 확인하세요.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('원격 CSE Group fan-out에는 HTTPS를 설정하세요.');
    if (typeof originator !== 'string' || !originator) throw new Error('Group fan-out originator를 설정하세요.');
    if (!Object.hasOwn(SDT_PROFILES, sdtProfile)) throw new Error('Group fan-out SDT profile을 확인하세요.');
    if (typeof fetchImpl !== 'function') throw new Error('Group fan-out fetch 구현이 필요합니다.');
    Object.assign(this, { endpoint: endpoint.replace(/\/$/, ''), cseBase: cseBase.replace(/\/$/, ''), originator, fetchImpl, timeoutMs, rvi: String(rvi), sdtProfile });
    this.envelope = SDT_PROFILES[sdtProfile].envelope;
  }

  path(value) {
    if (typeof value !== 'string' || !value.startsWith(`${this.cseBase}/`) || /[?#%\\]/.test(value)
        || value.split('/').some((part) => part === '..' || part === '.')) throw new Error('Group fan-out 자원 경로 범위를 확인하세요.');
    return value.replace(/\/$/, '');
  }

  async request(method, path, { body, ty } = {}) {
    const rqi = `grp-${randomUUID()}`;
    let response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${this.path(path)}`, { method, redirect: 'error', headers: { accept: 'application/json', 'X-M2M-Origin': this.originator, 'X-M2M-RI': rqi, 'X-M2M-RVI': this.rvi, ...(body ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      return { status: 0, rsc: null, rqi, rqiMatches: false, payload: null, transportError: error.name === 'TimeoutError' ? 'CSE_TIMEOUT' : 'CSE_TRANSPORT' };
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Group fan-out 응답 크기를 확인하세요.');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    return { status: response.status, rsc: Number(response.headers.get('X-M2M-RSC')), rqi, rqiMatches: response.headers.get('X-M2M-RI') === rqi, payload };
  }

  /** Create or update the household <grp>. mid uses CSE-relative structured paths of each member. */
  async ensureGroup({ parent, rn, members, macp = null, acpi = null, et = null, lbl = null, mnm = 16 }) {
    if (!RN.test(rn ?? '')) throw new Error('Group resourceName을 확인하세요.');
    if (!Array.isArray(members) || members.length < 1 || members.length > mnm) throw new Error('Group 구성원 수를 확인하세요.');
    const mid = members.map((member) => memberKey(this.path(member.path)));
    if (new Set(mid).size !== mid.length) throw new Error('Group 구성원 경로가 중복되었습니다.');
    const groupPath = `${this.path(parent)}/${rn}`;
    const attributes = { rn, mt: 28, mnm, mid, csy: 1, ...(macp ? { macp } : {}), ...(acpi ? { acpi } : {}), ...(et ? { et: toOneM2mTime(et) } : {}), ...(lbl ? { lbl } : {}) };
    const created = await this.request('POST', parent, { body: { 'm2m:grp': attributes }, ty: 9 });
    if (created.rsc === 2001 && created.rqiMatches) return this.groupResult(groupPath, created, { created: true, updated: false });
    if (created.rsc !== 4105) throw Object.assign(new Error(`Group 생성 응답 ${created.status}/${created.rsc}: ${this.debug(created)}`), { rsc: created.rsc });
    const current = await this.request('GET', groupPath);
    if (current.rsc !== 2000 || !current.payload?.['m2m:grp']) throw Object.assign(new Error(`Group 조회 응답 ${current.status}/${current.rsc}`), { rsc: current.rsc });
    const existing = current.payload['m2m:grp'];
    const patch = {};
    if (JSON.stringify([...(existing.mid ?? [])].map(memberKey).sort()) !== JSON.stringify([...mid].sort())) patch.mid = mid;
    if (macp && JSON.stringify(existing.macp ?? []) !== JSON.stringify(macp)) patch.macp = macp;
    if (attributes.et && existing.et !== attributes.et) patch.et = attributes.et;
    if (!Object.keys(patch).length) return this.groupResult(groupPath, current, { created: false, updated: false });
    for (const key of Object.keys(patch)) if (!GROUP_KEYS.has(key)) delete patch[key];
    const updated = await this.request('PUT', groupPath, { body: { 'm2m:grp': patch } });
    if (updated.rsc !== 2004 || !updated.rqiMatches) throw Object.assign(new Error(`Group 갱신 응답 ${updated.status}/${updated.rsc}: ${this.debug(updated)}`), { rsc: updated.rsc });
    return this.groupResult(groupPath, updated, { created: false, updated: true, patch: Object.keys(patch) });
  }

  groupResult(path, response, extra) {
    const grp = response.payload?.['m2m:grp'] ?? {};
    return { path, ri: grp.ri, mid: grp.mid ?? [], macp: grp.macp ?? [], mt: grp.mt, mtv: grp.mtv, cnm: grp.cnm, mnm: grp.mnm, csy: grp.csy, et: grp.et, rsc: response.rsc, rqi: response.rqi, ...extra };
  }

  debug(response) {
    const value = response.payload?.['m2m:dbg'];
    return typeof value === 'string' ? value.slice(0, 300) : response.transportError ?? 'no debug';
  }

  /** One UPDATE to <grp>/fopt. Returns the aggregate rsc and one entry per member answer. */
  async fanOut(groupPath, state) {
    if (typeof state !== 'boolean') throw new Error('Group fan-out state boolean을 확인하세요.');
    const body = encodeBinarySwitch({ state }, { profile: this.sdtProfile, operation: 'UPDATE' });
    const response = await this.request('PUT', `${this.path(groupPath)}/fopt`, { body });
    const answers = response.payload?.['m2m:agr']?.['m2m:rsp'];
    const members = Array.isArray(answers) ? answers.map((answer) => {
      const rsc = Number(answer?.rsc);
      return { fr: memberKey(answer?.fr), rsc, ok: MEMBER_OK.has(rsc), state: answer?.pc?.[this.envelope]?.state, dbg: typeof answer?.pc?.['m2m:dbg'] === 'string' ? answer.pc['m2m:dbg'].slice(0, 300) : undefined };
    }) : [];
    return { aggregateRsc: response.rsc, status: response.status, rqi: response.rqi, rqiMatches: response.rqiMatches, transportError: response.transportError, request: body, members, debug: Array.isArray(answers) ? undefined : this.debug(response) };
  }

  async updateMember(path, state) {
    if (typeof state !== 'boolean') throw new Error('구성원 state boolean을 확인하세요.');
    const response = await this.request('PUT', path, { body: encodeBinarySwitch({ state }, { profile: this.sdtProfile, operation: 'UPDATE' }) });
    return { rsc: response.rsc, rqi: response.rqi, rqiMatches: response.rqiMatches, ok: response.rsc === 2004 && response.rqiMatches, state: response.payload?.[this.envelope]?.state, debug: response.rsc === 2004 ? undefined : this.debug(response) };
  }

  async readMember(path) {
    const response = await this.request('GET', path);
    const resource = response.payload?.[this.envelope];
    return { rsc: response.rsc, rqi: response.rqi, rqiMatches: response.rqiMatches, ok: response.rsc === 2000 && response.rqiMatches && typeof resource?.state === 'boolean', state: resource?.state, ri: resource?.ri, cnd: resource?.cnd, envelope: response.payload ? Object.keys(response.payload)[0] : undefined };
  }

  /** contentInstance with expirationTime under a container that carries mni. */
  async appendInstance(containerPath, content, { et = null, lbl = null } = {}) {
    const body = { 'm2m:cin': { cnf: 'application/json', con: content, ...(et ? { et: toOneM2mTime(et) } : {}), ...(lbl ? { lbl } : {}) } };
    const response = await this.request('POST', containerPath, { body, ty: 4 });
    return { rsc: response.rsc, rqi: response.rqi, ok: response.rsc === 2001 && response.rqiMatches, ri: response.payload?.['m2m:cin']?.ri, et: response.payload?.['m2m:cin']?.et };
  }
}
