import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import type { FetchLike } from './onem2m.ts';

/**
 * Per-role oneM2M binding over mutual TLS (R10). The CSE front (nginx /onem2m route) binds X-M2M-Origin to the client
 * certificate fingerprint, so each dashboard role reads with its own least-privilege AE and never with the admin
 * originator. connectHost lets a LAN address serve the certificate host name (SNI and Host stay the name).
 */
export interface RoleBinding {
  /** AE-ID the front binds to this certificate, e.g. Cpb-dash-operator. */
  readonly originator: string;
  readonly endpoint: string;
  readonly cert: string;
  readonly key: string;
  /** CA bundle that verifies the CSE front certificate. */
  readonly ca: string;
  /** Optional IP or host to connect to instead of the endpoint host name. */
  readonly connectHost?: string;
}

const MAX_BODY = 2 * 1024 * 1024;

export function createMtlsFetch(binding: RoleBinding): FetchLike {
  const cert = readFileSync(binding.cert);
  const key = readFileSync(binding.key);
  const ca = readFileSync(binding.ca);
  const impl = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'https:') { reject(new TypeError('mTLS binding needs an https endpoint')); return; }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    headers['host'] = url.host;
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    const outgoing = request({
      host: binding.connectHost ?? url.hostname, port: url.port || 443, servername: url.hostname,
      path: `${url.pathname}${url.search}`, method: init.method ?? 'GET', headers, cert, key, ca, rejectUnauthorized: true,
    }, (incoming) => {
      const chunks: Buffer[] = []; let size = 0;
      incoming.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) { incoming.destroy(new Error('CSE response too large')); return; } chunks.push(chunk); });
      incoming.on('error', reject);
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        const status = incoming.statusCode ?? 502;
        resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
      });
    });
    outgoing.on('error', reject);
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) { outgoing.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted')); return; }
      signal.addEventListener('abort', () => outgoing.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted')), { once: true });
    }
    outgoing.end(body);
  });
  return impl as FetchLike;
}
