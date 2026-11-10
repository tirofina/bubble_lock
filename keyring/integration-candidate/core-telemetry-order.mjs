const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const uint = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const identity = (value) => typeof value === 'string' && id.test(value);
const validSource = (source) => identity(source?.gatewayId) && identity(source?.deviceId)
  && uint(source?.ownershipEpoch, 2147483647);
const matches = (owner, source) => validSource(owner) && owner.gatewayId === source.gatewayId
  && owner.deviceId === source.deviceId && owner.ownershipEpoch === source.ownershipEpoch;

/**
 * Serialize confirmed CSE updates inside one resource owner process.
 * source is authenticated ingress context, including its original epoch.
 * readCursor/writeCursor must access the durable record for the canonical CSE resource.
 */
export function createTelemetryOrder({ readOwner, readCursor, writeCursor, maxPending = 32 }) {
  if (!Number.isInteger(maxPending) || maxPending < 1) throw new RangeError('Invalid telemetry queue bound');
  const lanes = new Map();
  const unresolvedWrites = new Set();

  async function update(resource, source, payload, apply) {
    if (unresolvedWrites.has(resource)) return { status: 'REVIEW_PENDING' };
    const cursor = await readCursor(resource);
    if (cursor != null && (!validSource(cursor) || !uint(cursor.sequence, 4294967295)
        || !['PENDING', 'APPLIED'].includes(cursor.phase))) {
      throw new Error('INVALID_TELEMETRY_CURSOR');
    }
    if (cursor?.phase === 'PENDING') return { status: 'REVIEW_PENDING' };
    if (!matches(await readOwner(resource), source)) return { status: 'NOT_OWNER' };
    if (cursor && (cursor.deviceId !== source.deviceId
        || (cursor.ownershipEpoch === source.ownershipEpoch && cursor.gatewayId !== source.gatewayId))) {
      return { status: 'REVIEW_BINDING' };
    }
    if (cursor && (source.ownershipEpoch < cursor.ownershipEpoch
        || (source.ownershipEpoch === cursor.ownershipEpoch && payload.sequence <= cursor.sequence))) {
      return { status: 'STALE_SEQUENCE' };
    }

    const next = { ...source, sequence: payload.sequence, phase: 'PENDING' };
    try {
      await writeCursor(resource, next);
      if (!matches(await readOwner(resource), source)) {
        await writeCursor(resource, cursor ?? null);
        return { status: 'NOT_OWNER' };
      }
      // A late rejection or lost response leaves the intent unresolved.
      const receipt = await apply(payload);
      if (receipt?.status !== 'APPLIED') return { status: 'REVIEW_PENDING' };
      await writeCursor(resource, { ...next, phase: 'APPLIED' });
      return receipt;
    } catch {
      unresolvedWrites.add(resource);
      return { status: 'REVIEW_PENDING' };
    }
  }

  return function submit(resource, source, payload, apply) {
    if (typeof resource !== 'string' || !resource || !validSource(source)
        || payload?.gatewayId !== source.gatewayId || payload?.deviceId !== source.deviceId
        || typeof payload?.state !== 'boolean' || !uint(payload?.sequence, 4294967295)
        || typeof apply !== 'function') {
      return Promise.resolve({ status: 'INVALID_TELEMETRY_BINDING' });
    }
    let lane = lanes.get(resource);
    if (lane?.count >= maxPending) return Promise.resolve({ status: 'REVIEW_CAPACITY' });
    const context = { gatewayId: source.gatewayId, deviceId: source.deviceId, ownershipEpoch: source.ownershipEpoch };
    const message = structuredClone(payload);
    if (!lane) {
      lane = { tail: Promise.resolve(), count: 0 };
      lanes.set(resource, lane);
    }
    ++lane.count;
    const result = lane.tail.then(() => update(resource, context, message, apply));
    lane.tail = result.catch(() => {});
    return result.finally(() => {
      if (--lane.count === 0) lanes.delete(resource);
    });
  };
}
