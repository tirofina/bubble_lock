import { bindAppliedReceipt, bindIssuedReceipt } from './receipt-binding.mjs';
import { InvalidNativeReceipt } from './receipt-native-source.mjs';
import { matchesReceiptAuthorization, receiptIdentifier, receiptInstant } from './receipt-authorization.mjs';

const review = (reason) => ({ status: 'REVIEW', reason });
const negativeStatuses = new Set(['REJECTED', 'TIMEOUT', 'INDETERMINATE']);
const ackCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

function historicalApproval(history, command, payloadHash, storedAt) {
  const last = receiptInstant(storedAt);
  return history.find((record) => receiptInstant(record?.timestamp) <= last
    && matchesReceiptAuthorization(record, command, payloadHash));
}

/**
 * cseKey identifies the fixed authenticated instance used by readNativeReceipt.
 * The reader validates nativeRef and resolves its trusted Gateway from the ACL
 * mapping before returning { gatewayId, resourceId, storedAt, receipt }.
 * The command, approval history, canonical hash and commit come from central storage.
 * commitIfAbsent must return { created, record } for the durable unique key.
 */
export function createCommandReceiptSettlement({
  cseKey, readNativeReceipt, validateNativeReceipt, readIssuedCommand, readAuthorizationHistory, hashPayload, commitIfAbsent,
}) {
  if (!receiptIdentifier(cseKey)) throw new Error('SETTLEMENT_CSE_KEY_REQUIRED');
  return async function settle({ nativeRef, ack } = {}) {
    let native;
    try {
      native = await readNativeReceipt(nativeRef);
    } catch (error) {
      if (error instanceof InvalidNativeReceipt) return review(error.message);
      throw error;
    }
    if (native == null) return { status: 'WAITING_FOR_NATIVE' };
    const { gatewayId, resourceId, storedAt, storedAtPrecision, receipt } = native;
    if (!receiptIdentifier(gatewayId) || !receiptIdentifier(receipt?.commandId) || !receiptIdentifier(resourceId)
        || !Number.isFinite(receiptInstant(storedAt)) || await validateNativeReceipt(receipt) !== true) {
      return review('INVALID_NATIVE_RECEIPT');
    }
    const commandRecord = await readIssuedCommand(receipt.commandId);
    const command = commandRecord?.command;
    if (!command || command.gatewayId !== gatewayId || command.commandId !== receipt.commandId
        || hashPayload(command) !== commandRecord.payloadHash) return review('ISSUED_COMMAND_BINDING');
    if (negativeStatuses.has(receipt.status)) {
      try {
        bindIssuedReceipt({ trustedGatewayId: gatewayId, commandRecord, receipt });
      } catch (error) {
        return review(error.message);
      }
      if (ack !== undefined) return review('CORE_ACK_BINDING');
      if (typeof receipt.ackCode !== 'string' || ackCodePattern.exec(receipt.ackCode)?.[0] !== receipt.ackCode) {
        return review('INVALID_NATIVE_RECEIPT');
      }
      return review(`${receipt.status}_${receipt.ackCode}`);
    }
    const history = await readAuthorizationHistory(receipt.commandId);
    const authorization = historicalApproval(history, command, commandRecord.payloadHash, storedAt);
    if (!authorization) {
      const start = receiptInstant(storedAt);
      const ambiguous = storedAtPrecision === 'second' && history.some((record) => {
        const timestamp = receiptInstant(record?.timestamp);
        return start < timestamp && timestamp < start + 1000
          && matchesReceiptAuthorization(record, command, commandRecord.payloadHash);
      });
      return review(ambiguous ? 'AUTHORIZATION_ORDER_UNCERTAIN' : 'HISTORICAL_AUTHORIZATION_REQUIRED');
    }

    let bound;
    try {
      bound = bindAppliedReceipt({ trustedGatewayId: gatewayId, commandRecord, authorization, receipt, ack });
    } catch (error) {
      return review(error.message);
    }
    const candidate = {
      version: 1, ...bound, nativeCseKey: cseKey, nativeRef, nativeResourceId: resourceId, nativeStoredAt: storedAt,
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
    if (record.nativeResourceId !== resourceId || receiptInstant(record.nativeStoredAt) !== receiptInstant(storedAt)) {
      return review('SETTLEMENT_NATIVE_CONFLICT');
    }
    if (!Object.hasOwn(record, 'nativeCseKey') && !Object.hasOwn(record, 'nativeRef')) {
      return review('SETTLEMENT_SOURCE_UNBOUND');
    }
    if (record.nativeCseKey !== cseKey || record.nativeRef !== nativeRef) {
      return review('SETTLEMENT_SOURCE_CONFLICT');
    }
    return { status: created ? 'SETTLED' : 'ALREADY_SETTLED', record };
  };
}
