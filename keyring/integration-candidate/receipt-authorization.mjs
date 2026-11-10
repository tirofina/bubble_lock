const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const receiptIdentifier = (value) => typeof value === 'string' && id.exec(value)?.[0] === value;
export const receiptInstant = (value) => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value)
  ? Date.parse(value) : NaN;

export function matchesReceiptAuthorization(record, command, payloadHash) {
  const authorized = receiptInstant(record?.timestamp);
  const expiry = receiptInstant(record?.expiresAt);
  return record?.contractId === 'privacy-bubble.integration.v1' && record.docRevision === '2.0.0'
    && record.owner === 'PC-MOBIUS-INTEGRATION' && record.type === 'GATEWAY_COMMAND_AUTHORIZED'
    && receiptIdentifier(record.eventId) && record.allowed === true && record.payloadHash === payloadHash
    && ['gatewayId', 'commandId', 'deviceId', 'claimId', 'grantRevision', 'ownershipEpoch']
      .every((key) => record[key] === command[key])
    && receiptInstant(command.issuedAt) <= authorized && authorized < expiry
    && expiry <= receiptInstant(command.deadline);
}
