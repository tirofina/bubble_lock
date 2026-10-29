import type { AuditFixture, ResourceFixture } from '../shared/index.ts';

export class ReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? `조회하지 못했습니다. 진단: ${error.message}` : '알 수 없는 조회 오류';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getJson(url: string | URL, signal: AbortSignal, headers?: HeadersInit) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
  });
  if (!response.ok) throw new ReadError(`조회 실패: HTTP ${response.status} ${response.statusText}`);
  const rsc = response.headers.get('X-M2M-RSC');
  if (rsc !== null && rsc !== '2000') throw new ReadError(`oneM2M 조회 실패: RSC ${rsc}`);
  const value: unknown = await response.json();
  return { value, headers: response.headers };
}

function isResource(value: unknown): value is ResourceFixture {
  return isRecord(value) &&
    typeof value['resourceUri'] === 'string' &&
    (typeof value['parentUri'] === 'string' || value['parentUri'] === null) &&
    typeof value['name'] === 'string' && typeof value['ty'] === 'number' &&
    ['healthy', 'degraded', 'unknown'].includes(String(value['health'])) &&
    (value['state'] === undefined || typeof value['state'] === 'boolean') &&
    (value['cnd'] === undefined || typeof value['cnd'] === 'string') &&
    (value['deviceId'] === undefined || typeof value['deviceId'] === 'string') &&
    (value['gatewayId'] === undefined || typeof value['gatewayId'] === 'string');
}

function isAudit(value: unknown): value is AuditFixture {
  return isRecord(value) && value['simulation'] === true &&
    ['id', 'receivedAt', 'actor', 'action', 'resourceUri'].every((key) => typeof value[key] === 'string') &&
    ['allowed', 'denied', 'pending'].includes(String(value['outcome'])) &&
    (value['commandId'] === undefined || typeof value['commandId'] === 'string');
}

export async function fixtureResources(signal: AbortSignal): Promise<readonly ResourceFixture[]> {
  const { value } = await getJson('/api/resources', signal);
  if (!isRecord(value) || value['source'] !== 'fixture' || value['simulation'] !== true ||
    !Array.isArray(value['resources']) || !value['resources'].every(isResource)) {
    throw new ReadError('모의 자원 응답이 계약과 다릅니다.');
  }
  return value['resources'];
}

export async function fixtureAudit(query: string, signal: AbortSignal): Promise<readonly AuditFixture[]> {
  const { value } = await getJson(`/api/audit?q=${encodeURIComponent(query)}`, signal);
  if (!isRecord(value) || value['source'] !== 'fixture' || value['simulation'] !== true ||
    !Array.isArray(value['records']) || !value['records'].every(isAudit)) {
    throw new ReadError('모의 감사 응답이 계약과 다릅니다.');
  }
  return value['records'];
}

export interface MobiusSettings {
  readonly baseUrl: string;
  readonly originator: string;
  readonly aePath: string;
  readonly acp: string;
  readonly rvi: string;
  readonly ty: string;
  readonly cnd: string;
  readonly limit: string;
  readonly offset: string;
}

export const defaultMobiusSettings: MobiusSettings = {
  baseUrl: 'http://127.0.0.1:7579',
  originator: '',
  aePath: '/Mobius/privacy-bubble-test-ae',
  acp: '',
  rvi: '3',
  ty: '28',
  cnd: 'org.onem2m.common.moduleclass.binarySwitch',
  limit: '100',
  offset: '0',
};

function authority(settings: MobiusSettings): URL {
  const base = new URL(settings.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
    base.pathname !== '/' || base.search || base.hash) {
    throw new ReadError('Mobius 주소에는 HTTP(S) origin만 입력하세요. 경로·비밀값은 넣지 마세요.');
  }
  if (!settings.originator.trim() || !settings.rvi.trim() || !settings.aePath.trim()) {
    throw new ReadError('운영자 Originator, AE 경로, RVI를 입력하세요.');
  }
  return base;
}

/** Pinned upstream returns CSE-relative structured sid strings with drt=1.
 * Preserve explicit /~ and /_ HTTP mappings; never send identity to another host.
 * AE/ACP are operator context, not browser-enforced authorization.
 */
export function resourceUrl(settings: MobiusSettings, uri: string): URL {
  const base = authority(settings);
  if (!uri || uri.includes('\\') || uri.includes('?') || uri.includes('#') || uri.includes('..')) {
    throw new ReadError('조회할 자원 경로가 올바르지 않습니다.');
  }
  const url = new URL(uri.startsWith('/') ? uri : `/${uri}`, base);
  if (url.origin !== base.origin || /^[a-z]+:/i.test(uri)) {
    throw new ReadError('다른 서버의 discovery 주소는 자동 조회하지 않습니다.');
  }
  return url;
}

function mobiusHeaders(settings: MobiusSettings): Record<string, string> {
  return {
    'X-M2M-Origin': settings.originator.trim(),
    'X-M2M-RI': `dashboard-${crypto.randomUUID()}`,
    'X-M2M-RVI': settings.rvi.trim(),
  };
}

export interface Discovery {
  readonly uris: readonly string[];
  readonly partial: boolean;
  readonly nextOffset: string | null;
  readonly rsc: string | null;
}

export async function discover(settings: MobiusSettings, signal: AbortSignal): Promise<Discovery> {
  const url = resourceUrl(settings, settings.aePath.trim());
  if (!/^[1-9]\d*$/.test(settings.ty) || !/^[1-9]\d*$/.test(settings.limit) || !/^\d+$/.test(settings.offset)) {
    throw new ReadError('ty와 lim은 양의 정수, ofst는 0 이상의 정수여야 합니다.');
  }
  // Source-derived query only: docs/primary-sources.md M2-M6. No CREATE Content-Type.
  url.search = new URLSearchParams({
    fu: '1', drt: '1', ty: settings.ty, lim: settings.limit, ofst: settings.offset,
    ...(settings.cnd.trim() ? { cnd: settings.cnd.trim() } : {}),
  }).toString();
  const { value, headers } = await getJson(url, signal, mobiusHeaders(settings));
  if (!isRecord(value) || !Array.isArray(value['m2m:uril']) ||
    !value['m2m:uril'].every((uri: unknown): uri is string => typeof uri === 'string')) {
    throw new ReadError('discovery 응답에 m2m:uril 문자열 배열이 없습니다.');
  }
  const uris = [...new Set(value['m2m:uril'].map((uri) => resourceUrl(settings, uri).pathname))];
  return { uris, partial: headers.get('X-M2M-CTS') === '1', nextOffset: headers.get('X-M2M-CTO'), rsc: headers.get('X-M2M-RSC') };
}

export interface LiveResource {
  readonly envelope: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly rsc: string | null;
}

export async function retrieve(settings: MobiusSettings, uri: string, signal: AbortSignal): Promise<LiveResource> {
  const { value, headers } = await getJson(resourceUrl(settings, uri), signal, mobiusHeaders(settings));
  if (!isRecord(value)) throw new ReadError('자원 응답이 JSON 객체가 아닙니다.');
  const entries = Object.entries(value);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || !entry[0].includes(':') || !isRecord(entry[1])) {
    throw new ReadError('자원 응답에 namespaced resource envelope가 없습니다.');
  }
  return { envelope: entry[0], attributes: entry[1], rsc: headers.get('X-M2M-RSC') };
}
