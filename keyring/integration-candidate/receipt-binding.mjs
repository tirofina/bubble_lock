import { isDeepStrictEqual } from 'node:util';

const fields = ['deviceId', 'commandId', 'grantRevision', 'ownershipEpoch'];
const hash = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const validId = (value) => typeof value === 'string' && id.test(value);
const validRevision = (value, min) => Number.isInteger(value) && value >= min && value <= 2147483647;

/**
 * Check an applied readback against central records already authenticated by the caller.
 * trustedGatewayId comes from the authenticated route or the CSE resource ACL mapping.
 * The issued record and historical authorization come from central storage.
 */
export function bindAppliedReceipt({ trustedGatewayId, commandRecord, authorization, receipt, ack }) {
  const command = commandRecord?.command;
  const payloadHash = commandRecord?.payloadHash;
  if (command?.version !== 1 || receipt?.version !== 1
      || !validId(trustedGatewayId) || !validId(command.deviceId) || !validId(command.commandId)
      || !validRevision(command.grantRevision, 1) || !validRevision(command.ownershipEpoch, 0)
      || trustedGatewayId !== command.gatewayId || trustedGatewayId !== receipt.gatewayId
      || fields.some((key) => receipt[key] !== command[key])
      || typeof payloadHash !== 'string' || !hash.test(payloadHash) || receipt.payloadHash !== payloadHash) {
    throw new Error('ISSUED_COMMAND_BINDING');
  }
  const expiry = Date.parse(authorization?.expiresAt);
  const issued = Date.parse(command.issuedAt), deadline = Date.parse(command.deadline);
  if (authorization?.allowed !== true || authorization.payloadHash !== payloadHash
      || !validId(command.claimId) || authorization.claimId !== command.claimId
      || fields.some((key) => authorization[key] !== command[key])
      || ![authorization.expiresAt, command.issuedAt, command.deadline].every((value) => typeof value === 'string')
      || !(issued < expiry && expiry <= deadline)) {
    throw new Error('AUTHORIZATION_BINDING');
  }
  const desired = command.desiredState?.state;
  if (receipt.status !== 'APPLIED' || !['APPLIED', 'DUPLICATE'].includes(receipt.ackCode)
      || typeof desired !== 'boolean' || !isDeepStrictEqual(receipt.readback, { state: desired })) {
    throw new Error('APPLIED_READBACK_BINDING');
  }
  if (ack !== undefined && (ack?.ackState !== 'READBACK_VERIFIED'
      || (ack.gatewayId !== undefined && ack.gatewayId !== trustedGatewayId)
      || fields.some((key) => ack[key] !== command[key]) || ack.payloadHash !== payloadHash
      || ack.timestamp !== receipt.receivedAt || ack.measurementScope !== 'gpio-at-application'
      || !isDeepStrictEqual(ack.readback, receipt.readback)
      || !isDeepStrictEqual(ack.gatewayReceipt, receipt))) {
    throw new Error('CORE_ACK_BINDING');
  }
  return { gatewayId: trustedGatewayId, commandId: command.commandId, deviceId: command.deviceId,
    payloadHash, readbackState: desired };
}
