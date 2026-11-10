import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

const path = '/onem2m/keyring/receipt-notifications';
const rqiPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const [ca, cert, key] = await Promise.all(['ca.pem', 'relay.pem', 'relay.key'].map((name) => readFile(`/relay/tls/${name}`)));

function forward(method, headers, body) {
  return new Promise((resolve, reject) => {
    const outbound = httpsRequest({ hostname: 'host.docker.internal', servername: 'localhost', port: 8790, path,
      method, headers, ca, cert, key, minVersion: 'TLSv1.3', rejectUnauthorized: true,
      signal: AbortSignal.timeout(8000),
    }, (response) => {
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers }));
      response.resume();
    });
    outbound.once('error', reject);
    outbound.end(body);
  });
}

// Check the actual host TLS path without sending a notification or inserting an inbox row.
const ready = await forward('HEAD');
if (ready.status !== 405 || ready.headers['x-m2m-rsc'] !== '4005') throw new Error('RECEIPT_CALLBACK_TRANSPORT_UNAVAILABLE');

const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000,
  connectionsCheckingInterval: 1000 }, async (incoming, outgoing) => {
  const respond = (status, rsc, id) => outgoing.writeHead(status, { 'x-m2m-rsc': String(rsc),
    ...(id ? { 'x-m2m-ri': id } : {}), 'content-length': '0', connection: 'close',
  }).end();
  if (incoming.method !== 'POST' || incoming.url !== path) return respond(400, 4000);
  const rqi = incoming.headers['x-m2m-ri'];
  if (incoming.headers['x-m2m-origin'] !== '/Mobius4' || incoming.headers['x-m2m-rvi'] !== '4'
      || incoming.headers['content-type'] !== 'application/json' || incoming.headers['content-encoding'] !== undefined
      || typeof rqi !== 'string' || rqiPattern.exec(rqi)?.[0] !== rqi) return respond(400, 4000);

  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > 8192) return respond(413, 4000, rqi);
      chunks.push(chunk);
    }
    const result = await forward('POST', { 'Content-Type': 'application/json', 'Content-Length': length,
      'X-M2M-Origin': '/Mobius4', 'X-M2M-RI': rqi, 'X-M2M-RVI': '4',
    }, Buffer.concat(chunks, length));
    const rsc = result.headers['x-m2m-rsc'];
    if (result.headers['x-m2m-ri'] !== rqi || !/^\d{4}$/.test(rsc)) return respond(502, 5000, rqi);
    return respond(result.status, rsc, rqi);
  } catch {
    if (!outgoing.destroyed) respond(503, 5000, rqi);
  }
});

const listening = once(server, 'listening');
server.listen(8791, '127.0.0.1');
await listening;
console.log('SCOPED_RECEIPT_RELAY_READY');
