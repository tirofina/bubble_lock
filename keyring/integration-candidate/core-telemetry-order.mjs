const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const uint = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
const identity = (value) => typeof value === 'string' && id.exec(value)?.[0] === value;
const validSource = (source) => identity(source?.gatewayId) && identity(source?.deviceId)
  && uint(source?.ownershipEpoch, 2147483647);
const matches = (owner, source) => validSource(owner) && owner.gatewayId === source.gatewayId
  && owner.deviceId === source.deviceId && owner.ownershipEpoch === source.ownershipEpoch;
const copySource = ({ gatewayId, deviceId, ownershipEpoch }) => ({ gatewayId, deviceId, ownershipEpoch });
const validBinding = (binding) => typeof binding?.payloadHash === 'string' && binding.payloadHash.length === 64
  && /^[a-f0-9]{64}$/.test(binding.payloadHash) && typeof binding.cseRequestId === 'string'
  && binding.cseRequestId.length === 51 && /^kr-[a-f0-9]{48}$/.test(binding.cseRequestId);

/**
 * Serialize confirmed CSE updates inside one resource owner process.
 * source is authenticated ingress context, including its original epoch.
 * readCursor/writeCursor must access the durable record for the canonical CSE resource.
 * compareAndSetOwner must confirm the expected owner and durably commit the replacement.
 */
export function createTelemetryOrder({ readOwner, readCursor, writeCursor, compareAndSetOwner, maxPending = 32 }) {
  if (!Number.isInteger(maxPending) || maxPending < 1) throw new RangeError('Invalid telemetry queue bound');
  const lanes = new Map();
  const unresolvedWrites = new Set();

  async function checkedCursor(resource) {
    const cursor = await readCursor(resource);
    if (cursor != null && (!validSource(cursor) || !uint(cursor.sequence, 4294967295)
        || !['PENDING', 'APPLIED'].includes(cursor.phase)
        || (cursor.binding !== undefined && !validBinding(cursor.binding)))) {
      throw new Error('INVALID_TELEMETRY_CURSOR');
    }
    return cursor;
  }

  async function update(resource, source, payload, apply, binding) {
    if (unresolvedWrites.has(resource)) return { status: 'REVIEW_PENDING' };
    const cursor = await checkedCursor(resource);
    if (cursor?.phase === 'PENDING') return { status: 'REVIEW_PENDING' };
    if (!matches(await readOwner(resource), source)) return { status: 'NOT_OWNER' };
    if (cursor && (cursor.deviceId !== source.deviceId
        || (cursor.ownershipEpoch === source.ownershipEpoch && cursor.gatewayId !== source.gatewayId))) {
      return { status: 'REVIEW_BINDING' };
    }
    if (binding && cursor?.ownershipEpoch === source.ownershipEpoch && cursor.sequence === payload.sequence) {
      if (!cursor.binding) return { status: 'REVIEW_BINDING' };
      if (cursor.binding.payloadHash !== binding.payloadHash || cursor.binding.cseRequestId !== binding.cseRequestId) {
        return { status: 'CONFLICT' };
      }
      return { status: 'APPLIED', replayed: true };
    }
    if (cursor && (source.ownershipEpoch < cursor.ownershipEpoch
        || (source.ownershipEpoch === cursor.ownershipEpoch && payload.sequence <= cursor.sequence))) {
      return { status: 'STALE_SEQUENCE' };
    }

    const next = { ...source, sequence: payload.sequence, phase: 'PENDING' };
    if (binding) next.binding = binding;
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

  function enqueue(resource, operation) {
    let lane = lanes.get(resource);
    if (lane?.count >= maxPending) return Promise.resolve({ status: 'REVIEW_CAPACITY' });
    if (!lane) {
      lane = { tail: Promise.resolve(), count: 0 };
      lanes.set(resource, lane);
    }
    ++lane.count;
    const result = lane.tail.then(operation);
    lane.tail = result.catch(() => {});
    return result.finally(() => {
      if (--lane.count === 0) lanes.delete(resource);
    });
  }

  function submit(resource, source, payload, apply, binding) {
    if (typeof resource !== 'string' || !resource || !validSource(source)
        || payload?.gatewayId !== source.gatewayId || payload?.deviceId !== source.deviceId
        || typeof payload?.state !== 'boolean' || !uint(payload?.sequence, 4294967295)
        || typeof apply !== 'function' || (binding !== undefined && !validBinding(binding))) {
      return Promise.resolve({ status: 'INVALID_TELEMETRY_BINDING' });
    }
    const context = copySource(source);
    const message = structuredClone(payload);
    const proof = binding && { payloadHash: binding.payloadHash, cseRequestId: binding.cseRequestId };
    return enqueue(resource, () => update(resource, context, message, apply, proof));
  }

  submit.transition = function transition(resource, expected, replacement) {
    if (typeof resource !== 'string' || !resource || typeof compareAndSetOwner !== 'function'
        || !validSource(expected) || !validSource(replacement) || expected.deviceId !== replacement.deviceId
        || expected.ownershipEpoch >= replacement.ownershipEpoch) {
      return Promise.resolve({ status: 'INVALID_OWNER_TRANSITION' });
    }
    const previous = copySource(expected);
    const next = copySource(replacement);
    return enqueue(resource, async () => {
      if (unresolvedWrites.has(resource)) return { status: 'REVIEW_PENDING' };
      const cursor = await checkedCursor(resource);
      if (cursor?.phase === 'PENDING') return { status: 'REVIEW_PENDING' };
      if (!matches(await readOwner(resource), previous)) return { status: 'OWNER_CHANGED' };
      if (cursor && (cursor.deviceId !== previous.deviceId || cursor.ownershipEpoch > previous.ownershipEpoch
          || (cursor.ownershipEpoch === previous.ownershipEpoch && cursor.gatewayId !== previous.gatewayId))) {
        return { status: 'REVIEW_BINDING' };
      }
      try {
        const committed = await compareAndSetOwner(resource, previous, next);
        if (committed === true) return { status: 'OWNER_SWITCHED' };
        if (committed === false) return { status: 'OWNER_CHANGED' };
      } catch {
        // An uncertain owner write also fences telemetry for this resource.
      }
      unresolvedWrites.add(resource);
      return { status: 'REVIEW_OWNER_WRITE' };
    });
  };
  return submit;
}
