import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMtlsFetch } from '../../pc-mobius/integration/src/fl-worker.mjs';

const pki = process.argv[2];
const material = async (name) => ({ ca: await readFile(join(pki, 'trusted.pem')), cert: await readFile(join(pki, `${name}.pem`)), key: await readFile(join(pki, `${name}.key`)) });
const server = createServer({ ...await material('server'), minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true }, (request, response) => {
  assert.equal(request.socket.getProtocol(), 'TLSv1.3');
  if (request.url === '/slow') return;
  if (request.url === '/large') { response.end('x'.repeat(1024)); return; }
  if (request.url === '/json') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ authenticated: request.socket.authorized })); return; }
  response.writeHead(Number(request.url.slice(1)), { 'x-result': 'complete' }); response.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `https://127.0.0.1:${server.address().port}`;
const fetch = createMtlsFetch({ ...await material('client'), timeoutMs: 500, maxBytes: 256 });
let checks = 0;
try {
  for (const status of [204, 205, 304]) {
    const result = await fetch(`${origin}/${status}`, { method: status === 204 ? 'DELETE' : 'GET' });
    assert.equal(result.status, status); assert.equal(await result.text(), ''); assert.equal(result.headers.get('x-result'), 'complete'); checks++;
  }
  assert.deepEqual(await (await fetch(`${origin}/json`)).json(), { authenticated: true }); checks++;
  assert.equal(await (await fetch(`${origin}/200`, { method: 'HEAD' })).text(), ''); checks++;
  await assert.rejects(fetch(`${origin}/large`), /FL_RESPONSE_SIZE/); checks++;
  await assert.rejects(fetch(`${origin}/slow`), /FL_HTTPS_TIMEOUT/); checks++;
  console.log(JSON.stringify({ status: 'PASS', checks, transport: 'actual-TLS1.3-mTLS' }));
} finally { fetch.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
