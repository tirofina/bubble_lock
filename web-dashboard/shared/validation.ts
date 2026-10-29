import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../contracts/dashboard-event.schema.json' with { type: 'json' };
import type { CoreReceipt, DashboardEvent } from './types.ts';

export class ContractError extends Error {
  readonly details: string;
  constructor(details: string) {
    super(details);
    this.name = 'ContractError';
    this.details = details;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const eventValidator = ajv.compile<DashboardEvent>(schema);
const receiptValidator = ajv.compile<CoreReceipt>({
  $ref: `${schema.$id}#/$defs/coreReceipt`,
});

function checkReceiptIdentity(receipt: CoreReceipt): void {
  const payload = receipt.payload;
  if (payload !== undefined) {
    if (receipt.deviceId !== payload.deviceId) {
      throw new ContractError('Receipt deviceId does not match payload.deviceId');
    }
    if ('commandId' in payload && receipt.commandId !== payload.commandId) {
      throw new ContractError('Receipt commandId does not match payload.commandId');
    }
    if ('ackState' in payload && receipt.ackState !== payload.ackState) {
      throw new ContractError('Receipt ackState does not match payload.ackState');
    }
    if ('sequence' in payload && receipt.sequence !== payload.sequence) {
      throw new ContractError('Receipt device sequence does not match payload.sequence');
    }
  }
  if (receipt.members !== undefined) {
    if (receipt.memberCount !== receipt.members.length ||
        new Set(receipt.members.map((member) => member.memberId)).size !== receipt.members.length ||
        receipt.members.some((member) => member.memberCommandId !== `${receipt.commandId}:${member.memberId}`)) {
      throw new ContractError('Group members do not match the count or commandId suffix contract');
    }
  }
}

export function parseCoreReceipt(value: unknown): CoreReceipt {
  if (!receiptValidator(value)) {
    throw new ContractError(ajv.errorsText(receiptValidator.errors));
  }
  checkReceiptIdentity(value);
  return value;
}

/** Throws ContractError. Unknown properties and malformed nested receipts fail closed. */
export function parseDashboardEvent(value: unknown): DashboardEvent {
  if (!eventValidator(value)) {
    throw new ContractError(ajv.errorsText(eventValidator.errors));
  }
  if (value.receipt !== null) checkReceiptIdentity(value.receipt);
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
