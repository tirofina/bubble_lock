// R02 protocol matrix on one host: emulated GATT keyrings -> complete Gateway daemon ->
// MQTT over TLS 1.3 (default) / HTTPS (condition-based) -> real Mobius4 4.24.5 -> app push
// (HTTPS notification) and app REST (HTTPS retrieve). Broker restart, CSE-side MQTT loss and
// large bundles are induced on purpose; every number in the receipt comes from this run.
//
//   node pc-mobius/scripts/run-protocol-matrix-real.mjs [--receipt <path>] [--keep-logs]
//
// Requires MOBIUS4_ROOT, .local/postgres/connection.json, OpenSSL, the root .venv from
// `npm run setup`, and network access once to install aedes@1.2.0 under .local.
import { cp, mkdir, readFile, writeFile, symlink, lstat, rm } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscribeWithTransientCreate } from '../integration/src/cse-subscription-lifecycle.mjs';
import os from 'node:os';
import pg from 'pg';
import { MatrixBroker } from './protocol-matrix/broker.mjs';
import { createPki, CseFront, CountingProxy, NotificationSink, OneM2MClient, summary } from './protocol-matrix/edge.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const upstream = resolve(process.env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
const AEDES_VERSION = '1.2.0';
const DEVICE_COUNT = Number(process.env.PROTOCOL_MATRIX_DEVICES ?? 24);
const runId = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const base = join(root, '.local', 'protocol-matrix');
const directory = join(base, 'runs', runId);
const logs = join(directory, 'logs');
const localDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const argument = (name) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const receiptPath = resolve(argument('--receipt') ?? join(root, 'docs', 'verification-evidence', localDate, 'protocol-matrix-real-cse.json'));
const tracePath = join(dirname(receiptPath), 'protocol-matrix-trace.jsonl');
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const secrets = [];
const sanitize = (text) => { let value = String(text); for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[secret]'); return value; };

await mkdir(logs, { recursive: true });
const streams = {};
const logger = (name) => { streams[name] = createWriteStream(join(logs, `${name}.jsonl`), { flags: 'a' }); const records = []; const fn = (record) => { records.push(record); streams[name].write(`${JSON.stringify(record)}\n`); }; fn.records = records; return fn; };
const brokerLog = logger('broker'); const httpsLog = logger('https'); const notifyLog = logger('notify'); const phaseLog = logger('phases'); const appLog = logger('app-rest');

function sh(command, args, options = {}) { return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options }); }

async function ensureAedes() {
  const brokerRoot = join(base, 'broker');
  const manifest = join(brokerRoot, 'node_modules', 'aedes', 'package.json');
  if (!existsSync(manifest)) {
    await mkdir(brokerRoot, { recursive: true });
    await writeFile(join(brokerRoot, 'package.json'), `${JSON.stringify({ name: 'protocol-matrix-broker', private: true, type: 'module' })}\n`);
    const result = sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `aedes@${AEDES_VERSION}`], { cwd: brokerRoot, shell: process.platform === 'win32' });
    if (result.status !== 0) throw new Error(`aedes 설치를 확인하세요: ${result.stderr}`);
  }
  const version = JSON.parse(await readFile(manifest, 'utf8')).version;
  if (version !== AEDES_VERSION) throw new Error(`aedes ${AEDES_VERSION}가 필요합니다 (현재 ${version}).`);
  const lock = JSON.parse(await readFile(join(brokerRoot, 'package-lock.json'), 'utf8'));
  return { root: brokerRoot, version, integrity: lock.packages?.['node_modules/aedes']?.integrity ?? null };
}

async function freePort() { const { createServer } = await import('node:net'); const probe = createServer(); probe.listen(0, '127.0.0.1'); await new Promise((r) => probe.once('listening', r)); const { port } = probe.address(); await new Promise((r) => probe.close(r)); return port; }

function expect(condition, message) { if (!condition) throw new Error(message); }

const children = [];
let pool; let database; let broker; let front; let sink; let apiProxy; let gatewayClient; let appClient; let gatewayProcess; let appPoller;
const connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8'));
secrets.push(connection.password);

try {
  const aedes = await ensureAedes();
  const pki = await createPki(await mkdir(join(directory, 'pki'), { recursive: true }).then(() => join(directory, 'pki')));

  // PostgreSQL database owned by this run.
  pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database });
  database = `bubble_pm_${runId}`;
  await pool.query(`CREATE DATABASE "${database}"`);
  { const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database }); await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end(); }

  // Mobius4 source copy (read-only upstream).
  const source = join(base, 'source');
  await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
  try { await lstat(join(source, 'node_modules')); } catch { await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction'); }
  const cseVersion = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version;
  const cseRevision = sh('git', ['rev-parse', 'HEAD'], { cwd: upstream }).stdout.trim() || null;

  // Identities: device-side AE for the Gateway, separate AE for the app.
  const gwAei = `Cpbgw${randomBytes(4).toString('hex')}`;
  const appAei = `Cpbapp${randomBytes(4).toString('hex')}`;
  const cseId = 'Mobius4';
  const admin = `S${randomBytes(11).toString('hex')}`; secrets.push(admin);
  const gatewayId = 'pb-gw-matrix';
  const identities = { [pki.gateway.cn]: { role: 'gateway', publish: [`/oneM2M/req/${gwAei}/${cseId}/json`], subscribe: [`/oneM2M/resp/${gwAei}/${cseId}/json`] } };

  broker = await new MatrixBroker({ moduleRoot: aedes.root, tls: { key: pki.server.key, cert: pki.server.cert, ca: pki.ca }, identities, log: brokerLog, now }).load();
  const brokerPorts = await broker.start();

  const httpPort = await freePort();
  const preload = join(directory, 'loopback-only.cjs');
  await writeFile(preload, "const net = require('node:net'); const original = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1,0,'127.0.0.1'); return original.apply(this,args); };\n");
  const cseConfig = { http: { port: httpPort }, https: { enabled: false }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database },
    cse: { admin, cse_id: `/${cseId}`, csebase_rn: 'Mobius', cse_type: 1, poa: [`http://127.0.0.1:${httpPort}`], subscription_verification: false },
    mqtt: { enabled: true, ip: '127.0.0.1', port: brokerPorts.tcp }, logging: { level: 'info', file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
  const mobiusLog = createWriteStream(join(logs, 'mobius4.log'));
  const mobius = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(cseConfig), NODE_EXTRA_CA_CERTS: pki.path('ca.pem') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  children.push(mobius);
  let mobiusTail = '';
  for (const stream of [mobius.stdout, mobius.stderr]) stream.on('data', (chunk) => { const text = sanitize(chunk); mobiusTail = (mobiusTail + text).slice(-8000); mobiusLog.write(text); });
  await new Promise((resolveReady, reject) => { const timer = setTimeout(() => reject(new Error(`CSE 시작 대기: ${mobiusTail}`)), 40000); mobius.once('exit', (code) => { clearTimeout(timer); reject(new Error(`CSE 종료 ${code}: ${mobiusTail}`)); }); mobius.on('message', (message) => { if (message === 'ready') { clearTimeout(timer); resolveReady(); } }); });
  const waitFor = async (predicate, label, timeoutMs = 20000) => { const deadline = Date.now() + timeoutMs; while (!predicate()) { if (Date.now() > deadline) throw new Error(`대기 시간 초과: ${label}`); await sleep(25); } };
  await waitFor(() => brokerLog.records.some((r) => r.event === 'subscribe' && r.role === 'cse-internal' && r.topic === `/oneM2M/req/+/${cseId}/json`), 'CSE MQTT subscription');

  // CSE HTTPS front with certificate -> originator binding, app push sink.
  front = new CseFront({ tls: { key: pki.server.key, cert: pki.server.cert, ca: pki.ca }, upstreamPort: httpPort, bindings: { [pki.gateway.cn]: [gwAei], [pki.app.cn]: [appAei] }, log: httpsLog, now });
  const frontPort = await front.start();
  sink = new NotificationSink({ tls: { key: pki.server.key, cert: pki.server.cert }, log: notifyLog, now });
  const sinkPort = await sink.start();
  gatewayClient = new OneM2MClient({ port: frontPort, identity: pki.gateway, ca: pki.ca, originator: gwAei });
  appClient = new OneM2MClient({ port: frontPort, identity: pki.app, ca: pki.ca, originator: appAei });

  const provisioning = [];
  const step = async (label, client, method, path, body, ty, accept = [2001]) => {
    const result = await client.request(method, path, body, ty);
    provisioning.push({ label, originator: client === gatewayClient ? 'gateway-ae' : 'app-ae', method, path, status: result.status, rsc: result.rsc, rqiMatches: result.rqiMatches });
    expect(accept.includes(result.rsc), `${label}: ${result.status}/${result.rsc} ${JSON.stringify(result.body)}`);
    return result;
  };
  const aeRn = 'pb-gw-matrix'; const aePath = `/Mobius/${aeRn}`;
  const gwAe = await step('gateway AE', gatewayClient, 'POST', '/Mobius', { 'm2m:ae': { rn: aeRn, api: 'Npb.gateway.matrix', rr: false, srv: ['4'] } }, 2);
  expect(gwAe.body['m2m:ae'].aei === gwAei, 'gateway AE-ID binding');
  const appAe = await step('app AE', appClient, 'POST', '/Mobius', { 'm2m:ae': { rn: 'pb-app-matrix', api: 'Npb.app.matrix', rr: false, srv: ['4'] } }, 2);
  expect(appAe.body['m2m:ae'].aei === appAei, 'app AE-ID binding');
  const dataPolicy = { acr: [{ acor: [gwAei], acop: 63 }, { acor: [appAei], acop: 34 }] };
  const acp = await step('data ACP', gatewayClient, 'POST', aePath, { 'm2m:acp': { rn: 'gateway-data-acp', pv: dataPolicy, pvs: { acr: [{ acor: [gwAei], acop: 63 }] } } }, 1);
  const acpRi = acp.body['m2m:acp'].ri;
  for (const rn of ['observations', 'receipts', 'health']) await step(`${rn} container`, gatewayClient, 'POST', aePath, { 'm2m:cnt': { rn, mni: 20000, acpi: [acpRi] } }, 3);
  const denied = await appClient.request('POST', `${aePath}/observations`, { 'm2m:cin': { con: { forged: true } } }, 4);
  provisioning.push({ label: 'app create denied by ACP', originator: 'app-ae', status: denied.status, rsc: denied.rsc });
  expect(denied.rsc === 4103, `app AE must not create device data: ${denied.rsc}`);
  const impersonation = await new OneM2MClient({ port: frontPort, identity: pki.app, ca: pki.ca, originator: gwAei }).request('GET', `${aePath}/observations`);
  provisioning.push({ label: 'app certificate using gateway originator', status: impersonation.status, rsc: impersonation.rsc });
  expect(impersonation.status === 403, 'certificate/originator binding');
  const subscriptionOwner = 'app-ae';
  const subscriptionBody = { 'm2m:sub': { rn: 'app-push', nu: [`https://127.0.0.1:${sinkPort}/notify`], enc: { net: [3] }, nct: 1 } };
  const lifecycleAdmin = {
    request: (method, path, body) => gatewayClient.request(method, path, body),
    read: async (path) => (await gatewayClient.request('GET', path)).body,
  };
  const sub = await subscribeWithTransientCreate({ admin: lifecycleAdmin, acpPath: `${aePath}/gateway-data-acp`, policy: dataPolicy, subscriberId: appAei, createAsSubscriber: () => appClient.request('POST', `${aePath}/observations`, subscriptionBody, 23) });
  provisioning.push({ label: 'app subscription with transient CREATE', originator: 'app-ae', status: sub.status, rsc: sub.rsc });
  expect(sub.rsc === 2001, `app subscription: ${sub.status}/${sub.rsc}`);

  // Central API (team pc-mobius integration runtime) behind a byte-counting TCP proxy.
  const apiPort = await freePort();
  const fingerprint = new X509Certificate(pki.gateway.cert).fingerprint256;
  const devices = Object.fromEntries(Array.from({ length: DEVICE_COUNT }, (_, index) => [`kr-pm-${String(index + 1).padStart(2, '0')}`, `02:50:4d:00:00:${(index + 1).toString(16).padStart(2, '0')}`]));
  const apiConfig = { tls: { key: pki.path('server.key'), cert: pki.path('server.pem'), ca: pki.path('ca.pem') }, statePath: join(directory, 'central-state.json'), receiptPath: join(directory, 'central-receipts.jsonl'),
    principals: [{ principalId: gatewayId, mtlsFingerprint: fingerprint, scopes: [] }],
    gateways: [{ gatewayId, principalId: gatewayId, fingerprint, devices: Object.fromEntries(Object.keys(devices).map((id) => [id, `subject-${id}`])), credentialRevision: '1', ownershipEpoch: 0, status: 'ACTIVE' }] };
  await writeFile(join(directory, 'central.json'), JSON.stringify(apiConfig, null, 2));
  const centralLog = createWriteStream(join(logs, 'central.log'));
  const central = spawn(process.execPath, [join(root, 'pc-mobius/scripts/run-integration-api.mjs')], { cwd: root, env: { ...process.env, NODE_OPTIONS: '', PRIVACY_BUBBLE_API_CONFIG: join(directory, 'central.json'), PRIVACY_BUBBLE_INTEGRATION_PORT: String(apiPort) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.push(central);
  let centralReady = false;
  central.stdout.on('data', (chunk) => { centralLog.write(chunk); if (String(chunk).includes('"READY"')) centralReady = true; });
  central.stderr.on('data', (chunk) => centralLog.write(chunk));
  await waitFor(() => centralReady || central.exitCode !== null, 'central API');
  expect(centralReady, 'central API start');
  apiProxy = new CountingProxy({ upstreamPort: apiPort, label: 'central-api', now });
  const apiProxyPort = await apiProxy.start();

  // Gateway environment: the production loader validates every value.
  const gatewayOut = join(directory, 'gateway');
  await mkdir(gatewayOut, { recursive: true });
  const gatewayEnv = { GATEWAY_ID: gatewayId, M2M_ORIGINATOR: gwAei, M2M_CSE_ID: cseId, M2M_CSE_URL: `https://127.0.0.1:${frontPort}`, M2M_RVI: '4',
    M2M_CSE_DEPLOYMENT_ID: `protocol-matrix-${runId.replace('_', '-')}`, M2M_OBSERVATION_CONTAINER: `${aePath}/observations`, M2M_RECEIPT_CONTAINER: `${aePath}/receipts`, M2M_HEALTH_CONTAINER: `${aePath}/health`,
    PC_API_URL: `https://127.0.0.1:${apiProxyPort}`, TLS_CA_FILE: pki.path('ca.pem'), TLS_CERT_FILE: pki.path('gateway.pem'), TLS_KEY_FILE: pki.path('gateway.key'),
    MQTT_ENABLED: 'true', MQTT_HOST: '127.0.0.1', MQTT_PORT: String(brokerPorts.tls), MQTT_KEEPALIVE: '60', CORE_BRIDGE_ENABLED: 'false',
    MQTT_MAX_PAYLOAD_BYTES: '4096', MQTT_PROBE_INTERVAL_SECONDS: '5', REQUEST_TIMEOUT: '3',
    BLE_DEVICES: JSON.stringify(devices), BLE_PAIR: 'true', BLE_SCAN_SECONDS: '5', BLE_GATT_PROFILE: 'core-v1', GATEWAY_DATABASE: join(gatewayOut, 'gateway.sqlite3'),
    POLL_INTERVAL: '2', HEARTBEAT_INTERVAL: '15', CREDENTIAL_CHECK_INTERVAL: '15', CREDENTIAL_TTL: '30' };
  await writeFile(join(directory, 'gateway.env'), `${Object.entries(gatewayEnv).map(([key, value]) => `${key}=${key === 'BLE_DEVICES' ? `'${value}'` : value}`).join('\n')}\n`);
  const python = process.env.PROTOCOL_MATRIX_PYTHON ?? join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const pythonVersion = sh(python, ['--version']).stdout.trim();
  const harness = join(root, 'keyring/raspberry-pi-gateway/cse_integration_tests/protocol_matrix_daemon.py');
  const pyEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: process.env.TEMP ?? os.tmpdir(), TMP: process.env.TMP ?? os.tmpdir(), PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
  gatewayProcess = spawn(python, [harness, '--env-file', join(directory, 'gateway.env'), '--output', gatewayOut], { cwd: root, env: pyEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.push(gatewayProcess);
  const gatewayEvents = []; let gatewayStderr = ''; let gatewayStdoutClosed = false;
  const lines = createInterface({ input: gatewayProcess.stdout });
  lines.on('line', (line) => { try { gatewayEvents.push(JSON.parse(line)); } catch { gatewayStderr += `${line}\n`; } });
  lines.on('close', () => { gatewayStdoutClosed = true; });
  const gatewayStderrLog = createWriteStream(join(logs, 'gateway-stderr.log'));
  gatewayProcess.stderr.on('data', (chunk) => { gatewayStderrLog.write(chunk); gatewayStderr = (gatewayStderr + chunk).slice(-8000); });
  const send = (message) => gatewayProcess.stdin.write(`${JSON.stringify(message)}\n`);
  const nextEvent = async (predicate, label, timeoutMs = 60000, start = gatewayEvents.length) => { const deadline = Date.now() + timeoutMs; for (;;) { const found = gatewayEvents.slice(start).find(predicate); if (found) return found; if (gatewayProcess.exitCode !== null && gatewayStdoutClosed) throw new Error(`Gateway 종료 (${label}): ${gatewayStderr}`); if (Date.now() > deadline) throw new Error(`Gateway 대기 초과: ${label} ${gatewayStderr}`); await sleep(20); } };
  const status = async () => { send({ op: 'status' }); return nextEvent((e) => e.event === 'status', 'status', 10000); };
  const drain = async (label, timeoutMs = 90000) => { const deadline = Date.now() + timeoutMs; for (;;) { const s = await status(); if (s.outbox === 0) return s; if (Date.now() > deadline) throw new Error(`outbox drain: ${label} ${s.outbox}`); await sleep(250); } };
  await nextEvent((e) => e.event === 'ready', 'BLE ready', 60000);
  await waitFor(() => gatewayEvents.some((e) => e.event === 'mqttReady'), 'gateway MQTT session', 20000);
  const gatewayVersion = gatewayEvents.find((e) => e.event === 'ready').version;

  // App REST poller (HTTPS GET of the latest observation, keep-alive).
  let polling = true;
  appPoller = (async () => { while (polling) { const started = now(); try { const r = await appClient.request('GET', `${aePath}/observations/la`); appLog({ at: started, ms: r.ms, status: r.status, rsc: r.rsc, bytes: r.bytes, rqi: r.rqi }); } catch (error) { appLog({ at: started, error: error.message }); } await sleep(1000); } })();

  // Phases.
  const phases = [];
  const snapshot = () => ({ at: now(), brokerTls: broker.bytes('tls', pki.gateway.cn), cseHttps: front.ledger.totals((e) => e.handshake?.cn === pki.gateway.cn), api: apiProxy.ledger.totals(), notify: sink.ledger.totals(), appHttps: front.ledger.totals((e) => e.handshake?.cn === pki.app.cn) });
  const phase = async (name, body) => { const start = snapshot(); phaseLog({ at: start.at, event: 'phaseStart', name }); const marks = {}; await body(marks); const end = snapshot(); phaseLog({ at: end.at, event: 'phaseEnd', name, marks }); phases.push({ name, start, end, marks }); };
  const emit = async (phaseName, count, intervalMs) => { send({ op: 'emit', phase: phaseName, count, intervalMs }); return nextEvent((e) => e.event === 'emitDone' && e.phase === phaseName, `emit ${phaseName}`, count * intervalMs + 30000); };
  const emitAsync = (phaseName, count, intervalMs) => { send({ op: 'emit', phase: phaseName, count, intervalMs }); return nextEvent((e) => e.event === 'emitDone' && e.phase === phaseName, `emit ${phaseName}`, count * intervalMs + 60000); };

  await phase('warmup', async () => { await drain('warmup'); });
  await phase('mqtt-steady', async () => { await emit('mqtt-steady', 72, 200); await drain('mqtt-steady'); });
  const confirmedAfter = (t) => gatewayEvents.some((e) => e.event === 'mqttConfirmed' && e.atNs / 1e6 > t);
  await phase('broker-restart-stream', async (marks) => {
    const done = emitAsync('broker-restart-stream', 200, 200);
    await sleep(5000); marks.brokerStop = now(); await broker.stop();
    await sleep(10000); marks.brokerStart = now(); await broker.start();
    await done; await drain('broker-restart-stream');
    await waitFor(() => confirmedAfter(marks.brokerStart), 'gateway MQTT confirmed after restart', 120000);
  });
  await phase('outage-sparse-https', async (marks) => {
    marks.brokerStop = now(); await broker.stop(); await sleep(1000);
    await emit('outage-sparse-https', 6, 6000); await drain('outage-sparse-https');
    marks.brokerStart = now(); await broker.start();
    await waitFor(() => confirmedAfter(marks.brokerStart), 'gateway MQTT confirmed after sparse outage', 180000);
    marks.gatewayConfirmed = gatewayEvents.find((e) => e.event === 'mqttConfirmed' && e.atNs / 1e6 > marks.brokerStart).atNs / 1e6;
  });
  await phase('mqtt-sparse', async () => { await sleep(1000); await emit('mqtt-sparse', 6, 6000); await drain('mqtt-sparse'); });
  await phase('cse-mqtt-blackhole', async (marks) => {
    const done = emitAsync('cse-mqtt-blackhole', 225, 200);
    await sleep(3000); marks.blackholeOn = now(); broker.blackhole = true;
    await sleep(15000); marks.blackholeOff = now(); broker.blackhole = false;
    await done; await drain('cse-mqtt-blackhole');
  });
  await phase('large-bundle-window', async () => { await sleep(16000); await drain('large-bundle-window'); });

  polling = false; await appPoller;
  send({ op: 'stop' });
  const stopping = await nextEvent((e) => e.event === 'stopping', 'stop', 20000);
  await nextEvent((e) => e.event === 'stopped', 'stopped', 30000, 0); // may share a stdout chunk with 'stopping'
  await new Promise((resolveExit) => (gatewayProcess.exitCode !== null ? resolveExit() : gatewayProcess.once('exit', resolveExit)));
  expect(gatewayProcess.exitCode === 0, `Gateway exit ${gatewayProcess.exitCode}: ${gatewayStderr}`);
  await sleep(1500); // last notifications

  // Readback through the app identity and integrity accounting.
  const readJsonl = async (file) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const emits = await readJsonl(join(gatewayOut, 'emits.jsonl'));
  const publishes = await readJsonl(join(gatewayOut, 'publishes.jsonl'));
  const transportEvents = await readJsonl(join(gatewayOut, 'transport-events.jsonl'));
  const rnOf = (rqi) => `gw-${createHash('sha256').update(rqi).digest('hex')}`;
  const observationPublishes = publishes.filter((p) => p.kind === 'observation');
  const connectReads = [...new Set(observationPublishes.filter((p) => !emits.some((e) => e.rqi === p.rqi)).map((p) => p.rqi))];
  const readback = { checked: 0, matched: 0, missing: [], mismatched: [] };
  for (const record of emits) {
    const result = await appClient.request('GET', `${aePath}/observations/${rnOf(record.rqi)}`);
    readback.checked += 1;
    const con = result.body?.['m2m:cin']?.con;
    if (result.status !== 200 || result.rsc !== 2000) readback.missing.push(record.rqi);
    else if (con?.deviceId === record.deviceId && con?.bootId === record.bootId && con?.sequence === record.sequence) readback.matched += 1;
    else readback.mismatched.push(record.rqi);
  }
  const container = await appClient.request('GET', `${aePath}/observations`);
  const cni = container.body?.['m2m:cnt']?.cni ?? null;
  const notifications = notifyLog.records.filter((r) => r.event === 'notification' && !r.verification && r.rn);
  const notificationsByRn = new Map(); for (const n of notifications) notificationsByRn.set(n.rn, [...(notificationsByRn.get(n.rn) ?? []), n]);
  const conflicts = { mqtt: brokerLog.records.filter((r) => r.event === 'forward' && r.role === 'gateway' && r.rsc === 4105).length, https: httpsLog.records.filter((r) => r.cn === pki.gateway.cn && r.method === 'POST' && r.rsc === 4105).length };

  // Per-observation join.
  const emitByRqi = new Map(emits.map((e) => [e.rqi, e]));
  const okByRqi = new Map(); for (const p of observationPublishes) if (!p.error) okByRqi.set(p.rqi, p);
  const attemptsByRqi = new Map(); for (const p of observationPublishes) attemptsByRqi.set(p.rqi, (attemptsByRqi.get(p.rqi) ?? 0) + 1);
  const brokerReq = new Map(); const brokerResp = new Map();
  for (const r of brokerLog.records) { if (r.event === 'publish' && r.role === 'gateway') brokerReq.set(r.rqi, r); if (r.event === 'forward' && r.role === 'gateway') brokerResp.set(r.rqi, r); }
  const httpsByRqi = new Map(); for (const r of httpsLog.records) if (r.cn === pki.gateway.cn && r.method === 'POST' && r.rqi) httpsByRqi.set(r.rqi, r);
  const lane = (p) => (p.routes.includes('native_mqtt') && !p.routes.some((route) => route.startsWith('native_https_')) ? 'mqtt' : (p.routes.find((route) => route.startsWith('native_https_')) ?? 'unknown').replace('native_', ''));
  const rows = [];
  for (const [rqi, e] of emitByRqi) {
    const p = okByRqi.get(rqi); const n = notificationsByRn.get(rnOf(rqi))?.[0];
    rows.push({ rqi, phase: e.phase, deviceId: e.deviceId, sequence: e.sequence, lane: p ? lane(p) : 'undelivered', attempts: attemptsByRqi.get(rqi) ?? 0,
      emitMs: e.emitNs / 1e6, queueMs: p?.storedNs ? (p.startNs - p.storedNs) / 1e6 : null, publishMs: p ? (p.endNs - p.startNs) / 1e6 : null,
      e2eNotifyMs: n ? n.at - e.emitNs / 1e6 : null, gattBytes: e.gattBytes, gattNotifications: e.notifications,
      mqttRequestBytes: brokerReq.get(rqi)?.mqttBytes ?? null, mqttResponseBytes: brokerResp.get(rqi)?.mqttBytes ?? null, mqttPayloadBytes: brokerReq.get(rqi)?.payloadBytes ?? null,
      httpsWireIn: httpsByRqi.get(rqi)?.wireIn ?? null, httpsWireOut: httpsByRqi.get(rqi)?.wireOut ?? null, httpsFirstOnConnection: httpsByRqi.get(rqi)?.first ?? null,
      notifyWireIn: n?.wireIn ?? null, notifyBodyBytes: n?.bodyBytes ?? null, payloadBytes: p?.payloadBytes ?? null });
  }
  await writeFile(join(directory, 'observations.json'), JSON.stringify(rows, null, 1));
  const lanes = [...new Set(rows.map((r) => r.lane))];
  const pick = (list, key) => list.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
  const perLane = Object.fromEntries(lanes.map((name) => { const list = rows.filter((r) => r.lane === name); return [name, {
    observations: list.length, gatewayPublishRttMs: summary(pick(list, 'publishMs')), outboxQueueMs: summary(pick(list, 'queueMs')), bleEmitToCseNotificationMs: summary(pick(list, 'e2eNotifyMs')),
    mqttPublishPacketBytes: summary(pick(list, 'mqttRequestBytes')), mqttResponsePacketBytes: summary(pick(list, 'mqttResponseBytes')), mqttPrimitiveJsonBytes: summary(pick(list, 'mqttPayloadBytes')),
    httpsRequestWireBytes: summary(list.filter((r) => r.httpsFirstOnConnection === false).map((r) => r.httpsWireIn).filter((v) => v !== null)),
    httpsResponseWireBytes: summary(list.filter((r) => r.httpsFirstOnConnection === false).map((r) => r.httpsWireOut).filter((v) => v !== null)),
    httpsFirstRequestOnNewConnection: list.filter((r) => r.httpsFirstOnConnection === true).length, gatewayPayloadBytes: summary(pick(list, 'payloadBytes')) }]; }));

  // Phase wire totals (raw TCP incl. TLS) divided by observations emitted in the phase.
  const delta = (a, b) => Object.fromEntries(Object.keys(b).filter((k) => typeof b[k] === 'number').map((k) => [k, b[k] - (a[k] ?? 0)]));
  const phaseSummaries = phases.map((p) => {
    const list = rows.filter((r) => r.phase === p.name);
    const routeCounts = {}; for (const r of list) routeCounts[r.lane] = (routeCounts[r.lane] ?? 0) + 1;
    const wire = { mqttTls: delta(p.start.brokerTls, p.end.brokerTls), cseHttps: delta(p.start.cseHttps, p.end.cseHttps), centralApi: delta(p.start.api, p.end.api), appNotify: delta(p.start.notify, p.end.notify), appRest: delta(p.start.appHttps, p.end.appHttps) };
    const perObservation = list.length ? { mqttTlsBytes: +((wire.mqttTls.bytesIn + wire.mqttTls.bytesOut) / list.length).toFixed(1), cseHttpsBytes: +((wire.cseHttps.bytesIn + wire.cseHttps.bytesOut) / list.length).toFixed(1) } : null;
    return { name: p.name, durationS: +((p.end.at - p.start.at) / 1000).toFixed(2), observations: list.length, routes: routeCounts, marks: p.marks, wire, perObservationWireBytes: perObservation };
  });

  // Condition analyses.
  const ms = (ns) => ns / 1e6;
  const firstAfter = (list, t, predicate) => list.filter((item) => item.t >= t && predicate(item)).sort((a, b) => a.t - b.t)[0] ?? null;
  const publishTimeline = publishes.map((p) => ({ ...p, t: ms(p.startNs), end: ms(p.endNs), lane: lane(p) }));
  const transportTimeline = transportEvents.map((e) => ({ ...e, t: ms(e.atNs) }));
  const brokerTimeline = brokerLog.records.map((r) => ({ ...r, t: r.at }));
  const restartAnalysis = (p) => {
    const { brokerStop, brokerStart } = p.marks;
    const down = firstAfter(transportTimeline, brokerStop, (e) => e.event === 'mqttDown');
    const firstHttps = firstAfter(publishTimeline, brokerStop, (e) => e.kind === 'observation' && !e.error && e.lane.startsWith('https'));
    const gwReady = firstAfter(brokerTimeline, brokerStart, (r) => r.event === 'clientReady' && r.role === 'gateway');
    const gwSub = firstAfter(brokerTimeline, brokerStart, (r) => r.event === 'subscribe' && r.role === 'gateway');
    const cseSub = firstAfter(brokerTimeline, brokerStart, (r) => r.event === 'subscribe' && r.role === 'cse-internal' && r.topic === `/oneM2M/req/+/${cseId}/json`);
    const sessionReady = firstAfter(transportTimeline, brokerStart, (e) => e.event === 'mqttReady');
    const confirmed = firstAfter(transportTimeline, brokerStart, (e) => e.event === 'mqttConfirmed');
    const inPhase = (r) => r.rqi && emitByRqi.get(r.rqi)?.phase === p.name;
    const firstMqtt = firstAfter(publishTimeline, brokerStart, (e) => inPhase(e) && !e.error && e.lane === 'mqtt');
    const list = rows.filter((r) => r.phase === p.name);
    return { brokerDownS: +((brokerStart - brokerStop) / 1000).toFixed(2), gatewayDetectsDisconnectMs: down ? +(down.t - brokerStop).toFixed(1) : null,
      firstHttpsDeliveryAfterStopMs: firstHttps ? +(firstHttps.end - brokerStop).toFixed(1) : null,
      gatewayMqttConnectAfterRestartMs: gwReady ? +(gwReady.t - brokerStart).toFixed(1) : null, gatewaySubscribeAfterRestartMs: gwSub ? +(gwSub.t - brokerStart).toFixed(1) : null,
      cseMqttSubscribeAfterRestartMs: cseSub ? +(cseSub.t - brokerStart).toFixed(1) : null, gatewaySessionReadyAfterRestartMs: sessionReady ? +(sessionReady.t - brokerStart).toFixed(1) : null,
      gatewayMqttConfirmedByProbeAfterRestartMs: confirmed ? +(confirmed.t - brokerStart).toFixed(1) : null,
      ...(() => { const probes = brokerLog.records.filter((r) => r.event === 'publish' && r.role === 'gateway' && String(r.rqi).startsWith('mqtt-probe-') && r.at >= brokerStart && (!confirmed || r.at <= confirmed.t + 1)); return { probesSentUntilConfirmed: probes.length, probeTimesAfterRestartMs: probes.map((r) => +(r.at - brokerStart).toFixed(1)) }; })(),
      firstMqttDeliveryAfterRestartMs: firstMqtt ? +(firstMqtt.end - brokerStart).toFixed(1) : null,
      emitted: list.length, delivered: list.filter((r) => r.lane !== 'undelivered').length, lost: list.filter((r) => r.lane === 'undelivered').length,
      readbackMissing: readback.missing.filter((rqi) => emitByRqi.get(rqi)?.phase === p.name).length,
      duplicateNotifications: list.filter((r) => (notificationsByRn.get(rnOf(r.rqi))?.length ?? 0) > 1).length,
      fallbackTimeouts: publishTimeline.filter((e) => inPhase(e) && e.routes.includes('native_mqtt_timeout')).length,
      fallbackDisconnects: publishTimeline.filter((e) => inPhase(e) && e.routes.includes('native_mqtt_disconnect')).length,
      retriedObservations: list.filter((r) => r.attempts > 1).length, routes: Object.fromEntries([...new Set(list.map((r) => r.lane))].map((name) => [name, list.filter((r) => r.lane === name).length])) };
  };
  const byName = Object.fromEntries(phases.map((p) => [p.name, p]));
  const blackhole = (() => {
    const p = byName['cse-mqtt-blackhole']; const { blackholeOn, blackholeOff } = p.marks;
    const list = rows.filter((r) => r.phase === p.name);
    const firstTimeout = firstAfter(publishTimeline, blackholeOn, (e) => e.routes.includes('native_mqtt_timeout'));
    const unconfirmed = firstAfter(transportTimeline, blackholeOn, (e) => e.event === 'mqttUnconfirmed');
    const confirmed = firstAfter(transportTimeline, blackholeOff, (e) => e.event === 'mqttConfirmed');
    const firstMqtt = firstAfter(publishTimeline, blackholeOff, (e) => e.kind === 'observation' && !e.error && e.lane === 'mqtt');
    const inPhase = (e) => emitByRqi.get(e.rqi)?.phase === p.name;
    const probeEvents = brokerLog.records.filter((r) => r.event === 'publish' && r.role === 'gateway' && String(r.rqi).startsWith('mqtt-probe-') && r.at >= blackholeOn && (!confirmed || r.at <= confirmed.t + 1));
    return { blackholeS: +((blackholeOff - blackholeOn) / 1000).toFixed(2), probeIntervalS: Number(gatewayEnv.MQTT_PROBE_INTERVAL_SECONDS), requestTimeoutS: Number(gatewayEnv.REQUEST_TIMEOUT),
      firstTimeoutAfterOnMs: firstTimeout ? +(firstTimeout.t - blackholeOn).toFixed(1) : null, unconfirmedAfterOnMs: unconfirmed ? +(unconfirmed.t - blackholeOn).toFixed(1) : null,
      probesSentUntilConfirmed: probeEvents.length, probeTimesAfterOnMs: probeEvents.map((r) => +(r.at - blackholeOn).toFixed(1)),
      mqttConfirmedAfterOffMs: confirmed ? +(confirmed.t - blackholeOff).toFixed(1) : null, firstMqttDeliveryAfterOffMs: firstMqtt ? +(firstMqtt.end - blackholeOff).toFixed(1) : null,
      observationsThatWaitedForTimeout: publishTimeline.filter((e) => inPhase(e) && e.routes.includes('native_mqtt_timeout')).length,
      observationsSentHttpsWhileUnconfirmed: publishTimeline.filter((e) => inPhase(e) && e.routes.includes('native_https_mqtt_unconfirmed')).length,
      brokerDroppedForwards: brokerLog.records.filter((r) => r.event === 'forwardDropped' && r.at >= blackholeOn && r.at <= blackholeOff + 1).length,
      emitted: list.length, lost: list.filter((r) => r.lane === 'undelivered').length, routes: Object.fromEntries([...new Set(list.map((r) => r.lane))].map((name) => [name, list.filter((r) => r.lane === name).length])),
      httpsPublishRttWhileUnconfirmedMs: summary(list.filter((r) => r.lane === 'https_mqtt_unconfirmed').map((r) => r.publishMs)),
      timeoutPublishRttMs: summary(publishTimeline.filter((e) => inPhase(e) && e.routes.includes('native_mqtt_timeout')).map((e) => e.end - e.t)) };
  })();
  const bundles = publishTimeline.filter((p) => p.kind !== 'observation');
  const bundleSummary = Object.fromEntries([...new Set(bundles.map((p) => p.kind))].map((kind) => { const list = bundles.filter((p) => p.kind === kind && !p.error); return [kind, {
    published: list.length, payloadBytes: summary(list.map((p) => p.payloadBytes)), routes: Object.fromEntries([...new Set(list.map((p) => p.lane))].map((name) => [name, list.filter((p) => p.lane === name).length])), publishRttMs: summary(list.map((p) => p.end - p.t)) }]; }));
  const tlsFacts = {
    mqtt: broker.connections.find((c) => c.handshake?.cn === pki.gateway.cn)?.handshake ?? null,
    cseHttps: front.ledger.entries.find((e) => e.handshake?.cn === pki.gateway.cn)?.handshake ?? null,
    appHttps: front.ledger.entries.find((e) => e.handshake?.cn === pki.app.cn)?.handshake ?? null,
    appPush: sink.ledger.entries.find((e) => e.handshake)?.handshake ?? null };
  for (const value of Object.values(tlsFacts)) if (value) delete value.at;
  const restApp = appLog.records.filter((r) => !r.error);
  const restWire = httpsLog.records.filter((r) => r.cn === pki.app.cn && r.method === 'GET' && r.first === false && r.path.endsWith('/la'));
  const integrity = { emittedObservations: emits.length, connectReadObservations: connectReads.length, delivered: rows.filter((r) => r.lane !== 'undelivered').length,
    lost: rows.filter((r) => r.lane === 'undelivered').length, readbackChecked: readback.checked, readbackMatched: readback.matched, readbackMissing: readback.missing.length, readbackMismatched: readback.mismatched.length,
    cseContainerCni: cni, expectedCni: emits.length + connectReads.length, duplicateCreatesAbsorbed4105: conflicts, notifications: notifications.length,
    duplicateNotifications: [...notificationsByRn.values()].filter((list) => list.length > 1).length, finalOutboxRows: stopping.outbox };
  const ble = { framing: 'LF-terminated JSON, 20-byte GATT notifications (keyring/firmware/src/main.cpp)', frameBytes: summary(emits.map((e) => e.gattBytes)), notificationsPerObservation: summary(emits.map((e) => e.notifications)),
    estimatedOnAirBytesPerObservation: summary(emits.map((e) => e.gattBytes + e.notifications * 21)), onAirModel: 'per 20-byte fragment: ATT 3 + L2CAP 4 + LL header 2 + MIC 4 + preamble/access address/CRC 8 = 21 B (LE 1M PHY, encrypted link, empty-PDU acks excluded)' };
  // Session setup cost per new connection (TLS 1.3 handshake plus protocol setup).
  const observationRqis = new Set(observationPublishes.map((p) => p.rqi));
  const isObservationPost = (r) => r.cn === pki.gateway.cn && r.method === 'POST' && r.rsc === 2001 && observationRqis.has(r.rqi);
  const steadyMedian = summary(httpsLog.records.filter((r) => isObservationPost(r) && r.first === false).map((r) => r.wireIn + r.wireOut)).p50 ?? 0;
  const gatewaySessions = httpsLog.records.filter((r) => r.event === 'tlsSession' && r.cn === pki.gateway.cn);
  const httpsSetups = gatewaySessions.map((session) => {
    const first = httpsLog.records.find((r) => r.connection === session.connection && r.event === 'https' && r.first === true);
    return first && isObservationPost(first) ? session.handshakeIn + session.handshakeOut + first.wireIn + first.wireOut - steadyMedian : null; }).filter((v) => v !== null);
  const mqttSessions = broker.sessions(pki.gateway.cn);
  const sessionSetup = { method: 'raw TCP bytes both directions; MQTT counts bytes before the first PUBLISH (TLS handshake, CONNECT/CONNACK, SUBSCRIBE/SUBACK); HTTPS counts handshake plus the first observation exchange minus the median steady observation exchange (connections that opened with an observation POST)',
    mqttSessions: mqttSessions.length, mqttSetupBytes: summary(mqttSessions.map((s) => s.setupBytesBeforeFirstPublish).filter((v) => v !== null)),
    httpsConnectionsOpened: gatewaySessions.length, httpsConnectionsOpenedByObservation: httpsSetups.length, httpsSetupBytes: summary(httpsSetups), httpsSteadyObservationExchangeBytes: steadyMedian };
  const pass = integrity.lost === 0 && integrity.readbackMissing === 0 && integrity.readbackMismatched === 0 && integrity.cseContainerCni === integrity.expectedCni
    && perLane.mqtt?.observations > 0 && Object.keys(perLane).some((name) => name.startsWith('https')) && blackhole.firstMqttDeliveryAfterOffMs !== null && integrity.finalOutboxRows === 0;

  const sourceFiles = ['keyring/raspberry-pi-gateway/src/bubble_gateway/transport.py', 'keyring/raspberry-pi-gateway/src/bubble_gateway/config.py', 'keyring/raspberry-pi-gateway/src/bubble_gateway/service.py',
    'keyring/raspberry-pi-gateway/src/bubble_gateway/ble.py', 'keyring/raspberry-pi-gateway/cse_integration_tests/protocol_matrix_daemon.py', 'pc-mobius/scripts/run-protocol-matrix-real.mjs',
    'pc-mobius/scripts/protocol-matrix/broker.mjs', 'pc-mobius/scripts/protocol-matrix/edge.mjs'];
  const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, createHash('sha256').update((await readFile(join(root, file), 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
  const gitHead = sh('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim() || null;
  const receipt = {
    status: pass ? 'PASS' : 'FAIL', rubric: 'R02', documentRevision: '2.0.0', generatedAt: new Date().toISOString(), runId, gitHead, sourceSha256LfNormalized: sourceSha256,
    simulation: { device: true, gatewayDaemon: false, cse: false, broker: false, centralApi: false, apps: false,
      note: 'Keyrings are emulated at the Bleak GATT client boundary; every other process is the real program on one host over loopback TLS.' },
    hostCount: 1, host: { platform: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version, python: pythonVersion },
    transport: { device: 'BLE GATT (emulated peer, product BleFleet parser)', gatewayToCse: 'oneM2M MQTT binding over TLS 1.3 (default) + oneM2M HTTP binding over TLS 1.3 (condition-based)', brokerToCse: 'MQTT 3.1.1 plain TCP on loopback (Mobius4 dials tcp:// only)', gatewayToCentral: 'HTTPS REST mTLS', cseToApp: 'oneM2M HTTP notification over TLS 1.3', appToCse: 'oneM2M HTTP retrieve over TLS 1.3 mTLS' },
    cseVersion, cseSourceRevision: cseRevision, postgres: (await pool.query('SELECT version()')).rows[0].version.split(',')[0],
    broker: { implementation: 'aedes', version: aedes.version, integrity: aedes.integrity, protocol: 'MQTT 3.1.1', persistence: 'in-memory (session state lost on restart)', listeners: { gateway: 'TLS 1.3 + client certificate, CN topic ACL', cse: 'plain TCP 127.0.0.1' }, topics: { request: `/oneM2M/req/${gwAei}/${cseId}/json`, response: `/oneM2M/resp/${gwAei}/${cseId}/json` }, qos: { gatewayPublish: 1, gatewayResponseSubscription: 1, cseSubscription: 0, cseResponsePublish: 0 } },
    gateway: { version: gatewayVersion, daemon: 'bubble_gateway.service.Gateway.run (credential, poll, dispatch, outbox, health workers)', originator: 'registered AE-ID bound to the client certificate (not the CSE admin)', devices: DEVICE_COUNT,
      config: Object.fromEntries(['MQTT_MAX_PAYLOAD_BYTES', 'MQTT_PROBE_INTERVAL_SECONDS', 'REQUEST_TIMEOUT', 'MQTT_KEEPALIVE', 'HEARTBEAT_INTERVAL', 'POLL_INTERVAL', 'CREDENTIAL_CHECK_INTERVAL'].map((key) => [key, gatewayEnv[key]])), finalRouteCounters: stopping.routeCounters, finalCounters: stopping.counters },
    identity: { keyType: pki.keyType, provisioning, subscriptionOwner, tls: tlsFacts },
    perProtocol: perLane, sessionSetup, phases: phaseSummaries,
    conditions: { brokerRestartStream: restartAnalysis(byName['broker-restart-stream']), brokerOutageSparse: restartAnalysis(byName['outage-sparse-https']), cseMqttBlackhole: blackhole, bundles: bundleSummary },
    ble, integrity,
    apps: { restRetrieveLatest: { requests: restApp.length, latencyMs: summary(restApp.map((r) => r.ms)), responseBodyBytes: summary(restApp.map((r) => r.bytes)), requestWireBytes: summary(restWire.map((r) => r.wireIn)), responseWireBytes: summary(restWire.map((r) => r.wireOut)), statuses: [...new Set(restApp.map((r) => `${r.status}/${r.rsc}`))] },
      push: { notifications: notifications.length, bodyBytes: summary(notifications.map((n) => n.bodyBytes)), wireInBytes: summary(notifications.filter((n) => n.first === false).map((n) => n.wireIn)), connections: sink.ledger.totals() } },
    commands: ['npm run setup', 'node pc-mobius/scripts/run-protocol-matrix-real.mjs'],
    artifacts: { trace: basename(tracePath), localRunDirectory: `.local/protocol-matrix/runs/${runId}` },
    limitations: [
      'Device side is emulated: GATT timing, radio loss and BlueZ are not exercised; BLE on-air bytes are computed from the firmware framing.',
      'Single host over loopback: latency excludes Wi-Fi/LTE RTT; byte counts include TLS records but not TCP/IP headers.',
      'Mobius4 4.24.5 subscribes and responds at MQTT QoS 0, so QoS 1 covers the Gateway-broker leg only; end-to-end reliability comes from rqi-matched responses, SQLite outbox retry and deterministic resource names.',
      'The CSE-side MQTT fault is induced in the broker (forwards to the CSE dropped); the broker restart is a process-level stop/start with in-memory session state.',
      'The SSE/WebSocket app channel is not part of this run; web-dashboard SSE evidence remains fixture replay.'] };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  // Trace: lifecycle events in full, per-message records around every transition.
  const transitions = [...phases.flatMap((p) => Object.values(p.marks)), ...transportTimeline.filter((e) => e.event !== 'status').map((e) => e.t)];
  const near = (t) => transitions.some((mark) => Math.abs(mark - t) <= 1500);
  const lifecycle = new Set(['brokerStarted', 'brokerStopping', 'brokerStopped', 'clientReady', 'clientDisconnect', 'subscribe', 'authenticate', 'publishDenied', 'tlsClientError']);
  const trace = [
    ...phaseLog.records.map((r) => ({ source: 'runner', ...r })),
    ...transportTimeline.filter((e) => e.event !== 'status').map(({ t, atNs, ...rest }) => ({ source: 'gateway', at: t, ...rest, routeCounters: undefined, counters: undefined })),
    ...brokerLog.records.filter((r) => lifecycle.has(r.event) || ((r.event === 'publish' || r.event === 'forward' || r.event === 'forwardDropped') && near(r.at))).map((r) => ({ source: 'broker', ...r })),
    ...httpsLog.records.filter((r) => r.cn === pki.gateway.cn && near(r.at)).map((r) => ({ source: 'cse-https-front', ...r })),
    ...publishTimeline.filter((p) => near(p.t)).map((p) => ({ source: 'gateway-publish', at: p.t, rqi: p.rqi, kind: p.kind, lane: p.lane, routes: p.routes, rttMs: +(p.end - p.t).toFixed(2), error: p.error, sequence: p.sequence, deviceId: p.deviceId }))
  ].sort((a, b) => a.at - b.at).map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
  await writeFile(tracePath, `${trace.map((r) => sanitize(JSON.stringify(r))).join('\n')}\n`);
  console.log(JSON.stringify({ status: receipt.status, receipt: receiptPath, trace: tracePath, lanes: Object.fromEntries(Object.entries(perLane).map(([k, v]) => [k, v.observations])), integrity, restart: receipt.conditions.brokerRestartStream, blackhole }, null, 2));
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error(sanitize(error.stack ?? error));
  process.exitCode = 1;
} finally {
  try { if (gatewayProcess && gatewayProcess.exitCode === null) { gatewayProcess.stdin.end(); await sleep(3000); if (gatewayProcess.exitCode === null) gatewayProcess.kill(); } } catch { /* cleanup */ }
  gatewayClient?.close(); appClient?.close();
  await front?.close().catch(() => {}); await sink?.close().catch(() => {}); await apiProxy?.close().catch(() => {});
  for (const child of children) if (child.exitCode === null) child.kill();
  await sleep(1500);
  await broker?.stop().catch(() => {});
  for (const stream of Object.values(streams)) stream.end();
  if (pool) {
    if (database) await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch((error) => console.error(`DB 정리: ${sanitize(error.message)}`));
    await pool.end();
  }
  if (!process.argv.includes('--keep-logs')) await rm(join(directory, 'pki'), { recursive: true, force: true }).catch(() => {});
}
