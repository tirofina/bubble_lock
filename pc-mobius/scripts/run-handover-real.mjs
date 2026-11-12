import { cp, copyFile, mkdir, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { HandoverCoordinator } from '../integration/src/handover-coordinator.mjs';
import { encodeBinarySwitch, normalizeBinarySwitch } from '../src/sdt-adapter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const upstream = resolve(process.env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
const runId = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const directory = join(root, '.local', 'handover-cse', runId);
const source = join(root, '.local', 'handover-cse', 'source');
await mkdir(directory, { recursive: true });
await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
try { await lstat(join(source, 'node_modules')); } catch { await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction'); }
const prepared = spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: root, encoding: 'utf8', windowsHide: true });
if (prepared.status !== 0) throw new Error('실제 CSE canonical registry 생성을 확인하세요.');
const preload = join(directory, 'loopback-only.cjs');
await writeFile(preload, "const net = require('node:net'); const original = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1,0,'127.0.0.1'); return original.apply(this,args); };\n");
const connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8'));
const pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database });
const children = []; const secrets = [connection.password];
const keepRunning = process.argv.includes('--keep-running');
let coordinator; let callback;
const sdts = [];
function sanitized(value) { let text = String(value); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[secret]'); return text; }
async function freePort() { const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise((resolve) => probe.close(resolve)); return port; }
async function request(client, method, path, value, ty) {
  const rqi = `sdt-${randomBytes(6).toString('hex')}`;
  const response = await fetch(`${client.endpoint}${path}`, { method, headers: { 'X-M2M-Origin': client.originator, 'X-M2M-RI': rqi, 'X-M2M-RVI': '4', accept: 'application/json', ...(value ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
  const payload = await response.json().catch(() => null);
  return { status: response.status, rsc: Number(response.headers.get('X-M2M-RSC')), rqiMatches: response.headers.get('X-M2M-RI') === rqi, payload };
}
try {
  const store = await new IntegrationStore(join(directory, 'policy-state.json')).init();
  const policyService = new PolicyService({ store });
  coordinator = new HandoverCoordinator({ store, policyService, drainBudgetMs: 100, attemptBudgetMs: 10000 });
  callback = createServer(async (req, res) => {
    try { const chunks = []; for await (const chunk of req) chunks.push(chunk); const payload = JSON.parse(Buffer.concat(chunks).toString()); const signal = payload['m2m:sgn']; const url = new URL(req.url, 'http://loopback'); const edgeId = url.pathname.slice(1); const rawSur = signal.sur ?? url.searchParams.get('subscription'); const sur = rawSur.startsWith('Mobius/') ? `/${rawSur}` : rawSur.slice(rawSur.indexOf('/Mobius')); if (sur !== url.searchParams.get('subscription') || req.headers['x-m2m-origin'] !== `/${edgeId}`) throw new Error('CSE callback binding'); await coordinator.notification({ edgeId, subscriptionUri: sur, verified: true }); res.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': req.headers['x-m2m-ri'] ?? '' }); res.end(); }
    catch { res.writeHead(400); res.end(); }
  });
  callback.listen(0, '127.0.0.1'); await once(callback, 'listening');
  for (const label of ['a', 'b']) {
    const database = `bubble_handover_${runId}_${label}`;
    await pool.query(`CREATE DATABASE "${database}"`);
    const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database });
    await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
    const port = await freePort(); const admin = `S${randomBytes(11).toString('hex')}`; secrets.push(admin);
    const edgeId = `edge-${label}`;
    const config = { http: { port }, https: { enabled: false }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database }, cse: { admin, cse_id: `/${edgeId}`, csebase_rn: 'Mobius', cse_type: 1, subscription_verification: true, notification_allowed_origins: [`http://127.0.0.1:${callback.address().port}`], poa: [`http://127.0.0.1:${port}`] }, mqtt: { enabled: false }, logging: { level: 'error', file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
    let diagnostic = '';
    const child = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); children.push(child);
    child.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); }); child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
    await new Promise((resolveReady, reject) => { const timeout = setTimeout(() => reject(new Error(`CSE 시작 대기: ${sanitized(diagnostic)}`)), 30000); child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`CSE 시작 종료 ${code}: ${sanitized(diagnostic)}`)); }); child.on('message', (message) => { if (message === 'ready') { clearTimeout(timeout); resolveReady(); } }); });
    coordinator.registerEdge({ edgeId, endpoint: `http://127.0.0.1:${port}`, cseId: `/${edgeId}`, cseBase: '/Mobius', originator: admin, callbackUrl: `http://127.0.0.1:${callback.address().port}/${edgeId}`, simulation: false, timeoutMs: 5000 });
  }
  await writeFile(join(directory, 'cse-edges.json'), `${JSON.stringify([...coordinator.edges.values()], null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(root, '.local/handover-cse/current.json'), `${JSON.stringify({ directory, configPath: join(directory, 'cse-edges.json'), children: children.map((child) => child.pid), callbackPid: process.pid }, null, 2)}\n`);
  const principal = { principalId: 'handover-verifier', scopes: ['consent:write', 'grant:write'] };
  const consent = await policyService.createConsent({ principal, subjectId: 'verification-household', purpose: 'actual-two-CSE verification', scopes: ['mec:location'], ttlSec: 3600 });
  const grant = await policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['mec:location'], ttlSec: 3600 });
  const manifest = { aeName: 'handover-relay', requireCallbackVerification: true, resources: [
    { logicalId: 'observations', ty: 3, body: { 'm2m:cnt': { rn: 'observations' } } },
    { logicalId: 'switch', ty: 28, body: encodeBinarySwitch({ rn: 'switch', state: true }, { operation: 'CREATE' }), verifyFields: ['state'] },
  ], groups: [{ logicalId: 'switches', rn: 'switches', memberLogicalIds: ['switch'], memberType: 28 }], subscriptions: [{ logicalId: 'state', rn: 'state-sub', parentLogicalId: 'switch' }] };
  await coordinator.registerManifest('real-keyring-fixture', manifest);
  const first = await coordinator.handover({ ueId: 'real-keyring-fixture', targetEdgeId: 'edge-a', grantId: grant.grantId });
  if (first.state !== 'ACTIVE') throw new Error(`초기 CSE 복원: ${first.phase} ${first.reviewReason} ${first.diagnostic}`);
  const client = coordinator.clients.get('edge-a'); const binding = store.get('logicalBindings', 'real-keyring-fixture:edge-a'); const switchPath = binding.resources.switch.path;
  sdts.push({ operation: 'CREATE', payload: await client.read(switchPath) });
  const updated = await request(client, 'PUT', switchPath, encodeBinarySwitch({ state: false }, { operation: 'UPDATE' })); sdts.push({ operation: 'UPDATE_FALSE', ...updated });
  const readback = await request(client, 'GET', switchPath); if (readback.payload?.['cod:binSh']?.state !== false) throw new Error('canonical false readback을 확인하세요.'); sdts.push({ operation: 'GET_FALSE', ...readback });
  const discovered = await request(client, 'GET', `${binding.aePath}?fu=1&ty=28&cnd=${encodeURIComponent('org.onem2m.common.moduleclass.binarySwitch')}`); sdts.push({ operation: 'CND_DISCOVERY', ...discovered });
  const invalid = await request(client, 'PUT', switchPath, { 'cod:binSh': { state: 'false' } }); if (invalid.rsc < 4000) throw new Error('string state 판정을 확인하세요.'); sdts.push({ operation: 'STRING_STATE_REVIEW', ...invalid });
  const unknown = await request(client, 'POST', binding.aePath, { 'cod:binSh': { rn: 'unknown-schema', cnd: 'urn:fixture:unknown', state: false } }, 28); if (unknown.rsc < 4000) throw new Error('unknown cnd 판정을 확인하세요.'); sdts.push({ operation: 'UNKNOWN_CND_REVIEW', ...unknown });
  const normalized = normalizeBinarySwitch({ 'pb:binarySwitch': { state: false } }, { sourceVersion: 'pb-legacy-1.0', operation: 'UPDATE' }); sdts.push({ operation: 'LEGACY_NORMALIZED', receipt: normalized.receipt, ...await request(client, 'PUT', switchPath, normalized.envelope), readback: await client.read(switchPath) });
  for (let sequence = 0; sequence < 10; sequence++) await coordinator.acceptObservation({ ueId: 'real-keyring-fixture', sequence, payload: { sequence, sourceType: 'LOCAL_ACCEPTED_OBSERVATION', simulation: true } });
  const moved = await coordinator.handover({ ueId: 'real-keyring-fixture', targetEdgeId: 'edge-b', grantId: grant.grantId }); if (moved.state !== 'ACTIVE') throw new Error(`대상 CSE 복원: ${moved.phase} ${moved.reviewReason}`);
  const rolled = await coordinator.rollback('real-keyring-fixture'); if (rolled.state !== 'ROLLED_BACK') throw new Error(`CSE rollback: ${rolled.phase} ${rolled.reviewReason} ${rolled.diagnostic}`);
  const receipt = { status: 'PASS', generatedAt: new Date().toISOString(), transport: 'actual-mobius4-loopback-http', cseVersion: JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version, sourceRevision: process.env.MOBIUS4_REVISION ?? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout.trim(), postgres: (await pool.query('SELECT version()')).rows[0].version, acceptedObservations: 10, targetWatermark: moved.replay.watermark, handoverEpoch: moved.epoch, rollbackEpoch: rolled.epoch, identities: store.list('logicalBindings').map(({ edgeId, cseId, aeId, aeRi, resources, groups, subscriptions }) => ({ edgeId, cseId, aeId, aeRi, resources, groups, subscriptions })), sdt: sdts, registrySHA256: createHash('sha256').update(await readFile(join(source, 'config/specializations.json'))).digest('hex'), runtimeEvidenceDirectory: directory, physicalHardware: '별도 BLE/키링 수용 receipt', schemaAndIdentity: 'actual-CSE' };
  await mkdir(join(root, 'pc-mobius/receipts'), { recursive: true }); await writeFile(join(root, 'pc-mobius/receipts/handover-real-cse.json'), `${JSON.stringify(receipt, null, 2)}\n`); console.log(JSON.stringify({ status: receipt.status, transport: receipt.transport, cseVersion: receipt.cseVersion, observations: receipt.acceptedObservations, handoverEpoch: moved.epoch, rollbackEpoch: rolled.epoch, sdtChecks: sdts.length }, null, 2));
} catch (error) { console.error(sanitized(error.stack)); process.exitCode = 1; }
finally { if (!keepRunning || process.exitCode) { for (const child of children) if (child.exitCode === null) child.kill(); if (callback) { callback.closeAllConnections(); await new Promise((resolveClose) => callback.close(resolveClose)); } } await pool.end(); }
