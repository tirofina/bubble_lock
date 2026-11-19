// R02 protocol matrix: throwaway PKI, the CSE HTTPS front, app clients and byte counters.
// Every listener binds 127.0.0.1. Raw TCP byte counters include TLS records and handshakes.
import { createServer as createHttpsServer, Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function createPki(directory, openssl = process.env.OPENSSL ?? 'openssl') {
  const run = (...args) => {
    const result = spawnSync(openssl, args, { cwd: directory, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
  };
  const config = join(directory, 'openssl.cnf');
  await writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=protocol-matrix\n');
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  run('req', '-x509', ...ec, '-days', '2', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=protocol-matrix-test-ca',
    '-config', config, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  const leaf = async (name, cn, usage, san) => {
    run('req', '-new', ...ec, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`, '-config', config);
    await writeFile(join(directory, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${usage}\n${san ? `subjectAltName=${san}\n` : ''}`);
    run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', `0x${randomBytes(8).toString('hex')}`,
      '-days', '2', '-out', `${name}.pem`, '-extfile', `${name}.ext`);
  };
  await leaf('server', 'protocol-matrix-server', 'serverAuth', 'IP:127.0.0.1,DNS:localhost');
  await leaf('gateway', 'pb-gw-matrix', 'clientAuth');
  await leaf('app', 'pb-app-matrix', 'clientAuth');
  const read = async (name) => readFile(join(directory, name));
  return {
    directory, keyType: 'ECDSA P-256',
    ca: await read('ca.pem'),
    server: { key: await read('server.key'), cert: await read('server.pem') },
    gateway: { key: await read('gateway.key'), cert: await read('gateway.pem'), cn: 'pb-gw-matrix' },
    app: { key: await read('app.key'), cert: await read('app.pem'), cn: 'pb-app-matrix' },
    path: (name) => join(directory, name),
  };
}

async function listen(server, port = 0) { server.listen(port, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }

class ConnectionLedger {
  constructor(now) { this.now = now; this.entries = []; this.byPort = new Map(); }
  open(raw, label) {
    const entry = { id: this.entries.length + 1, label, raw, openedAt: this.now(), closedAt: null, handshake: null, lastIn: 0, lastOut: 0, requests: 0 };
    this.entries.push(entry); this.byPort.set(raw.remotePort, entry);
    raw.on('close', () => { entry.closedAt = this.now(); entry.finalIn = raw.bytesRead; entry.finalOut = raw.bytesWritten; });
    return entry;
  }
  secure(tlsSocket) {
    const entry = this.byPort.get(tlsSocket.remotePort);
    if (!entry) return null;
    entry.handshake = { at: this.now(), in: entry.raw.bytesRead, out: entry.raw.bytesWritten, protocol: tlsSocket.getProtocol(),
      cipher: tlsSocket.getCipher()?.name, cn: tlsSocket.getPeerCertificate?.()?.subject?.CN ?? null };
    entry.lastIn = entry.raw.bytesRead; entry.lastOut = entry.raw.bytesWritten;
    return entry;
  }
  delta(socket) {
    const entry = this.byPort.get(socket.remotePort);
    if (!entry) return null;
    const result = { connection: entry.id, wireIn: entry.raw.bytesRead - entry.lastIn, wireOut: entry.raw.bytesWritten - entry.lastOut, first: entry.requests === 0 };
    entry.lastIn = entry.raw.bytesRead; entry.lastOut = entry.raw.bytesWritten; entry.requests += 1;
    return result;
  }
  totals(filter = () => true) {
    let bytesIn = 0; let bytesOut = 0; let handshakes = 0; let handshakeIn = 0; let handshakeOut = 0; let connections = 0;
    for (const entry of this.entries) {
      if (!filter(entry)) continue;
      connections += 1;
      bytesIn += entry.closedAt === null ? entry.raw.bytesRead : entry.finalIn;
      bytesOut += entry.closedAt === null ? entry.raw.bytesWritten : entry.finalOut;
      if (entry.handshake) { handshakes += 1; handshakeIn += entry.handshake.in; handshakeOut += entry.handshake.out; }
    }
    return { connections, handshakes, bytesIn, bytesOut, handshakeIn, handshakeOut };
  }
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'te', 'trailer']);

// TLS 1.3 + client-certificate front for Mobius4 HTTP. Each certificate CN may only use the
// oneM2M originators bound to it, so the Gateway reaches the CSE as its own AE, not as admin.
export class CseFront {
  constructor({ tls, upstreamPort, bindings, log, now }) {
    this.tls = tls; this.upstreamPort = upstreamPort; this.bindings = bindings; this.log = log; this.now = now;
    this.ledger = new ConnectionLedger(now); this.agent = new HttpAgent({ keepAlive: true, maxSockets: 16 });
  }
  async start() {
    this.server = createHttpsServer({ ...this.tls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', keepAliveTimeout: 65000 }, (req, res) => this.handle(req, res));
    this.server.on('connection', (raw) => this.ledger.open(raw, 'cse-https'));
    this.server.on('secureConnection', (socket) => {
      const entry = this.ledger.secure(socket);
      if (entry) this.log({ at: this.now(), event: 'tlsSession', connection: entry.id, cn: entry.handshake.cn, handshakeIn: entry.handshake.in, handshakeOut: entry.handshake.out, protocol: entry.handshake.protocol });
    });
    this.port = await listen(this.server);
    return this.port;
  }
  handle(req, res) {
    const startedAt = this.now();
    const cn = req.socket.getPeerCertificate()?.subject?.CN ?? null;
    const origin = req.headers['x-m2m-origin'];
    const rqi = req.headers['x-m2m-ri'] ?? null;
    const finish = (status, rsc, extra = {}) => {
      res.on('finish', () => {
        const wire = this.ledger.delta(req.socket);
        this.log({ at: this.now(), event: 'https', cn, method: req.method, path: req.url.split('?')[0], rqi, status, rsc, upstreamMs: +(this.now() - startedAt).toFixed(3), ...wire, ...extra });
      });
    };
    if (!this.bindings[cn]?.includes(origin)) {
      finish(403, 4103, { denied: true });
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-M2M-RSC': '4103', 'X-M2M-RI': rqi ?? '' });
      res.end(JSON.stringify({ 'm2m:dbg': 'client certificate is not bound to this originator' }));
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP.has(name)));
    headers['x-forwarded-proto'] = 'https';
    const upstream = httpRequest({ host: '127.0.0.1', port: this.upstreamPort, method: req.method, path: req.url, headers, agent: this.agent }, (response) => {
      const out = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !HOP.has(name)));
      finish(response.statusCode, Number(response.headers['x-m2m-rsc'] ?? 0));
      res.writeHead(response.statusCode, out);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); });
    req.pipe(upstream);
  }
  async close() { this.server.closeAllConnections(); await new Promise((resolve) => this.server.close(resolve)); this.agent.destroy(); }
}

// Pass-through TCP proxy that only counts bytes (TLS stays end to end with the central API).
export class CountingProxy {
  constructor({ upstreamPort, label, now }) { this.upstreamPort = upstreamPort; this.label = label; this.ledger = new ConnectionLedger(now); this.sockets = new Set(); }
  async start() {
    this.server = createTcpServer((downstream) => {
      this.ledger.open(downstream, this.label);
      const upstream = tcpConnect(this.upstreamPort, '127.0.0.1');
      this.sockets.add(downstream); this.sockets.add(upstream);
      downstream.pipe(upstream); upstream.pipe(downstream);
      const end = () => { downstream.destroy(); upstream.destroy(); this.sockets.delete(downstream); this.sockets.delete(upstream); };
      downstream.on('error', end); upstream.on('error', end); downstream.on('close', end); upstream.on('close', end);
    });
    this.port = await listen(this.server);
    return this.port;
  }
  async close() { for (const socket of this.sockets) socket.destroy(); await new Promise((resolve) => this.server.close(resolve)); }
}

// App-side push endpoint: Mobius4 POSTs oneM2M notifications here over HTTPS (TLS 1.3).
export class NotificationSink {
  constructor({ tls, log, now }) { this.tls = tls; this.log = log; this.now = now; this.ledger = new ConnectionLedger(now); }
  async start() {
    this.server = createHttpsServer({ ...this.tls, minVersion: 'TLSv1.3', keepAliveTimeout: 65000 }, async (req, res) => {
      const arrivedAt = this.now();
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      let record = { at: arrivedAt, event: 'notification', rqi: req.headers['x-m2m-ri'] ?? null, bodyBytes: body.length };
      try {
        const sgn = JSON.parse(body.toString('utf8'))['m2m:sgn'] ?? {};
        const cin = sgn.nev?.rep?.['m2m:cin'];
        record = { ...record, verification: Boolean(sgn.vrq), net: sgn.nev?.net ?? null, rn: cin?.rn ?? null,
          deviceId: cin?.con?.deviceId ?? null, sequence: cin?.con?.sequence ?? null };
      } catch { record.parseError = true; }
      res.on('finish', () => this.log({ ...record, ...this.ledger.delta(req.socket) }));
      res.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': req.headers['x-m2m-ri'] ?? '', 'Content-Length': '0' });
      res.end();
    });
    this.server.on('connection', (raw) => this.ledger.open(raw, 'notify'));
    this.server.on('secureConnection', (socket) => this.ledger.secure(socket));
    this.port = await listen(this.server);
    return this.port;
  }
  async close() { this.server.closeAllConnections(); await new Promise((resolve) => this.server.close(resolve)); }
}

// oneM2M HTTP client over TLS 1.3 with a client certificate and keep-alive.
export class OneM2MClient {
  constructor({ origin, port, identity, ca, originator, rvi = '4' }) {
    this.port = port; this.originator = originator; this.rvi = rvi; this.origin = origin;
    this.agent = new HttpsAgent({ keepAlive: true, maxSockets: 4, ca, cert: identity.cert, key: identity.key, minVersion: 'TLSv1.3' });
  }
  request(method, path, body, ty) {
    const rqi = `pm-${randomBytes(8).toString('hex')}`;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'X-M2M-Origin': this.originator, 'X-M2M-RI': rqi, 'X-M2M-RVI': this.rvi, Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = `application/json${ty ? `;ty=${ty}` : ''}`; headers['Content-Length'] = String(payload.length); }
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const req = httpsRequest({ host: '127.0.0.1', port: this.port, method, path, headers, agent: this.agent, servername: 'localhost' }, (res) => {
        const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks); let json = null; try { json = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { json = null; }
          resolve({ status: res.statusCode, rsc: Number(res.headers['x-m2m-rsc'] ?? 0), rqiMatches: res.headers['x-m2m-ri'] === rqi, body: json, bytes: raw.length, ms: performance.now() - started, rqi });
        });
      });
      req.setTimeout(10000, () => req.destroy(new Error('request timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  close() { this.agent.destroy(); }
}

export function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return +sorted[rank].toFixed(3);
}

export function summary(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return { n: 0 };
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  return { n: finite.length, p50: percentile(finite, 50), p95: percentile(finite, 95), max: +Math.max(...finite).toFixed(3), mean: +mean.toFixed(3) };
}
