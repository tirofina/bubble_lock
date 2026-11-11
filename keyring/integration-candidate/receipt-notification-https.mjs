import { createServer } from 'node:https';

const maxBody = 8192;
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const cseKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const jsonType = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i;
const exact = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;

async function readBody(request) {
  const chunks = [];
  let length = 0;
  // The caller writes a bounded error response before the connection is closed.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBody) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

/** Use this handler on a TLS listener that authenticates the CSE relay client certificate. */
export function createReceiptNotificationHttpHandler({ peers, receive, path = '/onem2m/keyring/receipt-notifications' }) {
  const fingerprints = new Map();
  for (const { fingerprint256, cseKey } of peers) {
    if (!exact(fingerprintPattern, fingerprint256) || !exact(cseKeyPattern, cseKey) || fingerprints.has(fingerprint256)) {
      throw new Error('INVALID_RECEIPT_CALLBACK_PEER');
    }
    fingerprints.set(fingerprint256, cseKey);
  }
  if (!fingerprints.size) throw new Error('RECEIPT_CALLBACK_PEER_REQUIRED');

  return async function handle(request, response) {
    const reject = (httpStatus, rsc) => response.writeHead(httpStatus, {
      'x-m2m-rsc': String(rsc), 'content-length': '0', connection: 'close',
    }).end();
    if (request.url !== path) return reject(404, 4004);
    if (request.method !== 'POST') return reject(405, 4005);
    const peer = request.socket.authorized === true && request.socket.getPeerCertificate?.();
    const verifiedCseKey = fingerprints.get(peer?.fingerprint256);
    if (!verifiedCseKey) return reject(403, 4103);
    if (!exact(jsonType, request.headers['content-type']) || request.headers['content-encoding'] !== undefined) {
      return reject(415, 4000);
    }
    const declaredSize = request.headers['content-length'];
    if (declaredSize !== undefined && Number(declaredSize) > maxBody) return reject(413, 4000);

    let body;
    try {
      body = await readBody(request);
    } catch {
      if (!response.destroyed) return reject(400, 4000);
      return;
    }
    if (body === null) return reject(413, 4000);
    try {
      const { httpStatus, headers } = await receive({ verifiedCseKey, headers: request.headers, body });
      if (!response.destroyed) response.writeHead(httpStatus, { ...headers, 'content-length': '0' }).end();
    } catch {
      if (!response.destroyed) return reject(503, 5000);
    }
  };
}

export function createReceiptNotificationHttpsServer({ tls, ...handler }) {
  return createServer({ ...tls, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true,
    maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000, connectionsCheckingInterval: 1000,
  }, createReceiptNotificationHttpHandler(handler));
}
