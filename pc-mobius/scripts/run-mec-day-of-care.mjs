/**
 * R13 "day of care" run on the ETSI MEC Sandbox (STF_685): the oneM2M MEC IPE runs as a MEC application
 * (image pb-onem2m-ipe) on a MEP and is relocated from mep1 (Edge-A, home-district) to mep2 (Edge-B,
 * park-district) while the resident walks from home into Parc Princesse Antoinette.
 *
 * Hosts: PC = Mobius4 CSE (HTTPS 0.0.0.0:17599 with the lab CA, loopback HTTP for local AEs), the
 * orchestrator, the guardian app and this story driver; VM = sandbox `dayofcare` (scenario day-of-care)
 * with the IPE pods. Story time is compressed (minutes to seconds); the walk holds before park-district
 * until the pre-placed instance is ready, which keeps the real-time order of a 6 min walk.
 *
 * Environment: MOBIUS4_ROOT, MEC_BASE_URL (https://192.168.0.103), MEC_SANDBOX_NAME (dayofcare),
 * MEC_CA_FILE (.local/mec-sandbox/ca.pem), PB_CSE_PUBLIC_HOST (192.168.0.106), PB_CSE_PUBLIC_PORT (17599),
 * PB_CSE_TLS_KEY / PB_CSE_TLS_CERT (.local/mec-sandbox/pc-cse-server.key/.crt), PB_STEP_MS (1500),
 * PB_VM_SSH (mec@192.168.0.103), PB_VM_KEY, PB_VM_KNOWN_HOSTS (pod logs and pod timestamps; optional),
 * PB_IPE_IMAGE_DIGEST (informational).
 */
import { cp, mkdir, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { approvalHash } from '../integration/src/integration-utils.mjs';
import { MEC_IPE_SPECIALIZATIONS } from '../integration/src/mec-ipe.mjs';
import { IPE_LIFECYCLE_SCHEMA } from '../integration/src/mec-ipe-relocatable.mjs';
import { MecIpeOrchestrator, evaluateEligibility } from '../integration/src/mec-ipe-orchestrator.mjs';
import { createMecFetch } from '../integration/src/mec-platform-client.mjs';
import { Onem2mHttpClient, parseContent } from '../integration/src/onem2m-http-client.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const env = process.env;
const upstream = resolve(env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
const mecBase = (env.MEC_BASE_URL ?? 'https://192.168.0.103').replace(/\/+$/, '');
const sandboxName = env.MEC_SANDBOX_NAME ?? 'dayofcare';
const caFile = resolve(root, env.MEC_CA_FILE ?? '.local/mec-sandbox/ca.pem');
const publicHost = env.PB_CSE_PUBLIC_HOST ?? '192.168.0.106';
const publicPort = Number(env.PB_CSE_PUBLIC_PORT ?? 17599);
const tlsKey = resolve(root, env.PB_CSE_TLS_KEY ?? '.local/mec-sandbox/pc-cse-server.key');
const tlsCert = resolve(root, env.PB_CSE_TLS_CERT ?? '.local/mec-sandbox/pc-cse-server.crt');
const stepMs = Number(env.PB_STEP_MS ?? 1500);
const vmSsh = env.PB_VM_SSH ?? 'mec@192.168.0.103';
const vmKey = env.PB_VM_KEY ?? join(homedir(), 'VMs', 'mec-sandbox', 'id_ed25519');
const vmKnownHosts = env.PB_VM_KNOWN_HOSTS ?? join(homedir(), 'VMs', 'mec-sandbox', 'known_hosts');
const useSsh = env.PB_VM_SSH !== '' && existsSync(vmKey);
const scenarioFile = join(root, 'deploy', 'mec-sandbox', 'scenarios', 'day-of-care.yaml');
const sandboxRoot = `${mecBase}/${sandboxName}`;
const ids = { ipe: 'Cpb-mec-ipe', ipeAe: 'pb-mec-ipe', app: 'Cguardian-app', orchestrator: 'Cpb-orchestrator', device: 'Cresident-keyring', deviceAe: 'resident-keyring' };
const ue = { resident: 'resident-relay', caregiver: 'caregiver', guardian: 'guardian' };
const instances = { mep1: { name: 'pb-ipe-mep1', id: '0d0c0a00-0000-4000-8000-0000000001a1', nodePort: 31881 }, mep2: { name: 'pb-ipe-mep2', id: '0d0c0a00-0000-4000-8000-0000000001a2', nodePort: 31882 } };
const trail = [[7.417915, 43.736945], [7.417894, 43.736678], [7.417596, 43.736644], [7.417302, 43.736479], [7.417082, 43.736212], [7.416868, 43.735937], [7.416715, 43.735715], [7.416551, 43.735538], [7.41646, 43.735358], [7.416365, 43.735125], [7.416308, 43.734946], [7.416266, 43.734679], [7.416249, 43.734458], [7.416217, 43.7343], [7.416158, 43.734131], [7.416042, 43.733948], [7.415986, 43.733975], [7.415907, 43.733872], [7.41571, 43.733702], [7.41556, 43.733582], [7.415479, 43.733515], [7.415336, 43.733392], [7.415248, 43.733333], [7.415159, 43.733293], [7.4151, 43.733238], [7.415052, 43.733171], [7.414975, 43.733087], [7.414598, 43.732772], [7.414514, 43.732722], [7.414478, 43.732648]];
const PARK_ENTRY = 12; const FORK = 21; const BENCH = trail.length - 1;
const caregiverPath = [[7.416868, 43.735937], [7.417082, 43.736212], [7.417302, 43.736479], [7.417894, 43.736678], [7.417915, 43.736945]];
const guardianPath = [[7.417963, 43.730843], [7.417615, 43.73142], [7.416843, 43.732451], [7.41533, 43.7324], [7.415273, 43.732446], [7.415066, 43.732616], [7.414725, 43.732736], [7.414478, 43.732648]];
const parkArea = [[7.4135, 43.7322], [7.4165, 43.7322], [7.4165, 43.7346], [7.4135, 43.7346], [7.4135, 43.7322]];

const stamp = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const directory = join(root, '.local', 'mec-day-of-care', stamp);
const source = join(root, '.local', 'mec-day-of-care', 'source');
const evidenceDir = join(root, 'docs', 'verification-evidence', '2026-11-20');
await mkdir(directory, { recursive: true });
const t0 = Date.now(); const trace = []; const checks = []; const story = [];
const log = (entry) => { trace.push({ seq: trace.length + 1, tMs: Date.now() - t0, ...entry }); };
const step = (actor, name, details = {}) => log({ at: new Date().toISOString(), actor, step: name, ...details });
const check = (name, expected, actual, details = {}) => { const status = approvalHash(expected ?? null) === approvalHash(actual ?? null) ? 'PASS' : 'FAIL'; checks.push({ name, status, expected, actual, ...details }); step('verifier', 'CHECK', { name, status, expected, actual }); return status === 'PASS'; };
const chapter = (storyTime, title, details = {}) => { const entry = { storyTime, title, runMs: Date.now() - t0, ...details }; story.push(entry); step('story', 'STORY', entry); console.log(`[${storyTime}] ${title}`); };
const children = []; const databases = []; const servers = []; const sshStreams = [];
const connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8'));
const secrets = [connection.password];
const sanitized = (value) => { let text = String(value); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[secret]'); return text; };
const pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database });
async function freePort() { const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise((done) => probe.close(done)); return port; }
async function waitFor(predicate, timeoutMs, label) { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = await predicate(); if (value) return value; await delay(200); } throw new Error(`timeout: ${label}`); }
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sha256File = async (path) => sha256(await readFile(path));
const metersBetween = ([lon1, lat1], [lon2, lat2]) => { const rad = (d) => (d * Math.PI) / 180; const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2; return 2 * 6371008.8 * Math.asin(Math.sqrt(a)); };

// Sandbox control plane and MEC APIs through the k8s ingress with the pinned lab CA.
const mecFetch = createMecFetch({ caFile });
const sandbox = async (method, path, body, expected = [200, 201, 204]) => {
  const response = await mecFetch(`${sandboxRoot}${path}`, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!expected.includes(response.status)) throw Object.assign(new Error(`sandbox ${method} ${path} ${response.status} ${String(text).slice(0, 200)}`), { status: response.status });
  return { status: response.status, data };
};
const moveUe = async (name, coordinates) => (await sandbox('POST', `/gis/v1/geodata/${name}`, { assetName: name, assetType: 'UE', subType: 'UE', location: { type: 'Point', coordinates } })).status;
const ssh = (command, { timeoutMs = 30000 } = {}) => { if (!useSsh) return null; const result = spawnSync('ssh', ['-i', vmKey, '-o', `UserKnownHostsFile=${vmKnownHosts}`, '-o', 'BatchMode=yes', vmSsh, command], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }); return result.status === 0 ? result.stdout : null; };
const podInfo = (appId) => { const out = ssh(`kubectl -n ${sandboxName} get pods -l meepAppId=${appId} -o json`); if (!out) return null; try { const pod = JSON.parse(out).items?.at(-1); if (!pod) return null; const cond = (type) => pod.status?.conditions?.find((item) => item.type === type)?.lastTransitionTime ?? null; return { name: pod.metadata.name, node: pod.spec.nodeName, createdAt: pod.metadata.creationTimestamp, scheduledAt: cond('PodScheduled'), readyAt: cond('Ready'), phase: pod.status.phase, image: pod.status.containerStatuses?.find((item) => !item.name.includes('sidecar'))?.imageID ?? null }; } catch { return null; } };
// Pod logs are polled (kubectl logs -f needs an inotify watcher, which this single-node VM runs out of).
const sshAsync = (command, timeoutMs = 20000) => new Promise((done) => { if (!useSsh) return done(null); const child = spawn('ssh', ['-i', vmKey, '-o', `UserKnownHostsFile=${vmKnownHosts}`, '-o', 'BatchMode=yes', vmSsh, command], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); let out = ''; const timer = setTimeout(() => child.kill(), timeoutMs); child.stdout.on('data', (chunk) => { out += chunk; }); child.on('close', (code) => { clearTimeout(timer); done(code === 0 ? out : null); }); });
const podLogSeen = new Set();
const fetchPodLogs = async (instance, mep) => {
  const out = await sshAsync(`kubectl -n ${sandboxName} logs deployment/${instance.name} -c ${instance.name} 2>/dev/null`);
  for (const line of (out ?? '').split('\n')) { if (!line.trim() || podLogSeen.has(line)) continue; podLogSeen.add(line); try { const { at, actor, step: name, ...rest } = JSON.parse(line); log({ at: at ?? new Date().toISOString(), actor: `ipe@${mep}`, step: name ?? 'POD_LOG', podAt: at ?? null, ...rest }); } catch { /* non-JSON line */ } }
};
const streamPodLogs = (instance, mep) => { if (!useSsh) return; let busy = false; const timer = setInterval(async () => { if (busy) return; busy = true; try { await fetchPodLogs(instance, mep); } finally { busy = false; } }, 4000); sshStreams.push({ kill: () => clearInterval(timer), instance, mep }); };

let orchestrator; let mobilityWasActive = null; let runtimeError = null; let cseClient; let tookControl = false;
const lifecycle = []; const observations = []; const statuses = []; const rnisSeen = []; const relocation = {}; const preplacement = {}; const termination = {};
try {
  // ---- Preflight: sandbox, scenario, topology, declared placement.
  const yamlText = await readFile(scenarioFile); const yamlSHA256 = sha256(yamlText);
  // Declared IPE process (scenario yaml), used to re-create the mep1 instance when no instance is left.
  const declaredEnvironment = /name: pb-ipe-mep1[\s\S]*?environment: '([^']+)'/.exec(yamlText.toString('utf8'))?.[1];
  if (!declaredEnvironment) throw new Error('pb-ipe-mep1 environment not found in the scenario yaml');
  const declaredIpe = { id: instances.mep1.id, name: instances.mep1.name, type: 'EDGE-APP', image: 'meep-docker-registry:30001/pb-onem2m-ipe', environment: declaredEnvironment, serviceConfig: { name: instances.mep1.name, meSvcName: 'pb-onem2m-ipe', ports: [{ protocol: 'TCP', port: 18080, externalPort: instances.mep1.nodePort }] }, cpuConfig: { min: 0.1, max: 0.5 }, memoryConfig: { min: 64, max: 256 }, netChar: { latencyDistribution: 'Normal', throughputDl: 1000, throughputUl: 1000 } };
  const active = (await sandbox('GET', '/sandbox-ctrl/v1/active')).data;
  check('sandbox-scenario-active', 'day-of-care', active?.name);
  const activeHash = approvalHash(active);
  // The sandbox is shared with other experiments: refuse to drive the UEs while someone else moves them.
  const ueSnapshot = async () => JSON.stringify(((await sandbox('GET', '/gis/v1/geodata?assetType=UE&excludePath=true')).data?.geoDataAssets ?? []).map((asset) => [asset.assetName, asset.location?.coordinates]).sort());
  const before = await ueSnapshot(); await delay(6000);
  if (env.PB_IGNORE_SANDBOX_ACTIVITY !== '1' && before !== await ueSnapshot()) throw Object.assign(new Error('SANDBOX_IN_USE: UEs moved during the 6 s idle check; another experiment is driving sandbox dayofcare'), { code: 'SANDBOX_IN_USE' });
  tookControl = true;
  const automation = (await sandbox('GET', '/gis/v1/automation')).data?.states ?? [];
  mobilityWasActive = Boolean(automation.find((item) => item.type === 'MOBILITY')?.active);
  if (automation.find((item) => item.type === 'MOVEMENT')?.active) await sandbox('POST', '/gis/v1/automation/MOVEMENT?run=false');
  if (!mobilityWasActive) await sandbox('POST', '/gis/v1/automation/MOBILITY?run=true');
  for (const [name, point] of [[ue.resident, trail[0]], [ue.caregiver, caregiverPath[0]], [ue.guardian, guardianPath[0]]]) await moveUe(name, point);
  // MOBILITY automation re-aligns the POA of each UE with its position on its next ticks.
  const homeSeen = await waitFor(async () => { const users = (await sandbox('GET', '/mep1/location/v3/queries/users')).data?.userList?.user ?? []; return users.find((user) => user.address === ue.resident && user.accessPointId === 'home-wifi') ?? null; }, 30000, 'resident re-aligned on home-wifi');
  step('mec-sandbox', 'AUTOMATION', { mobility: true, mobilityWasActive, movement: false, resident: { zoneId: homeSeen.zoneId, accessPointId: homeSeen.accessPointId } });

  // ---- PC CSE: actual Mobius4 4.24.5, HTTPS on the LAN for the IPE pods, loopback HTTP for local AEs.
  await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
  try { await lstat(join(source, 'node_modules')); } catch { await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction'); }
  const prepared = spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (prepared.status !== 0) throw new Error(`specialization registry: ${prepared.stderr}`);
  const registryPath = join(source, 'config', 'specializations.json');
  await writeFile(registryPath, `${JSON.stringify({ ...JSON.parse(await readFile(registryPath, 'utf8')), ...MEC_IPE_SPECIALIZATIONS }, null, 2)}\n`);
  const preload = join(directory, 'lan-https-only.cjs');
  await writeFile(preload, "const net = require('node:net'); const keep = Number(process.env.PB_PUBLIC_PORT); const original = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && typeof args[1] !== 'string' && args[0] !== keep) args.splice(1,0,'127.0.0.1'); return original.apply(this,args); };\n");
  const database = `bubble_dayofcare_${stamp}`;
  await pool.query(`CREATE DATABASE "${database}"`); databases.push(database);
  const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database }); await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
  const httpPort = await freePort(); const admin = `S${randomBytes(11).toString('hex')}`; secrets.push(admin);
  const config = { http: { port: httpPort }, https: { enabled: true, port: publicPort, key: tlsKey, cert: tlsCert, chain: '' }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database }, cse: { admin, cse_id: '/pb-cse', csebase_rn: 'Mobius', cse_type: 1, subscription_verification: true, poa: [`https://${publicHost}:${publicPort}`] }, mqtt: { enabled: false }, logging: { level: 'error', file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
  let diagnostic = '';
  const cse = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(config), PB_PUBLIC_PORT: String(publicPort) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); children.push(cse);
  cse.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); }); cse.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
  await new Promise((ready, reject) => { const timeout = setTimeout(() => reject(new Error(`CSE start: ${sanitized(diagnostic)}`)), 30000); cse.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`CSE exit ${code}: ${sanitized(diagnostic)}`)); }); cse.on('message', (message) => { if (message === 'ready') { clearTimeout(timeout); ready(); } }); });
  const local = `http://127.0.0.1:${httpPort}`;
  const lanCheck = await createMecFetch({ caFile })(`https://${publicHost}:${publicPort}/Mobius`, { method: 'GET', headers: { 'X-M2M-Origin': 'Cprobe', 'X-M2M-RI': 'probe-1', 'X-M2M-RVI': '4', accept: 'application/json' } });
  step('runner', 'CSE_STARTED', { cseId: '/pb-cse', loopbackHttpPort: httpPort, lanHttps: `https://${publicHost}:${publicPort}`, lanProbeStatus: lanCheck.status });
  check('cse-lan-https-with-lab-ca', true, lanCheck.status > 0);
  const client = (originator) => new Onem2mHttpClient({ endpoint: local, cseBase: '/Mobius', originator });
  cseClient = client(admin);

  // ---- oneM2M side: guardian app, orchestrator and the resident's keyring (device AE).
  const receiver = (name, handler) => { const server = createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; } const signal = body?.['m2m:sgn']; if (signal && !signal.vrq) { try { await handler(signal, request.url); } catch (error) { step(name, 'HANDLER_REVIEW', { reason: error.message }); } } response.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end(); }); server.listen(0, '127.0.0.1'); servers.push(server); return once(server, 'listening').then(() => `http://127.0.0.1:${server.address().port}`); };
  const ipePath = `/Mobius/${ids.ipeAe}`; const devicePath = `/Mobius/${ids.deviceAe}`;
  const appUrl = await receiver('guardian-app', async (signal, url) => {
    const cin = signal.nev?.rep?.['m2m:cin']; const con = parseContent(cin?.con); if (!cin || !con) return;
    const arrivedAt = Date.now();
    if (con.schema === 'pb.mec.location.v1') { const entry = { arrivedAt, cinRi: cin.ri, creator: cin.cr, requestId: con.requestId, notificationType: con.notificationType, observedAt: con.observedAt, eventKey: con.eventKey, loc: cin.loc ? JSON.parse(cin.loc.crd) : null, zoneId: con.zoneId ?? null, accessPointId: con.accessPointId ?? null, event: con.event ?? null, servedBy: con.servedBy ?? null }; observations.push(entry); step('guardian-app', 'OBSERVATION', { ...entry, eventKey: entry.eventKey?.slice(0, 16) }); onObservation(entry); }
    else if (con.schema === 'pb.mec.rnis.v1') step('guardian-app', 'RNIS_OBSERVATION', { cinRi: cin.ri, srcCellId: con.srcCellId, trgCellId: con.trgCellId, servedBy: con.servedBy ?? null });
    else if (url.includes('status')) { const entry = { arrivedAt, requestId: con.requestId ?? null, state: con.state, service: con.service, mecSubscriptionId: con.mecSubscriptionId ?? null, providerStatus: con.providerStatus ?? null, servedBy: con.servedBy ?? null, reason: con.reason ?? null }; statuses.push(entry); step('guardian-app', 'REQUEST_STATUS', entry); }
  });
  let onLifecycle = async () => {}; let onRnis = async () => {}; let onObservation = () => {};
  const orchestratorUrl = await receiver('orchestrator', async (signal, url) => {
    const cin = signal.nev?.rep?.['m2m:cin']; const con = parseContent(cin?.con); if (!cin || !con) return;
    if (url.includes('lifecycle')) {
      if (cin.cr !== ids.ipe || con.schema !== IPE_LIFECYCLE_SCHEMA) { step('orchestrator', 'LIFECYCLE_REVIEW', { creator: cin.cr }); return; }
      const entry = { arrivedAt: Date.now(), event: con.event, mep: con.mep, appInstanceId: con.appInstanceId, epoch: con.epoch, at: con.at, con };
      lifecycle.push(entry); step('orchestrator', 'LIFECYCLE', { event: con.event, mep: con.mep, epoch: con.epoch, appInstanceId: con.appInstanceId });
      await onLifecycle(entry);
    } else if (url.includes('rnis')) { const entry = { arrivedAt: Date.now(), srcCellId: con.srcCellId ?? null, trgCellId: con.trgCellId ?? null, servedBy: con.servedBy ?? null }; rnisSeen.push(entry); step('orchestrator', 'RNIS_CELL_CHANGE', entry); await onRnis(entry); }
  });
  const app = client(ids.app); const orch = client(ids.orchestrator); const device = client(ids.device);
  await app.registerAe({ rn: 'guardian-app', api: 'N.privacy.bubble.guardian-app', poa: [appUrl] });
  await orch.registerAe({ rn: 'pb-orchestrator', api: 'N.privacy.bubble.mec-orchestrator', poa: [orchestratorUrl] });
  const deviceAe = await device.registerAe({ rn: ids.deviceAe, api: 'N.privacy.bubble.keyring', poa: [] });
  const ownerOnly = { acr: [{ acor: [ids.device], acop: 63 }] };
  const deviceAcp = await device.ensure(deviceAe.path, 1, { 'm2m:acp': { rn: 'device-acp', pv: { acr: [{ acor: [ids.device], acop: 63 }, { acor: [ids.ipe], acop: 3 }, { acor: [ids.app, ids.orchestrator], acop: 34 }] }, pvs: ownerOnly } });
  const observationAcp = await device.ensure(deviceAe.path, 1, { 'm2m:acp': { rn: 'observation-acp', pv: { acr: [{ acor: [ids.device], acop: 63 }, { acor: [ids.ipe], acop: 7 }, { acor: [ids.app, ids.orchestrator], acop: 35 }] }, pvs: ownerOnly } });
  for (const rn of ['location', 'rnis']) await device.ensure(deviceAe.path, 3, { 'm2m:cnt': { rn, acpi: [observationAcp.ri], mni: 1000, lbl: [`pb:${rn}`] } });
  await cseClient.update(deviceAe.path, { 'm2m:ae': { acpi: [deviceAcp.ri] } });
  for (const [rn, parent, nu] of [['app-location', `${devicePath}/location`, `${appUrl}/location`], ['app-rnis', `${devicePath}/rnis`, `${appUrl}/rnis`], ['orch-rnis', `${devicePath}/rnis`, `${orchestratorUrl}/rnis`]]) {
    const created = await (rn.startsWith('orch') ? orch : app).create(parent, 23, { 'm2m:sub': { rn, nu: [nu], enc: { net: [3] }, nct: 1 } });
    if (created.rsc !== 2001) throw new Error(`subscription ${rn} ${created.rsc}`);
  }
  step('runner', 'ONEM2M_PROVISIONED', { deviceAe: deviceAe.path, guardianApp: '/Mobius/guardian-app', orchestrator: '/Mobius/pb-orchestrator' });

  // ---- Orchestrator: topology, declared placement (IPE on mep1 only), eligibility record.
  orchestrator = new MecIpeOrchestrator({ sandbox, client: orch, ipeAePath: ipePath, request: { cpu: 0.1, memoryMi: 64 }, template: declaredIpe, trace: log });
  let topology = await orchestrator.refresh();
  step('orchestrator', 'TOPOLOGY', { hosts: topology.hosts.map(({ mep, zone, edge, capacity, mecApis, locality, userApps }) => ({ mep, zone, edge, capacity, mecApis, locality, userApps: userApps.map(({ name, cpu, memoryMi }) => ({ name, cpu, memoryMi })) })), amsCoverage: topology.amsCoverage, ipe: topology.ipeProcesses.map(({ name, id, mep }) => ({ name, id, mep })) });
  if (orchestrator.instanceOn('mep2')) { await orchestrator.remove(instances.mep2.name, { gracePeriod: 5 }); await waitFor(async () => !(await orchestrator.refresh()).ipeProcesses.some((item) => item.mep === 'mep2'), 60000, 'leftover mep2 instance removed'); }
  if (!orchestrator.instanceOn('mep1')) { await orchestrator.place('mep1', instances.mep1); topology = await orchestrator.refresh(); }
  check('declared-placement-ipe-on-mep1-only', [instances.mep1.id], (await orchestrator.refresh()).ipeProcesses.map((item) => item.id));
  streamPodLogs(instances.mep1, 'mep1');

  // ---- 13:00 at home. Initial placement decision and ownership epoch 1 for the mep1 instance.
  chapter('13:00', 'Resident at home (home-wifi, home-district, Edge-A)');
  const atHome = await orchestrator.locateUe(ue.resident);
  const initial = await orchestrator.decide({ kind: 'initial-placement', zone: atHome.zoneId ?? 'home-district', trigger: { type: 'MEC013-sighting', ...atHome }, ue: atHome.ueRef });
  check('initial-placement-selects-mep1', 'mep1', initial.selected, { eligible: initial.candidates.filter((item) => item.eligible).map((item) => item.mep) });
  await waitFor(async () => { const ae = await orch.retrieve(`${ipePath}/lifecycle`); return ae.rsc === 2000; }, 240000, 'IPE AE created by the mep1 pod');
  const lifecycleSub = await orch.create(`${ipePath}/lifecycle`, 23, { 'm2m:sub': { rn: 'orch-lifecycle', nu: [`${orchestratorUrl}/lifecycle`], enc: { net: [3] }, nct: 1 } });
  check('orchestrator-subscribes-ipe-lifecycle', 2001, lifecycleSub.rsc);
  await app.create(`${ipePath}/requestStatus`, 23, { 'm2m:sub': { rn: 'app-status', nu: [`${appUrl}/status`], enc: { net: [3] }, nct: 1 } });
  // READY may have been written before the subscription existed: read it back.
  const readyA = await waitFor(async () => { const listed = await orch.retrieve(`${ipePath}/lifecycle`, { fu: 1, ty: 4 }); for (const uri of listed.payload?.['m2m:uril'] ?? []) { const item = await orch.retrieve(`/${uri.replace(/^\/+/, '')}`); const con = parseContent(item.payload?.['m2m:cin']?.con); if (con?.event === 'READY' && con.appInstanceId === instances.mep1.id) return con; } return null; }, 60000, 'mep1 IPE READY');
  step('orchestrator', 'IPE_READY_READBACK', { mep: 'mep1', confirmReady: readyA.confirmReady, mecService: readyA.mecService, termination: readyA.termination, ams: readyA.ams });
  check('mep1-ipe-mec011-confirm-ready-and-service', { confirmReady: 204, service: 201, termination: 201 }, { confirmReady: readyA.confirmReady?.status ?? null, service: readyA.mecService?.httpStatus ?? null, termination: readyA.termination?.httpStatus ?? null });
  const own1 = await orchestrator.writeOwnership({ owner: instances.mep1.id, mep: 'mep1', decisionId: initial.decisionId, reason: 'initial-placement' });
  await waitFor(() => lifecycle.find((item) => item.event === 'RESUMED' && item.mep === 'mep1' && item.epoch === 1), 30000, 'mep1 owner epoch 1');
  check('ownership-epoch-1-mep1', { epoch: 1, mep: 'mep1' }, { epoch: own1.epoch, mep: lifecycle.find((item) => item.event === 'OWNER')?.mep ?? null });

  // Guardian app asks for the resident's location and cell changes through oneM2M.
  const requestIds = { periodic: `loc-periodic-${stamp.slice(-6)}`, tracking: `loc-tracking-${stamp.slice(-6)}`, rnis: `rnis-${stamp.slice(-6)}` };
  const subscribeRequest = (service, con) => app.create(`${ipePath}/${service === 'Location' ? 'locationRequests' : 'rnisRequests'}`, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'subscribe', deviceAe: ids.deviceAe, ueAddress: ue.resident, durationSec: 1800, ...con }, cr: null } });
  await subscribeRequest('RNIS', { requestId: requestIds.rnis, type: 'cellChange' });
  await subscribeRequest('Location', { requestId: requestIds.periodic, type: 'periodic', periodSec: 2 });
  await subscribeRequest('Location', { requestId: requestIds.tracking, type: 'userTracking' });
  await waitFor(() => Object.values(requestIds).every((id) => statuses.some((item) => item.requestId === id && item.state === 'ACTIVE' && item.servedBy?.mep === 'mep1')), 30000, 'requests ACTIVE on mep1');
  check('requests-active-on-mep1', 3, Object.values(requestIds).filter((id) => statuses.some((item) => item.requestId === id && item.state === 'ACTIVE' && item.servedBy?.mep === 'mep1')).length);
  await waitFor(() => observations.filter((item) => item.servedBy?.mep === 'mep1').length >= 2, 30000, 'home observations from mep1');
  check('home-observations-served-by-mep1', true, observations.every((item) => item.servedBy?.mep === 'mep1' && item.servedBy?.epoch === 1));
  // AMS registration of the served UE happens after the first request (background sync in the pod).
  await delay(2000);

  // ---- 14:00 caregiver visit, 16:00 departure.
  chapter('14:00', 'Visiting caregiver arrives at the home');
  for (const point of caregiverPath.slice(1)) { await moveUe(ue.caregiver, point); await delay(Math.round(stepMs / 2)); }
  await delay(2500);
  const visit = await waitFor(async () => { const users = (await sandbox('GET', '/mep1/location/v3/queries/users')).data?.userList?.user ?? []; const at = Object.fromEntries(users.map((user) => [user.address, user.accessPointId])); return at[ue.caregiver] === 'home-wifi' && at[ue.resident] === 'home-wifi' ? at : null; }, 20000, 'caregiver co-located').catch(() => null);
  check('caregiver-and-resident-share-home-wifi-on-mep1-mec013', true, Boolean(visit), { accessPoints: visit });
  await delay(stepMs * 2);
  chapter('16:00', 'Caregiver leaves');
  for (const point of [...caregiverPath].reverse().slice(1)) { await moveUe(ue.caregiver, point); await delay(Math.round(stepMs / 2)); }

  // ---- 16:30 the walk. Pre-placement when the resident attaches to a cell that borders another MEP.
  const borderCells = {};
  for (const poa of Object.values(topology.poas)) {
    if (!poa.cellId) continue;
    const ownMep = topology.amsCoverage[poa.zone];
    for (const other of Object.values(topology.poas)) if (topology.amsCoverage[other.zone] && topology.amsCoverage[other.zone] !== ownMep && metersBetween([poa.lon, poa.lat], [other.lon, other.lat]) < poa.radiusM + other.radiusM) (borderCells[poa.cellId] ??= new Set()).add(other.zone);
  }
  step('orchestrator', 'BORDER_CELLS', Object.fromEntries(Object.entries(borderCells).map(([cell, zones]) => [cell, [...zones]])));
  let walkIndex = 0;
  const prePlace = async (trigger) => {
    if (preplacement.started) return;
    preplacement.started = true; preplacement.triggerAt = Date.now(); preplacement.trigger = trigger; preplacement.walkIndex = walkIndex;
    const zones = [...(borderCells[trigger.cellId] ?? ['park-district'])];
    const zone = zones.includes('park-district') ? 'park-district' : zones[0];
    preplacement.decision = await orchestrator.decide({ kind: 'pre-placement', zone, trigger: { ...trigger, predictedZones: zones }, ue: approvalHash(ue.resident).slice(0, 16) });
    if (preplacement.decision.selected && !orchestrator.instanceOn(preplacement.decision.selected)) {
      const target = instances[preplacement.decision.selected];
      preplacement.add = await orchestrator.place(preplacement.decision.selected, target);
      streamPodLogs(target, preplacement.decision.selected);
    }
  };
  // Handlers answer the CSE at once; decisions run in the background.
  const background = (label, task) => { task().catch((error) => step('orchestrator', 'DECISION_REVIEW', { label, reason: error.message })); };
  onRnis = async (entry) => { if (entry.servedBy?.mep === 'mep1' && borderCells[entry.trgCellId]) background('pre-placement', () => prePlace({ type: 'RNIS-cell-change-via-oneM2M', cellId: entry.trgCellId, srcCellId: entry.srcCellId })); };
  // Each oneM2M location observation from Edge-A makes the orchestrator look up the serving access point
  // (MEC013 on the serving MEP); a border cell starts the pre-placement on the neighbouring MEP.
  let locating = false;
  onObservation = (entry) => {
    if (preplacement.started || locating || entry.servedBy?.mep !== 'mep1') return;
    locating = true;
    background('pre-placement-watch', async () => {
      try {
        const sighting = await orchestrator.locateUe(ue.resident);
        const cellId = Object.values(topology.poas).find((poa) => poa.name === sighting.accessPointId)?.cellId ?? null;
        if (cellId && borderCells[cellId]) await prePlace({ type: 'oneM2M-observation+MEC013-access-point', cellId, accessPointId: sighting.accessPointId, observationCin: entry.cinRi });
      } finally { locating = false; }
    });
  };
  onLifecycle = async (entry) => {
    if (entry.event === 'READY' && entry.appInstanceId === instances.mep2.id) preplacement.readyAt = entry.arrivedAt;
    if (entry.event === 'AMS_MOBILITY_PROCEDURE' && !relocation.triggerAt && entry.appInstanceId === instances.mep1.id) { relocation.triggerAt = entry.arrivedAt; relocation.trigger = { type: 'MEC021-MobilityProcedureNotification', mobilityStatus: entry.con.mobilityStatus, targetAppInstanceId: entry.con.targetAppInstanceId, observedAt: entry.con.observedAt, writtenAt: entry.at }; background('relocation', relocate); }
  };
  const relocate = async () => {
    if (relocation.started) return;
    relocation.started = true;
    const sighting = await orchestrator.locateUe(ue.resident);
    relocation.decision = await orchestrator.decide({ kind: 'relocation', zone: sighting.zoneId ?? 'park-district', trigger: { ...relocation.trigger, sighting }, ue: sighting.ueRef });
    const target = orchestrator.instanceOn(relocation.decision.selected);
    if (!target) { relocation.review = 'no instance on the selected host'; return; }
    relocation.ownership = await orchestrator.writeOwnership({ owner: target.id, mep: target.mep, decisionId: relocation.decision.decisionId, reason: relocation.trigger.type });
    relocation.decidedAt = Date.now();
  };
  chapter('16:30', 'Resident leaves home and walks down Boulevard de Belgique');
  let holdMs = 0;
  for (let index = 1; index <= PARK_ENTRY; index += 1) {
    if (index === PARK_ENTRY) {
      if (!preplacement.decision) { const sighting = await orchestrator.locateUe(ue.resident); const cell = Object.values(topology.poas).find((poa) => poa.name === sighting.accessPointId)?.cellId; await prePlace({ type: 'MEC013-access-point-fallback', cellId: cell ?? null, accessPointId: sighting.accessPointId }); }
      const holdStart = Date.now();
      await waitFor(() => preplacement.readyAt, 300000, 'mep2 instance READY before park-district');
      holdMs = Date.now() - holdStart;
      if (holdMs > 0) step('runner', 'WALK_HELD_FOR_PREPLACEMENT', { holdMs });
      await delay(3000);
      chapter('16:36', 'Resident enters park-district coverage at the park east gate (Edge-B)');
      relocation.zoneEntryAt = Date.now();
    }
    walkIndex = index;
    step('mec-sandbox', 'UE_MOVED', { ue: ue.resident, index, status: await moveUe(ue.resident, trail[index]) });
    if (index < PARK_ENTRY) await delay(stepMs);
  }
  // The walk goes on while the IPE relocates (real-time order); AMS triggers, MEC013 sighting is the fallback.
  const fallback = setTimeout(async () => { if (!relocation.triggerAt) { relocation.triggerAt = Date.now(); relocation.trigger = { type: 'MEC013-zone-sighting-fallback' }; await relocate().catch((error) => { relocation.review = error.message; }); } }, 25000);
  for (let index = PARK_ENTRY + 1; index <= FORK; index += 1) { await delay(stepMs); step('mec-sandbox', 'UE_MOVED', { ue: ue.resident, index, status: await moveUe(ue.resident, trail[index]) }); }
  await waitFor(() => relocation.decidedAt, 60000, 'relocation decision'); clearTimeout(fallback);
  await waitFor(() => lifecycle.find((item) => item.event === 'RESUMED' && item.mep === 'mep2' && item.epoch === 2), 60000, 'mep2 resumed');
  await waitFor(() => lifecycle.find((item) => item.event === 'DRAINED' && item.mep === 'mep1'), 30000, 'mep1 drained');
  await waitFor(() => observations.some((item) => item.servedBy?.mep === 'mep2' && item.requestId === requestIds.periodic), 60000, 'first periodic observation from mep2');

  // ---- 17:10 dusk: stop at the fork. The mep1 instance is removed (MEC011 graceful termination).
  chapter('17:10', 'At dusk the resident stops at the fork of the trail');
  await fetchPodLogs(instances.mep1, 'mep1');
  termination.requestedAt = Date.now();
  termination.remove = await orchestrator.remove(instances.mep1.name, { gracePeriod: 30 });
  const forkStopStart = Date.now();
  await waitFor(() => lifecycle.find((item) => item.event === 'TERMINATED' && item.mep === 'mep1'), 45000, 'mep1 TERMINATED').catch(() => null);
  await fetchPodLogs(instances.mep1, 'mep1');
  termination.goneAt = await waitFor(async () => !(await orchestrator.refresh()).ipeProcesses.some((item) => item.mep === 'mep1') && Date.now(), 90000, 'mep1 instance removed from scenario').catch(() => null);
  await delay(Math.max(0, 10000 - (Date.now() - forkStopStart)));
  // MEC013 on Edge-B reports the stop at the fork (position within 15 m); the serving POA is recorded as seen
  // (the GIS engine keeps a UE on its current POA of the same technology while it stays in range).
  const forkUser = (await sandbox('GET', `/mep2/location/v3/queries/users?address=${ue.resident}`)).data?.userList?.user?.[0];
  const forkPoint = [forkUser?.locationInfo?.longitude?.[0], forkUser?.locationInfo?.latitude?.[0]];
  const forkDistanceM = Number.isFinite(forkPoint[0]) ? Math.round(metersBetween(forkPoint, trail[FORK]) * 10) / 10 : null;
  check('fork-stop-seen-by-mep2-mec013', { zoneId: 'park-district', withinFifteenMetres: true }, { zoneId: forkUser?.zoneId ?? null, withinFifteenMetres: forkDistanceM !== null && forkDistanceM <= 15 }, { accessPointId: forkUser?.accessPointId ?? null, distanceM: forkDistanceM });
  story.at(-1).servingPoa = forkUser?.accessPointId ?? null;

  // ---- 17:20 the guardian hurries from the office; 17:25 the resident reaches the bench.
  chapter('17:20', 'Guardian leaves the Fontvieille office for the park bench');
  for (const point of guardianPath.slice(1)) { await moveUe(ue.guardian, point); await delay(Math.round(stepMs / 2)); }
  chapter('17:25', 'Resident walks on to the bench; guardian arrives');
  for (let index = FORK + 1; index <= BENCH; index += 1) { step('mec-sandbox', 'UE_MOVED', { ue: ue.resident, index, status: await moveUe(ue.resident, trail[index]) }); await delay(stepMs); }
  await delay(3000);
  const meeting = await waitFor(async () => { const users = (await sandbox('GET', '/mep2/location/v3/queries/users')).data?.userList?.user ?? []; const at = Object.fromEntries(users.map((user) => [user.address, user.accessPointId])); return at[ue.resident] === 'park-5g-bench' && at[ue.guardian] === 'park-5g-bench' ? at : null; }, 20000, 'meeting at the bench').catch(() => null);
  check('guardian-meets-resident-at-bench-on-mep2-mec013', true, Boolean(meeting), { accessPoints: meeting });
  await delay(4000);

  // ---- Evidence: oneM2M geo-query over the park, relocation metrics.
  const geo = await app.retrieve('/Mobius', { fu: 1, ty: 3, gmty: 3, gsf: 1, geom: [parkArea] });
  check('onem2m-geo-query-park-finds-resident-location-container', true, (geo.payload?.['m2m:uril'] ?? []).some((uri) => uri.includes(`${ids.deviceAe}/location`)), { uril: geo.payload?.['m2m:uril'] ?? [] });
  const lastA = observations.filter((item) => item.servedBy?.mep === 'mep1').at(-1); const firstB = observations.find((item) => item.servedBy?.mep === 'mep2');
  const periodic = observations.filter((item) => item.requestId === requestIds.periodic);
  const lastAPeriodic = periodic.filter((item) => item.servedBy?.mep === 'mep1').at(-1); const firstBPeriodic = periodic.find((item) => item.servedBy?.mep === 'mep2');
  const servedSequence = observations.map((item) => item.servedBy?.mep);
  const cutover = servedSequence.indexOf('mep2');
  const interleaved = cutover >= 0 && servedSequence.slice(cutover).some((mep) => mep !== 'mep2');
  const dupKeys = new Map(); for (const item of observations) { const key = `${item.requestId}|${item.observedAt}`; dupKeys.set(key, (dupKeys.get(key) ?? 0) + 1); }
  const duplicates = [...dupKeys.values()].filter((count) => count > 1).length;
  const sortedPeriodic = [...periodic].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const gaps = sortedPeriodic.slice(1).map((item, index) => ({ from: sortedPeriodic[index].servedBy?.mep, to: item.servedBy?.mep, ms: Date.parse(item.observedAt) - Date.parse(sortedPeriodic[index].observedAt) }));
  // The sandbox loc-serv reports on its own tick; the period is measured from same-instance intervals.
  const sameInstance = gaps.filter((gap) => gap.from === gap.to).map((gap) => gap.ms).sort((a, b) => a - b);
  const periodMs = sameInstance.length ? sameInstance[Math.floor(sameInstance.length / 2)] : 2000;
  const missedPeriods = gaps.reduce((sum, gap) => sum + Math.max(0, Math.round(gap.ms / periodMs) - 1), 0);
  const walkMeters = (from, to) => { let sum = 0; for (let index = from + 1; index <= to; index += 1) sum += metersBetween(trail[index - 1], trail[index]); return sum; };
  const realLeadMs = Number.isInteger(preplacement.walkIndex) ? Math.round((walkMeters(preplacement.walkIndex, PARK_ENTRY) / 0.9) * 1000) : null;
  const handoverGap = gaps.find((gap) => gap.from === 'mep1' && gap.to === 'mep2') ?? null;
  const ownerB = lifecycle.find((item) => item.event === 'OWNER' && item.mep === 'mep2'); const resumedB = lifecycle.find((item) => item.event === 'RESUMED' && item.mep === 'mep2'); const drainedA = lifecycle.find((item) => item.event === 'DRAINED' && item.mep === 'mep1');
  const readyB = lifecycle.find((item) => item.event === 'READY' && item.mep === 'mep2'); const terminatedA = lifecycle.find((item) => item.event === 'TERMINATED' && item.mep === 'mep1'); const terminatingA = lifecycle.find((item) => item.event === 'TERMINATING' && item.mep === 'mep1');
  const podB = podInfo(instances.mep2.id);
  const fenced = trace.filter((item) => item.step === 'MEC_OBSERVATION_FENCED').length;
  const metrics = {
    preplacement: { trigger: preplacement.trigger ?? null, decisionEvaluationMs: preplacement.decision?.evaluationMs ?? null, addRequestedAt: preplacement.add?.requestedAt ?? null, readyAfterAddMs: preplacement.readyAt && preplacement.add ? preplacement.readyAt - Date.parse(preplacement.add.requestedAt) : null, pod: podB ? { createdAt: podB.createdAt, scheduledAt: podB.scheduledAt, readyAt: podB.readyAt, podReadyAfterAddMs: podB.readyAt && preplacement.add ? Date.parse(podB.readyAt) - Date.parse(preplacement.add.requestedAt) : null } : null, walkHoldMs: holdMs, walkIndexAtTrigger: preplacement.walkIndex ?? null, realWalkLeadToParkMsAt0_9mps: realLeadMs, readyB: readyB?.con ? { confirmReady: readyB.con.confirmReady, mecService: readyB.con.mecService, ams: readyB.con.ams, amsSubscription: readyB.con.amsSubscription } : null },
    relocation: { trigger: relocation.trigger ?? null, zoneEntryToTriggerMs: relocation.triggerAt && relocation.zoneEntryAt ? relocation.triggerAt - relocation.zoneEntryAt : null, decisionMs: relocation.decidedAt && relocation.triggerAt ? relocation.decidedAt - relocation.triggerAt : null, eligibilityEvaluationMs: relocation.decision?.evaluationMs ?? null, ownershipEpoch: relocation.ownership?.epoch ?? null, decisionToOwnerMs: ownerB && relocation.decidedAt ? ownerB.arrivedAt - relocation.decidedAt : null, decisionToResumedMs: resumedB && relocation.decidedAt ? resumedB.arrivedAt - relocation.decidedAt : null, resumeMsInPod: resumedB?.con?.resumeMs ?? null, resumedRequests: resumedB?.con?.requests ?? [], drainMsInPod: drainedA?.con?.drainMs ?? null, drainedRequests: drainedA?.con?.requests ?? [], decisionToFirstMep2ObservationMs: firstB && relocation.decidedAt ? firstB.arrivedAt - relocation.decidedAt : null, zoneEntryToFirstMep2ObservationMs: firstB && relocation.zoneEntryAt ? firstB.arrivedAt - relocation.zoneEntryAt : null },
    observationGap: { lastMep1Observation: lastA ? { observedAt: lastA.observedAt, arrivedAtMs: lastA.arrivedAt - t0 } : null, firstMep2Observation: firstB ? { observedAt: firstB.observedAt, arrivedAtMs: firstB.arrivedAt - t0 } : null, arrivalGapMs: lastA && firstB ? firstB.arrivedAt - lastA.arrivedAt : null, periodicHandoverGapMs: handoverGap?.ms ?? null, periodicSourceGapMs: lastAPeriodic && firstBPeriodic ? Date.parse(firstBPeriodic.observedAt) - Date.parse(lastAPeriodic.observedAt) : null, requestedPeriodSec: 2, measuredPeriodMs: periodMs, missedPeriodicReports: missedPeriods, periodicReports: periodic.length },
    notifications: { observations: observations.length, byMep: { mep1: observations.filter((item) => item.servedBy?.mep === 'mep1').length, mep2: observations.filter((item) => item.servedBy?.mep === 'mep2').length }, duplicates, interleavedAfterCutover: interleaved, fencedInPods: fenced, amsMobilityNotifications: lifecycle.filter((item) => item.event === 'AMS_MOBILITY_PROCEDURE').length, amsNotificationsAfterTransfer: lifecycle.filter((item) => item.event === 'AMS_MOBILITY_PROCEDURE' && drainedA && item.arrivedAt > drainedA.arrivedAt).length, rnisCellChanges: rnisSeen.map((item) => `${item.srcCellId}->${item.trgCellId}@${item.servedBy?.mep ?? '?'}`) },
    termination: { requestedAt: termination.remove?.requestedAt ?? null, gracePeriodSec: 30, terminatingAfterRemoveMs: terminatingA ? terminatingA.arrivedAt - termination.requestedAt : null, terminatedAfterRemoveMs: terminatedA ? terminatedA.arrivedAt - termination.requestedAt : null, confirm: terminatedA?.con ? { confirmTermination: terminatedA.con.confirmTermination, serviceDelete: terminatedA.con.serviceDelete ?? null, amsDelete: terminatedA.con.amsDelete ?? null, amsSubscriptionDelete: terminatedA.con.amsSubscriptionDelete ?? null } : null, nodeRemovedAfterRemoveMs: termination.goneAt ? termination.goneAt - termination.requestedAt : null },
  };
  step('runner', 'METRICS', metrics);
  check('preplacement-selects-mep2-and-mep1-not-eligible-for-park', { selected: 'mep2', mep1Eligible: false }, { selected: preplacement.decision?.selected ?? null, mep1Eligible: preplacement.decision?.candidates.find((item) => item.mep === 'mep1')?.eligible ?? null });
  check('mep2-instance-mec011-ready-and-ams-registered', { confirmReady: 204, service: 201, ams: 201 }, { confirmReady: readyB?.con?.confirmReady?.status ?? null, service: readyB?.con?.mecService?.httpStatus ?? null, ams: readyB?.con?.ams?.httpStatus ?? null });
  check('relocation-triggered-by-mec021-ams', 'MEC021-MobilityProcedureNotification', relocation.trigger?.type ?? null, { trigger: relocation.trigger });
  check('relocation-decision-selects-mep2', 'mep2', relocation.decision?.selected ?? null);
  check('ownership-epoch-2-mep2', 2, relocation.ownership?.epoch ?? null);
  check('mep2-resumed-all-requests-on-its-mec013-mec012', ['ACTIVE', 'ACTIVE', 'ACTIVE'], (resumedB?.con?.requests ?? []).map((item) => item.state));
  check('mep1-drained-its-mec-subscriptions', [204, 204, 204], (drainedA?.con?.requests ?? []).map((item) => item.providerStatus));
  check('observations-cut-over-once-without-interleaving', false, interleaved);
  check('no-duplicate-observations-across-instances', 0, duplicates);
  check('same-onem2m-container-before-and-after', true, observations.some((item) => item.servedBy?.mep === 'mep1') && observations.some((item) => item.servedBy?.mep === 'mep2'));
  check('mep1-instance-terminated-via-mec011-and-removed', { confirmTermination: 204, removed: true }, { confirmTermination: terminatedA?.con?.confirmTermination ?? null, removed: Boolean(termination.goneAt) });

  // ---- Wrap-up: guardian ends the requests on Edge-B, the declared placement (mep1) is restored.
  for (const [service, requestId] of [['RNIS', requestIds.rnis], ['Location', requestIds.periodic], ['Location', requestIds.tracking]]) await app.create(`${ipePath}/${service === 'Location' ? 'locationRequests' : 'rnisRequests'}`, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'unsubscribe', requestId }, cr: null } });
  await waitFor(() => Object.values(requestIds).every((id) => statuses.some((item) => item.requestId === id && item.state === 'DELETED' && item.servedBy?.mep === 'mep2')), 30000, 'requests deleted on mep2').catch(() => null);
  const deletedOnB = statuses.filter((item) => item.state === 'DELETED' && item.servedBy?.mep === 'mep2').map((item) => item.providerStatus);
  check('unsubscribe-deletes-mep2-subscriptions', [204, 204, 204], deletedOnB);
  await fetchPodLogs(instances.mep2, 'mep2');
  const reverse = await orchestrator.remove(instances.mep2.name, { gracePeriod: 20 });
  await waitFor(() => lifecycle.find((item) => item.event === 'TERMINATED' && item.mep === 'mep2'), 40000, 'mep2 TERMINATED').catch(() => null);
  await fetchPodLogs(instances.mep2, 'mep2');
  for (const stream of sshStreams) stream.kill();
  await waitFor(async () => !(await orchestrator.refresh()).ipeProcesses.some((item) => item.mep === 'mep2') && Date.now(), 90000, 'mep2 removed').catch(() => null);
  const restored = await orchestrator.place('mep1', instances.mep1);
  step('runner', 'DECLARED_PLACEMENT_RESTORED', { remove: reverse, add: restored });

  // ---- Receipt and trace.
  const traceFile = join(evidenceDir, 'mec-day-of-care-trace.jsonl');
  const shorten = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value.slice(0, 16) : value;
  const redact = (value) => JSON.parse(JSON.stringify(value).replace(/\/(mec|mec011|ams|onem2m)\/(Location\/|RNIS\/)?[A-Za-z0-9_-]{43}/g, '/$1/$2<route-token>'));
  const shortTrace = trace.filter((item) => item.step !== 'CHECK').map(({ seq, tMs, actor, step: name, ...rest }) => ({ seq, tMs, actor, step: name, ...Object.fromEntries(Object.entries(rest).filter(([key]) => !['catalogHash'].includes(key)).map(([key, value]) => [key, shorten(value)])) }));
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(traceFile, `${shortTrace.map((item) => JSON.stringify(redact(item))).join('\n')}\n`);
  const cseVersion = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version;
  const decisions = orchestrator.decisions.map((record) => ({ ...record, candidates: record.candidates.map(({ mep, edge, hostZone, servesZone, amsPreferred, mecApis, liveApis, mec011Status, capacity, used, free, capacityOk, eligible, reasons }) => ({ mep, edge, hostZone, servesZone, amsPreferred, mecApis, liveApis, mec011Status, capacity, used, free, capacityOk, eligible, reasons })) }));
  const receipt = {
    status: checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(), docRevision: '2.0.0', rubricIds: ['R13'],
    simulation: { mec: false, ue: 'sandbox-scenario', cse: false, hardware: false },
    hosts: [
      { host: 'pc', address: publicHost, os: 'Windows 11', roles: ['Mobius4 CSE /pb-cse (HTTPS 17599 on the LAN with the lab CA, loopback HTTP for local AEs)', 'PostgreSQL + PostGIS', 'orchestrator AE Cpb-orchestrator', 'guardian app AE Cguardian-app', 'story driver'] },
      { host: 'vm mec-sandbox', address: new URL(mecBase).hostname, os: 'Ubuntu 22.04 (single-node kubeadm)', roles: ['ETSI MEC Sandbox STF_685', `sandbox ${sandboxName}`, 'MEP mep1 (Edge-A) and mep2 (Edge-B): MEC011, MEC012, MEC013, MEC021', 'oneM2M MEC IPE pods (image pb-onem2m-ipe)'] },
    ],
    scenario: { name: active.name, yaml: 'deploy/mec-sandbox/scenarios/day-of-care.yaml', yamlSHA256, activeScenarioHash: activeHash.slice(0, 16), zones: Object.keys(topology.zones), poas: Object.values(topology.poas).map(({ name, type, zone, cellId, radiusM }) => ({ name, type, zone, cellId, radiusM })), amsCoverage: topology.amsCoverage, ues: Object.values(ue) },
    sandbox: { name: sandboxName, host: new URL(mecBase).host, implementation: 'ETSI MEC Sandbox STF_685 (local kubeadm install)', caSHA256: await sha256File(caFile) },
    meps: topology.hosts.map(({ mep, zone, edge, capacity, mecApis, locality }) => ({ mep, zone, edge, capacity, mecApis, locality })),
    ipe: { image: 'meep-docker-registry:30001/pb-onem2m-ipe', imageDigest: env.PB_IPE_IMAGE_DIGEST ?? podB?.image ?? null, ae: ipePath, originator: ids.ipe, instances: { mep1: { name: instances.mep1.name, appInstanceId: instances.mep1.id, nodePort: instances.mep1.nodePort, placement: 'declared in the scenario' }, mep2: { name: instances.mep2.name, appInstanceId: instances.mep2.id, nodePort: instances.mep2.nodePort, placement: 'SCENARIO-UPDATE ADD by the orchestrator', pod: podB } } },
    cse: { implementation: 'Mobius4', version: cseVersion, sourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout.trim() || null, cseId: '/pb-cse', postgres: (await pool.query('SELECT version()')).rows[0].version.split(',')[0] },
    storyTimeline: story, decisions, metrics,
    requests: requestIds,
    checks, caseCount: checks.length, passed: checks.filter((item) => item.status === 'PASS').length, failed: checks.filter((item) => item.status !== 'PASS').length,
    artifacts: { trace: 'docs/verification-evidence/2026-11-20/mec-day-of-care-trace.jsonl', traceSHA256: await sha256File(traceFile), traceEntries: shortTrace.length, podLogs: useSsh ? 'kubectl logs of each IPE pod streamed over SSH into the trace (actor ipe@mepN)' : 'not collected', runtimeDirectory: `.local/mec-day-of-care/${stamp}` },
    runnerSHA256: await sha256File(fileURLToPath(import.meta.url)),
    notes: 'MEC side is the ETSI MEC Sandbox (STF_685) on a separate VM; UE movement is driven through the sandbox GIS engine with MOBILITY automation, so POA, zone, cell and MEC021 mobility events come from the sandbox. The IPE instances are real pods placed by the sandbox virt-engine; oneM2M side is an actual Mobius4 process with PostgreSQL/PostGIS on the PC. Story time is compressed; the walk waits for the pre-placed instance before park-district.',
  };
  await writeFile(join(evidenceDir, 'mec-day-of-care.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(join(directory, 'full-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  console.log(JSON.stringify({ status: receipt.status, cases: receipt.caseCount, passed: receipt.passed, failed: receipt.failed, metrics, failures: checks.filter((item) => item.status !== 'PASS') }, null, 2));
  if (receipt.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  runtimeError = error; console.error(sanitized(error.stack)); console.error(JSON.stringify(checks.filter((item) => item.status !== 'PASS'), null, 2)); process.exitCode = 1;
} finally {
  // Back to the start positions; MOBILITY stays on long enough to re-align the POAs before it is restored.
  if (tookControl) try { for (const [name, point] of [[ue.resident, trail[0]], [ue.caregiver, caregiverPath[0]], [ue.guardian, guardianPath[0]]]) await moveUe(name, point); await delay(4000); } catch { /* best effort */ }
  try { if (mobilityWasActive === false) await sandbox('POST', '/gis/v1/automation/MOBILITY?run=false'); } catch { /* best effort */ }
  if (runtimeError && orchestrator && tookControl) {
    // Leave the declared placement (mep1 only) for the next run.
    try { const topo = await orchestrator.refresh(); if (topo.ipeProcesses.some((item) => item.mep === 'mep2')) await orchestrator.remove(instances.mep2.name, { gracePeriod: 5 }); if (!topo.ipeProcesses.some((item) => item.mep === 'mep1')) await orchestrator.place('mep1', instances.mep1); } catch { /* best effort */ }
  }
  for (const stream of sshStreams) stream.kill();
  for (const server of servers) { server.closeAllConnections?.(); await new Promise((done) => server.close(done)); }
  for (const child of children) if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), delay(5000)]); }
  for (const database of databases) { try { await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); } catch (error) { console.error(`drop ${database}: ${sanitized(error.message)}`); } }
  await pool.end();
  if (runtimeError) await writeFile(join(directory, 'failure-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
}
export { evaluateEligibility };
