// TLS 1.3 mTLS front for Mobius4 (DOC-REV 2.0.0, R10).
//
// client --(TLS 1.3, client certificate from the local CA)--> this front --(loopback HTTP)--> Mobius4
//
// The front verifies the client certificate, resolves exactly one AE originator from the binding
// table, overwrites an absent X-M2M-Origin with it, rejects a different one with HTTP 403 /
// X-M2M-RSC 4103 before the CSE sees the request, and writes a hash-chained audit row per request
// and per failed handshake. The CSE then applies its ACPs to the bound originator.
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {
  BindingTableSource, HashChainedAudit, REJECTIONS, certificateIdentities, decideOrigin, headerValues,
  originatorDigest, rejectionBody, resolveBinding,
} from './originator-binding.mjs';

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
// Identity hints a client could forge; the front is the only identity source for the CSE.
const SPOOFABLE = [/^x-forwarded-/, /^forwarded$/, /^x-real-ip$/, /^x-ssl-/, /^x-client-/, /^x-tls-/, /^ssl-client/, /^x-bubble-/, /^x-m2m-origin$/];
const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

export function forwardHeaders(headers, originator, bodyLength) {
  const named = new Set(String(headers.connection ?? '').split(',').map((token) => token.trim().toLowerCase()).filter(Boolean));
  const result = {}; const stripped = [];
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    if (SPOOFABLE.some((pattern) => pattern.test(name))) { if (name !== 'x-m2m-origin') stripped.push(name); continue; }
    result[name] = value;
  }
  result['x-m2m-origin'] = originator;
  if (bodyLength > 0) result['content-length'] = String(bodyLength);
  return { headers: result, stripped };
}

function responseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'upgrade', 'trailer'].includes(name)));
}

function certificateSummary(identities) {
  return { fingerprint256: identities.fingerprint256 ?? null, serialNumber: identities.serialNumber ?? null, sanUris: identities.uris ?? [], cns: identities.cns ?? [], issuerCN: identities.issuerCN ?? null, validTo: identities.validTo ?? null };
}

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('payload'), { code: 'PAYLOAD_TOO_LARGE' }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export async function startOriginatorBindingProxy({
  host = '127.0.0.1', port = 0, tls, upstream, bindingTablePath, auditPath,
  maxBodyBytes = 1024 * 1024, upstreamTimeoutMs = 15000, now = () => Date.now(),
}) {
  if (!tls?.key || !tls?.cert || !tls?.ca) throw new Error('TLS key, certificate and client CA are required.');
  const upstreamUrl = new URL(upstream);
  if (upstreamUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstreamUrl.hostname)) throw new Error('The CSE upstream must be a loopback HTTP listener behind this front.');
  const upstreamHost = upstreamUrl.hostname.replace(/^\[|\]$/g, ''); const upstreamPort = Number(upstreamUrl.port || 80);
  const source = new BindingTableSource(bindingTablePath);
  const audit = new HashChainedAudit(auditPath); await audit.init();
  const initial = await source.current();
  if (!initial.table) throw new Error(`Binding table unavailable: ${initial.error}`);
  let connections = 0;
  const stats = { forwarded: 0, rejected: 0, handshakeRejected: 0 };

  const server = createServer({
    key: tls.key, cert: tls.cert, ca: tls.ca, ...(tls.crl ? { crl: tls.crl } : {}),
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true,
  }, async (req, res) => {
    const started = performance.now();
    const socket = req.socket;
    const rqi = typeof req.headers['x-m2m-ri'] === 'string' && REQUEST_ID.test(req.headers['x-m2m-ri']) ? req.headers['x-m2m-ri'] : null;
    const rvi = typeof req.headers['x-m2m-rvi'] === 'string' && /^[0-9a-z]{1,4}$/.test(req.headers['x-m2m-rvi']) ? req.headers['x-m2m-rvi'] : null;
    const target = typeof req.url === 'string' && req.url.startsWith('/') && !req.url.startsWith('//') ? new URL(req.url, 'https://front.invalid') : null;
    const peer = socket.getPeerCertificate();
    const identities = certificateIdentities(peer);
    const state = await source.current();
    const base = {
      event: 'HTTP_REQUEST', connectionId: socket.bubbleConnectionId ?? null, method: req.method,
      path: target?.pathname ?? null, queryKeys: target ? [...new Set(target.searchParams.keys())].sort() : [], requestId: rqi,
      tls: { protocol: socket.getProtocol(), cipher: socket.getCipher()?.name ?? null, sessionReused: socket.isSessionReused() },
      certificate: certificateSummary(identities), tableRevision: state.table?.revision ?? null, tableSha256: state.table?.sha256 ?? null,
    };
    const reject = async (code, extra = {}) => {
      const mapping = REJECTIONS[code];
      const entry = await audit.append({ ...base, ...extra, decision: 'REJECTED', code, httpStatus: mapping.httpStatus, rsc: mapping.rsc, latencyMs: Math.round(performance.now() - started) });
      stats.rejected += 1;
      const body = JSON.stringify(rejectionBody(code, { auditId: entry.entryHash.slice(0, 16), requestId: rqi }));
      if (!res.headersSent) res.writeHead(mapping.httpStatus, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-m2m-rsc': String(mapping.rsc), ...(rqi ? { 'x-m2m-ri': rqi } : {}), ...(rvi ? { 'x-m2m-rvi': rvi } : {}) });
      res.end(body);
    };
    try {
      if (!socket.authorized) return await reject('CLIENT_CERTIFICATE_UNVERIFIED');
      if (!METHODS.has(req.method)) return await reject('METHOD_NOT_ALLOWED');
      if (!target) return await reject('REQUEST_TARGET_INVALID');
      if (!state.table) return await reject('BINDING_TABLE_UNAVAILABLE', { tableError: state.error });
      const resolved = resolveBinding(state.table, peer, { now: now() });
      if (!resolved.ok) return await reject(resolved.code, { bindingId: resolved.binding?.bindingId ?? null });
      const binding = resolved.binding;
      const decision = decideOrigin(binding, headerValues(req.rawHeaders, 'x-m2m-origin'));
      const bound = { bindingId: binding.bindingId, role: binding.role, originatorDigest: originatorDigest(binding.originator), suppliedOrigin: decision.supplied, ...(decision.suppliedDigest ? { suppliedOriginatorDigest: decision.suppliedDigest } : {}) };
      if (!decision.ok) return await reject(decision.code, bound);
      let body;
      try { body = await readBody(req, maxBodyBytes); } catch { return await reject('PAYLOAD_TOO_LARGE', bound); }
      const { headers, stripped } = forwardHeaders(req.headers, decision.originator, body.length);
      const upstreamRes = await new Promise((resolveResponse, rejectResponse) => {
        const forward = httpRequest({ host: upstreamHost, port: upstreamPort, method: req.method, path: `${target.pathname}${target.search}`, headers, timeout: upstreamTimeoutMs }, resolveResponse);
        forward.on('timeout', () => forward.destroy(new Error('upstream timeout')));
        forward.on('error', rejectResponse);
        forward.end(body);
      }).catch(() => null);
      if (!upstreamRes) return await reject('UPSTREAM_UNREACHABLE', bound);
      res.writeHead(upstreamRes.statusCode, responseHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      await once(res, 'finish').catch(() => {});
      stats.forwarded += 1;
      await audit.append({ ...base, ...bound, decision: 'FORWARDED', mode: decision.mode, strippedHeaders: stripped, bodyBytes: body.length, bodySha256: body.length ? createHash('sha256').update(body).digest('hex') : null, httpStatus: upstreamRes.statusCode, rsc: Number(upstreamRes.headers['x-m2m-rsc']) || null, latencyMs: Math.round(performance.now() - started) });
    } catch (error) {
      if (!res.headersSent) await reject('UPSTREAM_UNREACHABLE', { error: String(error?.code ?? 'ERROR') }); else res.destroy();
    }
  });
  server.on('secureConnection', (socket) => { connections += 1; socket.bubbleConnectionId = connections; });
  server.on('tlsClientError', (error, socket) => {
    stats.handshakeRejected += 1;
    // Node destroys an unverified socket right after the handshake; authorizationError keeps the
    // X.509 verification result (CERT_HAS_EXPIRED, INVALID_PURPOSE, UNABLE_TO_VERIFY_LEAF_SIGNATURE).
    const verifyError = socket?.authorizationError ?? null;
    audit.append({ event: 'TLS_HANDSHAKE_REJECTED', decision: 'REJECTED', code: verifyError ?? error.code ?? 'TLS_ERROR', transportCode: error.code ?? null, reason: error.reason ?? String(error.message).slice(0, 200), remoteAddress: socket?.remoteAddress ?? null, tableRevision: source.state.table?.revision ?? null }).catch(() => {});
  });
  server.keepAliveTimeout = 10000;
  server.listen(port, host); await once(server, 'listening');
  return {
    server, port: server.address().port, audit, source, stats,
    async close() { server.closeAllConnections(); await new Promise((done) => server.close(done)); await audit.queue; },
  };
}

// CLI: node originator-binding-proxy.mjs --config=<json>. The config names file paths only.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv.find((value) => value.startsWith('--config='))?.slice(9);
  if (!configPath) throw new Error('--config=<proxy config JSON> is required.');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const proxy = await startOriginatorBindingProxy({
    host: config.listen?.host ?? '127.0.0.1', port: config.listen?.port ?? 0, upstream: config.upstream,
    bindingTablePath: config.bindingTablePath, auditPath: config.auditPath, maxBodyBytes: config.maxBodyBytes,
    tls: { key: await readFile(config.tls.keyPath), cert: await readFile(config.tls.certPath), ca: await readFile(config.tls.caPath), ...(config.tls.crlPath ? { crl: await readFile(config.tls.crlPath) } : {}) },
  });
  const ready = { type: 'ready', pid: process.pid, port: proxy.port, tableRevision: proxy.source.state.table.revision };
  if (process.send) process.send(ready); console.log(JSON.stringify(ready));
  const stop = async () => { await proxy.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('disconnect', stop);
  process.on('message', async (message) => { if (message?.type === 'stats') process.send?.({ type: 'stats', stats: proxy.stats, reloads: proxy.source.reloads, tableRevision: proxy.source.state.table?.revision ?? null, pid: process.pid }); });
}
