import { createHash } from 'node:crypto';

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const resourceName = /^gw-[a-f0-9]{64}$/;
const exact = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function cseCreatedAt(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (parts?.[0] !== value) return null;
  const [, year, month, day, hour, minute, second] = parts;
  const timestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === timestamp ? timestamp : null;
}

export class InvalidNativeReceipt extends Error {}

export function commandReceiptName(commandId) {
  if (!exact(id, commandId)) throw new InvalidNativeReceipt('INVALID_COMMAND_ID');
  const originalRequestId = `kr-${sha256(`receipt:${commandId}`).slice(0, 48)}`;
  return `gw-${sha256(originalRequestId)}`;
}

/** retrieve(path) uses a fixed authenticated CSE, verifies response RQI and returns { status, rsc, body }. */
export function createNativeReceiptReader({ receiptContainers, retrieve }) {
  const gatewayByContainer = new Map();
  for (const [gatewayId, container] of Object.entries(receiptContainers)) {
    const segments = typeof container === 'string' ? container.split('/') : [];
    if (!exact(id, gatewayId) || segments.length < 3 || segments[0] !== ''
        || segments.slice(1).some((part) => !exact(segment, part)) || gatewayByContainer.has(container)) {
      throw new Error('INVALID_RECEIPT_CONTAINER_MAPPING');
    }
    gatewayByContainer.set(container, gatewayId);
  }

  return async function readNativeReceipt(nativeRef) {
    if (typeof nativeRef !== 'string') throw new InvalidNativeReceipt('INVALID_NATIVE_REFERENCE');
    const separator = nativeRef.lastIndexOf('/');
    const gatewayId = gatewayByContainer.get(nativeRef.slice(0, separator));
    const name = nativeRef.slice(separator + 1);
    if (!gatewayId || !exact(resourceName, name)) throw new InvalidNativeReceipt('INVALID_NATIVE_REFERENCE');

    const { status, rsc, body } = await retrieve(nativeRef);
    if (status === 404 && rsc === 4004) return null;
    if (status !== 200 || rsc !== 2000) throw new Error('NATIVE_RECEIPT_RETRIEVE_FAILED');

    const cin = body?.['m2m:cin'];
    const receipt = cin?.con;
    const storedAt = cseCreatedAt(cin?.ct);
    if (cin?.ty !== 4 || cin.rn !== name || !exact(id, cin.ri) || !storedAt || !exact(id, receipt?.commandId)) {
      throw new InvalidNativeReceipt('INVALID_NATIVE_CONTENT_INSTANCE');
    }
    if (name !== commandReceiptName(receipt.commandId)) throw new InvalidNativeReceipt('NATIVE_RECEIPT_NAME_BINDING');
    return { gatewayId, resourceId: cin.ri, storedAt, receipt };
  };
}
