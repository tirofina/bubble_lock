import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';

/** Minimal oneM2M HTTP binding client (TS-0009) for one AE originator. */
export interface Onem2mResult {
  readonly status: number;
  readonly rsc: number;
  readonly rqi: string;
  readonly payload: Record<string, unknown> | null;
}
export type FetchLike = typeof fetch;

export class Onem2mClient {
  readonly endpoint: string;
  readonly originator: string;
  readonly rvi: string;
  readonly timeoutMs: number;
  readonly fetchImpl: FetchLike;
  /** allowLanHttp: explicit opt-in for plain HTTP to a private (RFC 1918) address, e.g. a self-hosted LAN relay. */
  constructor(options: { endpoint: string; originator: string; rvi?: string; timeoutMs?: number; fetchImpl?: FetchLike; allowLanHttp?: boolean }) {
    const url = new URL(options.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('CSE endpoint를 확인하세요.');
    const lan = options.allowLanHttp === true && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
    if (url.protocol === 'http:' && !lan && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new TypeError('원격 CSE에는 HTTPS를 설정하세요.');
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.originator = options.originator;
    this.rvi = options.rvi ?? '4';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: { body?: unknown; ty?: number; query?: Readonly<Record<string, string | number>> } = {}): Promise<Onem2mResult> {
    if (!path.startsWith('/') || path.includes('..') || /[?#\\]/.test(path)) throw new TypeError(`oneM2M path: ${path}`);
    const rqi = `dash-${randomUUID()}`;
    const url = new URL(`${this.endpoint}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
    const response = await this.fetchImpl(url.href, {
      method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Accept: 'application/json', 'X-M2M-Origin': this.originator, 'X-M2M-RI': rqi, 'X-M2M-RVI': this.rvi,
        ...(options.body === undefined ? {} : { 'Content-Type': `application/json${options.ty ? `;ty=${options.ty}` : ''}` }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error('CSE 응답 크기를 확인하세요.');
    let payload: Record<string, unknown> | null = null;
    try { const parsed: unknown = text ? JSON.parse(text) : null; payload = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null; } catch { payload = null; }
    if (response.headers.get('X-M2M-RI') !== rqi) throw new Error(`oneM2M 요청 식별자 불일치: ${method} ${path}`);
    return { status: response.status, rsc: Number(response.headers.get('X-M2M-RSC')), rqi, payload };
  }

  async expect(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, codes: readonly number[], options: { body?: unknown; ty?: number; query?: Readonly<Record<string, string | number>> } = {}): Promise<Onem2mResult> {
    const result = await this.request(method, path, options);
    if (!codes.includes(result.rsc)) throw Object.assign(new Error(`${method} ${path} → ${result.rsc}`), { rsc: result.rsc });
    return result;
  }

  /** Register with a pre-assigned AE-ID; an existing registration keeps its AE-ID and refreshes poa. */
  async registerAe(cseBase: string, ae: { rn: string; api: string; poa: readonly string[]; lbl?: readonly string[] }): Promise<{ created: boolean; path: string }> {
    const body = { 'm2m:ae': { rn: ae.rn, api: ae.api, rr: true, srv: ['4'], poa: ae.poa, lbl: ae.lbl ?? [] } };
    const created = await this.request('POST', cseBase, { body, ty: 2 });
    if (created.rsc === 2001) return { created: true, path: `${cseBase}/${ae.rn}` };
    await this.expect('PUT', `${cseBase}/${ae.rn}`, [2004], { body: { 'm2m:ae': { poa: ae.poa, lbl: ae.lbl ?? [] } } });
    return { created: false, path: `${cseBase}/${ae.rn}` };
  }
}

export function discoveredUris(payload: Record<string, unknown> | null): readonly string[] {
  const list = payload?.['m2m:uril'];
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string').map((uri) => (uri.startsWith('/') ? uri : `/${uri}`)) : [];
}

export interface NotificationIngress {
  readonly server: Server;
  readonly url: string;
  readonly stats: { received: number; rejected: number; verification: number };
  close(): Promise<void>;
}

/** CSE → AE notification endpoint. Path prefix selects the application (/operator, /guardian). */
export async function startNotificationIngress(options: {
  cseId: string; host?: string; port?: number;
  onNotify: (app: string, body: unknown, receivedAt: string) => Promise<void> | void;
}): Promise<NotificationIngress> {
  const stats = { received: 0, rejected: 0, verification: 0 };
  const server = createServer(async (request, response) => {
    const reply = (status: number, rsc: number) => {
      response.writeHead(status, { 'X-M2M-RSC': String(rsc), 'X-M2M-RI': String(request.headers['x-m2m-ri'] ?? ''), 'Content-Length': '0' });
      response.end();
    };
    try {
      if (request.method !== 'POST') { reply(405, 4005); return; }
      if (request.headers['x-m2m-origin'] !== options.cseId) { stats.rejected += 1; reply(403, 4103); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk as Buffer); size += bytes.length; if (size > 1024 * 1024) { reply(413, 4000); return; } chunks.push(bytes); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const app = new URL(request.url ?? '/', 'http://loopback').pathname.split('/').filter(Boolean)[0] ?? '';
      const sgn = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['m2m:sgn'] : undefined;
      if (typeof sgn !== 'object' || sgn === null) { stats.rejected += 1; reply(400, 4000); return; }
      if ((sgn as Record<string, unknown>)['vrq'] === true) { stats.verification += 1; reply(200, 2000); return; }
      stats.received += 1;
      reply(200, 2000);
      await options.onNotify(app, body, new Date().toISOString());
    } catch {
      if (!response.headersSent) reply(400, 4000);
    }
  });
  server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP notification listener');
  return {
    server, stats, url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
