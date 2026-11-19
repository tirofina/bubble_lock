// R02 protocol matrix: disposable MQTT 3.1.1 broker (aedes) with two loopback listeners.
// - TLS 1.3 + client-certificate listener for the Gateway, with a CN -> topic ACL.
// - Plain TCP listener for the co-located CSE (Mobius4 4.24.5 dials tcp:// only).
// Byte counters read the raw TCP sockets, so they include TLS records and handshakes.
import { createServer as createTcpServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export function mqttPublishBytes(topic, payloadLength, qos) {
  const remaining = 2 + Buffer.byteLength(topic) + (qos > 0 ? 2 : 0) + payloadLength;
  let lengthBytes = 1;
  for (let value = remaining; value > 127; value = Math.floor(value / 128)) lengthBytes += 1;
  return 1 + lengthBytes + remaining;
}

function topicMatches(filter, topic) {
  const f = filter.split('/'); const t = topic.split('/');
  for (let index = 0; index < f.length; index += 1) {
    if (f[index] === '#') return true;
    if (index >= t.length) return false;
    if (f[index] !== '+' && f[index] !== t[index]) return false;
  }
  return f.length === t.length;
}

export class MatrixBroker {
  constructor({ moduleRoot, tls, identities, log, now }) {
    this.moduleRoot = moduleRoot; this.tls = tls; this.identities = identities; this.log = log; this.now = now;
    this.ports = null; this.running = false; this.blackhole = false; this.generation = 0;
    this.connections = []; this.subscriptions = new Map();
  }

  async load() {
    const module = await import(pathToFileURL(join(this.moduleRoot, 'node_modules', 'aedes', 'aedes.js')).href);
    this.Aedes = module.Aedes;
    return this;
  }

  identity(client) {
    if (!client) return { role: 'broker', name: 'broker' };
    const conn = client.conn;
    if (typeof conn?.getPeerCertificate === 'function') {
      const cn = conn.getPeerCertificate()?.subject?.CN;
      const known = this.identities[cn];
      return known ? { role: known.role, name: cn, acl: known } : { role: 'unknown', name: cn ?? 'none' };
    }
    return { role: 'cse-internal', name: 'mobius4-loopback' };
  }

  record(event, fields) { this.log({ at: this.now(), generation: this.generation, event, ...fields }); }

  async start() {
    this.generation += 1;
    const aedes = await this.Aedes.createBroker({ drainTimeout: 10000, heartbeatInterval: 60000 });
    this.aedes = aedes;
    aedes.authenticate = (client, _username, _password, done) => {
      const who = this.identity(client);
      const ok = who.role === 'cse-internal' || who.role === 'gateway' || who.role === 'app';
      this.record('authenticate', { clientId: client.id, role: who.role, name: who.name, ok });
      done(null, ok);
    };
    aedes.authorizePublish = (client, packet, done) => {
      const who = this.identity(client);
      const allowed = !packet.retain && (who.role === 'cse-internal'
        || (who.acl?.publish ?? []).some((filter) => topicMatches(filter, packet.topic)));
      if (!allowed) { this.record('publishDenied', { clientId: client?.id, role: who.role, topic: packet.topic }); done(new Error('topic not allowed')); return; }
      done(null);
    };
    aedes.authorizeSubscribe = (client, subscription, done) => {
      const who = this.identity(client);
      const allowed = who.role === 'cse-internal' || (who.acl?.subscribe ?? []).includes(subscription.topic);
      this.record('subscribe', { clientId: client.id, role: who.role, topic: subscription.topic, qos: allowed ? subscription.qos : 128 });
      if (allowed) this.subscriptions.set(`${client.id} ${subscription.topic}`, { role: who.role, topic: subscription.topic, qos: subscription.qos });
      done(null, allowed ? subscription : null);
    };
    aedes.authorizeForward = (client, packet) => {
      const who = this.identity(client);
      const dropped = this.blackhole && who.role === 'cse-internal' && packet.topic.startsWith('/oneM2M/req/');
      const sub = [...this.subscriptions.entries()].find(([key, value]) => key.startsWith(`${client.id} `) && topicMatches(value.topic, packet.topic))?.[1];
      const qos = Math.min(packet.qos, sub?.qos ?? 0);
      this.record(dropped ? 'forwardDropped' : 'forward', { clientId: client.id, role: who.role, topic: packet.topic, qos,
        payloadBytes: packet.payload.length, mqttBytes: mqttPublishBytes(packet.topic, packet.payload.length, qos), rqi: rqiOf(packet.payload) });
      return dropped ? null : packet;
    };
    aedes.on('clientReady', (client) => { const who = this.identity(client); this.record('clientReady', { clientId: client.id, role: who.role, name: who.name }); });
    aedes.on('clientDisconnect', (client) => { const who = this.identity(client); this.record('clientDisconnect', { clientId: client.id, role: who.role }); for (const key of [...this.subscriptions.keys()]) if (key.startsWith(`${client.id} `)) this.subscriptions.delete(key); });
    aedes.on('publish', (packet, client) => {
      if (!client) return;
      const who = this.identity(client);
      const entry = this.connections.findLast((item) => item.closedAt === null && item.remotePort === client.conn?.remotePort);
      if (entry && !entry.firstPublish) {
        // Session setup cost: TLS handshake, CONNECT/CONNACK, SUBSCRIBE/SUBACK before the first PUBLISH.
        entry.firstPublish = { at: this.now(), in: entry.raw.bytesRead, out: entry.raw.bytesWritten, publishBytes: mqttPublishBytes(packet.topic, packet.payload.length, packet.qos) };
      }
      this.record('publish', { clientId: client.id, role: who.role, topic: packet.topic, qos: packet.qos, dup: Boolean(packet.dup),
        payloadBytes: packet.payload.length, mqttBytes: mqttPublishBytes(packet.topic, packet.payload.length, packet.qos), rqi: rqiOf(packet.payload), rsc: rscOf(packet.payload, packet.topic) });
    });
    aedes.on('clientError', (client, error) => this.record('clientError', { clientId: client?.id, message: error.message }));

    const track = (listener) => (raw) => {
      const entry = { listener, generation: this.generation, openedAt: this.now(), raw, closedAt: null, handshake: null, remotePort: raw.remotePort };
      this.connections.push(entry);
      raw.on('close', () => { entry.closedAt = this.now(); entry.finalIn = raw.bytesRead; entry.finalOut = raw.bytesWritten; });
    };
    this.tlsServer = createTlsServer({ ...this.tls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (socket) => {
      const entry = this.connections.findLast((item) => item.listener === 'tls' && item.remotePort === socket.remotePort);
      if (entry) entry.handshake = { at: this.now(), in: entry.raw.bytesRead, out: entry.raw.bytesWritten, protocol: socket.getProtocol(), cipher: socket.getCipher()?.name, cn: socket.getPeerCertificate()?.subject?.CN };
      aedes.handle(socket);
    });
    this.tlsServer.on('connection', track('tls'));
    this.tlsServer.on('tlsClientError', (error) => this.record('tlsClientError', { message: error.message }));
    this.tcpServer = createTcpServer((socket) => aedes.handle(socket));
    this.tcpServer.on('connection', track('tcp'));
    const listen = async (server, port) => { server.listen(port ?? 0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
    const tlsPort = await listen(this.tlsServer, this.ports?.tls);
    const tcpPort = await listen(this.tcpServer, this.ports?.tcp);
    this.ports = { tls: tlsPort, tcp: tcpPort };
    this.running = true;
    this.record('brokerStarted', { ports: this.ports });
    return this.ports;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.record('brokerStopping', {});
    const closing = [new Promise((resolve) => this.tlsServer.close(resolve)), new Promise((resolve) => this.tcpServer.close(resolve))];
    for (const entry of this.connections) if (entry.closedAt === null) entry.raw.destroy();
    await new Promise((resolve) => this.aedes.close(resolve));
    await Promise.all(closing);
    this.subscriptions.clear();
    this.record('brokerStopped', {});
  }

  sessions(cn) {
    return this.connections.filter((entry) => entry.handshake?.cn === cn).map((entry) => ({
      generation: entry.generation, tlsHandshakeBytes: entry.handshake.in + entry.handshake.out,
      setupBytesBeforeFirstPublish: entry.firstPublish ? entry.firstPublish.in - entry.firstPublish.publishBytes + entry.firstPublish.out : null }));
  }

  bytes(listener, role) {
    let input = 0; let output = 0; let count = 0; let handshakeIn = 0; let handshakeOut = 0;
    for (const entry of this.connections) {
      if (entry.listener !== listener) continue;
      if (role && entry.handshake?.cn !== role) continue;
      count += 1;
      input += entry.closedAt === null ? entry.raw.bytesRead : entry.finalIn;
      output += entry.closedAt === null ? entry.raw.bytesWritten : entry.finalOut;
      if (entry.handshake) { handshakeIn += entry.handshake.in; handshakeOut += entry.handshake.out; }
    }
    return { connections: count, bytesIn: input, bytesOut: output, handshakeIn, handshakeOut };
  }
}

function rqiOf(payload) {
  try { const value = JSON.parse(payload.toString('utf8')); return (value['m2m:rqp'] ?? value['m2m:rsp'] ?? value).rqi ?? null; } catch { return null; }
}

function rscOf(payload, topic) {
  if (!topic.startsWith('/oneM2M/resp/')) return null;
  try { const value = JSON.parse(payload.toString('utf8')); return (value['m2m:rsp'] ?? value).rsc ?? null; } catch { return null; }
}
