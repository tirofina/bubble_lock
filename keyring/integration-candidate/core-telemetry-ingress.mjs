import { createHash } from 'node:crypto';
import { createTelemetryOrder } from './core-telemetry-order.mjs';

const topicPattern = /^privacy-bubble\/gateway\/([A-Za-z0-9][A-Za-z0-9._:-]{0,63})\/telemetry-epoch\/([A-Za-z0-9][A-Za-z0-9._:-]{0,63})\/(0|[1-9][0-9]{0,9})$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const boundedInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** Use only on a trusted subscription whose broker enforces exclusive exact-topic publisher ACLs. */
export function createScopedTelemetryIngress({ resolveResource, apply, ...ordering }) {
  const submit = createTelemetryOrder(ordering);

  async function receive(topic, bytes, packet) {
    const match = typeof topic === 'string' ? topicPattern.exec(topic) : null;
    if (!match || match[0] !== topic || !boundedInt(Number(match[3]), 0, 2147483647)) {
      return { status: 'INVALID_TELEMETRY_TOPIC' };
    }
    if (packet?.retain !== false || !Buffer.isBuffer(bytes) || bytes.length > 4096) {
      return { status: 'INVALID_TELEMETRY_PACKET' };
    }
    const [, gatewayId, deviceId, epoch] = match;
    const ownershipEpoch = Number(epoch);
    let payload;
    try {
      payload = JSON.parse(utf8.decode(bytes));
    } catch {
      return { status: 'INVALID_TELEMETRY_PAYLOAD' };
    }
    if (payload?.gatewayId !== gatewayId || payload.deviceId !== deviceId
        || Object.hasOwn(payload, 'ownershipEpoch') || payload.schemaVersion !== '1.0.0'
        || typeof payload.state !== 'boolean' || !boundedInt(payload.sequence, 0, 4294967295)
        || !boundedInt(payload.batteryPct, 0, 100) || !boundedInt(payload.rssiDbm, -127, 20)
        || typeof payload.timestamp !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(payload.timestamp)
        || !Number.isFinite(Date.parse(payload.timestamp))) {
      return { status: 'INVALID_TELEMETRY_PAYLOAD' };
    }
    const resource = await resolveResource(deviceId);
    if (!resource) return { status: 'UNKNOWN_TELEMETRY_RESOURCE' };
    const source = { gatewayId, deviceId, ownershipEpoch };
    const requestId = 'kr-' + createHash('sha256').update(JSON.stringify(
      [resource, gatewayId, deviceId, ownershipEpoch, payload.sequence])).digest('hex').slice(0, 48);
    const binding = { cseRequestId: requestId, payloadHash: createHash('sha256').update(bytes).digest('hex') };
    const result = await submit(resource, source, payload,
      (message) => apply({ resource, source, requestId, payload: message }), binding);
    if (result.status !== 'APPLIED') return result;
    return { ...result, receipt: {
      version: 1, ...source, sequence: payload.sequence, ...binding, responseStatus: 2004,
    } };
  }

  receive.transition = async (expected, replacement) => {
    const resource = await resolveResource(expected?.deviceId);
    if (!resource) return { status: 'UNKNOWN_TELEMETRY_RESOURCE' };
    return submit.transition(resource, expected, replacement);
  };
  return receive;
}
