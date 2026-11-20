import type { AuditFixture, ResourceFixture } from '../shared/index.ts';
import { pick } from './server-messages.ts';

export class ReadError extends Error {
  readonly status:number|undefined;
  constructor(message: string,status?:number) {
    super(message);
    this.name = 'ReadError';
    this.status=status;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? `${pick('불러오지 못했어요.', 'Could not load.')} (${error.message})` : pick('불러오지 못했어요.', 'Could not load.');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getJson(url: string | URL, signal: AbortSignal, headers?: HeadersInit) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: typeof url==='string'&&url.startsWith('/api/')?'same-origin':'omit',
    redirect: 'error',
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
  });
  if (!response.ok) throw new ReadError(`${pick('서버 응답', 'Server response')} HTTP ${response.status} ${response.statusText}`.trim(),response.status);
  const rsc = response.headers.get('X-M2M-RSC');
  if (rsc !== null && rsc !== '2000') throw new ReadError(`${pick('oneM2M 응답 코드', 'oneM2M response code')} ${rsc}`);
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
    throw new ReadError(pick('모의 자원 데이터 형식이 예상과 달라요.', 'The simulated resource data has an unexpected format.'));
  }
  return value['resources'];
}

export async function fixtureAudit(query: string, signal: AbortSignal): Promise<readonly AuditFixture[]> {
  const { value } = await getJson(`/api/audit?q=${encodeURIComponent(query)}`, signal);
  if (!isRecord(value) || !['fixture', 'integration-journal-replay'].includes(String(value['source'])) || value['simulation'] !== true ||
    !Array.isArray(value['records']) || !value['records'].every(isAudit)) {
    throw new ReadError(pick('모의 활동 기록 형식이 예상과 달라요.', 'The simulated activity log has an unexpected format.'));
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
    throw new ReadError(pick('Mobius 서버 주소는 http:// 또는 https://로 시작하는 주소만 입력하세요. 예: http://127.0.0.1:7579', 'Enter a Mobius server address that starts with http:// or https://, for example http://127.0.0.1:7579'));
  }
  if (!settings.originator.trim() || !settings.rvi.trim() || !settings.aePath.trim()) {
    throw new ReadError(pick('운영자 식별자, 검색 시작 경로, 규격 버전을 입력하세요.', 'Enter the operator originator, the search start path and the release version.'));
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
    throw new ReadError(pick('자원 경로 형식을 확인해 주세요.', 'Check the resource path format.'));
  }
  const url = new URL(uri.startsWith('/') ? uri : `/${uri}`, base);
  if (url.origin !== base.origin || /^[a-z]+:/i.test(uri)) {
    throw new ReadError(pick('설정한 서버 안의 자원만 불러와요. 다른 서버 주소는 직접 확인해 주세요.', 'Only resources on the configured server are loaded. Check other server addresses yourself.'));
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
    throw new ReadError(pick('자원 유형(ty)과 개수(lim)는 1 이상, 건너뛸 개수(ofst)는 0 이상의 정수로 입력하세요.', 'Enter whole numbers: resource type (ty) and limit (lim) of 1 or more, offset (ofst) of 0 or more.'));
  }
  // Source-derived query only: docs/primary-sources.md M2-M6. No CREATE Content-Type.
  url.search = new URLSearchParams({
    fu: '1', drt: '1', ty: settings.ty, lim: settings.limit, ofst: settings.offset,
    ...(settings.cnd.trim() ? { cnd: settings.cnd.trim() } : {}),
  }).toString();
  const { value, headers } = await getJson(url, signal, mobiusHeaders(settings));
  if (!isRecord(value) || !Array.isArray(value['m2m:uril']) ||
    !value['m2m:uril'].every((uri: unknown): uri is string => typeof uri === 'string')) {
    throw new ReadError(pick('자원 찾기 응답 형식이 예상과 달라요. (m2m:uril 필요)', 'The discovery response has an unexpected format (m2m:uril required).'));
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
  if (!isRecord(value)) throw new ReadError(pick('자원 응답 형식이 예상과 달라요. (JSON 객체 필요)', 'The resource response has an unexpected format (JSON object required).'));
  const entries = Object.entries(value);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || !entry[0].includes(':') || !isRecord(entry[1])) {
    throw new ReadError(pick('자원 응답 형식이 예상과 달라요. (namespaced envelope 필요)', 'The resource response has an unexpected format (namespaced envelope required).'));
  }
  return { envelope: entry[0], attributes: entry[1], rsc: headers.get('X-M2M-RSC') };
}
