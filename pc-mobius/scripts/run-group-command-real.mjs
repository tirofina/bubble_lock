// R01/R11 real-CSE run: guardian-approved household command through a oneM2M <group> fanOutPoint
// on an actual Mobius4, partial failure by member ACP, durable failed-member retry, per-member
// ACK/readback, et/mni on related resources, and two SDT clients (JavaScript + independent Python).
import { cp, mkdir, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { OneM2mEdgeClient } from '../integration/src/handover-cse.mjs';
import { createPortalDemo } from '../integration/src/portal-demo.mjs';
import { encodeBinarySwitch, BINARY_SWITCH_CND } from '../src/sdt-adapter.mjs';
import { toOneM2mTime } from '../src/onem2m-group-fanout.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const upstream = resolve(process.env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
const runId = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const run = randomBytes(3).toString('hex');
const directory = join(root, '.local', 'group-command-cse', runId);
const source = join(root, '.local', 'group-command-cse', 'source');
const evidencePath = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? join(root, 'docs/verification-evidence/2026-11-19/group-command-real-cse.json');
const pythonClient = join(root, 'tools/onem2m-sdt-client/sdt_client.py');
const xsdPath = join(root, 'pc-mobius/specializations/r4/binarySwitch-r4-profile.xsd');
const python = process.env.BUBBLE_PYTHON ? [process.env.BUBBLE_PYTHON] : process.platform === 'win32' ? ['py', '-3'] : ['python3'];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const checks = [];
const check = (name, actual, expected) => { const status = JSON.stringify(actual) === JSON.stringify(expected) ? 'PASS' : 'FAIL'; checks.push({ name, expected, actual, status }); return status === 'PASS'; };

await mkdir(directory, { recursive: true });
await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
try { await lstat(join(source, 'node_modules')); } catch { await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction'); }
const prepared = spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: root, encoding: 'utf8', windowsHide: true });
if (prepared.status !== 0) throw new Error(`canonical registry 생성을 확인하세요: ${prepared.stderr}`);
const preload = join(directory, 'loopback-only.cjs');
await writeFile(preload, "const net = require('node:net'); const original = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1,0,'127.0.0.1'); return original.apply(this,args); };\n");
const connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8'));
const pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database });
const secrets = [connection.password];
const database = `bubble_group_${runId}`;
let child; let runtime; let databaseCreated = false;
const sanitized = (value) => { let text = String(value); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[secret]'); return text; };
async function freePort() { const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise((done) => probe.close(done)); return port; }

// Raw oneM2M HTTP request used for provisioning, probes and readback evidence.
async function raw(endpoint, originator, method, path, body, ty) {
  const rqi = `grp-run-${randomBytes(6).toString('hex')}`;
  const response = await fetch(`${endpoint}${path}`, { method, redirect: 'error', headers: { accept: 'application/json', 'X-M2M-Origin': originator, 'X-M2M-RI': rqi, 'X-M2M-RVI': '4', ...(body ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  return { status: response.status, rsc: Number(response.headers.get('X-M2M-RSC')), rqiMatches: response.headers.get('X-M2M-RI') === rqi, payload: text ? JSON.parse(text) : null };
}

function pythonSdt(endpoint, originator, args) {
  const result = spawnSync(python[0], [...python.slice(1), pythonClient, '--endpoint', endpoint, '--originator', originator, '--xsd', xsdPath, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 60000 });
  if (result.status !== 0) throw new Error(`Python SDT client ${args[0]}: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}

// Simulated Gateway/BLE stage. Calls go through the production IntegrationApiGateway routes in-process.
const gatewayPrincipal = { principalId: 'gateway-demo', scopes: [], mtlsFingerprint: 'DEMO-ONLY-NO-TRANSPORT' };
async function gatewayApplies(deviceIds) {
  const handled = [];
  const polled = await runtime.api.handle({ method: 'GET', path: '/api/v1/gateways/pi-01/commands?limit=16', principal: gatewayPrincipal });
  for (const command of polled.body.commands.filter((item) => deviceIds.includes(item.deviceId))) {
    const payloadHash = runtime.store.get('gatewayCommands', command.commandId).payloadHash;
    const binding = { commandId: command.commandId, deviceId: command.deviceId, claimId: command.claimId, grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, payloadHash };
    const authorized = await runtime.api.handle({ method: 'POST', path: '/api/v1/gateways/pi-01/authorize', principal: gatewayPrincipal, body: binding });
    const started = await runtime.api.handle({ method: 'POST', path: '/api/v1/gateways/pi-01/dispatch-start', principal: gatewayPrincipal, body: binding });
    const at = new Date().toISOString();
    const receipt = { version: 1, gatewayId: 'pi-01', deviceId: command.deviceId, commandId: command.commandId, payloadHash, status: 'APPLIED', ackCode: 'APPLIED', acceptedAt: at, appliedAt: at, receivedAt: at, readback: { state: command.desiredState.state }, firmwareRevision: 'keyring-simulated', ownershipEpoch: command.ownershipEpoch, grantRevision: command.grantRevision, timestampSource: 'gateway-estimated', detail: null, bootId: `sim-${run}` };
    const settled = await runtime.api.handle({ method: 'POST', path: '/api/v1/gateways/pi-01/receipts', principal: gatewayPrincipal, body: receipt });
    handled.push({ deviceId: command.deviceId, commandId: command.commandId, claimId: command.claimId, grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, deadline: command.deadline, payloadHash, authorizeAllowed: authorized.body.allowed, dispatchStartAllowed: started.body.allowed, receiptStatus: settled.body.status, executionState: settled.body.executionState, receiptHash: settled.body.receiptHash });
  }
  await runtime.groupCommands.idle();
  return handled;
}

const memberView = (summary) => summary.members.map(({ deviceId, path, status, attempts, cseRsc, error, binding, payloadHash, readback, cseReadback }) => ({ deviceId, path, status, attempts, cseRsc, error: error ?? null, binding, payloadHash, readback, cseReadback }));

try {
  await pool.query(`CREATE DATABASE "${database}"`); databaseCreated = true;
  const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database });
  await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
  const port = await freePort(); const admin = `S${randomBytes(11).toString('hex')}`; secrets.push(admin);
  const endpoint = `http://127.0.0.1:${port}`;
  const config = { http: { port }, https: { enabled: false }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database }, cse: { admin, cse_id: '/pb-group-cse', csebase_rn: 'Mobius', cse_type: 1, poa: [endpoint] }, mqtt: { enabled: false }, logging: { level: 'error', file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
  let diagnostic = '';
  child = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  child.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); }); child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
  await new Promise((ready, reject) => { const timeout = setTimeout(() => reject(new Error(`CSE 시작 대기: ${sanitized(diagnostic)}`)), 30000); child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`CSE 시작 종료 ${code}: ${sanitized(diagnostic)}`)); }); child.on('message', (message) => { if (message === 'ready') { clearTimeout(timeout); ready(); } }); });

  // Provisioning with the CSE administrator: central command AE, two client AEs, three keyring AEs.
  const adminClient = new OneM2mEdgeClient({ endpoint, cseBase: '/Mobius', cseId: '/pb-group-cse', originator: admin, timeoutMs: 8000 });
  const ae = (rn, api) => adminClient.ensure('/Mobius', 2, { 'm2m:ae': { rn, api, rr: true } }, { update: false });
  const central = await ae(`pb-central-${run}`, 'N.privacy.bubble.central');
  const pyAe = await ae(`pb-sdt-py-${run}`, 'N.privacy.bubble.sdt.python');
  const jsAe = await ae(`pb-sdt-js-${run}`, 'N.privacy.bubble.sdt.javascript');
  const grantHorizon = new Date(Date.now() + 3600 * 1000).toISOString();
  const pvs = { acr: [{ acor: [admin], acop: 63 }] };
  const acp = (parent, rn, rules, et = grantHorizon) => adminClient.ensure(parent, 1, { 'm2m:acp': { rn, et: toOneM2mTime(et), pv: { acr: [{ acor: [admin], acop: 63 }, ...rules] }, pvs } });
  const centralAcp = await acp(central.path, 'central-acp', [{ acor: [central.aei], acop: 63 }]);
  await adminClient.request('PUT', central.path, { 'm2m:ae': { acpi: [centralAcp.ri] } });
  const macp = await acp(central.path, 'household-macp', [{ acor: [central.aei], acop: 6 }]);
  const audit = await adminClient.ensure(central.path, 3, { 'm2m:cnt': { rn: 'groupCommands', mni: 10, acpi: [centralAcp.ri] } });
  const devices = {};
  for (const [label, deviceId] of [['a', 'keyring-A'], ['b', 'keyring-B'], ['c', 'keyring-C']]) {
    const device = await ae(`kr-${run}-${label}`, 'N.privacy.bubble.keyring');
    const centralMask = label === 'c' ? 34 : 39;
    const deviceAcp = await acp(device.path, 'device-acp', [{ acor: [central.aei, pyAe.aei, jsAe.aei], acop: 34 }]);
    await adminClient.request('PUT', device.path, { 'm2m:ae': { acpi: [deviceAcp.ri] } });
    const switchAcp = await acp(device.path, 'switch-acp', [{ acor: [central.aei], acop: centralMask }, { acor: [pyAe.aei, jsAe.aei], acop: 38 }]);
    const ackAcp = await acp(device.path, 'ack-acp', [{ acor: [central.aei], acop: 3 }]);
    const switchResource = await adminClient.ensure(device.path, 28, encodeBinarySwitch({ rn: 'binarySwitch', state: false, acpi: [switchAcp.ri], lbl: [`pb-device:${deviceId}`], et: toOneM2mTime(new Date(Date.now() + 86400 * 1000).toISOString()) }, { operation: 'CREATE' }));
    const ackContainer = await adminClient.ensure(device.path, 3, { 'm2m:cnt': { rn: 'commandAcks', mni: 1, acpi: [ackAcp.ri] } });
    devices[deviceId] = { deviceId, aePath: device.path, aeId: device.aei, switchPath: switchResource.path, switchRi: switchResource.ri, switchAcp: { path: switchAcp.path, ri: switchAcp.ri, centralAcop: centralMask }, ackContainer: ackContainer.path };
  }
  const flexMni = await raw(endpoint, admin, 'POST', devices['keyring-A'].aePath, encodeBinarySwitch({ rn: 'mni-probe', state: false, mni: 3 }, { operation: 'CREATE' }), 28);
  check('flexContainer mni capability boundary (5001 NOT_IMPLEMENTED)', flexMni.rsc, 5001);

  const fetchLog = [];
  const loggingFetch = async (url, init) => { const response = await fetch(url, init); fetchLog.push({ method: init.method, path: new URL(url).pathname, rsc: Number(response.headers.get('X-M2M-RSC')) }); return response; };
  const core = () => ({ groupCommand: { cse: { endpoint, cseBase: '/Mobius', originator: central.aei, timeoutMs: 8000 }, groupParent: central.path,
    memberResources: Object.fromEntries(Object.values(devices).map((item) => [item.deviceId, item.switchPath])), ackContainers: Object.fromEntries(Object.values(devices).map((item) => [item.deviceId, item.ackContainer])),
    auditContainer: audit.path, macp: [macp.ri], acpi: [centralAcp.ri] } });
  const withFetch = () => { const value = core(); value.groupCommand.cse.fetchImpl = loggingFetch; return value; };
  const statePath = join(directory, 'integration-state.json');
  let demo = await createPortalDemo({ statePath, core: withFetch() }); runtime = demo.runtime;
  const { principals } = demo;
  const portal = async (role, path, body) => { const response = await runtime.api.handle({ method: 'POST', path: `/v1/portal/${path}`, principal: principals[role], body }); if (response.status !== 200) throw new Error(`${path}: ${JSON.stringify(response.body)}`); return response.body; };
  const consent = await portal('guardian', 'consents', { householdId: 'household-demo', purpose: 'household group command', scopes: ['bubble:command'], ttlSec: 3600, idempotencyKey: `consent-${run}` });
  const grant = await portal('guardian', 'grants', { consentId: consent.consentId, scopes: ['bubble:command'], ttlSec: 1800, idempotencyKey: `grant-${run}` });
  const commands = [];

  // G1: household ON with keyring-C denied by its member ACP.
  const requested = await portal('visitor', 'commands/request', { householdId: 'household-demo', target: 'household', desiredState: { state: true }, reason: '가구 전체 보호 모드', ttlSec: 600, idempotencyKey: `g1-request-${run}` });
  const logStart = fetchLog.length;
  const approved = await portal('guardian', 'commands/approve', { requestId: requested.requestId, grantId: grant.grantId, idempotencyKey: `g1-approve-${run}` });
  const approveCalls = fetchLog.slice(logStart);
  const groupCommandId = approved.group.commandId;
  const afterFanout = runtime.groupCommands.summary(groupCommandId);
  check('G1 one fanOutPoint UPDATE for the household', approveCalls.filter((call) => call.path.endsWith('/fopt')).length, 1);
  check('G1 per-member rsc from m2m:agr', afterFanout.fanouts[0].memberResults.map((item) => [item.deviceId, item.rsc]), [['keyring-A', 2004], ['keyring-B', 2004], ['keyring-C', 4103]]);
  check('G1 request status after partial fan-out', approved.status, 'PARTIAL');
  check('G1 claims issued only for CSE-accepted members', approved.commands.map((item) => item.deviceId).sort(), ['keyring-A', 'keyring-B']);
  const g1Gateway = await gatewayApplies(['keyring-A', 'keyring-B']);
  check('G1 Gateway receipts for A and B settle APPLIED_VERIFIED', g1Gateway.map((item) => item.executionState), ['APPLIED_VERIFIED', 'APPLIED_VERIFIED']);
  const beforeRestart = runtime.groupCommands.summary(groupCommandId);
  await runtime.close();
  demo = await createPortalDemo({ statePath, core: withFetch() }); runtime = demo.runtime;
  const recovered = runtime.groupCommands.summary(groupCommandId);
  check('restart keeps member states durable', recovered.members.map((item) => [item.deviceId, item.status]), [['keyring-A', 'READBACK_VERIFIED'], ['keyring-B', 'READBACK_VERIFIED'], ['keyring-C', 'RETRY_PENDING']]);
  const repair = await raw(endpoint, admin, 'PUT', devices['keyring-C'].switchAcp.path, { 'm2m:acp': { pv: { acr: [{ acor: [admin], acop: 63 }, { acor: [central.aei], acop: 39 }, { acor: [pyAe.aei, jsAe.aei], acop: 38 }] } } });
  check('operator repairs keyring-C member ACP', repair.rsc, 2004);
  const retryStart = fetchLog.length;
  const retried = await portal('guardian', 'commands/retry', { requestId: requested.requestId, idempotencyKey: `g1-retry-${run}` });
  const retryCalls = fetchLog.slice(retryStart).filter((call) => call.method === 'PUT');
  check('retry reaches only the failed member', retryCalls.map((call) => [call.path, call.rsc]), [[devices['keyring-C'].switchPath, 2004]]);
  const replay = await portal('guardian', 'commands/retry', { requestId: requested.requestId, idempotencyKey: `g1-retry-${run}` });
  check('retry replay with the same key is idempotent', JSON.stringify(replay) === JSON.stringify(retried), true);
  const g1Retry = await gatewayApplies(['keyring-C']);
  const g1Final = runtime.groupCommands.summary(groupCommandId);
  check('G1 settles after retry', [g1Final.status, g1Final.appliedCount], ['SETTLED', 3]);
  check('G1 member binding equals Gateway claim', g1Final.members.every((item) => { const record = runtime.store.get('gatewayCommands', item.memberCommandId); return record && item.binding.claimId === record.command.claimId && item.binding.grantRevision === record.command.grantRevision && item.binding.ownershipEpoch === record.command.ownershipEpoch && item.binding.deadline === record.command.deadline && item.payloadHash === record.payloadHash; }), true);
  check('G1 device and CSE readback per member', g1Final.members.map((item) => [item.readback?.state, item.cseReadback?.state]), [[true, true], [true, true], [true, true]]);
  commands.push({ name: 'G1-household-on-partial-acp-retry', requestId: requested.requestId, groupCommandId, desiredState: true, fanout: afterFanout.fanouts[0], afterFanout: memberView(afterFanout), beforeRestart: memberView(beforeRestart), restartRecovered: memberView(recovered), aclRepair: { member: 'keyring-C', acp: devices['keyring-C'].switchAcp.path, rsc: repair.rsc, centralAcop: 39 }, retry: { portalStatus: retried.status, cseCalls: retryCalls, records: g1Final.retries }, gateway: [...g1Gateway, ...g1Retry], final: { status: g1Final.status, appliedCount: g1Final.appliedCount, attempts: g1Final.attempts, members: memberView(g1Final) }, centralCseCalls: approveCalls });

  // G2: household OFF, all members accept in one fan-out.
  const requested2 = await portal('visitor', 'commands/request', { householdId: 'household-demo', target: 'household', desiredState: { state: false }, reason: '가구 전체 보호 해제', ttlSec: 600, idempotencyKey: `g2-request-${run}` });
  const g2Start = fetchLog.length;
  const approved2 = await portal('guardian', 'commands/approve', { requestId: requested2.requestId, grantId: grant.grantId, idempotencyKey: `g2-approve-${run}` });
  const g2Calls = fetchLog.slice(g2Start);
  const g2Gateway = await gatewayApplies(['keyring-A', 'keyring-B', 'keyring-C']);
  const g2Final = runtime.groupCommands.summary(approved2.group.commandId);
  check('G2 group reused without re-creation', g2Calls.filter((call) => call.method === 'POST' && call.path === central.path).map((call) => call.rsc), [4105]);
  check('G2 all members 2004 in one fopt', g2Final.fanouts[0].memberResults.map((item) => item.rsc), [2004, 2004, 2004]);
  check('G2 settles with readback false', [g2Final.status, g2Final.members.map((item) => item.readback?.state)], ['SETTLED', [false, false, false]]);
  commands.push({ name: 'G2-household-off-all-members', requestId: requested2.requestId, groupCommandId: approved2.group.commandId, desiredState: false, fanout: g2Final.fanouts[0], gateway: g2Gateway, final: { status: g2Final.status, appliedCount: g2Final.appliedCount, attempts: g2Final.attempts, members: memberView(g2Final) }, centralCseCalls: g2Calls });

  // Related resources: group (mt, mid, macp, et), ACK containers (mni=1), audit container (mni=10, cin et).
  const groupRead = await raw(endpoint, admin, 'GET', g1Final.groupPath);
  const grp = groupRead.payload['m2m:grp'];
  check('group mt=28, 3 members, macp, et = grant expiry', [grp.mt, grp.cnm, grp.macp, grp.et], [28, 3, [macp.ri], toOneM2mTime(grant.expiresAt)]);
  const ackEvidence = [];
  for (const item of Object.values(devices)) {
    const container = (await raw(endpoint, admin, 'GET', item.ackContainer)).payload['m2m:cnt'];
    const latest = (await raw(endpoint, admin, 'GET', `${item.ackContainer}/la`)).payload?.['m2m:cin'];
    ackEvidence.push({ deviceId: item.deviceId, path: item.ackContainer, mni: container.mni, cni: container.cni, latest: { et: latest?.et, commandId: latest?.con?.commandId, claimId: latest?.con?.claimId, payloadHash: latest?.con?.payloadHash, readback: latest?.con?.readback, cseState: latest?.con?.cseState, executionState: latest?.con?.executionState } });
  }
  check('ACK container mni=1 keeps only the latest member readback', ackEvidence.map((item) => [item.mni, item.cni, item.latest.readback?.state]), [[1, 1, false], [1, 1, false], [1, 1, false]]);
  const auditContainer = (await raw(endpoint, admin, 'GET', audit.path)).payload['m2m:cnt'];
  const auditLatest = (await raw(endpoint, admin, 'GET', `${audit.path}/la`)).payload?.['m2m:cin'];
  check('audit container holds the fan-out records with et', [auditContainer.mni, auditContainer.cni, typeof auditLatest?.et], [10, 2, 'string']);
  const foreignFopt = await raw(endpoint, pyAe.aei, 'PUT', `${g1Final.groupPath}/fopt`, encodeBinarySwitch({ state: true }));
  check('macp refuses a non-central originator at the fanOutPoint', foreignFopt.rsc, 4103);

  // R11: same discovery, read and toggle results from two independent client implementations.
  const jsClient = new OneM2mEdgeClient({ endpoint, cseBase: '/Mobius', originator: jsAe.aei, timeoutMs: 8000 });
  const jsDiscovery = await jsClient.discover('/Mobius', { ty: 28, cnd: BINARY_SWITCH_CND });
  const jsUris = (jsDiscovery.payload['m2m:uril'] ?? []).map((uri) => uri.startsWith('/') ? uri : `/${uri}`).sort();
  const jsStates = Object.fromEntries(await Promise.all(jsUris.map(async (uri) => [uri, (await jsClient.read(uri))['cod:binSh'].state])));
  const pyVerify = pythonSdt(endpoint, pyAe.aei, ['verify', '--toggle', devices['keyring-B'].switchPath]);
  check('Python and JavaScript discover the same binarySwitch URIs', pyVerify.discovery.uris, jsUris);
  check('discovery finds exactly the three keyring flexContainers', jsUris, Object.values(devices).map((item) => item.switchPath).sort());
  check('Python and JavaScript read the same states', pyVerify.states, jsStates);
  check('Python toggle and restore readback', [pyVerify.toggle.set.rsc, pyVerify.toggle.set.readback, pyVerify.toggle.restore.rsc, pyVerify.toggle.restore.readback], [2004, !pyVerify.toggle.before, 2004, pyVerify.toggle.before]);
  check('unregistered cnd discovery is empty', pyVerify.unmatchedCnd.uris, []);
  const target = devices['keyring-A'].switchPath;
  const jsSet = await jsClient.request('PUT', target, encodeBinarySwitch({ state: true }));
  const pyReadAfterJs = pythonSdt(endpoint, pyAe.aei, ['read', target]);
  const pySet = pythonSdt(endpoint, pyAe.aei, ['set', target, 'false']);
  const jsReadAfterPy = (await jsClient.read(target))['cod:binSh'].state;
  check('JavaScript write is read by Python', [jsSet.rsc, pyReadAfterJs.state], [2004, true]);
  check('Python write is read by JavaScript', [pySet.rsc, pySet.readback, jsReadAfterPy], [2004, false, false]);

  const status = checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL';
  const evidence = {
    contractId: 'privacy-bubble.group-command-real-cse.v1', docRevision: '2.0.0', generatedAt: new Date().toISOString(), status, rubricIds: ['R01', 'R11'],
    simulation: { cse: false, oneM2MGroupFanout: false, centralCommandService: false, sdtClients: false, gatewayBleDevice: true,
      note: 'Mobius4, PostgreSQL, the <grp>/fopt fan-out, member ACP, ACK containers and both SDT clients ran for real over loopback HTTP. The Gateway poll/authorize/dispatch-start/receipt calls were made in-process by this script through IntegrationApiGateway.handle, and the keyring readback echoes the desired state. No Raspberry Pi, BLE link or keyring hardware took part.' },
    transport: { cse: 'actual-Mobius4-loopback-HTTP', centralApi: 'in-process IntegrationApiGateway.handle (no TLS)', pythonClient: 'urllib HTTP', javascriptClient: 'fetch HTTP' },
    cseImplementation: 'Mobius4', cseVersion: JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version,
    cseSourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout.trim() || null,
    hostCount: 1, cseCount: 1, host: { platform: process.platform, node: process.version }, postgres: (await pool.query('SELECT version()')).rows[0].version,
    registry: { profile: 'r4-common-1.0', envelope: 'cod:binSh', cnd: BINARY_SWITCH_CND, sha256: sha(await readFile(join(source, 'config/specializations.json'))) },
    resources: { centralAe: { path: central.path, aeId: central.aei }, sdtClientAes: { python: pyAe.aei, javascript: jsAe.aei }, macp: { path: macp.path, ri: macp.ri, centralAcop: 6 },
      group: { path: g1Final.groupPath, ri: grp.ri, mt: grp.mt, mnm: grp.mnm, cnm: grp.cnm, mtv: grp.mtv, csy: grp.csy, mid: grp.mid, macp: grp.macp, et: grp.et, fanoutPoint: `${g1Final.groupPath}/fopt` },
      devices: Object.values(devices), auditContainer: { path: audit.path, mni: auditContainer.mni, cni: auditContainer.cni, latestEt: auditLatest?.et }, flexContainerMniProbe: { rsc: flexMni.rsc, debug: flexMni.payload?.['m2m:dbg'] ?? null } },
    commands, ackContainers: ackEvidence, macpNegative: { originator: 'python SDT client AE', rsc: foreignFopt.rsc },
    sdtClients: { implementations: [{ language: 'JavaScript', implementation: 'pc-mobius OneM2mEdgeClient' }, { language: 'Python', implementation: 'tools/onem2m-sdt-client/sdt_client.py', dependencies: 'standard library only', contractSource: 'pc-mobius/specializations/r4/binarySwitch-r4-profile.xsd + TS-0023 cnd' }],
      javascript: { discovery: { filter: { fu: 1, ty: 28, cnd: BINARY_SWITCH_CND }, rsc: jsDiscovery.rsc, uris: jsUris }, states: jsStates },
      python: pyVerify, crossWrite: { jsWrite: { uri: target, rsc: jsSet.rsc, pythonRead: pyReadAfterJs.state }, pythonWrite: { uri: target, rsc: pySet.rsc, pythonReadback: pySet.readback, javascriptRead: jsReadAfterPy } } },
    checks, passed: checks.filter((item) => item.status === 'PASS').length, failed: checks.filter((item) => item.status === 'FAIL').length,
    runnerSHA256: sha(await readFile(fileURLToPath(import.meta.url))), pythonClientSHA256: sha(await readFile(pythonClient)),
    replay: 'MOBIUS4_ROOT=<mobius4> node pc-mobius/scripts/run-group-command-real.mjs (requires .local/postgres/connection.json)',
  };
  await mkdir(resolve(evidencePath, '..'), { recursive: true });
  await writeFile(evidencePath, `${sanitized(JSON.stringify(evidence, null, 2))}\n`);
  console.log(JSON.stringify({ status, passed: evidence.passed, failed: evidence.failed, failedChecks: checks.filter((item) => item.status === 'FAIL'), receipt: evidencePath }, null, 2));
  if (status !== 'PASS') process.exitCode = 1;
} catch (error) { console.error(sanitized(error.stack)); process.exitCode = 1; }
finally {
  try { await runtime?.close(); } catch {}
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit').catch(() => {}); }
  if (databaseCreated) { try { await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); } catch (error) { console.error(`database cleanup: ${sanitized(error.message)}`); } }
  await pool.end();
}
