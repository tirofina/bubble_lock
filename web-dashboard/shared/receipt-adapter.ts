import type { ApiAcceptance, CoreReceipt, DashboardEvent, EventEnvelope, SourceMode } from './types.ts';
import { ContractError, parseCoreReceipt, parseDashboardEvent } from './validation.ts';

export interface AdapterOptions {
  readonly resourceUri?: string;
  readonly currentRevision?: string | null;
  readonly roleScope?: readonly string[];
  readonly source?: SourceMode;
}

export const DEFAULT_RESOURCE_URI = '/Mobius/privacy-bubble-test-ae/bubbleState';

/** One adapter owns one stream. Never instantiate per connection. */
export function createReceiptAdapter(options: AdapterOptions = {}) {
  let sequence = 0;
  const source = options.source ?? 'core-journal-replay';
  const envelope = (receivedAt: string, resourceUri: string): EventEnvelope => ({
    schemaVersion: '1.0.0',
    sequence: ++sequence,
    resourceUri,
    currentRevision: options.currentRevision ?? null,
    receivedAt,
    roleScope: options.roleScope ?? ['operator'],
    simulation: true,
    source,
  });

  function adaptReceipt(value: unknown): DashboardEvent {
    const receipt = parseCoreReceipt(value);
    const base = envelope(receipt.journaledAt ?? receipt.timestamp, receipt.oneM2MResource ?? options.resourceUri ?? DEFAULT_RESOURCE_URI);
    let type: Exclude<DashboardEvent['type'], 'command.accepted'>;
    if (receipt.contractId === 'privacy-bubble.group-dispatch') {
      type = 'group.summary';
    } else {
      switch (receipt.status) {
        case 'DISPATCHED': type = 'command.dispatched'; break;
        case 'ACK_RECORDED': type = 'command.ack'; break;
        case 'APPLIED':
        case 'MQTT_DISPATCHED': type = 'gateway.telemetry'; break;
        case 'REVIEW':
        case 'DUPLICATE':
        case 'IN_FLIGHT': type = 'receipt.review'; break;
        case 'DISPATCHING':
        case 'SETTLED': throw new ContractError('Group status requires a group-dispatch receipt');
        default: return assertNever(receipt.status);
      }
    }
    return parseDashboardEvent({ ...base, type, receipt, acceptance: null });
  }

  function acceptanceEvent(acceptance: ApiAcceptance): DashboardEvent {
    if (source !== 'fixture-replay') throw new ContractError('API acceptance fixtures require fixture-replay source');
    return parseDashboardEvent({
      ...envelope(acceptance.acceptedAt, options.resourceUri ?? DEFAULT_RESOURCE_URI),
      type: 'command.accepted',
      receipt: null,
      acceptance,
    });
  }

  return { adaptReceipt, acceptanceEvent };
}

function assertNever(value: never): never {
  throw new ContractError(`Unsupported receipt status: ${String(value)}`);
}

/** Blank lines are ignored; malformed lines stop the replay with their line number. */
export function parseReceiptJsonl(text: string): readonly CoreReceipt[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim() === '') return [];
    try {
      return [parseCoreReceipt(JSON.parse(line))];
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ContractError) {
        throw new ContractError(`JSONL line ${index + 1}: ${error.message}`);
      }
      throw error;
    }
  });
}
