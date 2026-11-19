/**
 * Automation application (separate process, own AE and ACP) for the R03 scenario.
 *
 * It never calls the dashboard or the guardian portal. It subscribes to keyring button and battery
 * containers it discovers by label, and writes an incident contentInstance into its own incidents
 * container. The CSE then fans that incident out to every application subscribed to the container.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Onem2mHttp, startNotificationServer, normalizeSid, discoveredPaths, toOneM2mTime } from './onem2m-http.mjs';
import { ACOP, INCIDENT_TYPE, LABELS } from './topology.mjs';

export const LOW_BATTERY_PCT = 15;

/** Pure decision: which incident (if any) a keyring event raises. */
export function incidentFor({ stream, cin, gatewayAeId, householdId, deviceIds }) {
  if (cin?.cr !== gatewayAeId) return { incident: null, reason: 'unexpected-creator' };
  const observation = cin.con;
  if (!observation || observation.version !== 1 || typeof observation.deviceId !== 'string') return { incident: null, reason: 'schema' };
  const base = { version: 1, type: INCIDENT_TYPE, householdId, deviceId: observation.deviceId, sourceResource: cin.ri, sourceStream: stream, sourceSequence: observation.sequence, observedAt: observation.observedAt, simulation: true };
  const id = (kind) => `incident-${createHash('sha256').update(`${kind}:${cin.ri}`).digest('hex').slice(0, 20)}`;
  if (stream === 'button' && ['panic', 'confirm'].includes(observation.buttonState)) {
    return { incident: { ...base, incidentId: id('SAFETY'), kind: 'SAFETY', severity: observation.buttonState === 'panic' ? 'HIGH' : 'MEDIUM', message: observation.buttonState === 'panic' ? '키링 비상 버튼이 눌렸어요.' : '키링 확인 버튼이 눌렸어요.', proposal: { deviceIds, desiredState: { state: true }, reason: '버튼 사건 대응 보호 모드' } } };
  }
  if (stream === 'battery' && (observation.sensorValues?.batteryAlert === true || (typeof observation.battery === 'number' && observation.battery <= LOW_BATTERY_PCT))) {
    return { incident: { ...base, incidentId: id('MAINTENANCE'), kind: 'MAINTENANCE', severity: 'LOW', message: `키링 배터리가 ${observation.battery}%예요.`, proposal: null } };
  }
  return { incident: null, reason: 'no-trigger' };
}

export async function startAutomation(config, { report = () => {} } = {}) {
  const { cse, automation, apps, gatewayAeId, householdId } = config;
  const http = new Onem2mHttp({ endpoint: cse.endpoint, originator: automation.aeId });
  const aePath = `${cse.cseBase}/${automation.rn}`;
  const incidents = `${aePath}/incidents`;
  const bindings = new Map();
  const seen = new Set();
  const log = [];
  let deviceIds = [];

  const notifications = await startNotificationServer({
    cseId: cse.cseId,
    onNotify: async ({ sgn, receivedAt }) => {
      const notifiedMs = Date.now();
      const binding = bindings.get(normalizeSid(sgn.sur, cse.cseBase));
      const cin = sgn.nev?.rep?.['m2m:cin'];
      if (!binding || !cin || seen.has(cin.ri)) return;
      seen.add(cin.ri);
      const decision = incidentFor({ stream: binding.stream, cin, gatewayAeId, householdId, deviceIds });
      if (!decision.incident) { log.push({ cin: cin.ri, stream: binding.stream, reason: decision.reason }); return; }
      const createdAt = new Date().toISOString();
      const incident = { ...decision.incident, createdAt, automationAe: automation.aeId };
      const written = await http.request('POST', incidents, { body: { 'm2m:cin': { rn: incident.incidentId, cnf: 'application/json:0', con: incident, cr: null, et: toOneM2mTime(Date.now() + 3600_000), lbl: [LABELS.device(incident.deviceId), `pb-kind-${incident.kind}`] } }, ty: 4 });
      const entry = { type: 'incident', incidentId: incident.incidentId, kind: incident.kind, deviceId: incident.deviceId, sourceResource: cin.ri, sourceCt: cin.ct, notifiedAt: receivedAt, notifiedMs, incidentWrittenMs: Date.now(), rsc: written.rsc, incidentRi: written.payload?.['m2m:cin']?.ri ?? null, et: written.payload?.['m2m:cin']?.et ?? null };
      log.push(entry); report(entry);
    },
  });
  const ae = await http.registerAe(cse.cseBase, { rn: automation.rn, api: 'Npb.automation.incidents', poa: [`${notifications.url}/automation`], lbl: ['pb-app-automation'] });
  const read = ACOP.R + ACOP.DISC; const subscribe = ACOP.C + read;
  const acp = await http.ensure(aePath, 1, { 'm2m:acp': { rn: 'acp-incidents', pv: { acr: [{ acor: [automation.aeId], acop: ACOP.ALL }, { acor: [apps.operator], acop: subscribe }, { acor: [apps.guardian], acop: subscribe }] }, pvs: { acr: [{ acor: [automation.aeId], acop: ACOP.ALL }] } } });
  await http.ensure(aePath, 3, { 'm2m:cnt': { rn: 'incidents', mni: 50, mia: 86400, lbl: [LABELS.incidents, LABELS.household(householdId)], acpi: [acp.payload['m2m:acp'].ri] } });

  async function refresh() {
    const household = new Set(discoveredPaths((await http.expect('GET', cse.cseBase, [2000], { query: { fu: 1, ty: 3, lbl: LABELS.household(householdId) } })).payload));
    const roots = discoveredPaths((await http.expect('GET', cse.cseBase, [2000], { query: { fu: 1, ty: 3, lbl: LABELS.keyring } })).payload).filter((path) => household.has(path));
    const created = [];
    for (const stream of ['button', 'battery']) {
      const containers = discoveredPaths((await http.expect('GET', cse.cseBase, [2000], { query: { fu: 1, ty: 3, lbl: LABELS.stream(stream) } })).payload).filter((path) => roots.some((root) => path === `${root}/${stream}`));
      for (const container of containers) {
        const subPath = `${container}/sub-automation`;
        if (bindings.has(subPath)) continue;
        await http.request('DELETE', subPath);
        await http.expect('POST', container, [2001], { body: { 'm2m:sub': { rn: 'sub-automation', nu: [automation.aeId], su: automation.aeId, enc: { net: [3], chty: [4] }, nct: 1, et: toOneM2mTime(Date.now() + 86400_000) } }, ty: 23 });
        bindings.set(subPath, { stream, container });
        created.push(subPath);
      }
    }
    deviceIds = [...new Set(roots.map((path) => path.split('/').at(-1)))];
    return { deviceIds, subscriptions: created };
  }
  const discovery = await refresh();

  async function close() {
    for (const path of bindings.keys()) await http.request('DELETE', path).catch(() => {});
    await notifications.close();
  }
  return { ae, incidentsContainer: incidents, discovery, refresh, log, close, notificationStats: notifications.stats };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const send = (message) => process.send?.(message);
  try {
    const automation = await startAutomation(config, { report: send });
    send({ type: 'ready', ae: automation.ae, incidentsContainer: automation.incidentsContainer, discovery: automation.discovery });
    process.on('message', async (message) => {
      if (message?.type === 'stats') send({ type: 'stats', id: message.id, log: automation.log, notifications: automation.notificationStats });
      else if (message?.type === 'stop') { await automation.close(); send({ type: 'stopped' }); process.exit(0); }
    });
  } catch (error) { send({ type: 'fatal', message: error.message }); process.exit(1); }
}
