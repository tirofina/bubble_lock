// R10 real run: ACP role matrix through a TLS 1.3 mTLS originator-binding front on actual Mobius4.
//
//   role certificate --TLS 1.3 mTLS--> originator-binding front (child process) --loopback HTTP--> Mobius4
//   role certificate --TLS 1.3 mTLS--> Mosquitto (CN ACL, mount_point) --> originator guard --> Mobius4 MQTT
//
// Every identity gets a throwaway certificate from a run-local OpenSSL CA under .local. Each
// certificate is bound to exactly one AE originator; role AEs register themselves through the front
// with that originator. The ACP matrix of run-acp-real.mjs then runs through the front, followed by
// spoofing, handshake, identity and live revocation cases. Usage:
//   node pc-mobius/scripts/run-acp-mtls-real.mjs [--providers=2] [--skip-mqtt] [--keep-running]
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { Agent, request as httpsRequest } from 'node:https';
import { fork, spawn, spawnSync } from 'node:child_process';
import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import mqtt from 'mqtt';
import { encodeBinarySwitch } from '../src/sdt-adapter.mjs';
import { subscribeWithTransientCreate, revokeSubscriber } from '../integration/src/cse-subscription-lifecycle.mjs';
import { BINDING_TABLE_VERSION, BindingTableSource, HashChainedAudit, verifyAuditChain, writeBindingTable } from '../src/originator-binding.mjs';
import { renderMosquittoAcl, renderMosquittoConf, startMqttOriginatorGuard, topicId } from '../src/mqtt-originator-guard.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const upstream = resolve(process.env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
const providerCount = Number(process.argv.find((arg) => arg.startsWith('--providers='))?.slice(12) ?? 2);
const keepRunning = process.argv.includes('--keep-running');
const openssl = process.env.OPENSSL ?? 'openssl';
const mosquittoExe = process.env.MOSQUITTO_EXE ?? (process.platform === 'win32' ? 'C:/Program Files/mosquitto/mosquitto.exe' : '/usr/sbin/mosquitto');
const mqttEnabled = !process.argv.includes('--skip-mqtt') && existsSync(mosquittoExe);
const runId = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const run = randomBytes(3).toString('hex');
const directory = join(root, '.local/acp-mtls', runId);
const source = join(directory, 'source'); const pkiDir = join(directory, 'pki'); const auditDir = join(directory, 'audit');
const ROLES = ['guardian', 'visitor', 'relay', 'mecIPE', 'executor', 'operator', 'policyDeployer'];
const IDENTITIES = ['provisioner', 'parent', 'sink', ...ROLES];
const children = []; const secrets = []; const results = []; const notifications = []; const fronts = []; const trustedCreators = new Set();
let pool; let receiver; let broker; let guard; let guardClient; let connection; const databases = [];

function sanitized(value) { let text = String(value); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[secret]'); return text; }
async function freePort() { const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const { port } = probe.address(); await new Promise((done) => probe.close(done)); return port; }
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function check(provider, group, name, expected, actual, details = {}) { results.push({ provider, group, name, status: JSON.stringify(actual) === JSON.stringify(expected) ? 'PASS' : 'REVIEW', expected, actual, ...details }); }

// ---------- PKI (OpenSSL, run-local, throwaway) ----------
function ssl(args) {
  const result = spawnSync(openssl, args, { cwd: pkiDir, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr || result.error}`);
  return result.stdout;
}
async function buildPki() {
  await mkdir(join(pkiDir, 'newcerts'), { recursive: true });
  const ecKey = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  for (const ca of ['ca', 'rogue-ca']) ssl(['req', '-x509', ...ecKey, '-keyout', `${ca}.key`, '-out', `${ca}.pem`, '-days', '2', '-sha256', '-subj', `/CN=Privacy-Bubble-${ca === 'ca' ? 'ACP-mTLS-Run' : 'Rogue'}-CA-${run}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await writeFile(join(pkiDir, 'index.txt'), ''); await writeFile(join(pkiDir, 'serial'), `${randomBytes(8).toString('hex').toUpperCase()}\n`);
  const dir = pkiDir.replaceAll('\\', '/');
  await writeFile(join(pkiDir, 'ca.cnf'), `[ ca ]\ndefault_ca = run_ca\n[ run_ca ]\ndir = ${dir}\ndatabase = ${dir}/index.txt\nnew_certs_dir = ${dir}/newcerts\ncertificate = ${dir}/ca.pem\nprivate_key = ${dir}/ca.key\nserial = ${dir}/serial\ndefault_md = sha256\npolicy = policy_any\nunique_subject = no\nemail_in_dn = no\n[ policy_any ]\ncommonName = supplied\n`);
  const issue = async (name, { cn, uri, eku = 'clientAuth', ca = 'ca', expired = false, dns = false }) => {
    ssl(['req', '-new', ...ecKey, '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`]);
    await writeFile(join(pkiDir, `${name}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${eku}\n${dns ? 'subjectAltName=DNS:localhost,IP:127.0.0.1' : `subjectAltName=URI:${uri}`}\n`);
    if (expired) ssl(['ca', '-config', 'ca.cnf', '-batch', '-notext', '-startdate', '20250101000000Z', '-enddate', '20250102000000Z', '-in', `${name}.csr`, '-out', `${name}.pem`, '-extfile', `${name}.ext`]);
    else ssl(['x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`, '-set_serial', `0x${randomBytes(8).toString('hex')}`, '-days', '1', '-sha256', '-out', `${name}.pem`, '-extfile', `${name}.ext`]);
    const pem = await readFile(join(pkiDir, `${name}.pem`), 'utf8');
    const x509 = new X509Certificate(pem);
    return { name, cn, uri: uri ?? null, cert: pem, key: await readFile(join(pkiDir, `${name}.key`), 'utf8'), fingerprint256: x509.fingerprint256, validTo: x509.validTo, issuer: x509.issuer };
  };
  const certs = { server: await issue('server', { cn: 'localhost', eku: 'serverAuth', dns: true }) };
  for (const name of IDENTITIES) certs[name] = await issue(name, { cn: `pb-${name}`, uri: `urn:privacy-bubble:acp-mtls:${name}` });
  certs.cloneGuardian = await issue('clone-guardian', { cn: 'pb-guardian', uri: 'urn:privacy-bubble:acp-mtls:guardian' });
  certs.rogueGuardian = await issue('rogue-guardian', { cn: 'pb-guardian', uri: 'urn:privacy-bubble:acp-mtls:guardian', ca: 'rogue-ca' });
  certs.stranger = await issue('stranger', { cn: 'pb-stranger', uri: 'urn:privacy-bubble:acp-mtls:stranger' });
  certs.expiredRelay = await issue('expired-relay', { cn: 'pb-expired-relay', uri: 'urn:privacy-bubble:acp-mtls:expired-relay', expired: true });
  certs.serverEkuExecutor = await issue('server-eku-executor', { cn: 'pb-server-eku-executor', uri: 'urn:privacy-bubble:acp-mtls:server-eku-executor', eku: 'serverAuth' });
  return { ca: await readFile(join(pkiDir, 'ca.pem'), 'utf8'), certs };
}

function bindingTable(provider, revision, { omit = [] } = {}) {
  const entry = (bindingId, cert, role, originator, pin = true) => ({ bindingId, role, identity: { type: 'uri', value: cert.uri }, originator, ...(pin ? { certificateSha256: cert.fingerprint256 } : {}), mqttUsername: cert.cn });
  const rows = IDENTITIES.filter((name) => !omit.includes(name)).map((name) => entry(name, provider.pki.certs[name], name === 'provisioner' ? 'cse-provisioner' : name, provider.originatorOf(name)));
  // Bound but unusable at TLS: proves the handshake, not the table, stops these certificates.
  rows.push({ ...entry('expired-relay', provider.pki.certs.expiredRelay, 'relay', provider.originatorOf('relay'), false), mqttUsername: 'pb-expired-relay' });
  rows.push({ ...entry('server-eku-executor', provider.pki.certs.serverEkuExecutor, 'executor', provider.originatorOf('executor'), false), mqttUsername: 'pb-server-eku-executor' });
  return { version: BINDING_TABLE_VERSION, revision, cseId: provider.cseId, bindings: rows };
}

// ---------- HTTPS client through the front ----------
function call(provider, identity, method, path, { payload, ty, origin = provider.originMode, headers = {}, agent, cert, maxVersion } = {}) {
  const rqi = `mtls-${randomBytes(6).toString('hex')}`;
  const credential = cert === undefined ? provider.pki.certs[identity] : cert;
  const h = { accept: 'application/json', 'x-m2m-ri': rqi, 'x-m2m-rvi': '4', ...(payload ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}), ...headers };
  if (origin === 'bound') h['x-m2m-origin'] = provider.originatorOf(identity); else if (origin !== 'absent') h['x-m2m-origin'] = origin;
  const useAgent = agent ?? (cert === undefined && !maxVersion ? provider.agents[identity] : false);
  return new Promise((resolveCall) => {
    const req = httpsRequest({ host: '127.0.0.1', port: provider.frontPort, method, path, servername: 'localhost', ca: provider.pki.ca, agent: useAgent, ...(useAgent ? {} : credential ? { key: credential.key, cert: credential.cert } : {}), ...(maxVersion ? { maxVersion } : {}), headers: h, timeout: 10000 }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
        resolveCall({ httpStatus: res.statusCode, rsc: Number(res.headers['x-m2m-rsc']), rqi, riMatches: res.headers['x-m2m-ri'] === rqi, body, front: body?.['pb:originatorBinding'] ?? null, protocol: res.socket?.getProtocol?.() ?? null, reusedSocket: req.reusedSocket });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (error) => resolveCall({ error: error.code ?? error.message, rqi }));
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

async function startProvider(index, pki, mqttInternalPort) {
  const label = String.fromCharCode(97 + index);
  const database = `bubble_acpmtls_${runId}_${label}`;
  await pool.query(`CREATE DATABASE "${database}"`); databases.push(database);
  const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database }); await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
  const csePort = await freePort(); const admin = `S${randomBytes(11).toString('hex')}`; secrets.push(admin);
  const cseId = `/acpmtls-${label}`;
  const originatorOf = (name) => name === 'provisioner' ? admin : `Cpb-${run}-${index}-${name}`;
  const provider = { index, label, name: `provider-${index + 1}`, database, csePort, admin, cseId, originatorOf, pki, originMode: index % 2 === 0 ? 'bound' : 'absent', agents: {}, mqtt: index === 0 && mqttEnabled };
  const tablePath = join(directory, 'tables', `${provider.name}.json`); provider.tablePath = tablePath;
  await writeBindingTable(tablePath, bindingTable(provider, 1));
  return provider;
}

async function startCse(provider, mqttInternalPort) {
  const config = { http: { port: provider.csePort }, https: { enabled: false }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: provider.database }, cse: { admin: provider.admin, cse_id: provider.cseId, csebase_rn: 'Mobius', cse_type: 1, subscription_verification: true, poa: [`http://127.0.0.1:${provider.csePort}`] }, mqtt: provider.mqtt ? { enabled: true, ip: '127.0.0.1', port: mqttInternalPort } : { enabled: false }, logging: { level: 'error', file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
  let diagnostic = '';
  const child = spawn(process.execPath, ['--require', join(directory, 'loopback-only.cjs'), 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); children.push(child);
  child.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); }); child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
  await new Promise((ready, reject) => { const timer = setTimeout(() => reject(new Error(`CSE start timeout: ${sanitized(diagnostic)}`)), 30000); child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`CSE exited ${code}: ${sanitized(diagnostic)}`)); }); child.on('message', (message) => { if (message === 'ready') { clearTimeout(timer); ready(); } }); });
  provider.cse = child;
}

async function startFront(provider) {
  const configPath = join(directory, `front-${provider.label}.json`);
  await writeFile(configPath, JSON.stringify({ listen: { host: '127.0.0.1', port: 0 }, upstream: `http://127.0.0.1:${provider.csePort}`, bindingTablePath: provider.tablePath, auditPath: join(auditDir, `front-${provider.label}.jsonl`), tls: { keyPath: join(pkiDir, 'server.key'), certPath: join(pkiDir, 'server.pem'), caPath: join(pkiDir, 'ca.pem') } }, null, 2));
  const child = fork(join(root, 'pc-mobius/src/originator-binding-proxy.mjs'), [`--config=${configPath}`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); children.push(child);
  let diagnostic = ''; child.stdout.resume(); child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-16000); });
  const ready = await new Promise((done, reject) => { const timer = setTimeout(() => reject(new Error(`front start timeout ${diagnostic}`)), 15000); child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`front exited ${code}: ${diagnostic}`)); }); child.on('message', (message) => { if (message?.type === 'ready') { clearTimeout(timer); done(message); } }); });
  Object.assign(provider, { front: child, frontPort: ready.port, frontPid: ready.pid, auditPath: join(auditDir, `front-${provider.label}.jsonl`) });
  for (const name of IDENTITIES) provider.agents[name] = new Agent({ keepAlive: true, maxSockets: 4, key: provider.pki.certs[name].key, cert: provider.pki.certs[name].cert, ca: provider.pki.ca, servername: 'localhost' });
}
function frontStats(provider) {
  return new Promise((done) => { const listener = (message) => { if (message?.type === 'stats') { provider.front.off('message', listener); done(message); } }; provider.front.on('message', listener); provider.front.send({ type: 'stats' }); });
}

// ---------- ACP role matrix (same cases as run-acp-real.mjs), through the front ----------
async function roleMatrix(provider, sinkUrl) {
  const p = provider.name; const group = 'acp-matrix';
  const create = async (identity, parentPath, ty, body) => {
    const response = await call(provider, identity, 'POST', parentPath, { payload: body, ty });
    if (response.rsc !== 2001) throw new Error(`${identity} create ${ty} under ${parentPath}: ${response.httpStatus}/${response.rsc} ${sanitized(JSON.stringify(response.body))}`);
    const attributes = Object.values(response.body)[0];
    return { path: `${parentPath}/${attributes.rn}`, ri: attributes.ri, aei: attributes.aei ?? null, ty };
  };
  const admin = (method, path, payload) => call(provider, 'provisioner', method, path, { payload });
  const parent = await create('parent', '/Mobius', 2, { 'm2m:ae': { rn: `acp-${run}-${provider.index}`, api: 'N.privacy.bubble.acp', rr: true } });
  check(p, 'registration', 'parent:AE-ID=bound-originator', provider.originatorOf('parent'), parent.aei);
  const roles = {};
  for (const name of ROLES) {
    roles[name] = await create(name, '/Mobius', 2, { 'm2m:ae': { rn: `acp-${run}-${provider.index}-${name}`, api: 'N.privacy.bubble.role', rr: true, poa: [sinkUrl] } });
    roles[name].id = roles[name].aei;
    check(p, 'registration', `${name}:AE-ID=bound-originator`, provider.originatorOf(name), roles[name].aei);
  }
  trustedCreators.add(roles.mecIPE.id);
  const resources = [];
  const add = async (name, masks, ty = 3) => {
    const policy = { pv: { acr: [{ acor: [provider.admin], acop: 63 }, ...Object.entries(masks).map(([role, acop]) => ({ acor: [roles[role].id], acop }))] }, pvs: { acr: [{ acor: [provider.admin], acop: 63 }, { acor: [roles.policyDeployer.id], acop: 14 }] } };
    const acp = await create('provisioner', parent.path, 1, { 'm2m:acp': { rn: `${name}-acp`, ...policy } });
    const body = ty === 28 ? encodeBinarySwitch({ rn: name, state: false, acpi: [acp.ri] }, { operation: 'CREATE' }) : ty === 9 ? { 'm2m:grp': { rn: name, mt: 3, mnm: 1, mid: [resources[0].path.replace(/^\//, '')], csy: 1, acpi: [acp.ri] } } : { 'm2m:cnt': { rn: name, acpi: [acp.ri] } };
    const resource = await create('provisioner', parent.path, ty, body); resources.push({ ...resource, name, masks, acp, policy }); return resources.at(-1);
  };
  const abstract = await add('abstract', { guardian: 34 }); await add('incident', { guardian: 1 }); const groupResource = await add('group', { visitor: 34 }, 9); await add('intent', { visitor: 1 });
  const observation = await add('observation', { relay: 1 }); await add('receipt', { relay: 1 }); const desired = await add('desired', { mecIPE: 2 }); await add('actual', { mecIPE: 5 });
  const actuator = await add('actuator', { executor: 6 }, 28); const health = await add('health', { operator: 2 });
  const notifyPolicy = await create('provisioner', parent.path, 1, { 'm2m:acp': { rn: 'notify-acp', pv: { acr: [{ acor: [provider.admin], acop: 63 }, { acor: [roles.mecIPE.id, provider.cseId], acop: 16 }] }, pvs: { acr: [{ acor: [provider.admin], acop: 63 }, { acor: [roles.policyDeployer.id], acop: 14 }] } } });
  const sink = await create('sink', '/Mobius', 2, { 'm2m:ae': { rn: `acp-${run}-${provider.index}-sink`, api: 'N.privacy.bubble.receiver', rr: true, poa: [sinkUrl] } });
  check(p, 'registration', 'sink:AE-ID=bound-originator', provider.originatorOf('sink'), sink.aei);
  const linked = await admin('PUT', sink.path, { 'm2m:ae': { acpi: [notifyPolicy.ri] } });
  if (linked.rsc !== 2004) throw new Error(`sink acpi link ${linked.rsc}`);
  resources.push({ ...sink, name: 'notification', masks: { mecIPE: 16 }, acp: notifyPolicy });
  for (const [role, identity] of Object.entries(roles).filter(([role]) => role !== 'policyDeployer')) for (const resource of resources) {
    const mask = resource.masks[role] ?? 0;
    for (const [operation, bit, method, payload, ty] of [
      ['CREATE', 1, 'POST', { 'm2m:cin': { rn: `sample-${role}`, cnf: 'application/json', con: { abstractState: 'SAFE' } } }, 4],
      ['RETRIEVE', 2, 'GET', undefined, undefined],
      ['UPDATE', 4, 'PUT', resource.ty === 28 ? encodeBinarySwitch({ state: true }) : { [resource.ty === 9 ? 'm2m:grp' : resource.ty === 2 ? 'm2m:ae' : 'm2m:cnt']: { lbl: [`updated-${role}`] } }, undefined],
      ['DELETE', 8, 'DELETE', undefined, undefined],
      ['NOTIFY', 16, 'POST', { 'm2m:sgn': { sur: resource.path, nev: { net: 1, rep: { 'm2m:cnt': { rn: 'notification-probe' } } } } }, undefined],
    ]) {
      const response = await call(provider, role, method, resource.path, { payload, ty });
      const expected = mask & bit ? operation === 'CREATE' ? 2001 : operation === 'UPDATE' ? 2004 : operation === 'DELETE' ? 2002 : 2000 : 4103;
      check(p, group, `${role}:${resource.name}:${operation}`, expected, response.rsc, { role, resource: resource.name, operation, mask, requestId: response.rqi, decidedBy: response.front ? 'front' : 'cse', protocol: response.protocol });
    }
    const discovery = await call(provider, role, 'GET', `${parent.path}?fu=1&ty=${resource.ty}`);
    const found = (discovery.body?.['m2m:uril'] ?? []).some((uri) => uri.replace(/^\//, '') === resource.path.replace(/^\//, ''));
    check(p, group, `${role}:${resource.name}:DISCOVER`, Boolean(mask & 32), found, { role, resource: resource.name, operation: 'DISCOVER', mask, requestId: discovery.rqi, decidedBy: discovery.front ? 'front' : 'cse', protocol: discovery.protocol });
  }
  for (const role of ROLES.filter((role) => role !== 'policyDeployer')) {
    const updated = await call(provider, role, 'PUT', desired.acp.path, { payload: { 'm2m:acp': { pv: { acr: [{ acor: [roles[role].id], acop: 63 }] } } } });
    check(p, group, `${role}:ACP:self-update`, 4103, updated.rsc, { requestId: updated.rqi });
    const deleted = await call(provider, role, 'DELETE', desired.acp.path);
    check(p, group, `${role}:ACP:self-delete`, 4103, deleted.rsc, { requestId: deleted.rqi });
  }
  const deployed = await call(provider, 'policyDeployer', 'PUT', desired.acp.path, { payload: { 'm2m:acp': { pv: desired.policy.pv } } });
  check(p, group, 'policyDeployer:ACP:update', 2004, deployed.rsc, { requestId: deployed.rqi });
  const replaced = await call(provider, 'executor', 'PUT', actuator.path, { payload: { 'cod:binSh': { acpi: [desired.acp.ri] } } });
  check(p, group, 'executor:resource:acpi-replacement', 4103, replaced.rsc, { requestId: replaced.rqi });
  const lifecycleAdmin = {
    request: (method, path, body) => admin(method, path, body),
    read: async (path) => (await admin('GET', path)).body,
  };
  const desiredSubscription = { 'm2m:sub': { rn: 'desired-events', nu: [sink.path.replace(/^\//, '')], enc: { net: [1] }, nct: 1 } };
  const retrieveOnly = await call(provider, 'mecIPE', 'POST', desired.path, { payload: desiredSubscription, ty: 23 });
  check(p, group, 'mecIPE:RETRIEVE-only:SUBSCRIBE', 4103, retrieveOnly.rsc, { requestId: retrieveOnly.rqi });
  const subscribed = await subscribeWithTransientCreate({ admin: lifecycleAdmin, acpPath: desired.acp.path, policy: desired.policy.pv, subscriberId: roles.mecIPE.id, createAsSubscriber: () => call(provider, 'mecIPE', 'POST', desired.path, { payload: desiredSubscription, ty: 23 }) });
  check(p, group, 'mecIPE:transient-CREATE:SUBSCRIBE', 2001, subscribed.rsc, { requestId: subscribed.rqi });
  const restoredPolicy = Object.values(await lifecycleAdmin.read(desired.acp.path))[0].pv;
  check(p, group, 'mecIPE:transient-CREATE:policy-restored', false, restoredPolicy.acr.some((rule) => rule.acor.includes(roles.mecIPE.id) && (rule.acop & 1)));
  const commandCreate = await call(provider, 'mecIPE', 'POST', desired.path, { payload: { 'm2m:cin': { cnf: 'application/json', con: { abstractState: 'SAFE' } } }, ty: 4 });
  check(p, group, 'mecIPE:after-subscribe:CREATE-command', 4103, commandCreate.rsc, { requestId: commandCreate.rqi });
  const unverified = await subscribeWithTransientCreate({ admin: lifecycleAdmin, acpPath: health.acp.path, policy: health.policy.pv, subscriberId: roles.operator.id, createAsSubscriber: () => call(provider, 'operator', 'POST', health.path, { payload: { 'm2m:sub': { rn: 'health-events', nu: [sink.path.replace(/^\//, '')], enc: { net: [1] }, nct: 1 } }, ty: 23 }) });
  check(p, group, 'operator:no-NOTIFY-target:verification-refused', 5204, unverified.rsc, { requestId: unverified.rqi });
  const unreadable = await call(provider, 'relay', 'POST', observation.path, { payload: { 'm2m:sub': { rn: 'unreadable-events', nu: [sinkUrl], enc: { net: [1] }, nct: 1 } }, ty: 23 });
  check(p, group, 'relay:CREATE-only:SUBSCRIBE', 4103, unreadable.rsc, { requestId: unreadable.rqi });
  if (subscribed.rsc === 2001) {
    const matches = (label) => notifications.filter((entry) => { const signal = entry.body?.['m2m:sgn']; return signal?.sur?.replace(/^\//, '') === `${desired.path.replace(/^\//, '')}/desired-events` && signal.nev?.rep?.['m2m:cnt']?.lbl?.includes(label); });
    await admin('PUT', desired.path, { 'm2m:cnt': { lbl: ['before-revoke'] } });
    for (let attempt = 0; attempt < 100 && matches('before-revoke').length === 0; attempt++) await delay(10);
    check(p, group, 'subscription:authorized-notification', true, matches('before-revoke').length > 0);
    const revoked = await revokeSubscriber({ admin: lifecycleAdmin, subscriptionPaths: [`${desired.path}/desired-events`], acpPath: desired.acp.path, revokedPolicy: { acr: [{ acor: [provider.admin], acop: 63 }] } });
    check(p, group, 'revocation:subscription-deleted-before-ACP', 2002, revoked.subscriptions[0].rsc);
    await admin('PUT', desired.path, { 'm2m:cnt': { lbl: ['after-revoke'] } }); await delay(500);
    check(p, group, 'revocation:no-notification-after-revoke', 0, matches('after-revoke').length);
  }
  return { parent, roles, abstract, observation, actuator, groupResource, desired };
}

// ---------- mTLS-specific cases ----------
async function frontCases(provider, context) {
  const p = provider.name;
  const readActuator = async () => (await call(provider, 'provisioner', 'GET', context.actuator.path)).body?.['cod:binSh']?.state;
  const spoof = async (name, identity, method, path, origin, payload, expectedCode = 'ORIGINATOR_MISMATCH') => {
    const response = await call(provider, identity, method, path, { origin, payload });
    check(p, 'originator-spoofing', name, { httpStatus: 403, rsc: 4103, code: expectedCode }, { httpStatus: response.httpStatus, rsc: response.rsc, code: response.front?.code ?? null }, { requestId: response.rqi, decidedBy: response.front ? 'front' : 'cse' });
    return response;
  };
  const executorOrigin = provider.originatorOf('executor');
  // The matrix lets the executor set state=true; reset the baseline so the spoof readback is meaningful.
  const reset = await call(provider, 'provisioner', 'PUT', context.actuator.path, { payload: encodeBinarySwitch({ state: false }) });
  check(p, 'originator-spoofing', 'baseline:provisioner-sets-actuator-false', { rsc: 2004, state: false }, { rsc: reset.rsc, state: await readActuator() });
  await spoof('guardian-cert:origin=executor:UPDATE-actuator', 'guardian', 'PUT', context.actuator.path, executorOrigin, encodeBinarySwitch({ state: true }));
  check(p, 'originator-spoofing', 'actuator-state-unchanged-after-spoof', false, await readActuator());
  await spoof('visitor-cert:origin=cse-admin:RETRIEVE-parent', 'visitor', 'GET', context.parent.path, provider.admin);
  await spoof('relay-cert:origin=guardian:RETRIEVE-abstract', 'relay', 'GET', context.abstract.path, provider.originatorOf('guardian'));
  await spoof('guardian-cert:origin=C(cse-assigned):register-AE', 'guardian', 'POST', '/Mobius', 'C');
  await spoof('guardian-cert:duplicate-origin-headers', 'guardian', 'GET', context.abstract.path, [provider.originatorOf('guardian'), executorOrigin], undefined, 'ORIGINATOR_HEADER_DUPLICATE');
  // Forged identity hints are stripped; the CSE still evaluates the certificate-bound originator.
  const forgedHeaders = { 'x-ssl-client-s-dn': 'CN=pb-executor', 'x-forwarded-client-cert': `URI=${provider.pki.certs.executor.uri}`, 'x-client-originator': executorOrigin };
  const forgedRead = await call(provider, 'guardian', 'GET', context.abstract.path, { origin: 'absent', headers: forgedHeaders });
  check(p, 'originator-spoofing', 'guardian-cert:forged-identity-headers:RETRIEVE-abstract', 2000, forgedRead.rsc, { requestId: forgedRead.rqi, decidedBy: 'cse' });
  const forgedWrite = await call(provider, 'guardian', 'PUT', context.actuator.path, { origin: 'absent', headers: forgedHeaders, payload: encodeBinarySwitch({ state: true }) });
  check(p, 'originator-spoofing', 'guardian-cert:forged-identity-headers:UPDATE-actuator', { rsc: 4103, decidedBy: 'cse' }, { rsc: forgedWrite.rsc, decidedBy: forgedWrite.front ? 'front' : 'cse' }, { requestId: forgedWrite.rqi });
  const injected = await call(provider, 'relay', 'POST', context.observation.path, { origin: 'absent', ty: 4, payload: { 'm2m:cin': { cnf: 'application/json', con: { probe: 'injected-origin' } } } });
  check(p, 'originator-injection', 'relay-cert:no-origin:CREATE-observation', 2001, injected.rsc, { requestId: injected.rqi });
  const injectedRead = await call(provider, 'relay', 'GET', context.observation.path, { origin: 'absent' });
  check(p, 'originator-injection', 'relay-cert:no-origin:RETRIEVE-observation', { rsc: 4103, decidedBy: 'cse' }, { rsc: injectedRead.rsc, decidedBy: injectedRead.front ? 'front' : 'cse' }, { requestId: injectedRead.rqi });

  const identity = async (name, cert, expectedCode) => {
    const response = await call(provider, 'guardian', 'GET', context.abstract.path, { cert, origin: 'absent' });
    check(p, 'certificate-identity', name, { httpStatus: 403, rsc: 4103, code: expectedCode, protocol: 'TLSv1.3' }, { httpStatus: response.httpStatus, rsc: response.rsc, code: response.front?.code ?? null, protocol: response.protocol }, { requestId: response.rqi });
  };
  await identity('valid-CA-unbound-certificate', provider.pki.certs.stranger, 'ORIGINATOR_BINDING_NOT_FOUND');
  await identity('cloned-guardian-identity-other-key', provider.pki.certs.cloneGuardian, 'ORIGINATOR_BINDING_CERTIFICATE_MISMATCH');

  for (const [name, cert, maxVersion, expectedAudit] of [
    ['missing-client-certificate', null, undefined, 'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE'],
    ['expired-certificate(bound identity)', provider.pki.certs.expiredRelay, undefined, 'CERT_HAS_EXPIRED'],
    ['unknown-CA-certificate(guardian identity)', provider.pki.certs.rogueGuardian, undefined, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['serverAuth-only-certificate(bound identity)', provider.pki.certs.serverEkuExecutor, undefined, 'INVALID_PURPOSE'],
    ['TLS1.2-client(valid guardian certificate)', provider.pki.certs.guardian, 'TLSv1.2', 'ERR_SSL_UNSUPPORTED_PROTOCOL'],
  ]) {
    const handshakeRows = async () => (await verifyAuditChain(provider.auditPath)).rows.filter((row) => row.event === 'TLS_HANDSHAKE_REJECTED');
    const seen = (await handshakeRows()).length;
    const response = await call(provider, 'guardian', 'GET', context.abstract.path, { cert, maxVersion, origin: 'absent' });
    let rows = await handshakeRows(); for (let waited = 0; waited < 2000 && rows.length === seen; waited += 25) { await delay(25); rows = await handshakeRows(); }
    const audit = rows.length > seen ? rows.at(-1) : null;
    check(p, 'tls-handshake', name, { httpResponse: false, serverAudit: expectedAudit }, { httpResponse: response.httpStatus !== undefined, serverAudit: audit?.code ?? null }, { clientError: response.error ?? null });
  }

  // Live revocation: remove the guardian binding, same front process, same keep-alive TLS socket.
  const before = await frontStats(provider);
  const agent = new Agent({ keepAlive: true, maxSockets: 1, key: provider.pki.certs.guardian.key, cert: provider.pki.certs.guardian.cert, ca: provider.pki.ca, servername: 'localhost' });
  try {
    const granted = await call(provider, 'guardian', 'GET', context.abstract.path, { agent });
    check(p, 'binding-revocation', 'guardian:RETRIEVE-abstract:before-revocation', 2000, granted.rsc, { requestId: granted.rqi });
    await writeBindingTable(provider.tablePath, bindingTable(provider, 2, { omit: ['guardian'] }));
    const revoked = await call(provider, 'guardian', 'GET', context.abstract.path, { agent });
    check(p, 'binding-revocation', 'guardian:RETRIEVE-abstract:after-binding-removed', { httpStatus: 403, rsc: 4103, code: 'ORIGINATOR_BINDING_NOT_FOUND', reusedSocket: true }, { httpStatus: revoked.httpStatus, rsc: revoked.rsc, code: revoked.front?.code ?? null, reusedSocket: revoked.reusedSocket }, { requestId: revoked.rqi });
    const visitor = await call(provider, 'visitor', 'GET', context.groupResource.path);
    check(p, 'binding-revocation', 'visitor:RETRIEVE-group:unaffected', 2000, visitor.rsc, { requestId: visitor.rqi });
    const after = await frontStats(provider);
    check(p, 'binding-revocation', 'front-process-not-restarted', { pid: before.pid, revision: 2 }, { pid: after.pid, revision: after.tableRevision }, { reloads: after.reloads - before.reloads });
    await writeBindingTable(provider.tablePath, bindingTable(provider, 3));
    const restored = await call(provider, 'guardian', 'GET', context.abstract.path, { agent });
    check(p, 'binding-revocation', 'guardian:RETRIEVE-abstract:binding-restored', 2000, restored.rsc, { requestId: restored.rqi });
  } finally { agent.destroy(); }
}

// ---------- MQTT path ----------
async function startBroker(provider, internalPort, externalPort) {
  const mqttDir = join(directory, 'mqtt'); await mkdir(mqttDir, { recursive: true });
  const table = (await new BindingTableSource(provider.tablePath).current()).table;
  const acl = renderMosquittoAcl(table, { receivers: [provider.cseId] });
  await writeFile(join(mqttDir, 'originator.acl'), acl.text);
  await writeFile(join(mqttDir, 'mosquitto.conf'), renderMosquittoConf({ internalPort, externalPort, caPath: join(pkiDir, 'ca.pem'), certPath: join(pkiDir, 'server.pem'), keyPath: join(pkiDir, 'server.key'), aclPath: join(mqttDir, 'originator.acl') }));
  let diagnostic = '';
  broker = spawn(mosquittoExe, ['-c', join(mqttDir, 'mosquitto.conf')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); children.push(broker);
  broker.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-16000); }); broker.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-16000); });
  for (let attempt = 0; attempt < 50; attempt++) { try { const probe = await mqtt.connectAsync(`mqtt://127.0.0.1:${internalPort}`, { reconnectPeriod: 0, connectTimeout: 1000 }); await probe.endAsync(); break; } catch { if (broker.exitCode !== null) throw new Error(`mosquitto exited: ${diagnostic}`); await delay(100); } }
  const version = spawnSync(mosquittoExe, ['-h'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n')[0].trim();
  return { aclUsers: acl.users, aclSha256: sha256(acl.text), version, mqttDir };
}

async function mqttCases(provider, context, ports) {
  const p = provider.name; const receiverId = topicId(provider.cseId);
  const connect = (cert) => mqtt.connectAsync(`mqtts://127.0.0.1:${ports.external}`, { ...(cert ? { key: cert.key, cert: cert.cert } : {}), ca: provider.pki.ca, servername: 'localhost', protocolVersion: 5, clientId: `pb-${run}-${randomBytes(3).toString('hex')}`, reconnectPeriod: 0, connectTimeout: 5000, minVersion: 'TLSv1.3' });
  const clients = {};
  const responses = new Map();
  const open = async (name) => {
    const client = await connect(provider.pki.certs[name]); clients[name] = client;
    client.on('message', (topic, payload) => { try { const primitive = JSON.parse(payload.toString()); responses.set(`${name}:${primitive.rqi}`, { topic, primitive }); } catch { /* ignore */ } });
    await client.subscribeAsync(`/oneM2M/resp/${topicId(provider.originatorOf(name))}/${receiverId}/json`, { qos: 1 });
    return client;
  };
  const send = async (name, { topicOriginator = provider.originatorOf(name), primitive, waitMs = 2500 }) => {
    const rqi = `mqtt-${randomBytes(6).toString('hex')}`;
    const body = { rvi: '4', rqi, ...primitive };
    let publishError = null;
    try { await clients[name].publishAsync(`/oneM2M/req/${topicId(topicOriginator)}/${receiverId}/json`, JSON.stringify(body), { qos: 1 }); } catch (error) { publishError = error.code ?? error.message; }
    for (let waited = 0; waited < waitMs && !responses.has(`${name}:${rqi}`); waited += 20) { if (publishError) break; await delay(20); }
    const response = responses.get(`${name}:${rqi}`)?.primitive ?? null;
    return { rqi, publishError, rsc: response?.rsc ?? null, code: response?.pc?.['pb:originatorBinding']?.code ?? null, response };
  };
  const to = (path) => path.replace(/^\//, '');
  for (const name of ['guardian', 'relay', 'executor']) await open(name);
  clients.stranger = await connect(provider.pki.certs.stranger);
  // Warm-up: wait until Mobius4's MQTT binding answers through the guard.
  let warm = null; for (let attempt = 0; attempt < 25 && !warm?.rsc; attempt++) warm = await send('guardian', { primitive: { op: 2, to: 'Mobius', fr: provider.originatorOf('guardian') }, waitMs: 400 });
  check(p, 'mqtt', 'guard-and-CSE-MQTT-binding-reachable', true, Boolean(warm?.rsc), { rsc: warm?.rsc ?? null });
  const eavesdrop = clients.guardian; const executorResponses = [];
  eavesdrop.on('message', (topic) => { if (topic.includes(topicId(provider.originatorOf('executor')))) executorResponses.push(topic); });
  const eavesdropGrant = await eavesdrop.subscribeAsync(`/oneM2M/resp/${topicId(provider.originatorOf('executor'))}/${receiverId}/json`, { qos: 1 });

  const r1 = await send('guardian', { primitive: { op: 2, to: to(context.abstract.path), fr: provider.originatorOf('guardian') } });
  check(p, 'mqtt', 'guardian-cert:fr=bound:RETRIEVE-abstract', 2000, r1.rsc, { requestId: r1.rqi });
  const r2 = await send('guardian', { primitive: { op: 2, to: to(context.abstract.path) } });
  check(p, 'mqtt', 'guardian-cert:fr-absent(guard injects):RETRIEVE-abstract', 2000, r2.rsc, { requestId: r2.rqi });
  const r3 = await send('relay', { primitive: { op: 1, ty: 4, to: to(context.observation.path), fr: provider.originatorOf('relay'), pc: { 'm2m:cin': { cnf: 'application/json', con: { probe: 'mqtt' } } } } });
  check(p, 'mqtt', 'relay-cert:CREATE-observation', 2001, r3.rsc, { requestId: r3.rqi });
  const r4 = await send('relay', { primitive: { op: 2, to: to(context.observation.path), fr: provider.originatorOf('relay') } });
  check(p, 'mqtt', 'relay-cert:RETRIEVE-observation(CSE ACP)', { rsc: 4103, code: null }, { rsc: r4.rsc, code: r4.code }, { requestId: r4.rqi });
  const r5 = await send('executor', { primitive: { op: 2, to: to(context.actuator.path), fr: provider.originatorOf('executor') } });
  check(p, 'mqtt', 'executor-cert:RETRIEVE-actuator', 2000, r5.rsc, { requestId: r5.rqi });
  await delay(200);
  check(p, 'mqtt', 'guardian-cert:subscribe-executor-responses:delivery-denied', { subackGranted: eavesdropGrant.map((grant) => grant.qos), delivered: 0 }, { subackGranted: eavesdropGrant.map((grant) => grant.qos), delivered: executorResponses.length }, { note: 'Mosquitto 2.0 grants the SUBACK and enforces read ACL at delivery' });
  const baseline = await call(provider, 'provisioner', 'PUT', context.actuator.path, { payload: encodeBinarySwitch({ state: false }) });
  check(p, 'mqtt', 'baseline:actuator-false-before-mqtt-spoofs', 2004, baseline.rsc);
  const r6 = await send('guardian', { primitive: { op: 3, to: to(context.actuator.path), fr: provider.originatorOf('executor'), pc: encodeBinarySwitch({ state: true }) } });
  check(p, 'mqtt', 'guardian-cert:payload-fr=executor:UPDATE-actuator(guard)', { rsc: 4103, code: 'ORIGINATOR_MISMATCH' }, { rsc: r6.rsc, code: r6.code }, { requestId: r6.rqi });
  const r7 = await send('guardian', { topicOriginator: provider.originatorOf('executor'), primitive: { op: 3, to: to(context.actuator.path), fr: provider.originatorOf('executor'), pc: encodeBinarySwitch({ state: true }) }, waitMs: 1000 });
  check(p, 'mqtt', 'guardian-cert:topic=executor:UPDATE-actuator(broker ACL)', { publishError: 135, rsc: null }, { publishError: r7.publishError, rsc: r7.rsc }, { requestId: r7.rqi });
  const actuatorState = (await call(provider, 'provisioner', 'GET', context.actuator.path)).body?.['cod:binSh']?.state;
  check(p, 'mqtt', 'actuator-state-unchanged-after-mqtt-spoofs', false, actuatorState);
  let strangerError = null; try { await clients.stranger.publishAsync(`/oneM2M/req/pb-stranger/${receiverId}/json`, '{}', { qos: 1 }); } catch (error) { strangerError = error.code ?? error.message; }
  check(p, 'mqtt', 'valid-CA-unbound-certificate:publish(broker ACL)', 135, strangerError);
  for (const [name, cert] of [['missing-client-certificate', null], ['unknown-CA-certificate', provider.pki.certs.rogueGuardian], ['expired-certificate', provider.pki.certs.expiredRelay]]) {
    let connected = false; let error = null;
    try { const client = await connect(cert); connected = true; await client.endAsync(); } catch (failure) { error = failure.code ?? failure.message; }
    check(p, 'mqtt-tls', name, false, connected, { clientError: error ? String(error).slice(0, 120) : null });
  }
  // Live revocation on the same MQTT session: the guard reads the shared binding table.
  await writeBindingTable(provider.tablePath, bindingTable(provider, 4, { omit: ['guardian'] }));
  const r8 = await send('guardian', { primitive: { op: 2, to: to(context.abstract.path), fr: provider.originatorOf('guardian') } });
  check(p, 'mqtt-revocation', 'guardian-cert:RETRIEVE-abstract:after-binding-removed(guard)', { rsc: 4103, code: 'ORIGINATOR_BINDING_NOT_FOUND' }, { rsc: r8.rsc, code: r8.code }, { requestId: r8.rqi });
  await writeBindingTable(provider.tablePath, bindingTable(provider, 5));
  const r9 = await send('guardian', { primitive: { op: 2, to: to(context.abstract.path), fr: provider.originatorOf('guardian') } });
  check(p, 'mqtt-revocation', 'guardian-cert:RETRIEVE-abstract:binding-restored', 2000, r9.rsc, { requestId: r9.rqi });
  for (const client of Object.values(clients)) await client.endAsync().catch(() => {});
}

function summarizeAudit(rows) {
  const count = (predicate) => rows.filter(predicate).length;
  const codes = {}; for (const row of rows.filter((row) => row.decision === 'REJECTED')) codes[row.code] = (codes[row.code] ?? 0) + 1;
  return { entries: rows.length, forwarded: count((row) => row.decision === 'FORWARDED'), rejected: count((row) => row.decision === 'REJECTED'), handshakeRejected: count((row) => row.event === 'TLS_HANDSHAKE_REJECTED'), rejectedByCode: codes, forwardedProtocols: [...new Set(rows.filter((row) => row.decision === 'FORWARDED').map((row) => row.tls?.protocol ?? 'mqtt'))], ciphers: [...new Set(rows.filter((row) => row.tls?.cipher).map((row) => row.tls.cipher))], modes: [...new Set(rows.filter((row) => row.mode).map((row) => row.mode))] };
}

try {
  await mkdir(auditDir, { recursive: true });
  await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
  await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction');
  const prepared = spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (prepared.status !== 0) throw new Error('CSE canonical registry preparation failed.');
  await writeFile(join(directory, 'loopback-only.cjs'), "const net=require('node:net');const original=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(typeof args[0]==='number'&&typeof args[1]!=='string')args.splice(1,0,'127.0.0.1');return original.apply(this,args);};\n");
  connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8')); secrets.push(connection.password);
  pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database });
  const pki = await buildPki();
  receiver = httpServer(async (req, res) => { try { const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); notifications.push({ path: req.url, body, origin: req.headers['x-m2m-origin'] }); const signal = body?.['m2m:sgn']; const rsc = signal?.vrq === true && !trustedCreators.has(signal.cr) ? '4101' : '2000'; res.writeHead(rsc === '2000' ? 200 : 403, { 'X-M2M-RSC': rsc, 'X-M2M-RI': req.headers['x-m2m-ri'] ?? '' }); res.end(); } catch { res.writeHead(400); res.end(); } });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening'); const sinkUrl = `http://127.0.0.1:${receiver.address().port}`;
  const ports = mqttEnabled ? { internal: await freePort(), external: await freePort() } : null;
  const providers = []; for (let index = 0; index < providerCount; index++) providers.push(await startProvider(index, pki, ports?.internal));
  let brokerInfo = null;
  if (mqttEnabled) brokerInfo = await startBroker(providers[0], ports.internal, ports.external);
  for (const provider of providers) { await startCse(provider, ports?.internal); await startFront(provider); fronts.push(provider); }
  if (mqttEnabled) {
    guardClient = await mqtt.connectAsync(`mqtt://127.0.0.1:${ports.internal}`, { protocolVersion: 5, clientId: `pb-guard-${run}`, reconnectPeriod: 0 });
    guard = await startMqttOriginatorGuard({ client: guardClient, receivers: [providers[0].cseId], tableSource: new BindingTableSource(providers[0].tablePath), audit: new HashChainedAudit(join(auditDir, 'mqtt-guard.jsonl')) });
  }
  const contexts = [];
  for (const provider of providers) {
    const context = await roleMatrix(provider, sinkUrl); contexts.push(context);
    await frontCases(provider, context);
    if (provider.mqtt) await mqttCases(provider, context, ports);
  }
  const fronts_ = [];
  for (const provider of providers) {
    const stats = await frontStats(provider);
    const chain = await verifyAuditChain(provider.auditPath);
    const matrixIds = new Set(results.filter((item) => item.provider === provider.name && item.group === 'acp-matrix' && item.requestId).map((item) => item.requestId));
    const forwardedIds = new Set(chain.rows.filter((row) => row.decision === 'FORWARDED').map((row) => row.requestId));
    check(provider.name, 'audit', 'every-matrix-request-forwarded-over-TLS1.3-with-audit-row', true, [...matrixIds].every((id) => forwardedIds.has(id)) && chain.rows.filter((row) => matrixIds.has(row.requestId)).every((row) => row.tls.protocol === 'TLSv1.3'));
    const spoofIds = results.filter((item) => item.provider === provider.name && item.group === 'originator-spoofing' && item.decidedBy === 'front').map((item) => item.requestId);
    check(provider.name, 'audit', 'spoofed-requests-never-forwarded', true, spoofIds.length > 0 && spoofIds.every((id) => !forwardedIds.has(id) && chain.rows.some((row) => row.requestId === id && row.decision === 'REJECTED')));
    check(provider.name, 'audit', 'hash-chain-verifies', true, chain.ok);
    check(provider.name, 'audit', 'audit-rows-carry-no-plain-admin-originator', true, !(await readFile(provider.auditPath, 'utf8')).includes(provider.admin));
    fronts_.push({ provider: provider.name, cseId: provider.cseId, originHeaderMode: provider.originMode === 'bound' ? 'client sends the bound X-M2M-Origin (MATCHED)' : 'client omits X-M2M-Origin (front INJECTS)', frontPid: stats.pid, tableRevisionLoaded: stats.tableRevision, tableReloads: stats.reloads, stats: stats.stats, auditChainHead: chain.head, audit: summarizeAudit(chain.rows) });
  }
  let mqttSummary = null;
  if (mqttEnabled) {
    const chain = await verifyAuditChain(join(auditDir, 'mqtt-guard.jsonl'));
    check(providers[0].name, 'audit', 'mqtt-guard-hash-chain-verifies', true, chain.ok);
    mqttSummary = { broker: brokerInfo.version, listeners: { internal: 'loopback plain, Mobius4 + guard only', external: 'loopback TLS 1.3, require_certificate, use_identity_as_username, mount_point ext/, generated ACL' }, aclUsers: brokerInfo.aclUsers, aclSha256: brokerInfo.aclSha256, guardStats: guard.stats, guardAuditChainHead: chain.head, guardAudit: summarizeAudit(chain.rows) };
  }
  const groups = {}; for (const item of results) { groups[item.group] ??= { cases: 0, passed: 0 }; groups[item.group].cases += 1; if (item.status === 'PASS') groups[item.group].passed += 1; }
  const failed = results.filter((item) => item.status !== 'PASS');
  const evidence = {
    status: failed.length === 0 ? 'PASS' : 'REVIEW', recordedAt: new Date().toISOString(), rubricIds: ['R10', 'A07'],
    simulation: false, hostCount: 1, cseCount: providers.length, frontCount: providers.length,
    transport: 'TLS 1.3 mTLS originator-binding front (Node https, child process) -> loopback HTTP -> actual Mobius4' + (mqttEnabled ? '; TLS 1.3 mTLS Mosquitto (CN ACL, mount_point) -> originator guard -> Mobius4 MQTT binding' : ''),
    cseVersion: JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version,
    sourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout.trim() || null,
    cseSource: 'unmodified-upstream', postgres: (await pool.query('SELECT version()')).rows[0].version.split(',')[0], node: process.version,
    openssl: spawnSync(openssl, ['version'], { encoding: 'utf8', windowsHide: true }).stdout.trim(),
    pki: { generator: 'openssl (run-local throwaway CA under .local, deleted with the run directory)', keyType: 'EC P-256', caSubject: new X509Certificate(pki.ca).subject, caFingerprint256: new X509Certificate(pki.ca).fingerprint256, identities: Object.values(pki.certs).filter((cert) => cert.name !== 'server').map(({ name, cn, uri, fingerprint256, validTo, issuer }) => ({ name, cn, uri, fingerprint256, validTo, issuer })) },
    bindingModel: { identity: 'SAN URI (urn:privacy-bubble:acp-mtls:<role>) with SHA-256 certificate pin; CN used as MQTT username', originatorRule: 'one certificate identity -> exactly one AE originator; AE-ID pre-assigned and registered by the certificate holder', mismatch: 'HTTP 403 + X-M2M-RSC 4103 + pb:originatorBinding.code, request never forwarded', absent: 'front injects the bound originator', revocation: 'remove the row from the binding table; the front re-reads the file per request (stat key) without restart', auditPrivacy: 'originators logged as domain-separated SHA-256 digests (16 hex), request bodies as SHA-256 only, no payload content' },
    caseCount: results.length, passed: results.length - failed.length, failed: failed.length, groups,
    fronts: fronts_, mqtt: mqttSummary,
    scope: { real: [`${providers.length} Mobius4 processes with PostgreSQL/PostGIS`, 'OpenSSL-issued certificates', 'Node TLS 1.3 handshakes', ...(mqttEnabled ? ['Mosquitto broker process with TLS 1.3 and ACL', 'Mobius4 MQTT binding'] : [])], notCovered: ['Raspberry Pi Gateway and keyring hardware', 'nginx front (template only, nginx is not installed on this host)', 'CSE-to-AE notification delivery over TLS (loopback HTTP receiver)', 'Mosquitto ACL reload on revocation (the guard enforces revocation live; the ACL file is regenerated on restart)', 'direct loopback access to the CSE HTTP port by other local processes (deployment keeps that port on a private network or socket)', 'CRL or OCSP revocation of certificates (revocation acts on the binding table)'] },
    review: failed.map(({ provider, group, name, expected, actual }) => ({ provider, group, name, expected, actual })),
    results, runnerSHA256: sha256(await readFile(fileURLToPath(import.meta.url))), runtimeEvidenceDirectory: directory.replace(root, '').replaceAll('\\', '/'),
  };
  const text = sanitized(`${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(join(directory, 'acp-mtls-real-cse.json'), text);
  const out = join(root, 'docs/verification-evidence/2026-11-19'); await mkdir(out, { recursive: true });
  if (!process.argv.includes('--no-evidence')) await writeFile(join(out, 'acp-mtls-real-cse.json'), text);
  console.log(JSON.stringify({ status: evidence.status, cases: evidence.caseCount, passed: evidence.passed, failed: evidence.failed, groups, review: evidence.review }, null, 2));
  if (failed.length) process.exitCode = 1;
} catch (error) { console.error(sanitized(error.stack)); process.exitCode = 1; }
finally {
  if (!keepRunning || process.exitCode) {
    if (guard) await guard.close().catch(() => {});
    for (const provider of fronts) for (const agent of Object.values(provider.agents)) agent.destroy();
    for (const child of children.reverse()) if (child.exitCode === null) child.kill();
    if (receiver) { receiver.closeAllConnections(); await new Promise((done) => receiver.close(done)); }
    if (pool && !process.argv.includes('--keep-databases')) { await delay(500); for (const database of databases) await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {}); }
  }
  if (pool) await pool.end();
}
