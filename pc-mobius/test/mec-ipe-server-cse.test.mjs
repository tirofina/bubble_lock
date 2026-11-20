import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createTestPki, issueCertificate } from './support/mini-pki.mjs';
import { startFakeCse } from './support/fake-onem2m-cse.mjs';
import { startMecSandboxSimulator } from '../integration/src/mec-sandbox-simulator.mjs';
import { MecIpe, isDeviceRef, parseMecRequest } from '../integration/src/mec-ipe.mjs';
import { MecPlatformClient, createMecFetch, onem2mCseConfig } from '../integration/src/mec-platform-client.mjs';
import { Onem2mHttpClient } from '../integration/src/onem2m-http-client.mjs';
import { MecCipher } from '../integration/src/mec-state.mjs';

const ueAddress = '10.100.0.7';

/** HTTPS stand-in for the originator-binding proxy: DNS-only server certificate, client certificate required. */
async function startMtlsProxy(t, { servername = 'cse.test' } = {}) {
  const pki = createTestPki();
  const server = issueCertificate({ subjectCN: servername, issuer: pki.ca.signer, dns: [servername], eku: ['serverAuth'] });
  const ipe = issueCertificate({ subjectCN: 'pb-mec-ipe', issuer: pki.ca.signer, dns: ['pb-mec-ipe'], eku: ['clientAuth'] });
  const seen = [];
  const proxy = createServer({ key: server.key, cert: server.cert, ca: pki.ca.cert, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, (request, response) => {
    seen.push({ method: request.method, path: request.url, host: request.headers.host, sni: request.socket.servername, clientCN: request.socket.getPeerCertificate()?.subject?.CN ?? null, origin: request.headers['x-m2m-origin'] });
    response.writeHead(200, { 'content-type': 'application/json', 'X-M2M-RSC': '2000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' });
    response.end(JSON.stringify({ 'm2m:cb': { rn: 'Mobius', csi: '/bubble-cse' } }));
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => new Promise((done) => { proxy.closeAllConnections?.(); proxy.close(done); }));
  return { port: proxy.address().port, ca: pki.ca.cert, client: ipe, foreign: pki.client('visitor'), seen, servername };
}

test('R16 server CSE: settings come from ONEM2M_* with the MEC CA as the default trust anchor', () => {
  const config = onem2mCseConfig({ ONEM2M_CSE_URL: 'https://cse.example:8443/onem2m/', ONEM2M_CSE_ID: '/bubble-cse', ONEM2M_CLIENT_CERT_FILE: '/etc/pb-ipe/server-cse/client.pem', ONEM2M_CLIENT_KEY_FILE: '/etc/pb-ipe/server-cse/client.key', ONEM2M_CA_FILE: '/etc/pb-ipe/server-cse/trust-bundle.pem', ONEM2M_SERVERNAME: 'cse.example' }, { fallbackCaFile: '/etc/pb-ipe/ca.pem' });
  assert.deepEqual(config, { endpoint: 'https://cse.example:8443/onem2m', cseBase: '/Mobius', cseId: '/bubble-cse', caFile: '/etc/pb-ipe/server-cse/trust-bundle.pem', certFile: '/etc/pb-ipe/server-cse/client.pem', keyFile: '/etc/pb-ipe/server-cse/client.key', servername: 'cse.example' });
  const defaults = onem2mCseConfig({ ONEM2M_CSE_URL: 'https://192.0.2.106:17599' }, { fallbackCaFile: '/etc/pb-ipe/ca.pem' });
  assert.deepEqual([defaults.caFile, defaults.certFile, defaults.keyFile, defaults.servername, defaults.cseId], ['/etc/pb-ipe/ca.pem', null, null, null, null]);
  assert.equal(onem2mCseConfig({}).endpoint, null);
  assert.throws(() => createMecFetch({ cert: 'only-a-certificate' }), /client certificate and key/);
});

test('R16 server CSE: mTLS with SNI and Host set to the DNS name while dialing an IP, below a /onem2m path prefix', async (t) => {
  const proxy = await startMtlsProxy(t);
  const fetchImpl = createMecFetch({ ca: proxy.ca, cert: proxy.client.cert, key: proxy.client.key, servername: proxy.servername });
  const client = new Onem2mHttpClient({ endpoint: `https://127.0.0.1:${proxy.port}/onem2m/`, cseBase: '/Mobius', originator: 'Cpb-mec-ipe', fetchImpl });
  const answer = await client.retrieve('/Mobius/pb-mec-ipe/locationRequests', { fu: 1, ty: 4 });
  assert.equal(answer.rsc, 2000);
  assert.equal(answer.path, '/Mobius/pb-mec-ipe/locationRequests');
  assert.deepEqual(proxy.seen.at(-1), { method: 'GET', path: '/onem2m/Mobius/pb-mec-ipe/locationRequests?fu=1&ty=4', host: `cse.test:${proxy.port}`, sni: 'cse.test', clientCN: 'pb-mec-ipe', origin: 'Cpb-mec-ipe' });
  // Without the server name the DNS-only certificate does not match the IP address.
  const noName = new Onem2mHttpClient({ endpoint: `https://127.0.0.1:${proxy.port}/onem2m`, originator: 'Cpb-mec-ipe', fetchImpl: createMecFetch({ ca: proxy.ca, cert: proxy.client.cert, key: proxy.client.key }) });
  await assert.rejects(noName.retrieve('/Mobius'), (error) => error.code === 'CSE_TRANSPORT_REVIEW' && /ERR_TLS_CERT_ALTNAME_INVALID/.test(error.cause?.cause?.code ?? ''));
  // Without a client certificate the proxy ends the handshake.
  const anonymous = new Onem2mHttpClient({ endpoint: `https://127.0.0.1:${proxy.port}/onem2m`, originator: 'Cpb-mec-ipe', fetchImpl: createMecFetch({ ca: proxy.ca, servername: proxy.servername }) });
  await assert.rejects(anonymous.retrieve('/Mobius'), /oneM2M transport/);
  // A client certificate from the same CA reaches the proxy; the proxy (not this client) binds the originator.
  const visitor = createMecFetch({ ca: proxy.ca, cert: proxy.foreign.cert, key: proxy.foreign.key, servername: proxy.servername });
  assert.equal((await visitor(`https://127.0.0.1:${proxy.port}/onem2m/Mobius`, { headers: { 'X-M2M-Origin': 'Cvisitor' } })).status, 200);
  assert.equal(proxy.seen.at(-1).clientCN, 'visitor');
  assert.equal(proxy.seen.length, 2);
});

test('R16 server CSE: deviceAe accepts <ae> and <ae>/<container>; every other shape is rejected', () => {
  for (const value of ['keyring-1', 'bubble-household-1/resident-relay', 'bubble-household-1/keyring-1']) assert.equal(isDeviceRef(value), true, value);
  for (const value of ['', '/', 'a/', '/a', 'a//b', 'a/b/c', 'a/..', '../a', 'a/.', 'a/la', 'a/ol', 'la', 'a b', 'a/b?x', 'a\\b', 'a/%2e', 7, null, 'x'.repeat(65)]) assert.equal(isDeviceRef(value), false, String(value));
  const request = parseMecRequest('Location', { op: 'subscribe', requestId: 'loc-1', deviceAe: 'bubble-household-1/resident-relay', ueAddress, type: 'periodic' });
  assert.equal(request.deviceAe, 'bubble-household-1/resident-relay');
  assert.throws(() => parseMecRequest('RNIS', { op: 'subscribe', requestId: 'r-1', deviceAe: 'bubble-household-1/resident-relay/rnis', ueAddress }), /request-device/);
});

test('R16 server CSE: the IPE writes MEC013/MEC012 cins under <household AE>/<device container>/location and rnis', async (t) => {
  let now = Date.now(); const clock = () => now;
  const sim = await startMecSandboxSimulator({ locationVersion: 'v3', now: clock });
  const cse = await startFakeCse({ cseId: '/bubble-cse' });
  const ids = { ipe: 'Cpb-mec-ipe', household: 'Chousehold-test', requester: 'Cguardian-app' };
  const household = new Onem2mHttpClient({ endpoint: cse.endpoint, originator: ids.household });
  const app = new Onem2mHttpClient({ endpoint: cse.endpoint, originator: ids.requester });
  const ae = await household.registerAe({ rn: 'bubble-household-1', api: 'N.test.household' });
  await household.ensure(ae.path, 3, { 'm2m:cnt': { rn: 'resident-relay' } });
  for (const rn of ['location', 'rnis']) await household.ensure(`${ae.path}/resident-relay`, 3, { 'm2m:cnt': { rn } });
  const cipher = new MecCipher({ store: { path: null }, encryptionKey: randomBytes(32).toString('base64') });
  const platform = new MecPlatformClient({ platformRoot: sim.platformRoot, simulation: true });
  const ipe = new MecIpe({ cse: { endpoint: cse.endpoint, cseId: cse.cseId }, originator: ids.ipe, aeName: 'pb-mec-ipe', platform, requesters: { Location: [ids.requester], RNIS: [ids.requester] }, readers: [ids.requester], cipher, clock, renewCheckMs: 3600000, simulation: true, cellLocations: { 'cell-B': { lat: 43.7386, lon: 7.4224 } } });
  const started = await ipe.start();
  t.after(async () => { await ipe.stop(); await sim.close(); await cse.close(); });
  const settle = () => ipe.idle();
  const request = async (service, con) => { await app.create(started.paths[service], 4, { 'm2m:cin': { cnf: 'application/json', con, cr: null } }); for (let i = 0; i < 50 && !ipe.pending.size; i += 1) await new Promise((done) => setTimeout(done, 10)); await settle(); };
  const deviceAe = 'bubble-household-1/resident-relay';
  await request('RNIS', { op: 'subscribe', requestId: 'rnis-1', deviceAe, ueAddress, durationSec: 600 });
  await request('Location', { op: 'subscribe', requestId: 'loc-1', deviceAe, ueAddress, type: 'periodic', periodSec: 2, durationSec: 600 });
  await request('Location', { op: 'subscribe', requestId: 'loc-2', deviceAe: 'bubble-household-1/keyring-9', ueAddress, durationSec: 600 });
  const statuses = cse.children(started.paths.status, 4).map((item) => item.attrs.con);
  assert.deepEqual(statuses.map((item) => [item.requestId, item.state, item.reason ?? null]), [['rnis-1', 'ACTIVE', null], ['loc-1', 'ACTIVE', null], ['loc-2', 'REJECTED', 'device-container-unavailable']]);
  assert.deepEqual(ipe.store.list('ipeRequests').filter((item) => item.state === 'ACTIVE').map((item) => item.container).sort(), ['/Mobius/bubble-household-1/resident-relay/location', '/Mobius/bubble-household-1/resident-relay/rnis']);
  await sim.cellChange(ueAddress, { srcCellId: 'cell-A', trgCellId: 'cell-B' }); await settle();
  const rnisCin = cse.children('/Mobius/bubble-household-1/resident-relay/rnis', 4).at(-1);
  assert.equal(rnisCin.attrs.con.deviceId, deviceAe); assert.equal(rnisCin.attrs.cr, ids.ipe); assert.equal(rnisCin.attrs.con.trgCellId, 'cell-B');
  await sim.moveUe(ueAddress, { lat: 43.7385, lon: 7.4225, accuracyM: 8, zoneId: 'zone-B', accessPointId: 'ap-B1' }); await settle();
  const locationCin = cse.children('/Mobius/bubble-household-1/resident-relay/location', 4).at(-1);
  assert.equal(locationCin.attrs.loc.crd, '[7.423,43.739]');
  assert.ok(locationCin.attrs.lbl.includes(`pb:device:${deviceAe}`));
  assert.deepEqual(cipher.open(locationCin.attrs.con.precise, `${deviceAe}:${locationCin.attrs.con.eventKey}`), { lat: 43.7385, lon: 7.4225, accuracyM: 8 });
  assert.equal(cse.resources.get('Mobius/bubble-household-1/resident-relay/location').attrs.loc.crd, '[7.423,43.739]');
  // The single-segment form keeps working against an AE with its own location container.
  assert.equal(parseMecRequest('Location', { op: 'subscribe', requestId: 'loc-3', deviceAe: 'bubble-household-1', ueAddress }).deviceAe, 'bubble-household-1');
  await request('Location', { op: 'unsubscribe', requestId: 'loc-1' });
  assert.equal(cse.children(started.paths.status, 4).at(-1).attrs.con.state, 'DELETED');
  assert.ok(cse.requests.every((item) => !item.path.includes('//')));
});
