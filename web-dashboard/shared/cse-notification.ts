import type { AcceptanceLabel, CommandPayload, CoreReceipt, DashboardEvent, IntegrationReceipt } from './types.ts';
import { parseDashboardEvent } from './validation.ts';

/**
 * oneM2M notification (m2m:sgn) to dashboard event mapping for the live CSE source.
 * Pure functions: no network, no clock except the receivedAt the caller passes in.
 */
export const LIVE_SOURCE = 'onem2m-cse-live' as const;
export const LIVE_ACCEPTANCE_LABEL: AcceptanceLabel = 'oneM2M CSE contentInstance creationTime';
export const COMMAND_BUNDLE_TYPE = 'privacy-bubble.command-bundle';
export const DISPATCH_RECORD_TYPE = 'privacy-bubble.gateway-dispatch';
export const INCIDENT_TYPE = 'privacy-bubble.automation-incident';
const GATEWAY_CONTRACT = 'privacy-bubble.raspberrypi-gateway' as const;

export type CseStream = 'observation' | 'button' | 'battery' | 'command' | 'receipt' | 'incident';

/** One subscribed container, and the only AE whose writes it accepts (creator attribute). */
export interface CseBinding {
  readonly stream: CseStream;
  readonly containerPath: string;
  readonly deviceId: string | null;
  readonly gatewayId: string | null;
  readonly expectedCreator: string;
}

export interface ContentInstance {
  readonly ri: string;
  readonly rn: string;
  readonly ct: string;
  readonly con: unknown;
  readonly cr?: string;
  readonly pi?: string;
  readonly et?: string;
  readonly st?: number;
}

export interface ParsedNotification {
  readonly sur: string;
  readonly net: number | null;
  readonly cin: ContentInstance | null;
  readonly verification: boolean;
  readonly deletion: boolean;
}

type Draft = Pick<DashboardEvent, 'type' | 'resourceUri'> & {
  readonly receipt: CoreReceipt | IntegrationReceipt | null;
  readonly acceptance: DashboardEvent['acceptance'];
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** TS-0004 6.3.3 timestamp (UTC, YYYYMMDDTHHMMSS[,ffffff]) to RFC 3339. */
export function oneM2mTimeToIso(value: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:[,.](\d{1,6}))?$/.exec(value);
  if (!match) throw new TypeError(`oneM2M timestamp format: ${value}`);
  const [, y, mo, d, h, mi, s, fraction] = match;
  const ms = Number((fraction ?? '0').padEnd(3, '0').slice(0, 3));
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms)).toISOString();
}

export function isoToOneM2mTime(value: string | number | Date): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

export function parseContentInstance(value: unknown): ContentInstance | null {
  if (!record(value) || !text(value['ri']) || !text(value['rn']) || !text(value['ct']) || !('con' in value)) return null;
  try { oneM2mTimeToIso(value['ct']); } catch { return null; }
  return value as unknown as ContentInstance;
}

/** Notify request body (TS-0004 7.5.1.2.2). Unknown shapes return null. */
export function parseNotification(body: unknown): ParsedNotification | null {
  const sgn = record(body) ? body['m2m:sgn'] : undefined;
  if (!record(sgn)) return null;
  const nev = record(sgn['nev']) ? sgn['nev'] : null;
  const rep = nev && record(nev['rep']) ? nev['rep'] : null;
  return {
    sur: typeof sgn['sur'] === 'string' ? sgn['sur'] : '',
    net: nev && typeof nev['net'] === 'number' ? nev['net'] : null,
    cin: rep ? parseContentInstance(rep['m2m:cin']) : null,
    verification: sgn['vrq'] === true,
    deletion: sgn['sud'] === true,
  };
}

/** Structured ID (sur or uril entry) to the /Mobius/... resource path. */
export function normalizeStructuredId(value: string, cseBase = '/Mobius'): string {
  const base = cseBase.replace(/^\//, '');
  const at = value.indexOf(`${base}/`);
  const relative = at >= 0 ? value.slice(at) : value === base ? base : value.replace(/^\//, '');
  return `/${relative}`;
}

function review(binding: CseBinding, cin: ContentInstance, reason: string, extra: Partial<CoreReceipt> = {}): Draft {
  return {
    type: 'receipt.review', resourceUri: `${binding.containerPath}/${cin.rn}`, acceptance: null,
    receipt: { status: 'REVIEW', timestamp: oneM2mTimeToIso(cin.ct), reason, oneM2MResource: `${binding.containerPath}/${cin.rn}`, requestId: cin.rn, transport: 'oneM2M-http', ...(binding.deviceId ? { deviceId: binding.deviceId } : {}), ...extra },
  };
}

function telemetry(binding: CseBinding, cin: ContentInstance): Draft {
  const con = cin.con;
  if (!record(con) || con['version'] !== 1 || !text(con['deviceId']) || !text(con['gatewayId']) || !Number.isInteger(con['sequence'])
      || typeof con['state'] !== 'boolean' || typeof con['battery'] !== 'number' || !Number.isInteger(con['rssi']) || !text(con['receivedAt'])) {
    return review(binding, cin, 'observation-schema');
  }
  if (binding.deviceId !== null && con['deviceId'] !== binding.deviceId) return review(binding, cin, 'observation-device-binding');
  const deviceId = con['deviceId'];
  const sequence = con['sequence'] as number;
  const resource = `${binding.containerPath}/${cin.rn}`;
  return {
    type: 'gateway.telemetry', resourceUri: resource, acceptance: null,
    receipt: {
      contractId: GATEWAY_CONTRACT, contractVersion: '1.0.0', docRevision: '2.0.0', gatewayId: con['gatewayId'], deviceId, sequence,
      dedupKey: `${deviceId}:${binding.stream}:${sequence}`, requestId: cin.rn, oneM2MResource: resource, responseStatus: 2001,
      status: 'APPLIED', transport: 'oneM2M-http', timestamp: oneM2mTimeToIso(cin.ct),
      payload: {
        deviceId, sequence, timestamp: con['receivedAt'], state: con['state'], batteryPct: Math.max(0, Math.min(100, Math.round(con['battery']))),
        rssiDbm: con['rssi'] as number, schemaVersion: '1.0.0', ...(text(con['bootId']) ? { bootId: con['bootId'] } : {}), gatewayId: con['gatewayId'], timestampSource: 'gateway-received',
      },
    },
  };
}

function commandAccepted(binding: CseBinding, cin: ContentInstance): Draft[] {
  const con = cin.con;
  if (!record(con) || con['type'] !== COMMAND_BUNDLE_TYPE || con['version'] !== 1 || !Array.isArray(con['commands'])) return [review(binding, cin, 'command-bundle-schema')];
  const groupId = text(con['groupId']) ? con['groupId'] : 'cse-group';
  return con['commands'].flatMap((entry: unknown) => {
    const command = record(entry) && record(entry['command']) ? entry['command'] : null;
    if (!command || !text(command['commandId']) || command['deviceId'] !== binding.deviceId) return [];
    return [{
      type: 'command.accepted' as const, resourceUri: `${binding.containerPath}/${cin.rn}`, receipt: null,
      acceptance: { commandId: command['commandId'], groupId, acceptedAt: oneM2mTimeToIso(cin.ct), label: LIVE_ACCEPTANCE_LABEL },
    }];
  });
}

function receipt(binding: CseBinding, cin: ContentInstance): Draft {
  const con = cin.con;
  const resource = `${binding.containerPath}/${cin.rn}`;
  if (!record(con) || con['version'] !== 1 || !text(con['deviceId']) || !text(con['commandId']) || !text(con['gatewayId'])) return review(binding, cin, 'receipt-schema');
  if (binding.deviceId !== null && con['deviceId'] !== binding.deviceId) return review(binding, cin, 'receipt-device-binding');
  const base = { contractId: GATEWAY_CONTRACT, contractVersion: '1.0.0' as const, docRevision: '2.0.0' as const, gatewayId: con['gatewayId'], deviceId: con['deviceId'], commandId: con['commandId'], oneM2MResource: resource, requestId: cin.rn, transport: 'oneM2M-http' as const };
  if (con['type'] === DISPATCH_RECORD_TYPE) {
    if (!record(con['command']) || !text(con['dispatchedAt'])) return review(binding, cin, 'dispatch-schema');
    return { type: 'command.dispatched', resourceUri: resource, acceptance: null, receipt: { ...base, status: 'DISPATCHED', topic: `oneM2M ${binding.containerPath} -> ${String(con['transport'] ?? 'ble')}`, timestamp: con['dispatchedAt'], payload: con['command'] as unknown as CommandPayload } };
  }
  const status = con['status'];
  const readback = record(con['readback']) && typeof con['readback']['state'] === 'boolean' ? { state: con['readback']['state'] } : null;
  if (status === 'APPLIED' && readback && ['APPLIED', 'DUPLICATE'].includes(String(con['ackCode'])) && text(con['receivedAt'])) {
    const native = con as unknown as { deviceId: string; commandId: string; gatewayId: string; payloadHash: string; grantRevision: number; ownershipEpoch: number; receivedAt: string; acceptedAt: string | null; appliedAt: string | null; ackCode: string; firmwareRevision: string | null; timestampSource: string };
    return {
      type: 'command.ack', resourceUri: resource, acceptance: null,
      receipt: {
        ...base, status: 'ACK_RECORDED', ackState: 'READBACK_VERIFIED', timestamp: oneM2mTimeToIso(cin.ct),
        payload: {
          deviceId: native.deviceId, commandId: native.commandId, ackState: 'READBACK_VERIFIED', timestamp: native.receivedAt,
          ...(native.acceptedAt ? { acceptedAt: native.acceptedAt } : {}), ...(native.appliedAt ? { appliedAt: native.appliedAt } : {}),
          ackCode: native.ackCode, readback, ...(native.firmwareRevision ? { firmwareRevision: native.firmwareRevision } : {}),
          payloadHash: native.payloadHash, grantRevision: native.grantRevision, ownershipEpoch: native.ownershipEpoch,
          gatewayReceipt: con as never,
        },
      },
    };
  }
  // The command identity stays in the reason: a rejected or expired command is a review record, not a new timeline command.
  return review(binding, cin, `native-receipt:${String(status)}:${String(con['ackCode'] ?? 'NONE')}:${con['commandId']}`, { gatewayId: con['gatewayId'] });
}

function incident(binding: CseBinding, cin: ContentInstance): Draft {
  const con = cin.con;
  if (!record(con) || con['type'] !== INCIDENT_TYPE || !text(con['incidentId']) || !text(con['deviceId'])) return review(binding, cin, 'incident-schema');
  const resource = `${binding.containerPath}/${cin.rn}`;
  const value: IntegrationReceipt = {
    contractId: 'privacy-bubble.integration.v1', docRevision: '2.0.0', eventId: con['incidentId'], timestamp: oneM2mTimeToIso(cin.ct),
    type: 'AUTOMATION_INCIDENT_OPENED', status: 'OPEN', principalId: cin.cr ?? binding.expectedCreator, ueId: con['deviceId'],
    kind: con['kind'], severity: con['severity'], message: con['message'], sourceResource: con['sourceResource'], oneM2MResource: resource,
  };
  return { type: 'integration.receipt', resourceUri: resource, acceptance: null, receipt: value };
}

/** Map one contentInstance to zero or more event drafts. Unexpected writers become REVIEW. */
export function mapContentInstance(binding: CseBinding, cin: ContentInstance): readonly Draft[] {
  if (cin.cr !== binding.expectedCreator) return [review(binding, cin, `unexpected-creator:${cin.cr ?? 'absent'}`)];
  switch (binding.stream) {
    case 'observation': case 'button': case 'battery': return [telemetry(binding, cin)];
    case 'command': return commandAccepted(binding, cin);
    case 'receipt': return [receipt(binding, cin)];
    case 'incident': return [incident(binding, cin)];
  }
}

export interface LiveEventLogOptions {
  readonly simulation: boolean;
  readonly roleScope?: readonly string[];
  readonly maxEvents?: number;
}

/**
 * Global stream sequence over all subscribed containers. Deduplicates by container and
 * resource ID, so a notification and a later la/ RETRIEVE of the same contentInstance
 * produce one event.
 */
export function createLiveEventLog(options: LiveEventLogOptions) {
  const events: DashboardEvent[] = [];
  const seen = new Set<string>();
  const listeners = new Set<(event: DashboardEvent) => void>();
  let sequence = 0;
  const roleScope = options.roleScope ?? ['operator'];
  function append(binding: CseBinding, cin: ContentInstance, receivedAt: string): readonly DashboardEvent[] {
    const key = `${binding.containerPath}|${cin.ri}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const created: DashboardEvent[] = [];
    for (const draft of mapContentInstance(binding, cin)) {
      const event = parseDashboardEvent({
        schemaVersion: '1.0.0', sequence: sequence + 1, resourceUri: draft.resourceUri, currentRevision: cin.ri, receivedAt,
        roleScope: [...roleScope], simulation: options.simulation, source: LIVE_SOURCE,
        type: draft.type, receipt: draft.receipt, acceptance: draft.acceptance,
      });
      sequence = event.sequence;
      events.push(event);
      created.push(event);
    }
    if (options.maxEvents !== undefined && events.length > options.maxEvents) events.splice(0, events.length - options.maxEvents);
    for (const event of created) for (const listener of listeners) listener(event);
    return created;
  }
  return {
    append,
    has: (binding: CseBinding, ri: string) => seen.has(`${binding.containerPath}|${ri}`),
    get events(): readonly DashboardEvent[] { return events; },
    get lastSequence() { return sequence; },
    subscribe(listener: (event: DashboardEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type LiveEventLog = ReturnType<typeof createLiveEventLog>;
