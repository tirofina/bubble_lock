// R12 automated CSE handover on two real Mobius4 processes.
// Triggers come from events only: MEC Location zone reports, CSE base probe failures after a real process kill,
// and measured probe RTT/load scores. The script never calls coordinator.handover() for a move.
import { cp, mkdir, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as netServer, connect as netConnect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.argv[2] === '--latency-proxy') await runLatencyProxy();
else await main();

/** loopback TCP proxy. 방향마다 같은 지연을 더하고 순서를 유지한다. IPC {type:'delay', delayMs}로 지연을 바꾼다. */
async function runLatencyProxy() {
  const targetPort = Number(process.argv[3]); let delayMs = Number(process.argv[4] ?? 0);
  process.on('message', (message) => { if (message?.type === 'delay' && Number.isFinite(message.delayMs)) delayMs = message.delayMs; });
  process.on('disconnect', () => process.exit(0));
  const server = netServer((client) => {
    client.setNoDelay(true);
    const upstream = netConnect({ port: targetPort, host: '127.0.0.1' }); upstream.setNoDelay(true);
    const relay = (from, to) => {
      let releaseAt = 0;
      const schedule = (action) => { const at = Math.max(Date.now() + delayMs, releaseAt); releaseAt = at; const wait = at - Date.now(); if (wait <= 0 && delayMs === 0) action(); else setTimeout(action, Math.max(0, wait)); };
      from.on('data', (chunk) => schedule(() => { if (!to.destroyed) to.write(chunk); }));
      from.on('end', () => schedule(() => { if (!to.destroyed) to.end(); }));
    };
    relay(client, upstream); relay(upstream, client);
    const destroy = () => { client.destroy(); upstream.destroy(); };
    client.on('error', destroy); upstream.on('error', destroy); client.on('close', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.send({ type: 'listening', port: server.address().port });
}

async function main() {
  const pg = (await import('pg')).default;
  const { IntegrationStore } = await import('../integration/src/integration-store.mjs');
  const { PolicyService } = await import('../integration/src/policy-service.mjs');
  const { HandoverCoordinator } = await import('../integration/src/handover-coordinator.mjs');
  const { HandoverAutomation, ObservationForwarder } = await import('../integration/src/handover-automation.mjs');
  const { MecPolicyReconciler } = await import('../integration/src/mec-adapter.mjs');
  const { GatewayBridge } = await import('../src/gateway-bridge.mjs');
  const { encodeBinarySwitch } = await import('../src/sdt-adapter.mjs');

  /** 실행 전용 in-memory store. transaction마다 collection을 얕게 복사하고 row는 put에서 새 객체로 교체한다. */
  class SharedRowStore extends IntegrationStore {
    async transaction(lockKey, operation) {
      if (typeof lockKey === 'function') { operation = lockKey; lockKey = 'runtime'; }
      if (this.transactionContext.getStore()) return operation();
      const result = this.transactionQueue.then(async () => {
        await this.init();
        const data = Object.fromEntries(Object.entries(this.data).map(([name, value]) => [name, Array.isArray(value) ? [...value] : { ...value }]));
        const context = { lockKey, data, receipts: [] };
        return this.transactionContext.run(context, async () => { const value = await operation(); this.data = context.data; return value; });
      });
      this.transactionQueue = result.catch(() => {});
      return result;
    }
  }

  const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index > 0 ? Number(process.argv[index + 1]) : fallback; };
  const rounds = argument('--rounds', 5); const rateMs = argument('--rate-ms', 50);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const upstream = resolve(process.env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
  const runId = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const directory = join(root, '.local', 'handover-auto-cse', runId);
  const source = join(root, '.local', 'handover-auto-cse', 'source');
  await mkdir(directory, { recursive: true });
  await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
  try { await lstat(join(source, 'node_modules')); } catch { await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction'); }
  const prepared = spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (prepared.status !== 0) throw new Error('실제 CSE canonical registry 생성을 확인하세요.');
  const preload = join(directory, 'loopback-only.cjs');
  await writeFile(preload, "const net = require('node:net'); const original = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1,0,'127.0.0.1'); return original.apply(this,args); };\n");
  const connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8'));
  const pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database });
  const secrets = [connection.password]; const databases = []; const proxies = {}; const cses = {};
  const sanitized = (value) => { let text = String(value); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[secret]'); return text; };
  const freePort = async () => { const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise((done) => probe.close(done)); return port; };
  const t0 = performance.now(); const now = () => performance.now() - t0;
  const log = []; const record = (event) => { log.push({ at: event.at ?? now(), ...event }); };
  const loopDelay = monitorEventLoopDelay({ resolution: 1 }); loopDelay.enable();
  const timers = []; let callback; let automation; let forwarder; let status = 'REVIEW'; let failure = null;

  const baseDelayMs = { 'edge-a': 0, 'edge-b': 8 }; const injectedDelayMs = 40;
  const triggerPolicy = { minResidenceMs: 1500, cooldownMs: 1500, zoneDwellMs: 500, minInsideM: 20, continuityGapMs: 1000, healthFailures: 3, healthFailureSpacingMs: 1000, availabilityFailures: 3, availabilityFailureSpacingMs: 0, performanceDwellMs: 600, minScoreGain: 0.15, latencyBudgetMs: 50, latencyWeight: 1, latencyAlpha: 0.3, probeFailuresForDown: 3 };
  const intervals = { probeMs: 100, evaluateMs: 200, checkpointMs: 500, locationReportMs: 250, producerMs: rateMs };
  const zones = [
    { zoneId: 'home', geofence: { type: 'circle', lat: 37.5, lon: 127, radiusM: 120 } },
    { zoneId: 'street', geofence: { type: 'circle', lat: 37.503, lon: 127, radiusM: 150 } },
    { zoneId: 'outside', geofence: { type: 'circle', lat: 37.507, lon: 127, radiusM: 200 } },
  ];
  const edgeZones = { 'edge-a': ['home', 'street'], 'edge-b': ['street', 'outside'] };
  const ueId = 'keyring-auto-fixture';

  async function startCse(label) {
    const edgeId = `edge-${label}`; const state = cses[edgeId];
    let diagnostic = '';
    const child = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(state.config) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    child.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-32000); }); child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-32000); });
    await new Promise((resolveReady, reject) => { const timeout = setTimeout(() => reject(new Error(`CSE 시작 대기: ${sanitized(diagnostic)}`)), 30000); child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`CSE 시작 종료 ${code}: ${sanitized(diagnostic)}`)); }); child.on('message', (message) => { if (message === 'ready') { clearTimeout(timeout); resolveReady(); } }); });
    child.removeAllListeners('exit'); state.child = child; state.starts++;
    record({ type: 'cse-started', edgeId, pid: child.pid, start: state.starts });
  }
  async function killCse(label) {
    const edgeId = `edge-${label}`; const child = cses[edgeId].child;
    const exited = once(child, 'exit'); child.kill(); await exited;
    record({ type: 'cse-killed', edgeId, pid: child.pid, signal: 'TerminateProcess' });
  }
  async function startProxy(edgeId, targetPort) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--latency-proxy', String(targetPort), String(baseDelayMs[edgeId])], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    const [message] = await once(child, 'message');
    proxies[edgeId] = { child, port: message.port, delayMs: baseDelayMs[edgeId] };
  }
  function setDelay(edgeId, delayMs) { proxies[edgeId].child.send({ type: 'delay', delayMs }); proxies[edgeId].delayMs = delayMs; record({ type: 'latency-injection', edgeId, oneWayDelayMs: delayMs }); }
  async function waitFor(predicate, timeoutMs, label) {
    const until = performance.now() + timeoutMs;
    while (performance.now() < until) { if (predicate()) return true; await sleep(20); }
    throw new Error(`대기 시간 초과: ${label}`);
  }

  try {
    // 1. Mobius4 CSE 두 개(PostgreSQL DB 분리)와 각 CSE 앞의 지연 proxy
    for (const label of ['a', 'b']) {
      const database = `bubble_hoauto_${runId}_${label}`; databases.push(database);
      await pool.query(`CREATE DATABASE "${database}"`);
      const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database });
      await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
      const port = await freePort(); const admin = `S${randomBytes(11).toString('hex')}`; secrets.push(admin);
      const edgeId = `edge-${label}`;
      const config = { http: { port }, https: { enabled: false }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database }, cse: { admin, cse_id: `/${edgeId}`, csebase_rn: 'Mobius', cse_type: 1, subscription_verification: true, notification_timeout_seconds: 1, poa: [`http://127.0.0.1:${port}`] }, mqtt: { enabled: false }, logging: { level: 'error', file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
      cses[edgeId] = { config, port, admin, starts: 0, child: null };
      await startCse(label); await startProxy(edgeId, port);
    }

    // 2. coordinator, 정책, MEC reconciler, 자동 이동 controller
    const store = await new SharedRowStore(null).init();
    const policyService = new PolicyService({ store });
    const coordinator = new HandoverCoordinator({ store, policyService, drainBudgetMs: 100, attemptBudgetMs: 10000, triggerPolicy });
    coordinator.onEvent((event) => record(event));
    const notifications = []; const appSeen = new Set(); const app = { raw: 0, delivered: 0, duplicatesSuppressed: 0, verificationRequests: 0 };
    callback = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const signal = JSON.parse(Buffer.concat(chunks).toString())['m2m:sgn']; const url = new URL(req.url, 'http://loopback'); const edgeId = url.pathname.slice(1);
        const rawSur = signal.sur ?? url.searchParams.get('subscription'); const sur = rawSur.startsWith('Mobius/') ? `/${rawSur}` : rawSur.slice(rawSur.indexOf('/Mobius'));
        if (sur !== url.searchParams.get('subscription') || req.headers['x-m2m-origin'] !== `/${edgeId}`) throw new Error('CSE callback binding');
        if (signal.vrq || !store.get('handoverNotifications', `${edgeId}:${sur}`)?.verified) await coordinator.notification({ edgeId, subscriptionUri: sur, verified: true });
        if (signal.vrq) app.verificationRequests++;
        else {
          const kind = sur.endsWith('/obs-sub') ? 'obs' : 'state'; const cin = signal.nev?.rep?.['m2m:cin'];
          const sequence = kind === 'obs' && typeof cin?.rn === 'string' && /^obs-\d+$/.test(cin.rn) ? Number(cin.rn.slice(4)) : null;
          notifications.push({ at: now(), edgeId, kind, sequence });
          if (kind === 'obs' && sequence !== null) { app.raw++; if (appSeen.has(sequence)) app.duplicatesSuppressed++; else { appSeen.add(sequence); app.delivered++; } }
        }
        res.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': req.headers['x-m2m-ri'] ?? '' }); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    callback.listen(0, '127.0.0.1'); await once(callback, 'listening');
    for (const label of ['a', 'b']) {
      const edgeId = `edge-${label}`; const state = cses[edgeId];
      coordinator.registerEdge({ edgeId, endpoint: `http://127.0.0.1:${proxies[edgeId].port}`, cseId: `/${edgeId}`, cseBase: '/Mobius', originator: state.admin, callbackUrl: `http://127.0.0.1:${callback.address().port}/${edgeId}`, simulation: false, timeoutMs: 1500, zones: edgeZones[edgeId], region: 'loopback' });
    }
    const principal = { principalId: 'handover-auto-verifier', scopes: ['consent:write', 'grant:write', 'policy:approve'] };
    const consent = await policyService.createConsent({ principal, subjectId: 'verification-household', purpose: 'automated two-CSE handover verification', scopes: ['mec:location'], ttlSec: 3600 });
    const grant = await policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['mec:location'], ttlSec: 3600 });
    const zonePolicies = [];
    for (const [zoneId, targetEdgeId] of [['home', 'edge-a'], ['outside', 'edge-b']]) {
      const policy = await policyService.approvePolicy({ principal, idempotencyKey: `auto-zone-${zoneId}-${runId}`, policy: { ueId, grantId: grant.grantId, targetEdgeId, geofence: zones.find((zone) => zone.zoneId === zoneId).geofence, trigger: { kind: 'zone' } } });
      zonePolicies.push({ zoneId, policyId: policy.policyId, policyRevision: policy.revision, targetEdgeId });
    }
    await coordinator.registerManifest(ueId, { aeName: 'handover-auto', requireCallbackVerification: true, resources: [
      { logicalId: 'observations', ty: 3, body: { 'm2m:cnt': { rn: 'observations' } } },
      { logicalId: 'switch', ty: 28, body: encodeBinarySwitch({ rn: 'switch', state: true }, { operation: 'CREATE' }), verifyFields: ['state'] },
    ], groups: [{ logicalId: 'switches', rn: 'switches', memberLogicalIds: ['switch'], memberType: 28 }], subscriptions: [
      { logicalId: 'state', rn: 'state-sub', parentLogicalId: 'switch', events: [1] },
      // net 1은 VERIFY 단계 callback probe(label update)를, net 3은 CIN 생성 알림을 받는다.
      { logicalId: 'obs', rn: 'obs-sub', parentLogicalId: 'observations', events: [1, 3] },
    ] });
    const reconciler = new MecPolicyReconciler({ store, policyService, handoverCoordinator: coordinator });
    automation = new HandoverAutomation({ coordinator, reconciler, ueId, grantId: grant.grantId, zones, zonePolicies, now, locationSimulation: true, onEvent: (event) => { if (event.type !== 'probe') record(event); else if (!event.ok) record(event); } });
    const probeStats = {}; const originalProbe = automation.probeEdge.bind(automation);
    automation.probeEdge = async (edgeId) => { const edge = await originalProbe(edgeId); if (edge) { const stats = probeStats[edgeId] ??= { count: 0, failures: 0, rtt: [] }; stats.count++; if (edge.probeFailures) stats.failures++; else if (Number.isFinite(edge.lastRttMs)) stats.rtt.push(edge.lastRttMs); } return edge; };
    const position = (zoneId) => { const { lat, lon } = zones.find((zone) => zone.zoneId === zoneId).geofence; return { lat, lon, accuracyM: 5 }; };
    let location = position('home');
    const setLocation = (zoneId) => { location = position(zoneId); record({ type: 'location-change', zone: zoneId }); };

    // 3. 초기 배치: 첫 MEC Location 보고가 home zone 정책으로 edge-a 배치를 만든다.
    await automation.onLocation({ location });
    await waitFor(() => coordinator.status(ueId)?.state === 'ACTIVE' && coordinator.status(ueId)?.phase === 'COMPLETE', 15000, 'initial placement');
    if (coordinator.status(ueId).edgeId !== 'edge-a') throw new Error('초기 zone 배치를 확인하세요.');

    // 4. Gateway 경로: GatewayBridge(최신 binarySwitch PUT)와 관측 forwarder(sequence CIN)
    forwarder = new ObservationForwarder({ coordinator, ueId, concurrency: 4, retryMs: 40, holdMs: 10, mirror: true, mirrorConcurrency: 3, now, onEvent: (event) => { if (['observation-applied', 'observation-mirrored'].includes(event.type)) record(event); else if (event.type !== 'retransmission-suppressed') record(event); } }).start();
    const bridgeEdges = new Map();
    const routedFetch = async (url, init) => {
      const edgeId = forwarder.route(); if (!edgeId) throw new Error('ownership transition hold');
      const binding = store.get('logicalBindings', `${ueId}:${edgeId}`); const edge = coordinator.edges.get(edgeId);
      const target = new URL(url); const requestId = init.headers['X-M2M-RI']; bridgeEdges.set(requestId, edgeId);
      return fetch(`${edge.endpoint}${target.pathname}`, { ...init, headers: { ...init.headers, 'X-M2M-Origin': binding.aeId }, signal: AbortSignal.timeout(1500) });
    };
    const mqttStub = { on() {}, subscribe() {}, publish() {} };
    const switchPath = store.get('logicalBindings', `${ueId}:edge-a`).resources.switch.path;
    const bridge = new GatewayBridge({ mqttClient: mqttStub, fetchImpl: routedFetch, baseUrl: 'http://gateway-route.invalid', originator: 'gateway-route', resourcePath: switchPath, gatewayId: 'pi-gateway-sim', sdtProfile: 'r4-common-1.0' });
    const produced = new Map(); let sequence = 0; let retransmissions = 0; const deviceId = ueId;
    const telemetry = (seq) => ({ deviceId, sequence: seq, timestamp: new Date().toISOString(), state: Math.floor(seq / 50) % 2 === 0, batteryPct: 90, rssiDbm: -61, schemaVersion: '1.0.0' });
    const emitTelemetry = (payload) => { forwarder.submit(payload, now()); bridge.handleTelemetry(payload).catch(() => {}); };
    timers.push(setInterval(() => {
      const payload = telemetry(sequence); produced.set(sequence, now()); emitTelemetry(payload); sequence++;
      if (sequence % 37 === 0) { retransmissions++; emitTelemetry(telemetry(sequence - 2)); }
    }, intervals.producerMs));
    timers.push(setInterval(() => { automation.onLocation({ location }).catch((error) => record({ type: 'automation-review', message: error.message })); }, intervals.locationReportMs));
    automation.start({ probeIntervalMs: intervals.probeMs, evaluateIntervalMs: intervals.evaluateMs, checkpointIntervalMs: intervals.checkpointMs });

    // 5. 보안 맥락 검사: 대상 CSE ACP, acpi 복원, 미승인 originator 거부, 출발 CSE의 이전 AE UPDATE 거부
    const rawRequest = async (edgeId, method, path, value, originator) => {
      const rqi = `sec-${randomBytes(6).toString('hex')}`; const edge = coordinator.edges.get(edgeId);
      const response = await fetch(`${edge.endpoint}${path}`, { method, headers: { 'X-M2M-Origin': originator, 'X-M2M-RI': rqi, 'X-M2M-RVI': '4', accept: 'application/json', ...(value ? { 'content-type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}), signal: AbortSignal.timeout(3000) });
      await response.text(); return Number(response.headers.get('X-M2M-RSC'));
    };
    const security = [];
    async function securityCheck(handoverId, targetEdgeId, sourceEdgeId, { sourceAlive = true } = {}) {
      const binding = store.get('logicalBindings', `${ueId}:${targetEdgeId}`); const client = coordinator.clients.get(targetEdgeId);
      const acp = (await client.read(binding.acpPath))['m2m:acp']; const ae = (await client.read(binding.aePath))['m2m:ae']; const sw = (await client.read(binding.resources.switch.path))['cod:binSh'];
      const row = { handoverId, targetEdgeId, sourceEdgeId, acpRestored: acp.pv.acr.some((rule) => rule.acor.includes(binding.aeId) && rule.acop === 63), aeAcpi: Boolean(ae.acpi?.includes(binding.acpRi)), switchAcpi: Boolean(sw.acpi?.includes(binding.acpRi)) };
      row.intruderRsc = await rawRequest(targetEdgeId, 'PUT', binding.resources.switch.path, { 'cod:binSh': { state: true } }, `C${randomBytes(5).toString('hex')}intruder`);
      if (sourceEdgeId && sourceAlive) { const prior = store.get('logicalBindings', `${ueId}:${sourceEdgeId}`); row.staleSourceAeRsc = await rawRequest(sourceEdgeId, 'PUT', prior.resources.switch.path, { 'cod:binSh': { state: true } }, prior.aeId); }
      row.pass = row.acpRestored && row.aeAcpi && row.switchAcpi && row.intruderRsc === 4103 && (row.staleSourceAeRsc === undefined || row.staleSourceAeRsc === 4103);
      security.push(row); return row;
    }

    // 6. 시나리오: 환경 자극만 바꾸고 이동은 트리거가 결정한다.
    const steps = [];
    const settle = async () => { const session = coordinator.status(ueId); const residence = Math.max(triggerPolicy.minResidenceMs, triggerPolicy.cooldownMs) + 250; const elapsed = Date.now() - Date.parse(session.completedAt ?? session.startedAt); if (elapsed < residence) await sleep(residence - elapsed); };
    async function step(label, expectedKind, expectedEdge, stimulus, { securitySourceAlive = true } = {}) {
      await settle();
      const before = coordinator.status(ueId); const stimulusAt = now();
      record({ type: 'stimulus', label, expectedKind });
      await stimulus();
      if (!expectedEdge) { await sleep(700); const after = coordinator.status(ueId); steps.push({ label, expectedKind: null, stimulusAt, handoverId: after.handoverId === before.handoverId ? null : after.handoverId, unexpectedHandover: after.handoverId !== before.handoverId }); return; }
      await waitFor(() => { const session = coordinator.status(ueId); return session.handoverId !== before.handoverId && session.edgeId === expectedEdge && session.state === 'ACTIVE' && session.phase === 'COMPLETE'; }, 30000, label);
      const after = coordinator.status(ueId);
      steps.push({ label, expectedKind, stimulusAt, handoverId: after.handoverId, reason: after.reason, reasonMatches: after.reason === expectedKind, sourceEdgeId: after.previousEdgeId, targetEdgeId: after.edgeId, epoch: after.epoch, trigger: after.trigger, checkpointSource: after.checkpoint?.source, checkpointAgeMs: after.checkpoint?.ageMs, sourceFence: { fenced: Boolean(after.sourceFence?.fenced), deferred: Boolean(after.sourceFence?.deferred) }, sourceCleanup: after.sourceCleanup?.deferred ? 'deferred-to-recovery' : 'released', replay: after.replay, durationMs: after.durationMs });
      await securityCheck(after.handoverId, after.edgeId, after.previousEdgeId, { sourceAlive: securitySourceAlive });
    }
    for (let round = 1; round <= rounds; round++) {
      await step(`r${round} zone home->outside`, 'zone', 'edge-b', () => setLocation('outside'));
      await step(`r${round} zone outside->home`, 'zone', 'edge-a', () => setLocation('home'));
      await step(`r${round} home->street (both edges serve street)`, null, null, () => setLocation('street'));
      await step(`r${round} availability: kill edge-a Mobius4`, 'availability', 'edge-b', () => killCse('a'), { securitySourceAlive: false });
      await sleep(800);
      await step(`r${round} failback after edge-a restart`, 'performance', 'edge-a', async () => {
        await startCse('a');
        await waitFor(() => coordinator.edges.get('edge-a').health === 'HEALTHY', 10000, 'edge-a recovery reconcile');
        const failed = [...security].reverse().find((row) => row.targetEdgeId === 'edge-b' && row.staleSourceAeRsc === undefined);
        if (failed) { const prior = store.get('logicalBindings', `${ueId}:edge-a`); failed.staleSourceAeRscAfterRecovery = await rawRequest('edge-a', 'PUT', prior.resources.switch.path, { 'cod:binSh': { state: true } }, prior.aeId); failed.pass = failed.pass && failed.staleSourceAeRscAfterRecovery === 4103; }
      });
      if (round % 2) {
        await step(`r${round} latency: inject ${injectedDelayMs}ms one-way on edge-a`, 'performance', 'edge-b', () => setDelay('edge-a', injectedDelayMs));
        await step(`r${round} latency cleared on edge-a`, 'performance', 'edge-a', () => setDelay('edge-a', baseDelayMs['edge-a']));
      } else {
        await step(`r${round} load: edge-a agent reports load 0.7`, 'performance', 'edge-b', () => { coordinator.updateHealth('edge-a', { load: 0.7, loadSource: 'simulated-edge-agent-report' }); record({ type: 'load-report', edgeId: 'edge-a', load: 0.7 }); });
        await step(`r${round} load: edge-a agent reports load 0.0`, 'performance', 'edge-a', () => { coordinator.updateHealth('edge-a', { load: 0, loadSource: 'simulated-edge-agent-report' }); record({ type: 'load-report', edgeId: 'edge-a', load: 0 }); });
      }
      await step(`r${round} street->home`, null, null, () => setLocation('home'));
    }

    // 7. 생산 중지, 보관분 전달, 최종 검증
    for (const timer of timers.splice(0)) clearInterval(timer);
    await waitFor(() => forwarder.pending() === 0, 20000, 'forwarder drain');
    automation.stop(); await forwarder.stop(); await sleep(1500);
    const finalSession = coordinator.status(ueId); const finalEdge = finalSession.edgeId;
    const finalBinding = store.get('logicalBindings', `${ueId}:${finalEdge}`); const finalClient = coordinator.clients.get(finalEdge);
    const container = (await finalClient.read(finalBinding.resources.observations.path))['m2m:cnt'];
    const sequences = [...produced.keys()]; const missingOnCse = [];
    for (let index = 0; index < sequences.length; index += 16) {
      await Promise.all(sequences.slice(index, index + 16).map(async (seq) => { const result = await finalClient.request('GET', `${finalBinding.resources.observations.path}/obs-${seq}`); if (result.missing) missingOnCse.push(seq); }));
    }
    const appMissing = sequences.filter((seq) => !appSeen.has(seq));

    // 8. handover별 지표
    const percentile = (values, p) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(1)); };
    const round1 = (value) => Number.isFinite(value) ? Number(value.toFixed(1)) : null;
    const acks = log.filter((event) => event.type === 'observation-applied');
    const prepares = log.filter((event) => event.type === 'handover-prepare');
    const handovers = [];
    for (const [index, prepare] of prepares.entries()) {
      const transitions = log.filter((event) => event.type === 'transition' && event.handoverId === prepare.handoverId);
      const at = (type) => transitions.find((event) => event.receiptType === type)?.at;
      const cutoverAt = at('HANDOVER_CUTOVER_COMMITTED'); const activeAt = at('HANDOVER_ACTIVE'); const releasedAt = at('HANDOVER_SOURCE_RELEASED'); const restoredAt = at('HANDOVER_TARGET_RESTORED');
      const step = steps.find((item) => item.handoverId === prepare.handoverId);
      const row = { index, handoverId: prepare.handoverId, kind: prepare.reason, sourceEdgeId: prepare.sourceEdgeId, targetEdgeId: prepare.targetEdgeId, epoch: prepare.epoch + 1, step: step?.label ?? (prepare.sourceEdgeId ? 'automatic' : 'initial-placement'), sourceUnavailable: prepare.sourceUnavailable, reviews: transitions.filter((event) => event.receiptType === 'HANDOVER_REVIEW' || event.receiptType === 'HANDOVER_DELTA_PENDING').length };
      if (!prepare.sourceEdgeId) { handovers.push({ ...row, initialPlacement: true }); continue; }
      const previousActive = index > 0 ? log.find((event) => event.type === 'transition' && event.handoverId === prepares[index - 1].handoverId && event.receiptType === 'HANDOVER_ACTIVE')?.at ?? 0 : 0;
      const sourceAcks = acks.filter((event) => event.edgeId === prepare.sourceEdgeId && event.at >= previousActive && event.at <= (activeAt ?? Infinity));
      const lastSource = sourceAcks.reduce((best, event) => (!best || event.at > best.at ? event : best), null);
      const lastSourceSeq = Math.max(-1, ...sourceAcks.map((event) => event.sequence));
      const firstTarget = acks.filter((event) => event.edgeId === prepare.targetEdgeId && event.at >= prepare.at && event.sequence > lastSourceSeq).reduce((best, event) => (!best || event.at < best.at ? event : best), null);
      const stimulus = step ? log.find((event) => event.type === 'stimulus' && event.label === step.label) : null;
      const cause = step?.expectedKind === 'availability' ? log.find((event) => event.type === 'cse-killed' && event.at >= (stimulus?.at ?? 0)) : step?.label.includes('restart') ? log.find((event) => event.type === 'edge-reconciled' && event.at >= (stimulus?.at ?? 0)) : stimulus;
      // 데이터 알림만 본다: obs는 CIN 생성(sequence 포함), state는 Gateway binarySwitch 갱신. VERIFY callback probe는 ACTIVE 전에 끝난다.
      const notifyAfter = (kind) => notifications.find((event) => event.kind === kind && (kind !== 'obs' || event.sequence !== null) && event.edgeId === prepare.targetEdgeId && event.at >= (activeAt ?? Infinity));
      const lastNotifySource = [...notifications].reverse().find((event) => event.kind === 'obs' && event.sequence !== null && event.edgeId === prepare.sourceEdgeId && event.at <= (activeAt ?? Infinity) && event.at >= previousActive);
      const firstNotifyTarget = notifications.find((event) => event.kind === 'obs' && event.sequence !== null && event.edgeId === prepare.targetEdgeId && event.sequence > lastSourceSeq && event.at >= prepare.at);
      const delivered = [...forwarder.done.values()].filter((item) => item.producedAt >= (cause?.at ?? prepare.at) - 200 && item.producedAt <= (activeAt ?? prepare.at) + 200);
      handovers.push({ ...row,
        detectionMs: round1(prepare.at - (cause?.at ?? prepare.at)), detectionBasis: step?.expectedKind === 'availability' ? 'process-kill-to-prepare' : step?.label.includes('restart') ? 'recovered-edge-reconciled-to-prepare' : 'stimulus-to-prepare',
        cutoverMs: round1((cutoverAt ?? NaN) - prepare.at), activeMs: round1((activeAt ?? NaN) - prepare.at), releaseMs: round1((releasedAt ?? NaN) - prepare.at), holdWindowMs: round1((activeAt ?? NaN) - (restoredAt ?? NaN)),
        interruptionMs: round1((firstTarget?.at ?? NaN) - (lastSource?.at ?? NaN)), lastSourceSequence: lastSourceSeq, firstTargetSequence: firstTarget?.sequence ?? null, firstTargetVia: firstTarget?.via ?? null,
        replayedToTarget: acks.filter((event) => event.via === 'replay' && event.edgeId === prepare.targetEdgeId && event.handoverId === prepare.handoverId).length,
        maxDeliveryDelayMs: round1(Math.max(0, ...delivered.map((item) => item.deliveredAt - item.producedAt))),
        notificationResumeStateMs: round1((notifyAfter('state')?.at ?? NaN) - (activeAt ?? NaN)), notificationResumeObsMs: round1((notifyAfter('obs')?.at ?? NaN) - (activeAt ?? NaN)),
        notificationGapMs: round1((firstNotifyTarget?.at ?? NaN) - (lastNotifySource?.at ?? NaN)), notificationFromTarget: Boolean(firstNotifyTarget && notifyAfter('obs')),
        callbackVerifiedOnTarget: transitions.some((event) => event.receiptType === 'HANDOVER_ACTIVE'),
        checkpointSource: step?.checkpointSource ?? null, checkpointAgeMs: round1(step?.checkpointAgeMs), sourceFence: step?.sourceFence ?? null, sourceCleanup: step?.sourceCleanup ?? null, triggerDetails: step?.trigger ?? null,
        security: security.find((item) => item.handoverId === prepare.handoverId) ?? null,
      });
    }
    const moves = handovers.filter((row) => !row.initialPlacement);
    const by = (kind) => moves.filter((row) => row.kind === kind);
    const stats = (values) => ({ n: values.filter(Number.isFinite).length, p50: percentile(values.filter(Number.isFinite), 0.5), p95: percentile(values.filter(Number.isFinite), 0.95), max: round1(Math.max(...values.filter(Number.isFinite))) });
    const bridgeReceipts = bridge.getReceiptSnapshot().receipts; const bridgeByEdge = {};
    for (const receipt of bridgeReceipts) { const edgeId = ['DUPLICATE', 'IN_FLIGHT'].includes(receipt.status) ? 'gateway-dedup' : bridgeEdges.get(receipt.requestId) ?? 'cutover-hold'; const key = `${edgeId}:${receipt.status}`; bridgeByEdge[key] = (bridgeByEdge[key] ?? 0) + 1; }
    const lost = missingOnCse.length; const cseDuplicates = Math.max(0, (container.cni ?? 0) - (sequences.length - lost));
    const summary = {
      handovers: moves.length, initialPlacements: handovers.length - moves.length, byKind: Object.fromEntries(['zone', 'availability', 'performance'].map((kind) => [kind, by(kind).length])),
      stepsMatchingExpectedKind: steps.filter((item) => item.expectedKind).every((item) => item.reasonMatches), unexpectedHandovers: steps.filter((item) => item.unexpectedHandover).length,
      reviewsDuringRun: moves.reduce((sum, row) => sum + row.reviews, 0),
      interruptionMs: stats(moves.map((row) => row.interruptionMs)), interruptionMsByKind: Object.fromEntries(['zone', 'availability', 'performance'].map((kind) => [kind, stats(by(kind).map((row) => row.interruptionMs))])),
      detectionMsByKind: Object.fromEntries(['zone', 'availability', 'performance'].map((kind) => [kind, stats(by(kind).map((row) => row.detectionMs))])),
      cutoverMs: stats(moves.map((row) => row.cutoverMs)), activeMs: stats(moves.map((row) => row.activeMs)), maxDeliveryDelayMs: stats(moves.map((row) => row.maxDeliveryDelayMs)),
      notificationResumeObsMs: stats(moves.map((row) => row.notificationResumeObsMs)), notificationResumeStateMs: stats(moves.map((row) => row.notificationResumeStateMs)), notificationFromTargetEveryHandover: moves.every((row) => row.notificationFromTarget),
      observations: { produced: sequences.length, retransmissionsInjected: retransmissions, retransmissionsSuppressed: forwarder.counts.retransmissionsSuppressed, acceptedCentral: store.list('handoverObservations').filter((row) => row.ueId === ueId).length, finalEdge, finalContainerCni: container.cni, presentOnFinalCse: sequences.length - lost, lost, duplicatesInCse: cseDuplicates, liveWrites: forwarder.counts.liveWrites, replayDelivered: forwarder.counts.replayDelivered, cseDuplicateWriteAttempts: forwarder.counts.cseDuplicateWrites, writeFailuresRetried: forwarder.counts.writeFailures, heldDuringCutover: forwarder.counts.holds, standbyMirrored: forwarder.counts.mirrored, standbyMirrorFailures: forwarder.counts.mirrorFailures, standbyMirrorDropped: forwarder.counts.mirrorDropped },
      holdWindowMs: stats(moves.map((row) => row.holdWindowMs)), notificationGapMs: stats(moves.map((row) => row.notificationGapMs)),
      app: { notificationsRaw: app.raw, uniqueSequences: app.delivered, duplicatesSuppressedByAppDedup: app.duplicatesSuppressed, duplicatesDeliveredToApp: app.delivered - appSeen.size, missingAtApp: appMissing.length, verificationRequests: app.verificationRequests },
      security: { checks: security.length, pass: security.every((row) => row.pass), intruderDenied4103: security.filter((row) => row.intruderRsc === 4103).length, staleSourceDenied4103: security.filter((row) => row.staleSourceAeRsc === 4103 || row.staleSourceAeRscAfterRecovery === 4103).length, deferredFencesApplied: store.list('handoverDeferredFences').filter((row) => row.state === 'APPLIED').length, deferredFencesPending: store.list('handoverDeferredFences').filter((row) => row.state === 'PENDING').length },
      gatewayBridge: bridgeByEdge,
      probes: Object.fromEntries(Object.entries(probeStats).map(([edgeId, value]) => [edgeId, { count: value.count, failures: value.failures, rttP50Ms: percentile(value.rtt, 0.5), rttP95Ms: percentile(value.rtt, 0.95) }])),
      orchestratorEventLoopDelayMs: { p50: round1(loopDelay.percentile(50) / 1e6), p99: round1(loopDelay.percentile(99) / 1e6), max: round1(loopDelay.max / 1e6) },
      cseRestarts: cses['edge-a'].starts - 1,
    };
    const targets = { handoversAtLeast: 10, observationsAtLeast: 1000, lost: 0, duplicatesDeliveredToApp: 0 };
    const pass = moves.length >= targets.handoversAtLeast && sequences.length >= targets.observationsAtLeast && lost === 0 && cseDuplicates === 0 && appMissing.length === 0 && summary.security.pass && summary.security.deferredFencesPending === 0 && summary.stepsMatchingExpectedKind && summary.notificationFromTargetEveryHandover;
    status = pass ? 'PASS' : 'REVIEW';
    const receipt = {
      status, rubric: 'R12', docRevision: '2.0.0', generatedAt: new Date().toISOString(), runId,
      scope: { physicalHosts: 1, cseProcesses: 2, cseImplementation: 'Mobius4', cseVersion: JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version, sourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout.trim() || null, postgres: (await pool.query('SELECT version()')).rows[0].version, transport: 'actual-mobius4-loopback-http-through-latency-proxy', host: 'single Windows host, loopback only' },
      simulation: { cse: false, device: true, deviceNote: 'keyring telemetry generated in-process at a fixed rate (Gateway telemetry schema 1.0.0); no BLE hardware', location: true, locationNote: 'scripted MEC Location reports through MecPolicyReconciler and approved zone policies', availabilityFault: false, availabilityNote: 'edge-a Mobius4 process is terminated (TerminateProcess) and restarted on the same PostgreSQL database', latency: 'real probe RTT; extra delay injected by a loopback TCP proxy process', load: true, loadNote: 'edge-agent load value set by the scenario (simulated report)', coordinatorStore: 'run-local in-memory IntegrationStore subclass (shallow collection copy per transaction)' },
      triggerPolicy, intervals, baseOneWayDelayMs: baseDelayMs, injectedOneWayDelayMs: injectedDelayMs, zones, edgeZones, rounds,
      interruptionDefinition: 'time between the last observation acknowledged by the source CSE and the first acknowledgement on the target CSE of a newer sequence (live write or cutover replay)',
      targets, summary, steps, handovers, runtimeEvidenceDirectory: `.local/handover-auto-cse/${runId}`,
    };
    await writeFile(join(directory, 'event-log.json'), `${JSON.stringify({ log, notifications }, null, 0)}\n`, { mode: 0o600 });
    const evidence = join(root, 'docs/verification-evidence/2026-11-19'); await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'handover-auto-real-cse.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    await mkdir(join(root, 'pc-mobius/receipts'), { recursive: true }); await writeFile(join(root, 'pc-mobius/receipts/handover-auto-real-cse.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify({ status, handovers: summary.handovers, byKind: summary.byKind, observations: summary.observations.produced, lost, duplicatesInCse: cseDuplicates, appMissing: appMissing.length, interruptionMs: summary.interruptionMs, interruptionMsByKind: summary.interruptionMsByKind, detectionMsByKind: summary.detectionMsByKind, security: summary.security, eventLoop: summary.orchestratorEventLoopDelayMs }, null, 2));
    if (!pass) process.exitCode = 1;
  } catch (error) { failure = error; console.error(sanitized(error.stack)); process.exitCode = 1; }
  finally {
    for (const timer of timers) clearInterval(timer);
    automation?.stop(); await forwarder?.stop().catch(() => {});
    for (const state of Object.values(cses)) if (state.child && state.child.exitCode === null) { const exited = once(state.child, 'exit'); state.child.kill(); await exited.catch(() => {}); }
    for (const proxy of Object.values(proxies)) proxy.child.kill();
    if (callback) { callback.closeAllConnections(); await new Promise((done) => callback.close(done)); }
    if (failure) await writeFile(join(directory, 'event-log.json'), `${JSON.stringify({ failure: sanitized(failure.message), log }, null, 0)}\n`, { mode: 0o600 }).catch(() => {});
    if (!process.argv.includes('--keep-databases')) for (const database of databases) await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch((error) => console.error(sanitized(error.message)));
    await pool.end();
  }
}
