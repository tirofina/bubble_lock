// R17 place memory evaluation on the scripted (no-LLM) path.
// Part B: 14 synthetic evenings (learning curve, new place with guardian OK, repeated confused wandering) with the place
// memory sealed as AES-256-GCM ciphertext cin in the resident routine container of a real Mobius4 CSE after every day.
// Part A: the far cafe trip on the ETSI MEC Sandbox dayofcare with the guardian UE walking beside the resident (MEC013
// co-location) and alone, then alone again after the guardian marked the cafe OK.
// Usage: node pc-mobius/scripts/run-routine-learning.mjs [--skip-sandbox]
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { MecCipher } from '../integration/src/mec-state.mjs';
import { MecPlatformClient, createMecFetch } from '../integration/src/mec-platform-client.mjs';
import { Onem2mHttpClient, parseContent } from '../integration/src/onem2m-http-client.mjs';
import { createMecTriageAdapter } from '../integration/src/mcp-triage-tools.mjs';
import { RoutineDetector } from '../integration/src/routine-model.mjs';
import { CompanionTracker, PLACE_DEFAULTS, PLACE_MEMORY_VERSION, PlaceMemory, learningDecision, openPlaceMemory, sealPlaceMemory } from '../integration/src/place-memory.mjs';
import { judge, learningCurve, summarizeCurve, guardianFeedback } from '../integration/src/routine-learning.mjs';
import { LEARNING_DAYS, dayofcareDefinition, guardianCompanionTrack, learningEvening, routineMapOf } from '../integration/src/routine-scenarios.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.length ? value.join('=') : true]; }));
const env = process.env;
const DAYOFCARE_JSON = env.DAYOFCARE_JSON ?? 'C:/Users/user/orca/workspaces/bubble_lock/kelp/.local/mec-sandbox/dayofcare.json';
const dayofcareText = readFileSync(DAYOFCARE_JSON, 'utf8'); const description = JSON.parse(dayofcareText);
const definition = dayofcareDefinition(description, { farTrip: true }); const map = routineMapOf(definition);
const labeler = (point) => { const match = map.match(point); return match.distanceM <= 35 ? match.name : 'unmapped stop'; };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();
const COORDINATE = /\b(4[0-9]|[0-9])\.\d{4,}\b/g;
const coordinateHits = (text) => (String(text).match(COORDINATE) ?? []).filter((value) => { const n = Number(value); return (n > 43 && n < 44) || (n > 7 && n < 8); }).length;
const runTag = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const runDir = join(root, '.local', 'routine-learning', runTag); await mkdir(runDir, { recursive: true });
const evidenceDir = join(root, 'docs', 'verification-evidence', '2026-11-20');
const connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8')); const secrets = [connection.password];
const sanitize = (text) => secrets.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, '[secret]'), String(text));
const log = (entry) => { const line = sanitize(JSON.stringify({ ...entry, at: nowIso() })); console.log(line); appendFileSync(join(runDir, 'runner.jsonl'), `${line}\n`); };
const pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database });
const database = `bubble_learning_${runTag}`; let databaseCreated = false; let cse = null; let exitCode = 1;
const mecBase = (env.MEC_BASE_URL ?? 'https://192.0.2.103').replace(/\/+$/, ''); const caFile = resolve(root, env.MEC_CA_FILE ?? '.local/mec-sandbox/ca.pem');
const sandboxRoot = `${mecBase}/${definition.sandbox}`; const mecFetch = createMecFetch({ caFile });
const sandbox = async (method, path, body, expected = [200, 201, 204]) => {
  const response = await mecFetch(`${sandboxRoot}${path}`, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!expected.includes(response.status)) throw Object.assign(new Error(`sandbox ${method} ${path} ${response.status}`), { status: response.status });
  return { status: response.status, data };
};
let gisRetries = 0;
const moveUe = async (ue, point) => { for (let attempt = 0; ; attempt += 1) { try { return await sandbox('POST', `/gis/v1/geodata/${encodeURIComponent(ue)}`, { assetName: ue, assetType: 'UE', subType: 'UE', location: { type: 'Point', coordinates: [point.lon, point.lat] } }); } catch (error) { if (attempt >= 4) throw error; gisRetries += 1; await delay(1000 * (attempt + 1)); } } };
const freePort = async () => { const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const { port } = probe.address(); await new Promise((done) => probe.close(done)); return port; };
const waitFor = async (predicate, timeoutMs) => { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = await predicate(); if (value) return value; await delay(20); } return null; };
const original = {}; let mobilityWasActive = null;

try {
  // ---------------------------------------------------------------- Mobius4 CSE with the resident routine container
  const upstream = resolve(env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4')); const source = join(root, '.local', 'routine-learning', 'source');
  await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
  try { await lstat(join(source, 'node_modules')); } catch { await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction'); }
  if (spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: root, encoding: 'utf8', windowsHide: true }).status !== 0) throw new Error('Mobius4 specialization registry preparation failed');
  const preload = join(runDir, 'loopback-only.cjs');
  await writeFile(preload, "const net = require('node:net'); const original = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1,0,'127.0.0.1'); return original.apply(this,args); };\n");
  await pool.query(`CREATE DATABASE "${database}"`); databaseCreated = true;
  const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database }); await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
  const port = await freePort(); const admin = `S${randomBytes(11).toString('hex')}`; secrets.push(admin); const endpoint = `http://127.0.0.1:${port}`;
  const cseConfig = { http: { port }, https: { enabled: false }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database }, cse: { admin, cse_id: '/pb-learning-in', csebase_rn: 'Mobius', cse_type: 1, subscription_verification: true, poa: [endpoint] }, mqtt: { enabled: false }, logging: { level: 'error', file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
  let diagnostic = '';
  cse = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(cseConfig) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  cse.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-16000); }); cse.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-16000); });
  await new Promise((ready, reject) => { const timeout = setTimeout(() => reject(new Error(`CSE start timeout: ${sanitize(diagnostic)}`)), 30000); cse.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`CSE exited ${code}`)); }); cse.on('message', (message) => { if (message === 'ready') { clearTimeout(timeout); ready(); } }); });
  const adminClient = new Onem2mHttpClient({ endpoint, cseBase: '/Mobius', originator: admin });
  await waitFor(async () => (await adminClient.retrieve('/Mobius').catch(() => ({ rsc: 0 }))).rsc === 2000, 10000);
  const ids = { resident: `Cresident-${runTag}`, routine: `Croutine-${runTag}`, triage: `Ctriage-${runTag}` };
  const clients = Object.fromEntries(Object.entries(ids).map(([key, originator]) => [key, new Onem2mHttpClient({ endpoint, cseBase: '/Mobius', originator })]));
  const aes = {}; for (const [key, client] of Object.entries(clients)) aes[key] = await client.registerAe({ rn: `pb-${key}-${runTag}`, api: `N.privacy.bubble.${key}`, poa: [] });
  const acp = await clients.resident.ensure(aes.resident.path, 1, { 'm2m:acp': { rn: 'resident-acp', pv: { acr: [{ acor: [ids.resident, ids.routine], acop: 63 }, { acor: [ids.triage], acop: 34 }] }, pvs: { acr: [{ acor: [ids.resident], acop: 63 }] } } });
  if ((await clients.resident.update(aes.resident.path, { 'm2m:ae': { acpi: [acp.ri] } })).rsc !== 2004) await adminClient.update(aes.resident.path, { 'm2m:ae': { acpi: [acp.ri] } });
  const routinePath = (await clients.resident.ensure(aes.resident.path, 3, { 'm2m:cnt': { rn: 'routine', acpi: [acp.ri], mni: 200 } })).path;
  // location-privacy key handling: MecCipher keeps a 32-byte key file next to the service store (0600), never on the CSE.
  const cipher = new MecCipher({ store: { path: join(runDir, 'routine-service-store.json') } });
  const writes = [];
  const persist = async (memory, rn, dayMs) => {
    const sealed = await sealPlaceMemory(memory, cipher, 'resident-r1');
    const created = await clients.routine.create(routinePath, 4, { 'm2m:cin': { rn: `memory-${rn}`, cnf: 'application/json', con: sealed } });
    const summary = { type: 'PLACE_SUMMARY', version: PLACE_MEMORY_VERSION, residentId: 'resident-r1', summary: memory.describe(dayMs), stateHash: sealed.stateHash };
    const summaryCreated = await clients.routine.create(routinePath, 4, { 'm2m:cin': { rn: `summary-${rn}`, cnf: 'application/json', con: summary } });
    const readBack = (await clients.triage.retrieve(`${routinePath}/memory-${rn}`)).payload?.['m2m:cin']?.con;
    const reopened = await openPlaceMemory(parseContent(readBack), cipher, { home: map.home, tzOffsetMin: map.tzOffsetMin, params: memory.p, labeler });
    writes.push({ rn, memoryRsc: created.rsc, summaryRsc: summaryCreated.rsc, ciphertextBytes: sealed.sealed.ciphertext.length, coordinateHitsMemoryCin: coordinateHits(JSON.stringify(readBack)), coordinateHitsSummaryCin: coordinateHits(JSON.stringify(summary)), roundTrip: reopened.stateHash() === memory.stateHash(), readerOriginator: 'triage AE (RETRIEVE only)' });
    return reopened;
  };
  log({ step: 'CSE_READY', endpoint, routinePath });

  // ---------------------------------------------------------------- Part B: learning curve with the memory sealed on the CSE every day
  const learning = await learningCurve({ definition, map, variant: 'learning', labeler, afterDay: async (row, memory, evening) => persist(memory, `d${row.day}`, evening.walk.endMs) });
  const variants = { learning };
  for (const variant of ['frozen', 'noGate', 'segmentV1']) variants[variant] = await learningCurve({ definition, map, variant, labeler });
  const curves = Object.fromEntries(Object.entries(variants).map(([key, curve]) => [key, summarizeCurve(curve)]));
  log({ step: 'LEARNING_CURVE', curves });

  // ---------------------------------------------------------------- Part A: far cafe trip on the sandbox with the guardian UE (MEC013 co-location)
  let partA = null;
  if (!args['skip-sandbox']) {
    const residentUe = definition.ue; const guardianUe = description.ues?.find((ue) => ue.id === 'guardian')?.id ?? 'guardian';
    for (const ue of [residentUe, guardianUe]) original[ue] = (await sandbox('GET', `/gis/v1/geodata/${encodeURIComponent(ue)}?excludePath=true`)).data?.location?.coordinates ?? null;
    const automation = (await sandbox('GET', '/gis/v1/automation')).data?.states ?? [];
    mobilityWasActive = Boolean(automation.find((item) => item.type === 'MOBILITY')?.active);
    if (automation.find((item) => item.type === 'MOVEMENT')?.active) throw new Error('MOVEMENT automation is active; the replay needs it off');
    if (!mobilityWasActive) await sandbox('POST', '/gis/v1/automation/MOBILITY?run=true');
    await delay(3000);
    const platforms = (definition.meps?.length ? definition.meps : ['mep1']).map((mep) => new MecPlatformClient({ platformRoot: `${sandboxRoot}/${mep}`, fetchImpl: mecFetch, timeoutMs: 6000, locationVersion: 'v3' }));
    const mec = createMecTriageAdapter({ platforms });
    const locateMatched = async (ue, point) => (await waitFor(async () => { const value = await mec.locate(ue).catch(() => null); return value && Math.abs(value.lat - point.lat) < 1e-5 && Math.abs(value.lon - point.lon) < 1e-5 ? value : null; }, 4000)) ?? await mec.locate(ue);
    // Memory for the sandbox trips: the first five learned evenings of the schedule, then sealed and reopened from the CSE.
    let memory = new PlaceMemory({ home: map.home, tzOffsetMin: map.tzOffsetMin, labeler });
    for (const spec of LEARNING_DAYS.slice(0, 5)) { const evening = learningEvening(definition, spec); memory.learnTrip({ samples: evening.samples, endedMs: evening.walk.endMs, mode: 'solo' }); }
    memory = await persist(memory, 'a0', learningEvening(definition, LEARNING_DAYS[4]).walk.endMs);
    const trips = [
      { id: 'A1-cafe-with-guardian', date: '2026-11-26', accompanied: 'mec', expectAlert: false, seed: 601 },
      { id: 'A2-cafe-first-solo', date: '2026-11-27', accompanied: null, expectAlert: true, guardian: 'dismissOk', markPlace: 'Q', seed: 602 },
      { id: 'A3-cafe-solo-after-ok', date: '2026-11-28', accompanied: null, expectAlert: false, seed: 603 },
    ];
    const results = [];
    for (const trip of trips) {
      const spec = { day: trip.id, date: trip.date, kind: trip.id, route: 'cafeTrip', depart: '16:30:00', speedMps: 0.9, stops: { B2: [600], Q: 1200 }, seed: trip.seed, guardian: trip.guardian, markPlace: trip.markPlace };
      const evening = { ...learningEvening(definition, spec), expectAlert: false };
      const guardianTrack = trip.accompanied === 'mec' ? guardianCompanionTrack(definition, evening.walk) : null;
      const guardianStill = original[guardianUe] ? { lat: original[guardianUe][1], lon: original[guardianUe][0] } : definition.nodes.O;
      const detector = new RoutineDetector({ map, memory }); const tracker = new CompanionTracker();
      const byTime = new Map(evening.samples.map((sample) => [sample.t, sample])); const guardianByTime = guardianTrack ? new Map(guardianTrack.map((point) => [point.t, point])) : null;
      const alerts = []; const zones = {}; const started = Date.now(); let unmatched = 0;
      if (!guardianTrack) await moveUe(guardianUe, guardianStill);
      for (const point of evening.track) {
        const t = point.t; await moveUe(residentUe, point);
        const guardianPoint = guardianByTime?.get(t) ?? guardianStill; if (guardianTrack) await moveUe(guardianUe, guardianPoint);
        const resident = await locateMatched(residentUe, point); const companion = await locateMatched(guardianUe, guardianPoint);
        if (Math.abs(resident.lat - point.lat) >= 1e-5) unmatched += 1;
        zones[`${resident.zoneId}|${companion.zoneId}`] = (zones[`${resident.zoneId}|${companion.zoneId}`] ?? 0) + 1;
        if (byTime.has(t)) {
          detector.observe({ t, lat: resident.lat, lon: resident.lon });
          detector.observeCompanion(tracker.observe({ t, resident: { lat: resident.lat, lon: resident.lon, zoneId: resident.zoneId }, companion: { lat: companion.lat, lon: companion.lon, zoneId: companion.zoneId } }));
        }
        for (const alert of detector.evaluate(t).alerts) { alerts.push({ kind: alert.kind, trigger: alert.features.trigger ?? null, score: alert.score, detectedMs: t, detectedLocal: map.localTime(t, true), place: alert.features.place ?? null }); log({ step: 'SANDBOX_ALERT', trip: trip.id, kind: alert.kind, trigger: alert.features.trigger, detectedLocal: map.localTime(t, true), place: alert.features.place?.label }); }
      }
      const result = judge(map, evening, alerts, tracker.status());
      const feedback = guardianFeedback(spec, result, definition);
      const decision = learningDecision({ accompanied: result.companion.accompanied, guardianAlerts: alerts.length, guardianDismissedOk: feedback.dismissedOk });
      if (feedback.markPlace && decision.learn) memory.markPlaceOk({ point: feedback.markPlace.point, atMs: evening.walk.endMs, label: feedback.markPlace.label });
      if (decision.learn) memory.learnTrip({ samples: evening.samples, endedMs: evening.walk.endMs, mode: decision.mode });
      memory = await persist(memory, trip.id.split('-')[0].toLowerCase(), evening.walk.endMs);
      const row = { trip: trip.id, accompaniedBy: trip.accompanied === 'mec' ? `guardian UE ${guardianUe} beside the resident from the bench (MEC013)` : `guardian UE ${guardianUe} at the office`, expectAlert: trip.expectAlert,
        companion: { accompanied: result.companion.accompanied, reason: result.companion.reason, coLocatedReports: result.companion.coLocatedReports, since: result.companion.since ? map.localTime(result.companion.since, true) : null },
        alerts: alerts.map(({ kind, trigger, detectedLocal, place }) => ({ kind, trigger, detectedLocal, place: place?.label ?? null, familiarity: place?.familiarity ?? null, distanceBand: place?.distanceBand ?? null })),
        pass: alerts.length > 0 === trip.expectAlert, guardianDismissedOk: feedback.dismissedOk, learned: decision, zonesSeen: zones, mecPositionUnmatched: unmatched, ticks: evening.track.length, wallSec: Math.round((Date.now() - started) / 1000) };
      results.push(row); log({ step: 'SANDBOX_TRIP', ...row });
    }
    partA = { sandbox: definition.sandbox, residentUe, guardianUe, meps: definition.meps, trips: results, gisPostRetries: gisRetries, mobility: { wasActive: mobilityWasActive, leftActive: true, note: 'left on: the declared dayofcare state after the R13 run' } };
  }

  // ---------------------------------------------------------------- receipt
  const learningDays = learning.days;
  const dayOf = (n) => learningDays.find((day) => day.day === n);
  const checks = {
    falseAlarmsDropWithLearning: curves.learning.falseAlarmsDays8to14 < curves.frozen.falseAlarmsDays8to14 && curves.learning.falseAlarms < curves.segmentV1.falseAlarms && curves.learning.falseAlarmsDays8to14 <= curves.learning.falseAlarmsDays1to7,
    wanderingDetectionHeld: curves.learning.wanderingDetected === curves.learning.wanderingEvenings && Object.values(curves.learning.leadTimeSec).every((value) => value > 0),
    accompaniedTripKeptOutOfSoloMemory: dayOf(6).accompanied && dayOf(6).alerts.length === 0 && dayOf(7).alerts.length > 0,
    newPlaceQuietAfterGuardianOk: dayOf(7).guardianDismissedOk && dayOf(10).alerts.length === 0 && dayOf(14).alerts.length === 0,
    confusedWanderingNotLearned: [8, 11, 12].every((n) => dayOf(n).detected && !dayOf(n).learned.learn) && curves.noGate.wanderingDetected < curves.learning.wanderingDetected,
    memoryEncryptedAtRest: writes.every((entry) => entry.coordinateHitsMemoryCin === 0 && entry.coordinateHitsSummaryCin === 0 && entry.roundTrip && entry.memoryRsc === 2001),
    ...(partA ? { companionSandboxTrips: partA.trips.every((trip) => trip.pass) && partA.trips[0].companion.accompanied } : {}),
  };
  const csv = ['day,date,kind,accompanied,cold_start,alerts,false_alarms,detected,lead_time_s,guardian_ok,learned_as,frozen_alerts,no_gate_alerts,segment_v1_alerts',
    ...learningDays.map((day, index) => [day.day, day.date, day.kind, day.accompanied, day.coldStartAtStart, day.alerts.map((a) => `${a.kind}/${a.trigger}@${a.detectedLocal}`).join(' '), day.falseAlarms, day.detected ?? '', day.leadTimeSec ?? '', day.guardianDismissedOk, day.learned.mode ?? 'not learned',
      variants.frozen.days[index].alerts.length, variants.noGate.days[index].alerts.length, variants.segmentV1.days[index].alerts.length].map((value) => `"${value}"`).join(','))];
  const receipt = {
    receiptId: 'routine-learning', status: Object.values(checks).every(Boolean) ? 'PASS' : 'REVIEW', generatedAt: nowIso(), docRevision: '2.0.0', rubricIds: ['R17'], command: 'node pc-mobius/scripts/run-routine-learning.mjs', agent: 'none (scripted path, LLM invocations 0)',
    simulationScope: { evenings: 'synthetic (seeded generator on the dayofcare trail and guardianPath)', bleProximity: 'simulated flag (day 6)', guardianFeedback: 'scripted', cse: false, mecSandbox: partA ? false : 'not used', hardware: false },
    placeMemory: { version: PLACE_MEMORY_VERSION, params: PLACE_DEFAULTS, finalSummary: learning.memory.describe(Date.parse('2026-12-04T18:00:00Z')), finalStateHash: learning.memory.stateHash() },
    encryption: { cipher: 'AES-256-GCM (MecCipher, location-privacy key handling: 32-byte key file next to the routine service store, 0600)', aad: 'place-memory:<residentId>', container: routinePath, writes, plaintext: 'only inside the routine service process; the triage AE reads ciphertext and the label summary' },
    learningCurve: { schedule: LEARNING_DAYS.map(({ day, date, kind, route, accompanied, guardian }) => ({ day, date, kind, route, accompanied: accompanied ?? null, guardian: guardian ?? null })), curves, days: learningDays, variants: Object.fromEntries(Object.entries(variants).map(([key, curve]) => [key, curve.days.map(({ day, alerts, falseAlarms, detected, leadTimeSec, learned }) => ({ day, alerts: alerts.map((a) => `${a.kind}/${a.trigger}@${a.detectedLocal}`), falseAlarms, detected, leadTimeSec, learned: learned.mode ?? 'not learned' }))])) },
    companionRule: { mec: 'same MEC013 zone, under 50 m, similar heading and speed for 3 consecutive reports', ble: 'guardian phone sees the keyring over BLE (simulated flag)', effect: 'no novelty or distance alerts while accompanied; accompanied trips learned into a separate store; PANIC unaffected' },
    partA, checks,
    sandbox: { host: new URL(mecBase).host, definitionSource: { sha256: sha256(dayofcareText), schema: description.schema } },
    runnerSHA256: sha256(await readFile(fileURLToPath(import.meta.url))), runDirectory: `.local/routine-learning/${runTag}`,
    limits: ['Evenings, BLE proximity and guardian answers are synthetic and designed with the model parameters; fourteen evenings and three sandbox trips, no clinical claim.', 'The sandbox positions are the generated points set through GIS; MEC013 echoes them, so real positioning error is absent.'],
  };
  await writeFile(join(evidenceDir, 'routine-learning.json'), `${sanitize(JSON.stringify(receipt, null, 2))}\n`);
  await writeFile(join(evidenceDir, 'routine-learning-curve.csv'), `${csv.join('\n')}\n`);
  log({ step: 'RECEIPT', status: receipt.status, checks, curves, partA: partA?.trips.map(({ trip, pass, alerts, companion }) => ({ trip, pass, alerts: alerts.length, accompanied: companion.accompanied })) });
  exitCode = receipt.status === 'PASS' ? 0 : 1;
} catch (error) { console.error(sanitize(error.stack ?? error)); exitCode = 1; }
finally {
  for (const [ue, coordinates] of Object.entries(original)) { try { if (coordinates) await moveUe(ue, { lon: coordinates[0], lat: coordinates[1] }); } catch (error) { console.error(`restore ${ue}: ${error.message}`); } }
  // MOBILITY stays on: the declared dayofcare state after the R13 run (reported by the lead).
  if (cse && cse.exitCode === null) { cse.kill(); await Promise.race([once(cse, 'exit'), delay(5000)]); }
  if (databaseCreated) { try { await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); } catch (error) { console.error(sanitize(`database cleanup: ${error.message}`)); } }
  await pool.end();
  process.exitCode = exitCode;
}
