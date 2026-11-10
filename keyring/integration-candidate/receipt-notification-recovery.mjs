import { matchesReceiptAuthorization, receiptIdentifier, receiptInstant } from './receipt-authorization.mjs';
import { commandReceiptName, InvalidNativeReceipt } from './receipt-native-source.mjs';

const containerPattern = /^(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){2,8}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function validIssuedCommand(commandId, command, payloadHash, hashPayload) {
  return receiptIdentifier(commandId) && command?.commandId === commandId && receiptIdentifier(command.gatewayId)
    && typeof payloadHash === 'string' && hashPattern.exec(payloadHash)?.[0] === payloadHash
    && hashPayload(command) === payloadHash;
}

/** Build one paged sweep from a trusted, immutable team IntegrationStore snapshot. */
export function createReceiptNotificationSweep({ snapshot, from, until, hashPayload, resolveRoute, inbox }) {
  const start = receiptInstant(from);
  const end = receiptInstant(until);
  if (!(start < end)) throw new Error('INVALID_RECEIPT_RECOVERY_WINDOW');
  const { gatewayCommands = {}, receipts } = snapshot ?? {};
  if (!gatewayCommands || typeof gatewayCommands !== 'object' || Array.isArray(gatewayCommands) || !Array.isArray(receipts)) {
    throw new Error('INVALID_TEAM_STATE');
  }

  const byCommand = new Map();
  for (const event of receipts) {
    const timestamp = receiptInstant(event?.timestamp);
    const commandId = event?.commandId;
    if (event?.allowed !== true || event.type !== 'GATEWAY_COMMAND_AUTHORIZED'
        || !(start <= timestamp && timestamp < end) || !receiptIdentifier(commandId)
        || !Object.hasOwn(gatewayCommands, commandId)) continue;
    const prior = byCommand.get(commandId);
    if (prior && prior.timestamp <= timestamp) continue;
    const { command, payloadHash } = gatewayCommands[commandId] ?? {};
    if (!validIssuedCommand(commandId, command, payloadHash, hashPayload)
        || !matchesReceiptAuthorization(event, command, payloadHash)) continue;
    byCommand.set(commandId, { commandId, gatewayId: command.gatewayId, issuedAt: command.issuedAt,
      timestamp, anchor: 'authorizedAt' });
  }
  // A denied or unapproved command can still produce an authenticated failure receipt.
  // Look after its deadline without turning a missing CSE resource into a failure record.
  for (const [commandId, record] of Object.entries(gatewayCommands)) {
    if (byCommand.has(commandId)) continue;
    const { command, payloadHash } = record ?? {};
    const timestamp = receiptInstant(command?.deadline);
    if (!(start <= timestamp && timestamp < end) || !(receiptInstant(command?.issuedAt) < timestamp)
        || !validIssuedCommand(commandId, command, payloadHash, hashPayload)) continue;
    byCommand.set(commandId, { commandId, gatewayId: command.gatewayId, issuedAt: command.issuedAt,
      timestamp, anchor: 'deadline' });
  }
  const candidates = [...byCommand.values()].sort((left, right) => left.timestamp - right.timestamp
    || (left.commandId < right.commandId ? -1 : 1));
  const positions = new Map(candidates.map((candidate, index) => [candidate.commandId, index]));

  return async function recoverPage({ after = null, limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('INVALID_RECEIPT_RECOVERY_LIMIT');
    let offset = 0;
    if (after !== null) {
      const position = positions.get(after?.commandId);
      const candidate = candidates[position];
      if (!candidate || receiptInstant(after[candidate.anchor]) !== candidate.timestamp) {
        throw new Error('INVALID_RECEIPT_RECOVERY_CURSOR');
      }
      offset = position + 1;
    }

    const page = candidates.slice(offset, offset + limit);
    const result = { checked: page.length, queued: 0, alreadyQueued: 0, gaps: [], next: null };
    for (const { commandId, gatewayId, issuedAt } of page) {
      const gap = (reason) => result.gaps.push({ gatewayId, commandId, reason });
      const route = await resolveRoute({ gatewayId, commandId, issuedAt });
      if (!route || !receiptIdentifier(route.cseKey) || typeof route.receiptContainer !== 'string'
          || containerPattern.exec(route.receiptContainer)?.[0] !== route.receiptContainer
          || typeof route.readNativeReceipt !== 'function') {
        gap('UNKNOWN_RECEIPT_ROUTE');
        continue;
      }
      const nativeRef = `${route.receiptContainer}/${commandReceiptName(commandId)}`;
      const entry = { cseKey: route.cseKey, nativeRef };
      if (await inbox.has(entry)) {
        result.alreadyQueued++;
        continue;
      }

      let native;
      try {
        native = await route.readNativeReceipt(nativeRef);
      } catch (error) {
        gap(error instanceof InvalidNativeReceipt ? 'INVALID_NATIVE_RECEIPT' : 'NATIVE_RECEIPT_UNAVAILABLE');
        continue;
      }
      if (native == null) {
        gap('WAITING_FOR_NATIVE');
      } else if (native.gatewayId !== gatewayId || native.receipt?.commandId !== commandId) {
        gap('NATIVE_RECEIPT_BINDING');
      } else if (await inbox.enqueue(entry, 'RECOVERY_SWEEP')) {
        result.queued++;
      } else {
        result.alreadyQueued++; // The callback or another sweep won the insert.
      }
    }
    if (offset + page.length < candidates.length) {
      const last = page.at(-1);
      result.next = { commandId: last.commandId, [last.anchor]: new Date(last.timestamp).toISOString() };
    }
    return result;
  };
}
