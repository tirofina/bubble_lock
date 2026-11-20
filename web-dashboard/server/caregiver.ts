import { randomUUID } from 'node:crypto';

/**
 * Caregiver delegation (R04/R06/R07 video cuts): a visiting caregiver presses "Living Room On" and the household
 * <grp>/fopt group command goes to the living room light and fan, through the existing pc-mobius
 * HouseholdGroupCommandService (portal commands/request with target household, commands/approve with the guardian's
 * delegation grant). The grant expiry (story time 16:00) is enforced by the policy service, so a press after expiry is
 * REJECTED before any CSE call. Members are emulated devices; the Gateway stage runs the production
 * IntegrationApiGateway routes in-process, like pc-mobius/scripts/run-group-command-real.mjs.
 */
export interface LivingRoomConfig {
  readonly householdId?: string;
  readonly name?: string;
  readonly devices?: readonly { readonly deviceId: string; readonly label: string; readonly labelEn: string }[];
  readonly delegationSec?: number;
  readonly storyExpiryLocal?: string;
  /** Live: the CSE that holds <grp> and the member flexContainers (core.groupCommand for createPortalDemo). */
  readonly groupCommand?: Record<string, unknown>;
  readonly cse?: { readonly cseId: string; readonly version?: string };
}
interface ApiResult { status: number; body: any }
interface Runtime {
  api: { handle(request: { method: string; path: string; principal: unknown; body?: unknown }): Promise<ApiResult> };
  policyService: { createConsent(input: Record<string, unknown>): Promise<{ consentId: string }>; createGrant(input: Record<string, unknown>): Promise<{ grantId: string; expiresAt: string }> };
  portalService: { provisionHousehold(input: Record<string, unknown>): Promise<unknown>; registerDevice(principal: unknown, input: Record<string, unknown>): Promise<unknown> };
  store: { get(collection: string, id: string): any };
  gatewayControl: { enroll(input: Record<string, unknown>): Promise<unknown> };
  groupCommands: { idle(): Promise<void>; summary(id: string): any } | null;
}
type Principals = Record<'guardian' | 'visitor' | 'operator', { principalId: string }>;

export const DEFAULT_DEVICES = [
  { deviceId: 'living-room-light', label: '거실 조명 (모의 기기)', labelEn: 'Living room light (emulated)' },
  { deviceId: 'living-room-fan', label: '거실 선풍기 (모의 기기)', labelEn: 'Living room fan (emulated)' },
] as const;
const GATEWAY = 'pi-lr';
const memberKey = (value: unknown) => String(value ?? '').replace(/^\/+/, '');
const toOneM2mTime = (value: string) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');

/** In-memory fanOutPoint for recording without a CSE (simulation; same interface as OneM2mGroupFanout). */
export class EmulatedGroupFanout {
  readonly states = new Map<string, boolean>();
  readonly groups = new Map<string, string[]>();
  private counter = 0;
  path(value: unknown) { const text = String(value ?? ''); return text.startsWith('/') ? text : `/${text}`; }
  async ensureGroup({ parent, rn, members, macp = null, et = null }: { parent: string; rn: string; members: { path: string }[]; macp?: string[] | null; et?: string | null }) {
    const path = `${this.path(parent)}/${rn}`; const mid = members.map((member) => memberKey(this.path(member.path)));
    const created = !this.groups.has(path); this.groups.set(path, mid);
    return { path, ri: `emulated-${rn}`, mid, macp: macp ?? [], mt: 28, mtv: true, cnm: mid.length, mnm: 16, csy: 1, et: et ? toOneM2mTime(et) : undefined, rsc: created ? 2001 : 2000, rqi: 'emulated', created, updated: false };
  }
  async fanOut(groupPath: string, state: boolean) {
    const mid = this.groups.get(this.path(groupPath)) ?? [];
    for (const member of mid) this.states.set(member, state);
    return { aggregateRsc: 2000, status: 200, rqi: `emulated-${++this.counter}`, rqiMatches: true, request: { 'cod:binSh': { state } }, members: mid.map((fr) => ({ fr, rsc: 2004, ok: true, state })) };
  }
  async updateMember(path: string, state: boolean) { this.states.set(memberKey(this.path(path)), state); return { rsc: 2004, rqi: 'emulated', rqiMatches: true, ok: true, state }; }
  async readMember(path: string) { const state = this.states.get(memberKey(this.path(path))) ?? false; return { rsc: 2000, rqi: 'emulated', rqiMatches: true, ok: true, state, ri: 'emulated', cnd: 'org.onem2m.common.moduleclass.binarySwitch', envelope: 'cod:binSh' }; }
  async appendInstance() { this.counter += 1; return { rsc: 2001, rqi: 'emulated', ok: true, ri: `emulated-cin-${this.counter}`, et: undefined }; }
}

/** core option for createPortalDemo: the live CSE config from the runner, or the emulated fanout. */
export function livingRoomCore(config: LivingRoomConfig) {
  if (config.groupCommand) return { groupCommand: config.groupCommand };
  const devices = config.devices ?? DEFAULT_DEVICES;
  return { groupCommand: { fanout: new EmulatedGroupFanout(), groupParent: '/Mobius/pb-central-emulated',
    memberResources: Object.fromEntries(devices.map((device) => [device.deviceId, `/Mobius/${device.deviceId}/binarySwitch`])), ackContainers: {} } };
}

export async function createLivingRoom(runtime: Runtime, principals: Principals, config: LivingRoomConfig) {
  const householdId = config.householdId ?? 'household-living-room';
  const devices = config.devices ?? DEFAULT_DEVICES;
  const storyExpiryLocal = config.storyExpiryLocal ?? '16:00';
  const live = Boolean(config.groupCommand);
  // The living room devices sit behind their own emulated Gateway, enrolled like the demo pi-01.
  try { await runtime.gatewayControl.enroll({ gatewayId: GATEWAY, principalId: 'gateway-demo', fingerprint: 'DEMO-ONLY-NO-TRANSPORT', credentialRevision: 'demo-1', ownershipEpoch: 0, devices: Object.fromEntries(devices.map((device) => [device.deviceId, householdId])) }); } catch { /* enrolled on an earlier start */ }
  try { await runtime.portalService.provisionHousehold({ householdId, name: config.name ?? '거실 (Living room)', ownerId: principals.guardian.principalId, members: [{ principalId: principals.visitor.principalId, role: 'visitor' }] }); } catch { /* kept from an earlier start */ }
  for (const device of devices) {
    try { await runtime.portalService.registerDevice(principals.guardian, { householdId, deviceId: device.deviceId, gatewayId: GATEWAY, label: device.label, idempotencyKey: `living-room-${device.deviceId}` }); } catch { /* already registered */ }
  }
  let grant: { grantId: string; expiresAt: string } | null = null;
  async function renew(ttlSec = config.delegationSec ?? 600) {
    const purpose = 'Caregiver visit: living room until 16:00 (story time)';
    const consent = await runtime.policyService.createConsent({ principal: principals.guardian, subjectId: householdId, purpose, scopes: ['bubble:command'], ttlSec: ttlSec + 120 });
    grant = await runtime.policyService.createGrant({ principal: principals.guardian, consentId: consent.consentId, purpose, scopes: ['bubble:command'], ttlSec });
    return grant;
  }
  await renew();
  const results: Record<string, unknown>[] = [];
  const gatewayPrincipal = { principalId: 'gateway-demo', scopes: [], mtlsFingerprint: 'DEMO-ONLY-NO-TRANSPORT' };
  const deviceIds = devices.map((device) => device.deviceId);

  /** Emulated living room devices behind Gateway pi-01: poll, authorize, dispatch-start, APPLIED receipt with readback. */
  async function gatewayApplies() {
    const handled = [];
    const polled = await runtime.api.handle({ method: 'GET', path: `/api/v1/gateways/${GATEWAY}/commands?limit=16`, principal: gatewayPrincipal });
    for (const command of (polled.body?.commands ?? []).filter((item: { deviceId: string }) => deviceIds.includes(item.deviceId))) {
      const payloadHash = runtime.store.get('gatewayCommands', command.commandId)?.payloadHash;
      const binding = { commandId: command.commandId, deviceId: command.deviceId, claimId: command.claimId, grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, payloadHash };
      const authorized = await runtime.api.handle({ method: 'POST', path: `/api/v1/gateways/${GATEWAY}/authorize`, principal: gatewayPrincipal, body: binding });
      const started = await runtime.api.handle({ method: 'POST', path: `/api/v1/gateways/${GATEWAY}/dispatch-start`, principal: gatewayPrincipal, body: binding });
      const at = new Date().toISOString();
      const receipt = { version: 1, gatewayId: GATEWAY, deviceId: command.deviceId, commandId: command.commandId, payloadHash, status: 'APPLIED', ackCode: 'APPLIED', acceptedAt: at, appliedAt: at, receivedAt: at, readback: { state: command.desiredState.state }, firmwareRevision: 'living-room-emulated', ownershipEpoch: command.ownershipEpoch, grantRevision: command.grantRevision, timestampSource: 'gateway-estimated', detail: 'emulated living room device (simulation)', bootId: 'living-room-emulated' };
      const settled = await runtime.api.handle({ method: 'POST', path: `/api/v1/gateways/${GATEWAY}/receipts`, principal: gatewayPrincipal, body: receipt });
      handled.push({ deviceId: command.deviceId, claimId: command.claimId, authorizeAllowed: authorized.body?.allowed ?? null, dispatchStartAllowed: started.body?.allowed ?? null, executionState: settled.body?.executionState ?? null, receiptHash: settled.body?.receiptHash ?? null });
    }
    await runtime.groupCommands?.idle();
    return handled;
  }

  async function command(state: boolean) {
    const at = new Date().toISOString();
    const base = { id: randomUUID(), at, state, householdId, by: principals.visitor.principalId, grantId: grant?.grantId ?? null, grantExpiresAt: grant?.expiresAt ?? null, storyExpiryLocal, live, simulation: true };
    const requested = await runtime.api.handle({ method: 'POST', path: '/v1/portal/commands/request', principal: principals.visitor, body: { householdId, target: 'household', desiredState: { state }, reason: `Caregiver: living room ${state ? 'on' : 'off'}`, ttlSec: 120, idempotencyKey: randomUUID() } });
    if (requested.status !== 200) { const entry = { ...base, outcome: 'REJECTED', stage: 'request', reason: String(requested.body?.error ?? requested.status), members: deviceIds.map((deviceId) => ({ deviceId, status: 'REJECTED' })) }; results.unshift(entry); return entry; }
    // Pre-approved delegation: the guardian's grant (scope bubble:command, et story 16:00) approves the caregiver request.
    const approved = await runtime.api.handle({ method: 'POST', path: '/v1/portal/commands/approve', principal: principals.guardian, body: { requestId: requested.body.requestId, grantId: grant?.grantId, idempotencyKey: randomUUID() } });
    if (approved.status !== 200) {
      const entry = { ...base, requestId: requested.body.requestId, outcome: 'REJECTED', stage: 'grant', reason: String(approved.body?.error ?? approved.status), grantActive: grant ? Date.parse(grant.expiresAt) > Date.now() : false, members: deviceIds.map((deviceId) => ({ deviceId, status: 'REJECTED', receipt: 'no claim issued, no CSE request' })) };
      results.unshift(entry); results.splice(20); return entry;
    }
    const gateway = await gatewayApplies();
    const summary = runtime.groupCommands?.summary(approved.body.group.commandId);
    const fanout = summary?.fanouts?.[0];
    const entry = { ...base, requestId: requested.body.requestId, outcome: summary?.status === 'SETTLED' ? 'APPLIED' : String(summary?.status ?? approved.body.status), approvalHash: approved.body.approvalHash, groupCommandId: approved.body.group.commandId,
      groupPath: summary?.groupPath, fanoutPoint: summary?.fanoutPoint, aggregateRsc: fanout?.aggregateRsc ?? null, groupEt: summary?.group?.et ?? null,
      members: (summary?.members ?? []).map((member: any) => ({ deviceId: member.memberId, status: member.status, cseRsc: member.cseRsc, readback: member.readback?.state ?? (typeof member.readback === 'boolean' ? member.readback : null), cseReadback: member.cseReadback?.state ?? null, claimId: member.binding?.claimId ?? null, payloadHash: member.payloadHash ?? null })),
      gateway };
    results.unshift(entry); results.splice(20);
    return entry;
  }

  return {
    status() {
      return { householdId, devices, live, cse: config.cse ?? null, simulation: { devices: true, gateway: true, cse: !live },
        grant: grant ? { grantId: grant.grantId, expiresAt: grant.expiresAt, active: Date.parse(grant.expiresAt) > Date.now(), storyExpiryLocal } : null, results };
    },
    command, renew,
  };
}
export type LivingRoomService = Awaited<ReturnType<typeof createLivingRoom>>;
