import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

/** oneM2M timestamp (TS-0004 6.3.3, UTC, second resolution) from an ISO date or epoch ms. */
export function toOneM2mTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

/** ISO 8601 from a oneM2M YYYYMMDDTHHMMSS[,ffffff] timestamp. */
export function fromOneM2mTime(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:[,.](\d{1,6}))?$/.exec(String(value));
  if (!match) throw new Error(`oneM2M timestamp format: ${value}`);
  const [, y, mo, d, h, mi, s, fraction = '0'] = match;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Number(fraction.padEnd(3, '0').slice(0, 3)))).toISOString();
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

/** Same digest as integration-utils approvalHash and bubble_gateway.model.payload_hash. */
export function payloadHash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** Minimal oneM2M HTTP binding client (TS-0009) for one originator. */
export class Onem2mHttp {
  constructor({ endpoint, originator, rvi = '4', timeoutMs = 5000, fetchImpl = globalThis.fetch, trace = null }) {
    if (!originator) throw new Error('oneM2M originator required');
    Object.assign(this, { endpoint: endpoint.replace(/\/$/, ''), originator, rvi, timeoutMs, fetchImpl, trace });
  }

  async request(method, path, { body, ty, query, origin } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..')) throw new Error(`oneM2M path: ${path}`);
    const rqi = `rq-${randomUUID()}`;
    const url = new URL(`${this.endpoint}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    const started = Date.now();
    const response = await this.fetchImpl(url.href, {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'X-M2M-Origin': origin ?? this.originator,
        'X-M2M-RI': rqi,
        'X-M2M-RVI': this.rvi,
        ...(body ? { 'Content-Type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 500) }; }
    const rsc = Number(response.headers.get('X-M2M-RSC'));
    if (response.headers.get('X-M2M-RI') !== rqi) throw new Error(`oneM2M response request identifier mismatch for ${method} ${path}`);
    const result = { status: response.status, rsc, rqi, payload, durationMs: Date.now() - started, method, path: `${url.pathname}${url.search}` };
    this.trace?.(result);
    return result;
  }

  async expect(method, path, codes, options) {
    const result = await this.request(method, path, options);
    if (!codes.includes(result.rsc)) {
      const debug = typeof result.payload?.['m2m:dbg'] === 'string' ? result.payload['m2m:dbg'] : JSON.stringify(result.payload)?.slice(0, 300);
      throw Object.assign(new Error(`${method} ${path} expected ${codes.join('/')} got ${result.rsc}: ${debug}`), { result });
    }
    return result;
  }

  /** CREATE, or reuse the existing resource with the same resourceName. */
  async ensure(parent, ty, body) {
    const created = await this.request('POST', parent, { body, ty });
    if (created.rsc === 2001) return { created: true, path: `${parent}/${Object.values(body)[0].rn}`, payload: created.payload, rsc: created.rsc };
    if (created.rsc === 4105) {
      const path = `${parent}/${Object.values(body)[0].rn}`;
      const read = await this.expect('GET', path, [2000]);
      return { created: false, path, payload: read.payload, rsc: created.rsc };
    }
    throw new Error(`CREATE ${parent} ty=${ty} got ${created.rsc}: ${JSON.stringify(created.payload)?.slice(0, 300)}`);
  }

  /** AE registration with a pre-assigned AE-ID (TS-0001 10.1.1.2.2); reuse refreshes poa. */
  async registerAe(cseBase, { rn, api, poa, lbl = [] }) {
    const body = { 'm2m:ae': { rn, api, rr: true, srv: ['4'], poa, lbl } };
    const created = await this.request('POST', cseBase, { body, ty: 2 });
    if (created.rsc === 2001) return { created: true, path: `${cseBase}/${rn}`, aei: created.payload['m2m:ae'].aei, rsc: 2001 };
    const updated = await this.expect('PUT', `${cseBase}/${rn}`, [2004], { body: { 'm2m:ae': { poa, lbl } } });
    return { created: false, path: `${cseBase}/${rn}`, aei: updated.payload['m2m:ae'].aei, rsc: created.rsc };
  }
}

export function discoveredPaths(payload) {
  return (payload?.['m2m:uril'] ?? []).map((uri) => (uri.startsWith('/') ? uri : `/${uri}`));
}

/** Notification ingress for one or more AEs. Each AE gets the prefix /<app>. */
export async function startNotificationServer({ cseId, host = '127.0.0.1', port = 0, onNotify }) {
  const stats = { received: 0, rejected: 0, verification: 0, deletion: 0 };
  const server = createServer(async (request, response) => {
    const reply = (status, rsc) => { response.writeHead(status, { 'X-M2M-RSC': String(rsc), 'X-M2M-RI': String(request.headers['x-m2m-ri'] ?? ''), 'Content-Length': '0' }); response.end(); };
    try {
      if (request.method !== 'POST') return reply(405, 4005);
      if (request.headers['x-m2m-origin'] !== cseId) { stats.rejected += 1; return reply(403, 4103); }
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) return reply(413, 4000); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const sgn = body?.['m2m:sgn'];
      if (!sgn || typeof sgn !== 'object') { stats.rejected += 1; return reply(400, 4000); }
      const app = new URL(request.url ?? '/', 'http://loopback').pathname.split('/').filter(Boolean)[0] ?? '';
      if (sgn.vrq) { stats.verification += 1; return reply(200, 2000); }
      if (sgn.sud) stats.deletion += 1;
      stats.received += 1;
      reply(200, 2000);
      await onNotify({ app, sgn, receivedAt: new Date().toISOString(), requestId: request.headers['x-m2m-ri'] });
    } catch {
      if (!response.headersSent) reply(400, 4000);
    }
  });
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  return {
    server, stats, url: `http://${host}:${address.port}`,
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

/** Normalize a subscription reference (sur) or structured ID to /Mobius/... form. */
export function normalizeSid(value, cseBase = '/Mobius') {
  let text = String(value ?? '');
  const base = cseBase.replace(/^\//, '');
  const at = text.indexOf(`${base}/`);
  if (at >= 0) text = text.slice(at);
  return text.startsWith('/') ? text : `/${text}`;
}
