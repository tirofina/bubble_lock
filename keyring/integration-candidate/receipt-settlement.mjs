import { bindAppliedReceipt } from './receipt-binding.mjs';
import { InvalidNativeReceipt } from './receipt-native-source.mjs';
import { matchesReceiptAuthorization, receiptIdentifier, receiptInstant } from './receipt-authorization.mjs';

const review = (reason) => ({ status: 'REVIEW', reason });

function historicalApproval(history, command, payloadHash, storedAt) {
  const last = receiptInstant(storedAt);
  return history.find((record) => receiptInstant(record?.timestamp) <= last
    && matchesReceiptAuthorization(record, command, payloadHash));
}

/**
 * readNativeReceipt retrieves a CSE cin, resolves its trusted Gateway from the
 * configured ACL mapping, and returns { gatewayId, resourceId, storedAt, receipt }.
 * The command, approval history, canonical hash and commit come from central storage.
 * commitIfAbsent must return { created, record } for the durable unique key.
 */
export function createCommandReceiptSettlement({
  readNativeReceipt, validateNativeReceipt, readIssuedCommand, readAuthorizationHistory, hashPayload, commitIfAbsent,
}) {
  return async function settle({ nativeRef, ack } = {}) {
    let native;
    try {
      native = await readNativeReceipt(nativeRef);
    } catch (error) {
      if (error instanceof InvalidNativeReceipt) return review(error.message);
      throw error;
    }
    if (native == null) return { status: 'WAITING_FOR_NATIVE' };
    const { gatewayId, resourceId, storedAt, receipt } = native;
    if (!receiptIdentifier(gatewayId) || !receiptIdentifier(receipt?.commandId) || !receiptIdentifier(resourceId)
        || !Number.isFinite(receiptInstant(storedAt)) || await validateNativeReceipt(receipt) !== true) {
      return review('INVALID_NATIVE_RECEIPT');
    }
    const commandRecord = await readIssuedCommand(receipt.commandId);
    const command = commandRecord?.command;
    if (!command || command.gatewayId !== gatewayId || command.commandId !== receipt.commandId
        || hashPayload(command) !== commandRecord.payloadHash) return review('ISSUED_COMMAND_BINDING');
    const history = await readAuthorizationHistory(receipt.commandId);
    const authorization = historicalApproval(history, command, commandRecord.payloadHash, storedAt);
    if (!authorization) return review('HISTORICAL_AUTHORIZATION_REQUIRED');

    let bound;
    try {
      bound = bindAppliedReceipt({ trustedGatewayId: gatewayId, commandRecord, authorization, receipt, ack });
    } catch (error) {
      return review(error.message);
    }
    const candidate = {
      version: 1, ...bound, nativeResourceId: resourceId, nativeStoredAt: storedAt,
      authorizationEventId: authorization.eventId, receiptSha256: hashPayload(receipt),
    };
    const key = [bound.gatewayId, bound.commandId];
    const { created, record } = await commitIfAbsent(key, candidate);
    if (typeof created !== 'boolean' || !record || record.version !== 1
        || record.gatewayId !== bound.gatewayId || record.commandId !== bound.commandId) {
      return review('SETTLEMENT_RECORD_BINDING');
    }
    if (record.deviceId !== bound.deviceId || record.payloadHash !== bound.payloadHash
        || record.receiptSha256 !== candidate.receiptSha256 || record.readbackState !== bound.readbackState) {
      return review('SETTLEMENT_CONFLICT');
    }
    return { status: created ? 'SETTLED' : 'ALREADY_SETTLED', record };
  };
}
