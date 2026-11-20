import { createHash, randomBytes } from 'node:crypto';
import {
  COMMAND_BUNDLE_TYPE, createLiveEventLog, isoToOneM2mTime, LIVE_SOURCE, normalizeStructuredId, oneM2mTimeToIso,
  parseContentInstance, parseNotification,
} from '../shared/cse-notification.ts';
import type { ContentInstance, CseBinding, CseStream } from '../shared/cse-notification.ts';
import type { DashboardEvent } from '../shared/types.ts';
import { activeLease, FEED_CONTAINERS, residentStatusOf } from '../shared/guardian-alert.ts';
import type { AlertCard, FeedContainer } from '../shared/guardian-alert.ts';
import type { LocationSnapshot } from '../shared/location.ts';
import { discoveredUris, Onem2mClient, startNotificationIngress } from './onem2m.ts';
import type { FetchLike, NotificationIngress } from './onem2m.ts';
import type { RoleBinding } from './mtls-fetch.ts';
import type { AlertBackend, AlertFeed } from './guardian-alerts.ts';

/**
 * Live oneM2M data source for the dashboard server (R03).
 *
 * The operator dashboard and the guardian portal register as two AEs with their own ACP
 * entries, discover keyrings by label, and create their own <subscription>s. Notifications
 * become the existing dashboard event contract; an la/ RETRIEVE (plus a createdAfter discovery
 * for gaps) restores anything a notification did not deliver.
 */
export interface CseLiveConfig {
  readonly cse: { readonly endpoint: string; readonly cseBase: string; readonly cseId: string; readonly rvi?: string; readonly allowLanHttp?: boolean };
  readonly notification?: { readonly host?: string; readonly port?: number };
  readonly simulation: boolean;
  /** Expected creator (cr) of keyring containers: the Gateway AE. */
  readonly gatewayAeId: string;
  /** Expected creator of incident contentInstances. */
  readonly automationAeId: string;
  readonly operator: { readonly aeId: string; readonly rn: string };
  readonly guardian?: { readonly aeId: string; readonly rn: string; readonly principalId: string; readonly householdId: string };
  readonly labels?: { readonly keyring?: string; readonly incidents?: string };
  readonly subscriptionTtlSec?: number;
  readonly refreshMs?: number;
  /**
   * R17 resident feed (alerts, triageLog, guardianInbox, approvals, incidents, leases, audit, location containers),
   * discovered by label. Writers are the AE-IDs allowed per record type; the guardian AE is the guardian writer.
   */
  readonly residents?: {
    readonly label?: string;
    readonly residentId?: string;
    readonly writers: { readonly routine: readonly string[]; readonly triage: readonly string[]; readonly incident: readonly string[]; readonly guardianDecider: readonly string[]; readonly resident: readonly string[] };
  };
  /** 'labeled-keyring' (default): label discovery plus subscriptions. 'gateway-container': la/ polling, see cse-gateway-poll.ts. */
  readonly layout?: 'labeled-keyring' | 'gateway-container';
  /** gateway-container paths relative to cseBase, e.g. bubble-household-1/gateway-1/observations. */
  readonly paths?: { readonly observations: string; readonly receipts?: string; readonly health?: string; readonly location?: string; readonly locationDeviceId?: string; readonly locationLabel?: string; readonly locationSimulated?: boolean };
  /**
   * gateway-container per-role bindings (R10): each role reads with its own least-privilege AE over mTLS. When set,
   * gatewayReader and operator.aeId are not used for reads, and a role without a binding reads nothing.
   */
  readonly roles?: { readonly operator: RoleBinding; readonly guardian?: RoleBinding };
  /** gateway-container originator for reads without roles; defaults to operator.aeId. */
  readonly gatewayReader?: string;
  readonly pollMs?: number;
  readonly backlog?: number;
  /**
   * Public story-demo writer. Each browser receives a short-lived child container below
   * this AE and all demo actions are CREATE + RETRIEVE verified through Mobius4.
   * A dedicated mTLS binding keeps the public demo writer separate from dashboard readers.
   */
  readonly story?: {
    readonly parentPath?: string;
    readonly rootRn?: string;
    readonly originator?: string;
    readonly binding?: RoleBinding;
    readonly sessionTtlSec?: number;
    readonly careGrantSec?: number;
    readonly maxSessions?: number;
  };
}

type App = 'operator' | 'guardian';
interface SubscriptionEntry { readonly app: App; readonly binding: CseBinding; readonly kind: 'stream' | 'confirm' | 'alert'; readonly requestId?: string }
interface Keyring { readonly deviceId: string; readonly gatewayId: string | null; readonly householdId: string | null; readonly root: string }
export const OPERATOR_STREAMS: readonly CseStream[] = ['observation', 'button', 'battery', 'command', 'receipt'];
export const GUARDIAN_STREAMS: readonly CseStream[] = ['button', 'battery', 'receipt'];

export interface GuardianIncident { incidentId: string; householdId: string; deviceId: string | null; kind: string; message: string; status: string; createdBy: string; createdAt: string; source: 'onem2m-cse' }
export interface GuardianNotification { notificationId: string; householdId: string; principalId: string; type: string; title: string; createdAt: string; readAt: null; source: 'onem2m-cse' }

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
/** Same digest as PC-MOBIUS approvalHash and bubble_gateway.model.payload_hash. */
export function commandPayloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const labelValue = (labels: readonly string[], prefix: string) => labels.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? null;
function minusOneSecond(ct: string): string { return isoToOneM2mTime(Date.parse(oneM2mTimeToIso(ct)) - 1000); }

/** Guardian portal view state built only from the guardian AE's own notifications. */
export function createGuardianOverlay(guardian: { principalId: string; householdId: string }) {
  const incidents = new Map<string, GuardianIncident>();
  const notifications: GuardianNotification[] = [];
  /** Arrival log of the guardian AE's own notifications (for latency evidence). */
  const received: { stream: string; ri: string; deviceId: string | null; receivedAt: string }[] = [];
  /** Commands whose native APPLIED receipt reached the guardian AE through its own subscription. */
  const appliedCommands = new Set<string>();
  const notify = (type: string, title: string, createdAt: string, key: string) => {
    const notificationId = `cse-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    if (notifications.some((item) => item.notificationId === notificationId)) return;
    notifications.unshift({ notificationId, householdId: guardian.householdId, principalId: guardian.principalId, type, title, createdAt, readAt: null, source: 'onem2m-cse' });
    notifications.splice(50);
  };
  return {
    ingest(binding: CseBinding, cin: ContentInstance, receivedAt = new Date().toISOString()) {
      if (cin.cr !== binding.expectedCreator || !record(cin.con)) return;
      received.push({ stream: binding.stream, ri: cin.ri, deviceId: binding.deviceId, receivedAt }); received.splice(0, Math.max(0, received.length - 200));
      const con = cin.con; const createdAt = oneM2mTimeToIso(cin.ct);
      if (binding.stream === 'incident' && typeof con['incidentId'] === 'string') {
        incidents.set(con['incidentId'], { incidentId: con['incidentId'], householdId: typeof con['householdId'] === 'string' ? con['householdId'] : guardian.householdId, deviceId: typeof con['deviceId'] === 'string' ? con['deviceId'] : null, kind: String(con['kind'] ?? 'SAFETY'), message: String(con['message'] ?? '자동화 사건'), status: 'OPEN', createdBy: cin.cr, createdAt, source: 'onem2m-cse' });
        notify('INCIDENT_OPENED', String(con['message'] ?? '새 안전 요청이 도착했습니다.'), createdAt, `incident:${cin.ri}`);
      } else if (binding.stream === 'button' && con['buttonState'] !== 'released') {
        notify('KEYRING_BUTTON', `${binding.deviceId ?? '키링'} 버튼이 눌렸어요.`, createdAt, `button:${cin.ri}`);
      } else if (binding.stream === 'battery' && typeof con['battery'] === 'number' && con['battery'] <= 15) {
        notify('KEYRING_BATTERY_LOW', `${binding.deviceId ?? '키링'} 배터리가 ${con['battery']}%예요.`, createdAt, `battery:${cin.ri}`);
      } else if (binding.stream === 'receipt' && con['status'] === 'APPLIED') {
        if (typeof con['commandId'] === 'string') appliedCommands.add(con['commandId']);
        notify('COMMAND_APPLIED', `${binding.deviceId ?? '키링'}에 보호 모드가 적용됐어요.`, createdAt, `receipt:${cin.ri}`);
      }
    },
    confirm(deviceId: string, state: boolean, receivedAt: string, key: string) {
      received.push({ stream: 'switch-confirm', ri: key, deviceId, receivedAt });
      notify('KEYRING_STATE_CONFIRMED', `${deviceId} 상태를 CSE에서 다시 확인했어요 (${state ? '켜짐' : '꺼짐'}).`, receivedAt, `confirm:${key}`);
    },
    /** Merge into a guardian portal snapshot of the same household; other roles stay unchanged. */
    apply(snapshot: unknown): unknown {
      if (!record(snapshot) || !record(snapshot['principal']) || snapshot['principal']['role'] !== 'guardian') return snapshot;
      const households = Array.isArray(snapshot['households']) ? snapshot['households'] as unknown[] : [];
      if (!households.some((house) => record(house) && house['householdId'] === guardian.householdId)) return snapshot;
      const existingIncidents = Array.isArray(snapshot['incidents']) ? snapshot['incidents'] as unknown[] : [];
      const existingNotifications = Array.isArray(snapshot['notifications']) ? snapshot['notifications'] as unknown[] : [];
      const ids = new Set(existingIncidents.flatMap((item) => (record(item) && typeof item['incidentId'] === 'string' ? [item['incidentId']] : [])));
      const requests = Array.isArray(snapshot['commandRequests']) ? snapshot['commandRequests'] as unknown[] : [];
      const confirmed = (request: Record<string, unknown>) => Array.isArray(request['commands']) && request['commands'].length > 0
        && request['commands'].every((command: unknown) => record(command) && typeof command['commandId'] === 'string' && appliedCommands.has(command['commandId']));
      return {
        ...snapshot,
        commandRequests: requests.map((request) => (record(request) && confirmed(request) ? { ...request, effectiveStatus: 'CONFIRMED_BY_CSE' } : request)),
        incidents: [...[...incidents.values()].filter((item) => !ids.has(item.incidentId)).reverse(), ...existingIncidents],
        notifications: [...notifications, ...existingNotifications],
      };
    },
    get incidents() { return [...incidents.values()]; },
    get notifications() { return [...notifications]; },
    get received() { return [...received]; },
  };
}

export async function startCseLiveSource(config: CseLiveConfig, options: { fetchImpl?: FetchLike } = {}) {
  const { cse } = config;
  const cseBase = cse.cseBase.replace(/\/$/, '');
  const ttlSec = config.subscriptionTtlSec ?? 86400;
  const keyringLabel = config.labels?.keyring ?? 'pb-keyring';
  const incidentLabel = config.labels?.incidents ?? 'pb-incidents';
  const client = (originator: string) => new Onem2mClient({ endpoint: cse.endpoint, originator, ...(cse.rvi ? { rvi: cse.rvi } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const operator = client(config.operator.aeId);
  const guardian = config.guardian ? client(config.guardian.aeId) : null;
  const log = createLiveEventLog({ simulation: config.simulation, roleScope: ['operator'] });
  // Resident feed: each app keeps the log of its own subscriptions (the guardian card, the operator triage audit).
  const alertLogs = { guardian: createLiveEventLog({ simulation: config.simulation, roleScope: ['guardian'], maxEvents: 2000 }), operator: createLiveEventLog({ simulation: config.simulation, roleScope: ['operator'], maxEvents: 2000 }) };
  const residentStatus = new Map<string, string>();
  const latestLocation = new Map<string, { cin: ContentInstance; receivedAt: string }>();
  const feedLabel = config.residents?.label ?? 'pb-guardian-feed';
  const overlay = config.guardian ? createGuardianOverlay(config.guardian) : null;
  const subscriptions = new Map<string, SubscriptionEntry>();
  const operatorBindings = new Map<string, CseBinding>();
  const keyrings = new Map<string, Keyring>();
  const guardianKeyrings = new Map<string, Keyring>();
  const latestCt = new Map<string, string>();
  const stats = {
    notifications: 0, unmatchedNotifications: 0, subscriptionsCreated: 0, subscriptionsDenied: [] as string[], discoveries: 0,
    resyncs: [] as { reason: string; at: string; containers: number; recovered: number; durationMs: number }[],
    publications: [] as unknown[], recoveredByResync: [] as string[],
  };

  function appendOperator(binding: CseBinding, cin: ContentInstance, receivedAt: string): readonly DashboardEvent[] {
    const events = log.append(binding, cin, receivedAt);
    const previous = latestCt.get(binding.containerPath);
    if (!previous || cin.ct > previous) latestCt.set(binding.containerPath, cin.ct);
    return events;
  }

  async function onNotify(app: string, body: unknown, receivedAt: string) {
    const parsed = parseNotification(body);
    if (!parsed) return;
    const key = normalizeStructuredId(parsed.sur, cseBase);
    const entry = subscriptions.get(key);
    if (!entry || entry.app !== app) { stats.unmatchedNotifications += 1; return; }
    stats.notifications += 1;
    if (parsed.deletion) { subscriptions.delete(key); return; }
    if (entry.kind === 'confirm') {
      const sgn = record(body) && record(body['m2m:sgn']) ? body['m2m:sgn'] : {};
      const rep = record(sgn['nev']) && record(sgn['nev']['rep']) ? sgn['nev']['rep'] : {};
      const state = record(rep['cod:binSh']) ? rep['cod:binSh']['state'] : undefined;
      if (typeof state === 'boolean' && entry.binding.deviceId) overlay?.confirm(entry.binding.deviceId, state, receivedAt, `${key}:${receivedAt}`);
      return;
    }
    if (!parsed.cin) return;
    if (entry.kind === 'alert') appendAlert(entry.app, entry.binding, parsed.cin, receivedAt);
    else if (app === 'operator') appendOperator(entry.binding, parsed.cin, receivedAt);
    else overlay?.ingest(entry.binding, parsed.cin, receivedAt);
  }

  /** Location samples arrive every 20 s; only a change of At home / Moving becomes a record, the latest fix is cached for the lease map. */
  function appendAlert(app: App, binding: CseBinding, cin: ContentInstance, receivedAt: string) {
    if (binding.feed?.container === 'location') {
      const root = binding.containerPath.slice(0, -'/location'.length);
      const previous = latestLocation.get(root);
      if (!previous || cin.ct >= previous.cin.ct) latestLocation.set(root, { cin, receivedAt });
      const status = residentStatusOf(cin.con); const key = `${app}|${root}`; const state = status ? `${status.state}|${status.place ?? ''}` : null;
      if (state === null || residentStatus.get(key) === state) return;
      residentStatus.set(key, state);
    }
    alertLogs[app].append(binding, cin, receivedAt);
  }

  const ingress: NotificationIngress = await startNotificationIngress({ cseId: cse.cseId, ...(config.notification?.host ? { host: config.notification.host } : {}), ...(config.notification?.port === undefined ? {} : { port: config.notification.port }), onNotify });
  await operator.registerAe(cseBase, { rn: config.operator.rn, api: 'Npb.operator.dashboard', poa: [`${ingress.url}/operator`], lbl: ['pb-app-operator'] });
  if (guardian && config.guardian) await guardian.registerAe(cseBase, { rn: config.guardian.rn, api: 'Npb.guardian.portal', poa: [`${ingress.url}/guardian`], lbl: ['pb-app-guardian'] });

  async function subscribe(app: App, appClient: Onem2mClient, aeId: string, binding: CseBinding, kind: 'stream' | 'alert' = 'stream') {
    const path = `${binding.containerPath}/sub-${app}`;
    if (subscriptions.has(path)) return true;
    await appClient.request('DELETE', path);
    const created = await appClient.request('POST', binding.containerPath, { ty: 23, body: { 'm2m:sub': { rn: `sub-${app}`, nu: [aeId], su: aeId, enc: { net: [3], chty: [4] }, nct: 1, et: isoToOneM2mTime(Date.now() + ttlSec * 1000), lbl: [`pb-app-${app}`] } } });
    if (created.rsc !== 2001) { stats.subscriptionsDenied.push(`${app}:${binding.containerPath}:${created.rsc}`); return false; }
    subscriptions.set(path, { app, binding, kind });
    stats.subscriptionsCreated += 1;
    if (kind === 'alert') await backfillAlert(app, appClient, binding).catch(() => undefined);
    return true;
  }

  /** Records written before the subscription existed: children by creationTime (location: la only). */
  async function backfillAlert(app: App, appClient: Onem2mClient, binding: CseBinding) {
    const receivedAt = new Date().toISOString();
    if (binding.feed?.container === 'location') {
      const latest = await appClient.request('GET', `${binding.containerPath}/la`);
      const cin = latest.rsc === 2000 ? parseContentInstance(latest.payload?.['m2m:cin']) : null;
      if (cin) appendAlert(app, binding, cin, receivedAt);
      return;
    }
    const discovery = await appClient.request('GET', binding.containerPath, { query: { fu: 1, ty: 4, lim: 100 } });
    const found: ContentInstance[] = [];
    for (const uri of discoveredUris(discovery.payload)) {
      const read = await appClient.request('GET', uri);
      const cin = read.rsc === 2000 ? parseContentInstance(read.payload?.['m2m:cin']) : null;
      if (cin) found.push(cin);
    }
    found.sort((a, b) => a.ct.localeCompare(b.ct) || (a.st ?? 0) - (b.st ?? 0));
    for (const cin of found) appendAlert(app, binding, cin, receivedAt);
  }

  /** Resident feed containers by label; the container name selects the record mapping. */
  async function discoverResidentFeeds() {
    if (!config.residents || !config.guardian || !guardian) return;
    const residents = config.residents;
    const writers = { ...residents.writers, guardian: [config.guardian.aeId] };
    const uris = discoveredUris((await guardian.expect('GET', cseBase, [2000, 4004], { query: { fu: 1, ty: 3, lbl: feedLabel } })).payload);
    for (const containerPath of uris) {
      const name = containerPath.split('/').at(-1) as FeedContainer;
      if (!FEED_CONTAINERS.includes(name)) continue;
      const read = await guardian.request('GET', containerPath);
      const cnt = record(read.payload?.['m2m:cnt']) ? read.payload['m2m:cnt'] as Record<string, unknown> : null;
      const labels = Array.isArray(cnt?.['lbl']) ? (cnt['lbl'] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
      const residentId = labelValue(labels, 'pb-resident-') ?? residents.residentId ?? 'resident';
      if (residents.residentId && residentId !== residents.residentId) continue;
      const binding: CseBinding = { stream: 'alert-feed', containerPath, deviceId: null, gatewayId: null, expectedCreator: writers.triage[0] ?? '', feed: { container: name, residentId, writers } };
      await subscribe('guardian', guardian, config.guardian.aeId, binding, 'alert');
      if (name !== 'location') await subscribe('operator', operator, config.operator.aeId, binding, 'alert');
    }
  }

  async function discoverKeyrings(appClient: Onem2mClient) {
    const roots = discoveredUris((await appClient.expect('GET', cseBase, [2000, 4004], { query: { fu: 1, ty: 3, lbl: keyringLabel } })).payload);
    const found: Keyring[] = [];
    for (const root of roots) {
      const read = await appClient.request('GET', root);
      const cnt = record(read.payload?.['m2m:cnt']) ? read.payload['m2m:cnt'] as Record<string, unknown> : null;
      const labels = Array.isArray(cnt?.['lbl']) ? (cnt['lbl'] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
      const deviceId = labelValue(labels, 'pb-device-') ?? root.split('/').at(-1) ?? root;
      found.push({ deviceId, gatewayId: labelValue(labels, 'pb-gateway-'), householdId: labelValue(labels, 'pb-household-'), root });
    }
    return found;
  }

  /** Discovery by label, then one subscription per container the AE is permitted to watch. */
  async function refresh() {
    stats.discoveries += 1;
    for (const keyring of await discoverKeyrings(operator)) {
      keyrings.set(keyring.deviceId, keyring);
      for (const stream of OPERATOR_STREAMS) {
        const binding: CseBinding = { stream, containerPath: `${keyring.root}/${stream}`, deviceId: keyring.deviceId, gatewayId: keyring.gatewayId, expectedCreator: stream === 'command' ? config.guardian?.aeId ?? config.gatewayAeId : config.gatewayAeId };
        if (await subscribe('operator', operator, config.operator.aeId, binding)) operatorBindings.set(binding.containerPath, binding);
      }
    }
    const incidentContainers = discoveredUris((await operator.expect('GET', cseBase, [2000, 4004], { query: { fu: 1, ty: 3, lbl: incidentLabel } })).payload);
    for (const containerPath of incidentContainers) {
      const binding: CseBinding = { stream: 'incident', containerPath, deviceId: null, gatewayId: null, expectedCreator: config.automationAeId };
      if (await subscribe('operator', operator, config.operator.aeId, binding)) operatorBindings.set(containerPath, binding);
      if (guardian && config.guardian) await subscribe('guardian', guardian, config.guardian.aeId, binding);
    }
    if (guardian && config.guardian) {
      for (const keyring of await discoverKeyrings(guardian)) {
        if (keyring.householdId !== config.guardian.householdId) continue;
        guardianKeyrings.set(keyring.deviceId, keyring);
        for (const stream of GUARDIAN_STREAMS) await subscribe('guardian', guardian, config.guardian.aeId, { stream, containerPath: `${keyring.root}/${stream}`, deviceId: keyring.deviceId, gatewayId: keyring.gatewayId, expectedCreator: config.gatewayAeId });
      }
    }
    await discoverResidentFeeds();
  }

  /** Recover through the CSE: la/ RETRIEVE per container, createdAfter discovery for gaps. */
  async function resyncBinding(binding: CseBinding): Promise<number> {
    const latest = await operator.request('GET', `${binding.containerPath}/la`);
    const cin = latest.rsc === 2000 ? parseContentInstance(latest.payload?.['m2m:cin']) : null;
    if (!cin || log.has(binding, cin.ri)) return 0;
    const receivedAt = new Date().toISOString();
    const missed: ContentInstance[] = [];
    const since = latestCt.get(binding.containerPath);
    if (since) {
      const discovery = await operator.request('GET', binding.containerPath, { query: { fu: 1, ty: 4, cra: minusOneSecond(since), lim: 50 } });
      for (const uri of discoveredUris(discovery.payload)) {
        const read = await operator.request('GET', uri);
        const item = read.rsc === 2000 ? parseContentInstance(read.payload?.['m2m:cin']) : null;
        if (item && !log.has(binding, item.ri) && item.ri !== cin.ri) missed.push(item);
      }
      missed.sort((a, b) => a.ct.localeCompare(b.ct) || (a.st ?? 0) - (b.st ?? 0));
    }
    let recovered = 0;
    for (const item of [...missed, cin]) {
      if (appendOperator(binding, item, receivedAt).length > 0) { recovered += 1; stats.recoveredByResync.push(`${binding.containerPath}/${item.rn}`); }
    }
    return recovered;
  }

  let running: Promise<{ recovered: number }> | null = null;
  async function resync(reason: string) {
    if (running) return running;
    running = (async () => {
      const started = Date.now();
      let recovered = 0;
      try { await refresh(); } catch { /* discovery errors keep existing subscriptions */ }
      for (const binding of operatorBindings.values()) {
        try { recovered += await resyncBinding(binding); } catch { /* one container failure does not block the rest */ }
      }
      stats.resyncs.push({ reason, at: new Date().toISOString(), containers: operatorBindings.size, recovered, durationMs: Date.now() - started });
      stats.resyncs.splice(0, Math.max(0, stats.resyncs.length - 20));
      return { recovered };
    })().finally(() => { running = null; });
    return running;
  }

  /** Guardian approval → transient <group> (et = deadline) → one fopt CREATE fans out to keyring command containers. */
  async function publishApproved(result: unknown) {
    if (!guardian || !config.guardian) throw new Error('보호자 AE 설정을 확인하세요.');
    if (!record(result) || !Array.isArray(result['commands']) || typeof result['requestId'] !== 'string') throw new Error('승인 결과 형식을 확인하세요.');
    const commands = result['commands'].filter(record);
    if (commands.length === 0) throw new Error('승인된 명령을 확인하세요.');
    const members: string[] = [];
    for (const command of commands) {
      const keyring = guardianKeyrings.get(String(command['deviceId']));
      if (!keyring) throw new Error(`CSE에서 ${String(command['deviceId'])} 키링을 찾지 못했어요.`);
      members.push(`${keyring.root}/command`);
    }
    const deadline = Math.min(...commands.map((command) => Date.parse(String(command['deadline']))));
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('명령 유효기간을 확인하세요.');
    const suffix = randomBytes(3).toString('hex');
    const shortId = `${result['requestId'].replace(/[^A-Za-z0-9]/g, '').slice(-10)}${suffix}`;
    const groupRn = `cmd-${shortId}`;
    const aePath = `${cseBase}/${config.guardian.rn}`;
    const et = isoToOneM2mTime(deadline);
    const group = await guardian.expect('POST', aePath, [2001], { ty: 9, body: { 'm2m:grp': { rn: groupRn, mt: 3, mnm: members.length, mid: members.map((path) => path.replace(/^\//, '')), csy: 1, et, lbl: ['pb-command-group', `pb-request-${result['requestId']}`] } } });
    // Transient confirmation subscriptions exist before the fan-out, so the first readback is not missed.
    const confirmations = [];
    for (const command of commands) {
      const keyring = guardianKeyrings.get(String(command['deviceId']));
      if (!keyring) continue;
      const switchPath = `${keyring.root}/switch`;
      const rn = `confirm-${shortId}`;
      const created = await guardian.request('POST', switchPath, { ty: 23, body: { 'm2m:sub': { rn, nu: [config.guardian.aeId], enc: { net: [1], atr: ['state'] }, nct: 2, et, lbl: ['pb-app-guardian', 'pb-transient'] } } });
      if (created.rsc === 2001) subscriptions.set(`${switchPath}/${rn}`, { app: 'guardian', kind: 'confirm', requestId: String(result['requestId']), binding: { stream: 'receipt', containerPath: switchPath, deviceId: keyring.deviceId, gatewayId: keyring.gatewayId, expectedCreator: config.gatewayAeId } });
      confirmations.push({ path: `${switchPath}/${rn}`, rsc: created.rsc, et });
    }
    const bundle = {
      version: 1, type: COMMAND_BUNDLE_TYPE, requestId: result['requestId'], approvalHash: result['approvalHash'] ?? null, approvedBy: result['approvedBy'] ?? config.guardian.principalId,
      groupId: groupRn, commands: commands.map((command) => ({ command, payloadHash: commandPayloadHash(command) })), publishedAt: new Date().toISOString(),
    };
    const publishedMs = Date.now();
    const fanout = await guardian.expect('POST', `${aePath}/${groupRn}/fopt`, [2000], { ty: 4, body: { 'm2m:cin': { rn: `cmd-${shortId}`, cnf: 'application/json:0', con: bundle, cr: null, et, lbl: ['pb-command', `pb-request-${result['requestId']}`] } } });
    const rsp = record(fanout.payload?.['m2m:agr']) ? (fanout.payload['m2m:agr'] as Record<string, unknown>)['m2m:rsp'] : [];
    const memberResults = (Array.isArray(rsp) ? rsp : []).filter(record).map((item) => {
      const pc = record(item['pc']) && record(item['pc']['m2m:cin']) ? item['pc']['m2m:cin'] as Record<string, unknown> : {};
      return { member: String(item['fr'] ?? ''), rsc: Number(item['rsc']), ri: pc['ri'] ?? null, ct: pc['ct'] ?? null };
    });
    if (memberResults.length !== members.length || memberResults.some((item) => item.rsc !== 2001)) throw Object.assign(new Error('그룹 fan-out 결과를 확인하세요.'), { memberResults });
    const report = { requestId: result['requestId'], groupPath: `${aePath}/${groupRn}`, groupRsc: group.rsc, groupEt: et, members, memberResults, bundleHash: commandPayloadHash(bundle), payloadHashes: bundle.commands.map((item) => item.payloadHash), publishedAt: new Date(publishedMs).toISOString(), confirmations };
    stats.publications.push(report);
    return report;
  }

  const feedView = (app: App): AlertFeed => ({
    source: LIVE_SOURCE, simulation: config.simulation,
    get events() { return alertLogs[app].events; }, get lastSequence() { return alertLogs[app].lastSequence; }, subscribe: alertLogs[app].subscribe,
  });
  /** Feed root (.../ev-c4) of a card, from the resource of any of its records. */
  const feedRoot = (card: AlertCard): string | null => {
    for (const event of alertLogs.guardian.events) {
      if (event.type !== 'guardian.alert') continue;
      const item = event.receipt;
      if (item.oneM2MResource && ((item.incidentId && item.incidentId === card.incidentId) || (item.alertId && item.alertId === card.alertId))) return item.oneM2MResource.split('/').slice(0, -2).join('/');
    }
    return null;
  };
  /** Guardian decisions go to the CSE as the guardian AE; the triage runtime decides with this exact hash and applies the lease. */
  const alerts: AlertBackend | null = config.residents && config.guardian && guardian ? {
    mode: 'live', guardianId: config.guardian.principalId, guardian: feedView('guardian'), operator: feedView('operator'),
    async review(card, input) {
      if (!input.requestResource || !card.draft) throw new Error('승인 요청 컨테이너를 찾지 못했어요.');
      const con = { type: 'GUARDIAN_REVIEW', approvalRequestId: card.draft.approvalRequestId, draftId: card.draft.draftId, reviewedDraftHash: input.reviewedDraftHash, decision: input.decision, guardianId: config.guardian!.principalId, reviewedAt: new Date().toISOString() };
      const created = await guardian.expect('POST', input.requestResource, [2001], { ty: 4, body: { 'm2m:cin': { rn: `review-${card.draft.approvalRequestId.replace(/^approval-/, '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)}`, cnf: 'application/json:0', con, cr: null } } });
      const cin = record(created.payload?.['m2m:cin']) ? created.payload['m2m:cin'] as Record<string, unknown> : {};
      return { status: 'SUBMITTED', resource: `${input.requestResource}/${String(cin['rn'] ?? '')}`, payloadHash: commandPayloadHash(con) };
    },
    async requestShare(card, input) {
      if (!input.container) throw new Error('보호자 기록 컨테이너를 찾지 못했어요.');
      const con = { type: 'SHARE_REQUEST', requestId: input.requestId, alertId: card.alertId, incidentId: card.incidentId, purpose: input.purpose, durationMinutes: input.durationMinutes, guardianId: config.guardian!.principalId, requestedAt: new Date().toISOString() };
      await guardian.expect('POST', input.container, [2001], { ty: 4, body: { 'm2m:cin': { rn: input.requestId, cnf: 'application/json:0', con, cr: null } } });
    },
    async feedback(card, learning, container) {
      if (!container) throw new Error('보호자 기록 컨테이너를 찾지 못했어요.');
      const con = { type: 'GUARDIAN_FEEDBACK', feedback: 'ALERT_OK', alertId: card.alertId, incidentId: card.incidentId, guardianId: config.guardian!.principalId, guardianDismissedOk: true, learn: learning.learn, mode: learning.mode, reason: learning.reason, at: new Date().toISOString() };
      await guardian.expect('POST', container, [2001], { ty: 4, body: { 'm2m:cin': { cnf: 'application/json:0', con, cr: null } } });
      return { status: 'SUBMITTED', learning };
    },
    async location(card, lang): Promise<LocationSnapshot | null> {
      const root = feedRoot(card);
      if (!activeLease(card) || !root) return null;
      let latest = latestLocation.get(root);
      if (!latest) {
        const read = await guardian.request('GET', `${root}/location/la`);
        const cin = read.rsc === 2000 ? parseContentInstance(read.payload?.['m2m:cin']) : null;
        if (cin) { latest = { cin, receivedAt: new Date().toISOString() }; latestLocation.set(root, latest); }
      }
      const con = latest && record(latest.cin.con) ? latest.cin.con : null;
      // R17 samples carry con.grid; the MEC IPE record carries the cin loc attribute ([lon, lat], three decimals).
      let point: { lat: number; lon: number } | null = con && record(con['grid']) && typeof con['grid']['lat'] === 'number' && typeof con['grid']['lon'] === 'number' ? { lat: con['grid']['lat'], lon: con['grid']['lon'] } : null;
      const loc = latest ? (latest.cin as unknown as { loc?: { crd?: unknown } }).loc : undefined;
      if (!point && typeof loc?.crd === 'string') { try { const [lon, lat] = JSON.parse(loc.crd) as number[]; if (typeof lat === 'number' && typeof lon === 'number') point = { lat, lon }; } catch { /* malformed loc */ } }
      if (!latest || !point) return null;
      const observedAt = oneM2mTimeToIso(latest.cin.ct);
      const relay = con && record(con['relay']) && typeof con['relay']['rssiDbm'] === 'number' && typeof con['relay']['gatewayId'] === 'string' ? con['relay'] : null;
      const simulated = config.simulation || con?.['simulation'] === true;
      const label = lang === 'en' ? "Mom's keyring" : '어머니 키링';
      // Three-decimal coordinates bound the error to about 70 m here; the circle shows that bound, not a precise fix.
      return { schemaVersion: '1.0.0', mode: 'live', source: 'portal-api', simulation: simulated, updatedAt: new Date().toISOString(), rejectedRecords: 0, caughtUp: true,
        gateways: relay ? [{ gatewayId: String(relay['gatewayId']), label: lang === 'en' ? "Mom's phone (BLE relay)" : '어머니 휴대폰 (BLE 중계)', position: point, simulation: relay['simulation'] !== false, referenceRssiDbm: Number(relay['referenceRssiDbm'] ?? -59), pathLossExponent: Number(relay['pathLossExponent'] ?? 2) }] : [],
        devices: [{ deviceId: card.residentId, label, position: { coordinates: point, source: 'mec', observedAt, accuracyM: 70, simulation: simulated },
          ble: relay ? { gatewayId: String(relay['gatewayId']), rssiDbm: Math.round(Number(relay['rssiDbm'])), observedAt, simulation: relay['simulation'] !== false } : null }] };
    },
    describe() { return { mode: 'live', label: feedLabel, guardian: alertLogs.guardian.lastSequence, operator: alertLogs.operator.lastSequence, locations: latestLocation.size }; },
  } : null;

  await refresh();
  await resync('startup');
  const timer = config.refreshMs ? setInterval(() => { void refresh().catch(() => {}); }, config.refreshMs) : null;
  timer?.unref();

  return {
    source: LIVE_SOURCE,
    simulation: config.simulation,
    get events() { return log.events; },
    get lastSequence() { return log.lastSequence; },
    subscribe: log.subscribe,
    resync,
    refresh,
    publishApproved,
    guardianOverlay: overlay,
    alerts,
    describe() {
      return {
        transport: 'oneM2M HTTP notifications', cseId: cse.cseId, notificationUrl: ingress.url,
        apps: { operator: config.operator.aeId, ...(config.guardian ? { guardian: config.guardian.aeId } : {}) },
        keyrings: [...keyrings.keys()], subscriptions: subscriptions.size, notifications: stats.notifications, unmatchedNotifications: stats.unmatchedNotifications,
        subscriptionsDenied: stats.subscriptionsDenied, resyncs: stats.resyncs, recoveredByResync: stats.recoveredByResync.length, publications: stats.publications.length, ingress: ingress.stats,
        ...(overlay ? { guardian: { incidents: overlay.incidents.length, notifications: overlay.notifications.length, received: overlay.received.slice(-50) } } : {}),
      };
    },
    stats,
    async close() {
      if (timer) clearInterval(timer);
      for (const [path, entry] of subscriptions) {
        const owner = entry.app === 'operator' ? operator : guardian;
        await owner?.request('DELETE', path).catch(() => undefined);
      }
      await ingress.close();
    },
  };
}
export type CseLiveSource = Awaited<ReturnType<typeof startCseLiveSource>>;
