const cseId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const pathPattern = /^(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){2,8}$/;
const resourceName = /^gw-[a-f0-9]{64}$/;
const exact = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** verifiedCseKey is supplied by the authenticated server transport, never by the request. */
export function createReceiptNotificationIngress({ subscriptions, enqueue }) {
  const bindings = new Map();
  for (const { cseKey, originator, rvi = '4', subscriptionRef, receiptContainer } of subscriptions) {
    if (!exact(cseId, cseKey) || typeof originator !== 'string' || !originator || typeof rvi !== 'string'
        || !exact(pathPattern, receiptContainer) || typeof subscriptionRef !== 'string') {
      throw new Error('INVALID_RECEIPT_SUBSCRIPTION');
    }
    const wireContainer = subscriptionRef.startsWith('/') ? receiptContainer : receiptContainer.slice(1);
    const slash = subscriptionRef.lastIndexOf('/');
    const subscriptionName = subscriptionRef.slice(slash + 1);
    const key = JSON.stringify([cseKey, subscriptionRef]);
    if (subscriptionRef.slice(0, slash) !== wireContainer || !exact(cseId, subscriptionName) || bindings.has(key)) {
      throw new Error('INVALID_RECEIPT_SUBSCRIPTION');
    }
    bindings.set(key, { originator, rvi, receiptContainer, wireContainer });
  }

  return async function receive({ verifiedCseKey, headers, body }) {
    const requestId = headers?.['x-m2m-ri'];
    const reply = (httpStatus, rsc) => ({ httpStatus, headers: {
      'x-m2m-rsc': String(rsc), ...(exact(requestIdPattern, requestId) ? { 'x-m2m-ri': requestId } : {}),
    } });
    if (!exact(cseId, verifiedCseKey)) return reply(403, 4103);
    if (!exact(requestIdPattern, requestId) || !Buffer.isBuffer(body) || body.length > 8192) return reply(400, 4000);
    let signal;
    try {
      signal = JSON.parse(utf8.decode(body))?.['m2m:sgn'];
    } catch {
      return reply(400, 4000);
    }
    const binding = typeof signal?.sur === 'string' && bindings.get(JSON.stringify([verifiedCseKey, signal.sur]));
    if (!binding || headers['x-m2m-origin'] !== binding.originator || headers['x-m2m-rvi'] !== binding.rvi) {
      return reply(403, 4103);
    }
    if (signal.vrq === true && !Object.hasOwn(signal, 'nev') && !Object.hasOwn(signal, 'sud')) return reply(200, 2000);
    const rep = signal.nev?.rep;
    const uri = rep?.['m2m:uri'];
    if (Object.hasOwn(signal, 'vrq') || Object.hasOwn(signal, 'sud') || signal.nev?.net !== 3
        || typeof uri !== 'string' || Object.keys(rep).length !== 1) return reply(400, 4000);
    const separator = uri.lastIndexOf('/');
    const name = uri.slice(separator + 1);
    if (uri.slice(0, separator) !== binding.wireContainer || !exact(resourceName, name)) return reply(400, 4000);
    try {
      await enqueue({ cseKey: verifiedCseKey, nativeRef: `${binding.receiptContainer}/${name}` });
    } catch {
      return reply(503, 5000);
    }
    return reply(200, 2000);
  };
}
