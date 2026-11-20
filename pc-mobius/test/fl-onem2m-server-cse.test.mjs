import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestPki, issueCertificate } from './support/mini-pki.mjs';
import { startFakeCse } from './helpers/fake-onem2m-cse.mjs';
import { flCseClientFromConfig, flCseTransport } from '../integration/src/fl-onem2m-plane.mjs';

// mTLS front end in the shape of the server CSE nginx route: DNS-only server certificate, client
// certificate required, /onem2m prefix stripped, X-M2M-Origin forced from the certificate CN.
async function startFrontEnd(t, cse) {
  const pki = createTestPki();
  const server = issueCertificate({ subjectCN: 'cse.test', issuer: pki.ca.signer, dns: ['cse.test'], eku: ['serverAuth'] });
  const seen = [];
  const proxy = createServer({ key: server.key, cert: server.cert, ca: pki.ca.cert, requestCert: true, rejectUnauthorized: true }, async (request, response) => {
    const cn = request.socket.getPeerCertificate()?.subject?.CN ?? null;
    seen.push({ method: request.method, path: request.url, host: request.headers.host, sni: request.socket.servername, cn });
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (!request.url.startsWith('/onem2m/Mobius') || request.url.startsWith('/onem2m/Mobius/acp-')) { response.writeHead(403, { 'content-type': 'text/html' }); response.end('<html>403 Forbidden</html>'); return; }
    const upstream = await fetch(`${cse.endpoint}${request.url.slice('/onem2m'.length)}`, { method: request.method, headers: { ...Object.fromEntries(Object.entries(request.headers).filter(([k]) => !['host', 'authorization', 'x-m2m-origin', 'connection'].includes(k))), 'x-m2m-origin': `Cpb-${cn}` }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    response.writeHead(upstream.status, { 'content-type': 'application/json', 'X-M2M-RSC': upstream.headers.get('x-m2m-rsc'), 'X-M2M-RI': upstream.headers.get('x-m2m-ri') ?? '' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => new Promise((done) => { proxy.closeAllConnections?.(); proxy.close(done); }));
  return { port: proxy.address().port, pki, seen };
}

test('FLS01 FL CSE client: mTLS with caFile, clientCertFile, clientKeyFile, servername and connectHost below a /onem2m prefix', async (t) => {
  const cse = await startFakeCse(); t.after(() => cse.close());
  const front = await startFrontEnd(t, cse);
  const dir = await mkdtemp(join(tmpdir(), 'bubble-fl-tls-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const client = front.pki.client('fl-coord');
  await writeFile(join(dir, 'ca.pem'), front.pki.ca.cert); await writeFile(join(dir, 'fl-coord.pem'), client.cert); await writeFile(join(dir, 'fl-coord.key'), client.key);
  const config = { cseUrl: `https://cse.test:${front.port}/onem2m`, cseBase: '/Mobius', caFile: './ca.pem', clientCertFile: './fl-coord.pem', clientKeyFile: './fl-coord.key', servername: 'cse.test', connectHost: '127.0.0.1' };
  const fl = flCseClientFromConfig(config, { baseDir: dir, originator: 'Cpb-fl-coord' });
  assert.deepEqual(fl.transport, { scheme: 'https', mutualTls: true, pinnedCa: true, servername: 'cse.test', connectHost: '127.0.0.1' });
  const ae = await fl.create('/Mobius', 2, { 'm2m:ae': { rn: 'fl-pm', api: 'N.test', rr: true, srv: ['4'] } });
  assert.equal(ae.rsc, 2001);
  // The front end refuses by itself (HTML, no X-M2M-RSC): a refused request, not a protocol error.
  const refused = await fl.retrieve('/Mobius/acp-fl-pm');
  assert.deepEqual([refused.ok, refused.rsc, refused.status], [false, null, 403]);
  const read = await fl.retrieve('/Mobius/fl-pm');
  assert.equal(read.payload['m2m:ae'].aei, 'Cpb-fl-coord', 'the front end binds the originator to the client certificate');
  assert.ok(front.seen.every((s) => s.sni === 'cse.test' && s.host === `cse.test:${front.port}` && s.cn === 'fl-coord'));
  assert.deepEqual(front.seen.map((s) => s.path), ['/onem2m/Mobius', '/onem2m/Mobius/acp-fl-pm', '/onem2m/Mobius/fl-pm']);
  assert.throws(() => flCseTransport({ ...config, clientKeyFile: undefined }, dir), (e) => e.code === 'FL_CSE_TLS_CONFIG');
  assert.throws(() => flCseTransport({ ...config, cseUrl: 'http://127.0.0.1:1/onem2m' }, dir), (e) => e.code === 'FL_CSE_TLS_CONFIG');
});
