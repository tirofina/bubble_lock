import { createHash } from 'node:crypto';
import { createLiveEventLog, LIVE_SOURCE, oneM2mTimeToIso, parseContentInstance } from '../shared/cse-notification.ts';
import type { ContentInstance, CseBinding } from '../shared/cse-notification.ts';
import { discoveredUris, Onem2mClient } from './onem2m.ts';
import type { FetchLike } from './onem2m.ts';
import { createMtlsFetch } from './mtls-fetch.ts';
import type { RoleBinding } from './mtls-fetch.ts';
import type { CseLiveConfig } from './cse-live.ts';
import type { LocationDevice } from '../shared/location.ts';

/**
 * Polling source for the self-hosted Mobius gateway layout (layout: 'gateway-container').
 *
 * The gateway writes plain contentInstances to <ae>/<gateway>/{observations,receipts,health}
 * without keyring labels, and the CSE sits on an internal network that cannot deliver
 * notifications back to the dashboard PC. The source therefore reads <container>/la every
 * pollMs, discovers devices from observation deviceIds, and maps changes to the guardian
 * notification types (KEYRING_BUTTON, KEYRING_BATTERY_LOW, KEYRING_STATE_CONFIRMED, COMMAND_APPLIED).
 */
export interface GatewayLayoutPaths { readonly observations: string; readonly receipts?: string; readonly health?: string; readonly location?: string; readonly locationDeviceId?: string; readonly locationLabel?: string; readonly locationSimulated?: boolean }

/** MEC013 location cin (MEC IPE): loc.crd is a GeoJSON point string "[lon,lat]"; the fix belongs to the keyring the resident carries.
 * `simulated` marks fixes of emulated UEs (ETSI MEC Sandbox scenario), which the password-account map is allowed to show. */
export function mecLocationFix(raw: unknown, deviceId: string, label: string, simulated = false): LocationDevice | null {
  if (!record(raw) || !record(raw['con'])) return null;
  const con = raw['con'];
  const loc = record(raw['loc']) ? raw['loc'] : null;
  let crd: unknown = loc?.['crd'];
  if (typeof crd === 'string') { try { crd = JSON.parse(crd); } catch { return null; } }
  if (!Array.isArray(crd) || crd.length < 2) return null;
  const lon = num(crd[0]); const lat = num(crd[1]);
  const observedAt = typeof con['observedAt'] === 'string' && Number.isFinite(Date.parse(con['observedAt'])) ? con['observedAt'] : null;
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180 || !observedAt) return null;
  const accuracy = num(con['accuracyM']);
  return { deviceId, label, ble: null, position: { coordinates: { lat, lon }, source: 'mec', observedAt, accuracyM: accuracy !== null && accuracy >= 0 && accuracy <= 100000 ? accuracy : null, simulation: simulated || con['simulation'] === true } };
}

interface DeviceView {
  deviceId: string; gatewayId: string; lastSeen: string; battery: number | null; state: boolean | null;
  firmwareRevision: string | null; buttonState: string | null; presses: number | null; confirms: number | null; panics: number | null; rssi: number | null; sequence: number | null;
}
interface PollNotification { notificationId: string; householdId: string; principalId: string; type: string; title: string; createdAt: string; readAt: null; source: 'cse-live' }

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const BATTERY_LOW_PCT = 15;
/** PANIC from the keyring: the portal opens an emergency incident or escalates the open one. */
export interface PanicEvent { deviceId: string; at: string; key: string }

export async function startGatewayPollSource(config: CseLiveConfig, options: { fetchImpl?: FetchLike } = {}) {
  const paths = config.paths;
  if (!paths?.observations) throw new TypeError('gateway-container 레이아웃에는 paths.observations를 지정하세요.');
  const { cse } = config;
  // R10: with config.roles the operator timeline and the guardian view each read through their own role AE (mTLS);
  // the admin originator is never used. Without roles the single legacy reader serves both (local tests, relay).
  const roleClient = (binding: RoleBinding) => new Onem2mClient({ endpoint: binding.endpoint, originator: binding.originator, ...(cse.rvi ? { rvi: cse.rvi } : {}), fetchImpl: options.fetchImpl ?? createMtlsFetch(binding) });
  const roleReaders = config.roles ? { operator: roleClient(config.roles.operator), guardian: config.roles.guardian ? roleClient(config.roles.guardian) : null } : null;
  const legacyReader = roleReaders ? null : new Onem2mClient({ endpoint: cse.endpoint, originator: config.gatewayReader ?? config.operator.aeId, ...(cse.rvi ? { rvi: cse.rvi } : {}), ...(cse.allowLanHttp ? { allowLanHttp: true } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const pollMs = config.pollMs ?? 2500;
  const backlog = config.backlog ?? 20;
  const log = createLiveEventLog({ simulation: config.simulation, roleScope: ['operator'], maxEvents: 2000 });
  const devices = new Map<string, DeviceView>();
  const notifications: PollNotification[] = [];
  const seen = new Map<string, Set<string>>();
  const stats = { polls: 0, errors: 0, lastError: null as string | null, lastPollAt: null as string | null, contentInstances: 0 };
  /** Last oneM2M result per role; 4103 means the role AE has no right on that container. */
  const roleStatus: Record<string, { originator: string; lastRsc: number | null; denied: string[] }> = {};
  const operatorReader = roleReaders?.operator ?? legacyReader!;
  const guardianReader = roleReaders ? roleReaders.guardian : null;
  if (roleReaders) { roleStatus['operator'] = { originator: roleReaders.operator.originator, lastRsc: null, denied: [] }; if (roleReaders.guardian) roleStatus['guardian'] = { originator: roleReaders.guardian.originator, lastRsc: null, denied: [] }; }
  const gatewayCreator = config.gatewayAeId;
  const panicListeners: ((event: PanicEvent) => Promise<void> | void)[] = [];
  let panicChain: Promise<void> = Promise.resolve();
  /** Incidents escalated by a later PANIC (incidentId -> count, last time) and incidents opened by PANIC. */
  const escalations = new Map<string, { count: number; at: string; deviceId: string }>();
  const emergencies = new Set<string>();
  let mecFix: LocationDevice | null = null;

  const notify = (type: string, title: string, createdAt: string, key: string) => {
    const notificationId = `cse-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    if (notifications.some((item) => item.notificationId === notificationId)) return;
    notifications.unshift({ notificationId, householdId: '', principalId: '', type, title, createdAt, readAt: null, source: 'cse-live' });
    notifications.splice(50);
  };

  type Part = 'timeline' | 'view' | 'both';
  function observation(cin: ContentInstance, receivedAt: string, initial: boolean, part: Part = 'both') {
    const con = cin.con;
    if (!record(con) || typeof con['deviceId'] !== 'string') return;
    const deviceId = con['deviceId'];
    const sensors = record(con['sensorValues']) ? con['sensorValues'] : {};
    // Keyring firmware: buttonPresses = [confirm, panic] counters.
    const pressList = Array.isArray(sensors['buttonPresses']) ? sensors['buttonPresses'] as unknown[] : null;
    const presses = pressList ? pressList.reduce<number>((sum, item) => sum + (num(item) ?? 0), 0) : null;
    const createdAt = oneM2mTimeToIso(cin.ct);
    const previous = devices.get(deviceId);
    const next: DeviceView = {
      deviceId, gatewayId: typeof con['gatewayId'] === 'string' ? con['gatewayId'] : previous?.gatewayId ?? 'unknown',
      lastSeen: typeof con['receivedAt'] === 'string' ? con['receivedAt'] : createdAt,
      battery: num(con['battery']) ?? previous?.battery ?? null,
      state: typeof con['state'] === 'boolean' ? con['state'] : previous?.state ?? null,
      firmwareRevision: typeof con['firmwareRevision'] === 'string' ? con['firmwareRevision'] : previous?.firmwareRevision ?? null,
      buttonState: typeof con['buttonState'] === 'string' ? con['buttonState'] : null, presses, confirms: pressList ? num(pressList[0]) : null, panics: pressList ? num(pressList[1]) : null, rssi: num(con['rssi']), sequence: num(con['sequence']),
    };
    if (part !== 'view') {
      // Operator timeline: the existing telemetry mapping (records without battery or rssi become REVIEW).
      const binding: CseBinding = { stream: 'observation', containerPath: `${cse.cseBase.replace(/\/$/, '')}/${paths!.observations}`, deviceId, gatewayId: next.gatewayId, expectedCreator: gatewayCreator };
      log.append(binding, { ...cin, cr: cin.cr ?? gatewayCreator }, receivedAt);
    }
    if (part === 'timeline') return;
    devices.set(deviceId, next);
    if (initial || !previous) return;
    const rose = (a: number | null, b: number | null) => a !== null && b !== null && a > b;
    const panic = rose(next.panics, previous.panics) || (next.buttonState === 'panic' && previous.buttonState !== 'panic' && next.panics === null);
    const confirmed = rose(next.confirms, previous.confirms) || (next.buttonState === 'confirm' && previous.buttonState !== 'confirm' && next.confirms === null);
    if (panic) {
      notify('KEYRING_PANIC', `${labelOf(deviceId)}: PANIC button pressed. Opening an emergency incident.`, createdAt, `panic:${cin.ri}`);
      // Several presses inside one observation (panic counter +2 or more) become one event per press, capped at 5.
      // The chain runs them in order, so the first opens the incident and the later ones escalate it.
      const steps = next.panics !== null && previous.panics !== null ? Math.min(5, Math.max(1, next.panics - previous.panics)) : 1;
      for (let step = 0; step < steps; step += 1) {
        const event = { deviceId, at: createdAt, key: step === 0 ? cin.ri : `${cin.ri}:${step}` };
        for (const listener of panicListeners) {
          panicChain = panicChain.then(() => listener(event)).catch((error) => { stats.lastError = `panic: ${error instanceof Error ? error.message : String(error)}`; });
        }
      }
    } else if (confirmed) notify('KEYRING_BUTTON', `${labelOf(deviceId)}: confirm button pressed.`, createdAt, `button:${cin.ri}`);
    else if ((next.buttonState === 'pressed' && previous.buttonState !== 'pressed') || rose(next.presses, previous.presses)) notify('KEYRING_BUTTON', `${labelOf(deviceId)}: button pressed.`, createdAt, `button:${cin.ri}`);
    const alert = sensors['batteryAlert'];
    const low = (next.battery !== null && next.battery <= BATTERY_LOW_PCT) || alert === true || alert === 'low' || alert === 'LOW';
    if (low) notify('KEYRING_BATTERY_LOW', `${labelOf(deviceId)}: battery ${next.battery === null ? 'is low' : `at ${next.battery}%`}.`, createdAt, `battery:${deviceId}:${next.battery ?? String(alert)}`);
    if (next.state !== null && previous.state !== null && next.state !== previous.state) {
      notify('KEYRING_STATE_CONFIRMED', `${labelOf(deviceId)}: state confirmed on the CSE (${next.state ? 'on' : 'off'}).`, createdAt, `confirm:${cin.ri}`);
    }
  }

  // Notifications name the keyring by its label when the config gives one (the MEC location keyring).
  const labelOf = (id: string) => (id === paths?.locationDeviceId && paths?.locationLabel ? paths.locationLabel : id);

  function receipt(cin: ContentInstance, receivedAt: string, initial: boolean, part: Part = 'both') {
    const con = record(cin.con) ? cin.con : {};
    const deviceId = typeof con['deviceId'] === 'string' ? con['deviceId'] : null;
    if (part !== 'view') {
      const binding: CseBinding = { stream: 'receipt', containerPath: `${cse.cseBase.replace(/\/$/, '')}/${paths!.receipts}`, deviceId, gatewayId: typeof con['gatewayId'] === 'string' ? con['gatewayId'] : null, expectedCreator: gatewayCreator };
      log.append(binding, { ...cin, cr: cin.cr ?? gatewayCreator }, receivedAt);
    }
    if (initial || part === 'timeline') return;
    const status = String(con['status'] ?? 'APPLIED');
    if (status === 'APPLIED') notify('COMMAND_APPLIED', `Protection mode applied to ${deviceId ? labelOf(deviceId) : 'the keyring'}.`, oneM2mTimeToIso(cin.ct), `receipt:${cin.ri}`);
  }

  const track = (role: string, path: string, rsc: number) => {
    const status = roleStatus[role]; if (!status) return;
    status.lastRsc = rsc;
    if (rsc === 4103 && !status.denied.includes(path)) status.denied.push(path);
    if (rsc === 2000) status.denied = status.denied.filter((item) => item !== path);
  };
  async function readCin(reader: Onem2mClient, role: string, uri: string) {
    const path = uri.startsWith('/') ? uri : `/${uri}`;
    const read = await reader.request('GET', path);
    track(role, path, read.rsc);
    return read.rsc === 2000 ? parseContentInstance(read.payload?.['m2m:cin']) : null;
  }

  async function pollContainer(reader: Onem2mClient, role: string, part: Part, relative: string, handle: (cin: ContentInstance, receivedAt: string, initial: boolean, part: Part) => void, initial: boolean) {
    const path = `${cse.cseBase.replace(/\/$/, '')}/${relative}`;
    const key = `${role}:${path}`;
    const known = seen.get(key) ?? new Set<string>();
    seen.set(key, known);
    const receivedAt = new Date().toISOString();
    if (initial) {
      const list = await reader.request('GET', path, { query: { fu: 1, ty: 4, lim: backlog } });
      track(role, path, list.rsc);
      const items: ContentInstance[] = [];
      for (const uri of discoveredUris(list.payload)) { const cin = await readCin(reader, role, uri); if (cin) items.push(cin); }
      items.sort((a, b) => a.ct.localeCompare(b.ct) || (a.st ?? 0) - (b.st ?? 0));
      for (const cin of items) { known.add(cin.ri); if (part !== 'view') stats.contentInstances += 1; handle(cin, receivedAt, true, part); }
      return;
    }
    const latest = await reader.request('GET', `${path}/la`);
    track(role, `${path}/la`, latest.rsc);
    const cin = latest.rsc === 2000 ? parseContentInstance(latest.payload?.['m2m:cin']) : null;
    if (!cin || known.has(cin.ri)) return;
    known.add(cin.ri);
    if (part !== 'view') stats.contentInstances += 1;
    handle(cin, receivedAt, false, part);
  }

  let running: Promise<{ recovered: number }> | null = null;
  async function poll(initial = false) {
    if (running) return running;
    running = (async () => {
      const before = stats.contentInstances;
      stats.polls += 1;
      try {
        // Operator timeline through the operator AE; the guardian device view through the guardian AE when roles are set.
        const operatorPart: Part = roleReaders ? 'timeline' : 'both';
        await pollContainer(operatorReader, 'operator', operatorPart, paths!.observations, observation, initial);
        if (paths!.receipts) await pollContainer(operatorReader, 'operator', operatorPart, paths!.receipts, receipt, initial);
        if (guardianReader) {
          await pollContainer(guardianReader, 'guardian', 'view', paths!.observations, observation, initial);
          if (paths!.receipts) await pollContainer(guardianReader, 'guardian', 'view', paths!.receipts, receipt, initial);
        }
        stats.lastError = null;
      } catch (error) { stats.errors += 1; stats.lastError = error instanceof Error ? error.message : String(error); }
      // MEC location (resident relay) for the guardian map; a failure here never blocks the keyring polling.
      if (paths!.location && paths!.locationDeviceId) {
        try {
          const reader = guardianReader ?? operatorReader;
          const path = `${cse.cseBase.replace(/\/$/, '')}/${paths!.location}/la`;
          const latest = await reader.request('GET', path);
          track(guardianReader ? 'guardian' : 'operator', path, latest.rsc);
          const fix = latest.rsc === 2000 ? mecLocationFix(latest.payload?.['m2m:cin'], paths!.locationDeviceId, paths!.locationLabel ?? paths!.locationDeviceId, paths!.locationSimulated === true) : null;
          if (fix) mecFix = fix;
        } catch (error) { stats.lastError = `location: ${error instanceof Error ? error.message : String(error)}`; }
      }
      stats.lastPollAt = new Date().toISOString();
      return { recovered: stats.contentInstances - before };
    })().finally(() => { running = null; });
    return running;
  }

  async function readHealth() {
    if (!paths!.health) return null;
    try {
      const cin = await readCin(operatorReader, 'operator', `${cse.cseBase.replace(/\/$/, '')}/${paths!.health}/la`);
      return cin && record(cin.con) ? cin.con : null;
    } catch { return null; }
  }

  /** Guardian snapshot overlay: CSE keyrings and notifications join the first household of the guardian. */
  const guardianOverlay = {
    apply(snapshot: unknown): unknown {
      if (!record(snapshot) || !record(snapshot['principal']) || snapshot['principal']['role'] !== 'guardian') return snapshot;
      const households = Array.isArray(snapshot['households']) ? snapshot['households'].filter(record) : [];
      const householdId = config.guardian?.householdId ?? (typeof households[0]?.['householdId'] === 'string' ? households[0]['householdId'] as string : null);
      if (!householdId) return snapshot;
      const principalId = typeof snapshot['principal']['principalId'] === 'string' ? snapshot['principal']['principalId'] : '';
      const existing = Array.isArray(snapshot['devices']) ? snapshot['devices'] as unknown[] : [];
      const live = new Map([...devices.values()].map((device) => [device.deviceId, device]));
      const merged = existing.map((item) => {
        if (!record(item) || typeof item['deviceId'] !== 'string' || !live.has(item['deviceId'])) return item;
        const device = live.get(item['deviceId'])!; live.delete(device.deviceId);
        return { ...item, ...view(device) };
      });
      const added = [...live.values()].map((device) => ({ deviceId: device.deviceId, householdId, gatewayId: device.gatewayId, label: labelOf(device.deviceId), registeredAt: device.lastSeen, ...view(device) }));
      const existingNotifications = Array.isArray(snapshot['notifications']) ? snapshot['notifications'] as unknown[] : [];
      const incidents = (Array.isArray(snapshot['incidents']) ? snapshot['incidents'] as unknown[] : []).map((item) => {
        if (!record(item) || typeof item['incidentId'] !== 'string') return item;
        const escalation = escalations.get(item['incidentId']);
        if (!escalation && !emergencies.has(item['incidentId'])) return item;
        const message = String(item['message'] ?? '');
        return { ...item, priority: 'EMERGENCY', message: escalation ? `[Escalated, PANIC x${escalation.count}] ${message}` : message, ...(escalation ? { escalatedAt: escalation.at, escalationCount: escalation.count } : {}) };
      });
      return {
        ...snapshot,
        incidents,
        devices: [...merged, ...added],
        notifications: [...notifications.map((item) => ({ ...item, householdId, principalId })), ...existingNotifications],
      };
    },
    get notifications() { return [...notifications]; },
    onPanic(listener: (event: PanicEvent) => Promise<void> | void) { panicListeners.push(listener); },
    markEmergency(incidentId: string) { emergencies.add(incidentId); },
    escalate(incidentId: string, event: PanicEvent) {
      const current = escalations.get(incidentId);
      escalations.set(incidentId, { count: (current?.count ?? 0) + 1, at: event.at, deviceId: event.deviceId });
      notify('INCIDENT_ESCALATED', `${labelOf(event.deviceId)} PANIC: the open incident is now an emergency.`, event.at, `escalate:${event.key}`);
    },
  };
  const view = (device: DeviceView) => ({
    lastSeen: device.lastSeen, battery: device.battery, state: device.state, firmwareRevision: device.firmwareRevision,
    buttonState: device.buttonState, rssi: device.rssi, sequence: device.sequence, source: 'cse-live' as const,
  });

  await poll(true);
  let health: Record<string, unknown> | null = await readHealth();
  const timer = setInterval(() => { void poll(); }, pollMs);
  const healthTimer = setInterval(() => { void readHealth().then((value) => { health = value; }); }, Math.max(pollMs * 4, 10000));
  timer.unref(); healthTimer.unref();

  return {
    source: LIVE_SOURCE,
    simulation: config.simulation,
    get events() { return log.events; },
    get lastSequence() { return log.lastSequence; },
    subscribe: log.subscribe,
    resync: (reason: string) => { void reason; return poll(); },
    refresh: () => poll(),
    async publishApproved(): Promise<unknown> { throw new Error('gateway-container 레이아웃은 읽기 전용이에요.'); },
    guardianOverlay,
    /** Latest MEC location fix for the configured keyring (lease gating stays in the portal). */
    locationDevices(): LocationDevice[] { return mecFix ? [mecFix] : []; },
    describe() {
      return {
        transport: `oneM2M HTTP polling (${pollMs} ms)`, layout: 'gateway-container', cseId: cse.cseId, paths,
        keyrings: [...devices.keys()], polls: stats.polls, errors: stats.errors, lastError: stats.lastError, lastPollAt: stats.lastPollAt,
        contentInstances: stats.contentInstances, notifications: notifications.length, mecLocation: mecFix ? { deviceId: mecFix.deviceId, observedAt: mecFix.position?.observedAt ?? null } : null,
        originators: roleReaders ? Object.fromEntries(Object.entries(roleStatus).map(([role, status]) => [role, { originator: status.originator, binding: 'mTLS client certificate', lastRsc: status.lastRsc, accessDenied: status.denied }])) : 'single reader (no role bindings)',
        gatewayHealth: health ? { gatewayId: health['gatewayId'] ?? null, observedAt: health['observedAt'] ?? null, devices: health['devices'] ?? null } : null,
      };
    },
    stats,
    async close() { clearInterval(timer); clearInterval(healthTimer); await running?.catch(() => undefined); },
  };
}
export type GatewayPollSource = Awaited<ReturnType<typeof startGatewayPollSource>>;
