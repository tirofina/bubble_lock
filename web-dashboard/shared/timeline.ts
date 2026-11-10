import type { AckState, CoreReceipt, DashboardEvent } from './types.ts';

export type Stage = { readonly status: 'pending' } | {
  readonly status: 'complete';
  readonly at: string;
  readonly source: string;
};
export interface TimelineStages {
  readonly accepted: Stage;
  readonly sent: Stage;
  readonly applied: Stage;
  readonly verified: Stage;
}
export interface MemberTimeline extends TimelineStages {
  readonly memberId: string;
  readonly commandId: string;
  readonly deviceId: string;
  readonly gatewayId: string | null;
  readonly ack: boolean;
  readonly readbackVerified: boolean;
  readonly readback: boolean | null;
  readonly ackState: AckState | null;
  readonly retryPending: boolean;
}
export interface CommandTimeline extends TimelineStages {
  readonly commandId: string;
  readonly groupId: string | null;
  readonly members: Readonly<Record<string, MemberTimeline>>;
}
export interface TimelineState {
  readonly lastSequence: number;
  readonly ignoredEvents: number;
  readonly commands: Readonly<Record<string, CommandTimeline>>;
}
export const initialTimelineState: TimelineState = { lastSequence: 0, ignoredEvents: 0, commands: {} };
const pending: Stage = { status: 'pending' };
function emptyStages(): TimelineStages {
  return { accepted: pending, sent: pending, applied: pending, verified: pending };
}
function observed(previous: Stage, at: string, source: string): Stage {
  // Preserve the earliest explicit evidence, even when receipt timestamps arrive late.
  return previous.status === 'complete' && Date.parse(previous.at) <= Date.parse(at)
    ? previous : { status: 'complete', at, source };
}
function memberIdentity(commandId: string): { commandId: string; memberId: string } {
  const separator = commandId.lastIndexOf(':');
  return separator > 0
    ? { commandId: commandId.slice(0, separator), memberId: commandId.slice(separator + 1) }
    : { commandId, memberId: commandId };
}
function newMember(memberId: string, commandId: string, deviceId: string, gatewayId: string | null): MemberTimeline {
  return { ...emptyStages(), memberId, commandId, deviceId, gatewayId, ack: false, readbackVerified: false, readback: null, ackState: null, retryPending: false };
}
function aggregate(members: readonly MemberTimeline[], key: keyof TimelineStages): Stage {
  if (members.length === 0 || members.some((member) => member[key].status === 'pending')) return pending;
  let latest: Stage = pending;
  for (const member of members) {
    const stage = member[key];
    if (stage.status === 'complete' && (latest.status === 'pending' || Date.parse(stage.at) > Date.parse(latest.at))) latest = stage;
  }
  return latest;
}
function withMembers(command: CommandTimeline, members: Readonly<Record<string, MemberTimeline>>): CommandTimeline {
  const values = Object.values(members);
  return {
    ...command, members,
    sent: aggregate(values, 'sent'),
    applied: aggregate(values, 'applied'),
    verified: aggregate(values, 'verified'),
  };
}

function applyAck(member: MemberTimeline, receipt: CoreReceipt): MemberTimeline {
  const payload = receipt.payload;
  if (payload === undefined || !('ackState' in payload)) return member;
  let applied = member.applied;
  let verified = member.verified;
  // READBACK_VERIFIED proves verification, not the missing application timestamp.
  if (payload.appliedAt !== undefined) applied = observed(applied, payload.appliedAt, 'payload.appliedAt');
  switch (payload.ackState) {
    case 'APPLIED':
      applied = observed(applied, payload.appliedAt ?? payload.timestamp, 'APPLIED ACK payload.timestamp');
      break;
    case 'READBACK_VERIFIED':
      verified = observed(verified, payload.timestamp, 'READBACK_VERIFIED ACK payload.timestamp');
      break;
    case 'RECEIVED':
    case 'FORWARDED':
    case 'RETRY_PENDING': break;
    default: return assertNever(payload.ackState);
  }
  return {
    ...member, applied, verified,
    ack: true,
    ackState: payload.ackState,
    readback: payload.readback ?? member.readback,
    readbackVerified: verified.status === 'complete',
    retryPending: payload.ackState === 'RETRY_PENDING',
  };
}

/** Call only after validateDashboardEvent/parseDashboardEvent succeeds. */
export function timelineReducer(state: TimelineState, event: DashboardEvent): TimelineState {
  if (event.sequence <= state.lastSequence) return { ...state, ignoredEvents: state.ignoredEvents + 1 };
  const next = { ...state, lastSequence: event.sequence };
  const rawCommandId = event.type === 'command.accepted' ? event.acceptance.commandId : event.receipt.commandId;
  if (rawCommandId === undefined) return next;
  const identity = event.type === 'group.summary' || event.type === 'command.accepted'
    ? { commandId: rawCommandId, memberId: rawCommandId } : memberIdentity(rawCommandId);
  const command = state.commands[identity.commandId] ?? {
    ...emptyStages(), commandId: identity.commandId, groupId: null, members: {},
  };
  let updated: CommandTimeline = command;
  switch (event.type) {
    case 'command.accepted':
      updated = {
        ...command,
        groupId: event.acceptance.groupId,
        accepted: observed(command.accepted, event.acceptance.acceptedAt, event.acceptance.label),
      };
      break;
    case 'command.dispatched':
    case 'command.ack': {
      const receipt = event.receipt;
      if (receipt.deviceId === undefined) break;
      const member = command.members[identity.memberId] ?? newMember(identity.memberId, rawCommandId, receipt.deviceId, receipt.gatewayId ?? null);
      const changed = event.type === 'command.dispatched'
        ? { ...member, sent: observed(member.sent, receipt.timestamp, 'DISPATCHED receipt.timestamp') }
        : applyAck(member, receipt);
      updated = withMembers(command, { ...command.members, [identity.memberId]: changed });
      break;
    }
    case 'group.summary': {
      const members = { ...command.members };
      for (const item of event.receipt.members ?? []) {
        const member = members[item.memberId] ?? newMember(item.memberId, item.memberCommandId, item.deviceId, item.gatewayId);
        // Summary ACK time is CORE receipt time, not a missing device-stage time.
        members[item.memberId] = {
          ...member,
          ack: member.ack || item.ackTimestamp !== undefined,
          retryPending: item.status === 'RETRY_PENDING',
        };
      }
      updated = withMembers({ ...command, groupId: event.receipt.groupId ?? null }, members);
      break;
    }
    case 'gateway.telemetry':
    case 'receipt.review': break;
    default: return assertNever(event);
  }
  return { ...next, commands: { ...state.commands, [identity.commandId]: updated } };
}

export function reduceTimeline(events: readonly DashboardEvent[]): TimelineState {
  return events.reduce(timelineReducer, initialTimelineState);
}

export function stageDurationMs(from: Stage, to: Stage): number | null {
  if (from.status === 'pending' || to.status === 'pending') return null;
  const duration = Date.parse(to.at) - Date.parse(from.at);
  return duration < 0 ? null : duration;
}

export function summarizeCommand(command: CommandTimeline) {
  const members = Object.values(command.members);
  const verified = members.filter((member) => member.readbackVerified).length;
  const retryPending = members.filter((member) => member.retryPending).length;
  const status = members.length === 0 ? 'pending'
    : verified === members.length ? 'verified'
    : verified > 0 ? 'partial'
    : retryPending > 0 ? 'failure'
    : 'in-flight';
  return {
    status,
    memberCount: members.length,
    ackCount: members.filter((member) => member.ack).length,
    verifiedCount: verified,
    retryPendingCount: retryPending,
    acceptedToSentMs: stageDurationMs(command.accepted, command.sent),
    sentToAppliedMs: stageDurationMs(command.sent, command.applied),
    appliedToVerifiedMs: stageDurationMs(command.applied, command.verified),
  };
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected timeline variant: ${String(value)}`);
}
