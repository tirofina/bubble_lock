import type { ErrorObject } from 'ajv';
import { eventValidator, receiptValidator, integrationValidator } from './validators.generated.mjs';
import type { CoreReceipt, DashboardEvent, JournalReceipt } from './types.ts';

export class ContractError extends Error {
  readonly details: string;
  constructor(details: string) {
    super(details);
    this.name = 'ContractError';
    this.details = details;
  }
}

function errorsText(errors: readonly ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `data${error.instancePath} ${error.message}`).join(', ') || 'No errors';
}

function checkReceiptIdentity(receipt: CoreReceipt): void {
  const payload = receipt.payload;
  if (payload !== undefined) {
    if (receipt.deviceId !== undefined && receipt.deviceId !== payload.deviceId) {
      throw new ContractError('Receipt deviceId does not match payload.deviceId');
    }
    if ('commandId' in payload && receipt.commandId !== undefined && receipt.commandId !== payload.commandId) {
      throw new ContractError('Receipt commandId does not match payload.commandId');
    }
    if ('ackState' in payload && receipt.ackState !== undefined && receipt.ackState !== payload.ackState) {
      throw new ContractError('Receipt ackState does not match payload.ackState');
    }
    if ('sequence' in payload && receipt.sequence !== undefined && receipt.sequence !== payload.sequence) {
      throw new ContractError('Receipt device sequence does not match payload.sequence');
    }
    if ('gatewayId' in payload && receipt.gatewayId !== undefined && payload.gatewayId !== receipt.gatewayId) {
      throw new ContractError('Receipt gatewayId does not match payload.gatewayId');
    }
    if ('gatewayReceipt' in payload && payload.gatewayReceipt) {
      const nested = payload.gatewayReceipt;
      if ((receipt.gatewayId !== undefined && nested.gatewayId !== receipt.gatewayId) || nested.deviceId !== payload.deviceId || nested.commandId !== payload.commandId ||
          nested.payloadHash !== payload.payloadHash || nested.grantRevision !== payload.grantRevision || nested.ownershipEpoch !== payload.ownershipEpoch ||
          nested.readback?.state !== (typeof payload.readback === 'object' ? payload.readback.state : payload.readback)) {
        throw new ContractError('Gateway acknowledgement does not match its native receipt');
      }
    }
  }
  if (receipt.members !== undefined) {
    if (receipt.memberCount !== receipt.members.length ||
        new Set(receipt.members.map((member) => member.memberId)).size !== receipt.members.length ||
        new Set(receipt.members.map((member)=>member.memberCommandId)).size!==receipt.members.length) {
      throw new ContractError('Group members require distinct member and command identities matching the count');
    }
  }
}

export function parseCoreReceipt(value: unknown): CoreReceipt {
  if (!receiptValidator(value)) {
    throw new ContractError(errorsText(receiptValidator.errors));
  }
  checkReceiptIdentity(value);
  return value;
}

export function parseJournalReceipt(value: unknown): JournalReceipt {
  if (typeof value === 'object' && value !== null && 'contractId' in value && value.contractId === 'privacy-bubble.integration.v1') {
    if (!integrationValidator(value)) throw new ContractError(errorsText(integrationValidator.errors));
    return value;
  }
  return parseCoreReceipt(value);
}

/** Throws ContractError. Unknown properties and malformed nested receipts fail closed. */
export function parseDashboardEvent(value: unknown): DashboardEvent {
  if (!eventValidator(value)) {
    throw new ContractError(errorsText(eventValidator.errors));
  }
  if (value.receipt !== null && value.type !== 'integration.receipt') checkReceiptIdentity(value.receipt);
  return value;
}

export type EventValidation =
  | { readonly valid: true; readonly event: DashboardEvent }
  | { readonly valid: false; readonly error: string };

/** UI-friendly boundary, including malformed JSON from MessageEvent.data. */
export function validateDashboardEvent(value: unknown): EventValidation {
  try {
    return { valid: true, event: parseDashboardEvent(typeof value === 'string' ? JSON.parse(value) : value) };
  } catch (error) {
    if (error instanceof ContractError || error instanceof SyntaxError) {
      return { valid: false, error: error.message };
    }
    throw error;
  }
}
