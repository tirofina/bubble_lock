import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startFakeCse } from './support/fake-onem2m-cse.mjs';
import { startMecSandboxSimulator } from '../integration/src/mec-sandbox-simulator.mjs';
import { MEC_IPE_SPECIALIZATIONS } from '../integration/src/mec-ipe.mjs';
import { RelocatableMecIpe, activeRequestSet, m2mTimeMs, IPE_OWNERSHIP_SCHEMA } from '../integration/src/mec-ipe-relocatable.mjs';
import { MecIpeOrchestrator, evaluateEligibility, scenarioTopology } from '../integration/src/mec-ipe-orchestrator.mjs';
import { MecPlatformClient } from '../integration/src/mec-platform-client.mjs';
import { Onem2mHttpClient, parseContent } from '../integration/src/onem2m-http-client.mjs';

async function waitFor(predicate, timeoutMs = 4000) { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('waitFor timeout'); }

// Two-MEP scenario shaped like deploy/mec-sandbox/scenarios/day-of-care.yaml.
const proc = (name, image, environment = '', extra = {}) => ({ id: `id-${name}`, name, type: 'EDGE-APP', image: `meep-docker-registry:30001/${image}`, environment, ...extra });
const ipeProcess = proc('pb-ipe-mep1', 'pb-onem2m-ipe', 'PB_IPE_MEP=mep1,MEC_MEP=mep1,MEC_SANDBOX_NAME=dayofcare,MEC_APP_INSTANCE_ID=id-pb-ipe-mep1,MEC_CALLBACK_PUBLIC_URL=http://192.0.2.103:31881,MEC_IPE_ONEM2M_URL=http://192.0.2.103:31881,ONEM2M_CSE_URL=https://192.0.2.106:17599', { serviceConfig: { name: 'pb-ipe-mep1', meSvcName: 'pb-onem2m-ipe', ports: [{ protocol: 'TCP', port: 18080, externalPort: 31881 }] }, cpuConfig: { min: 0.1, max: 0.5 }, memoryConfig: { min: 64, max: 256 } });
const coverage = 'MEEP_MEP_COVERAGE=mep1:home-district/mep2:park-district:office-district,MEEP_SCOPE_OF_LOCALITY=MEC_SYSTEM';
const host = (mep, cpu, locality, extra = []) => ({ name: mep, type: 'EDGE', meta: { 'pb.edge': mep === 'mep1' ? 'edge-a' : 'edge-b', 'pb.capacity.cpu': String(cpu), 'pb.capacity.memoryMi': '512' }, processes: [proc(`mec011-${mep}`, 'meep-app-enablement'), proc(`mec012-${mep}`, 'meep-rnis', `MEEP_LOCALITY=${locality}`), proc(`mec013-${mep}`, 'meep-loc-serv', `MEEP_LOCALITY=${locality}`), proc(`mec021-${mep}`, 'meep-ams', coverage), ...extra] });
const poa = (name, type, cellId, lon, lat, radius) => ({ name, type, ...(type === 'POA-4G' ? { poa4GConfig: { cellId } } : { poa5GConfig: { cellId } }), geoData: { location: { type: 'Point', coordinates: [lon, lat] }, radius } });
const scenario = (mep2Extra = []) => ({ name: 'day-of-care', deployment: { domains: [{ name: 'op', type: 'OPERATOR-CELLULAR', zones: [
  { name: 'op-COMMON', type: 'COMMON', networkLocations: [] },
  { name: 'home-district', type: 'ZONE', networkLocations: [{ name: 'home-district-DEFAULT', type: 'DEFAULT', physicalLocations: [host('mep1', 1.0, 'home-district', [ipeProcess])] }, poa('moneghetti-4g-macro', 'POA-4G', '1A00001', 7.417, 43.7352, 600)] },
  { name: 'park-district', type: 'ZONE', networkLocations: [{ name: 'park-district-DEFAULT', type: 'DEFAULT', physicalLocations: [host('mep2', 0.5, 'park-district:office-district', mep2Extra)] }, poa('park-5g-fork', 'POA-5G', '2B0000002', 7.4153, 43.73335, 80)] },
] }] } });
const probesOk = { mep1: { status: 200, activeApis: ['MEC012', 'MEC013', 'MEC021'] }, mep2: { status: 200, activeApis: ['MEC012', 'MEC013', 'MEC021'] } };

test('R13: request set rebuilt from oneM2M request cins keeps the latest op and the remaining duration', () => {
  const now = Date.UTC(2026, 10, 20, 8, 0, 0);
  const cin = (requestId, op, cr = 'Capp', extra = {}) => ({ cr, ri: `ri-${requestId}-${op}`, con: JSON.stringify({ op, requestId, ueAddress: 'resident-relay', durationSec: 600, ...extra }) });
  const entries = [
    { service: 'Location', cin: cin('loc-a', 'subscribe'), createdMs: now - 60000, order: 1 },
    { service: 'RNIS', cin: cin('rnis-a', 'subscribe'), createdMs: now - 50000, order: 2 },
    { service: 'Location', cin: cin('loc-a', 'unsubscribe'), createdMs: now - 40000, order: 3 },
    { service: 'Location', cin: cin('loc-old', 'subscribe', 'Capp', { durationSec: 30 }), createdMs: now - 60000, order: 4 },
    { service: 'Location', cin: cin('loc-b', 'subscribe', 'Cother'), createdMs: now - 10000, order: 5 },
  ];
  const active = activeRequestSet(entries, { now });
  assert.deepEqual(active.map((item) => [item.service, item.requestId, item.cin.cr, item.remainingSec]), [['RNIS', 'rnis-a', 'Capp', 550], ['Location', 'loc-b', 'Cother', 590]]);
  assert.equal(m2mTimeMs('20261120T081500'), Date.UTC(2026, 10, 20, 8, 15, 0));
  assert.equal(m2mTimeMs('20261120T081500,250'), Date.UTC(2026, 10, 20, 8, 15, 0, 250));
  assert.equal(m2mTimeMs('bad'), null);
});

test('R13: host eligibility follows MEC013/MEC012 locality, live MEC011 catalog, capacity and AMS coverage', () => {
  const topology = scenarioTopology(scenario());
  assert.deepEqual(topology.hosts.map((item) => [item.mep, item.zone, item.edge, item.capacity.cpu]), [['mep1', 'home-district', 'edge-a', 1], ['mep2', 'park-district', 'edge-b', 0.5]]);
  assert.deepEqual(topology.amsCoverage, { 'home-district': 'mep1', 'park-district': 'mep2', 'office-district': 'mep2' });
  assert.deepEqual(topology.ipeProcesses.map((item) => [item.name, item.mep, item.nodePort]), [['pb-ipe-mep1', 'mep1', 31881]]);
  assert.equal(topology.poas['park-5g-fork'].cellId, '2B0000002');

  const home = evaluateEligibility(topology, { zone: 'home-district', probes: probesOk });
  assert.equal(home.selected, 'mep1');
  assert.deepEqual(home.candidates.find((item) => item.mep === 'mep1').free, { cpu: 0.9, memoryMi: 448 });

  const park = evaluateEligibility(topology, { zone: 'park-district', probes: probesOk });
  assert.equal(park.selected, 'mep2');
  const mep1 = park.candidates.find((item) => item.mep === 'mep1');
  assert.equal(mep1.eligible, false); assert.match(mep1.reasons[0], /locality .*home-district.* excludes park-district/);

  // Office has no MEP of its own; mep2's locality and the AMS map cover it.
  assert.equal(evaluateEligibility(topology, { zone: 'office-district', probes: probesOk }).selected, 'mep2');
  // A full host or a host whose MEC011 does not answer is not eligible.
  const full = evaluateEligibility(scenarioTopology(scenario([proc('other-app', 'other', '', { cpuConfig: { min: 0.45 } })])), { zone: 'park-district', probes: probesOk });
  assert.equal(full.selected, null); assert.match(full.candidates.find((item) => item.mep === 'mep2').reasons.join(' '), /capacity free cpu 0.05/);
  const down = evaluateEligibility(topology, { zone: 'park-district', probes: { ...probesOk, mep2: { status: 503, activeApis: [] } } });
  assert.equal(down.selected, null);
  const missingLocation = evaluateEligibility(topology, { zone: 'park-district', probes: { ...probesOk, mep2: { status: 200, activeApis: ['MEC012'] } } });
  assert.equal(missingLocation.selected, null);
});

test('R13: orchestrator derives the target instance from the declared one and places it by SCENARIO-UPDATE', async () => {
  const events = [];
  const sandbox = async (method, path, body) => { events.push({ method, path, body }); if (path === '/sandbox-ctrl/v1/active') return { status: 200, data: scenario() }; return { status: 200, data: null }; };
  const writes = [];
  const client = { create: async (parent, ty, body) => { writes.push({ parent, ty, body }); return { rsc: 2001, payload: { 'm2m:cin': { ri: `ri-${writes.length}` } } }; } };
  const orchestrator = new MecIpeOrchestrator({ sandbox, client, ipeAePath: '/Mobius/pb-mec-ipe' });
  await orchestrator.refresh();
  const placed = await orchestrator.place('mep2', { id: 'id-pb-ipe-mep2', nodePort: 31882 });
  const add = events.at(-1);
  assert.equal(add.path, '/sandbox-ctrl/v1/events/SCENARIO-UPDATE');
  assert.equal(add.body.eventScenarioUpdate.action, 'ADD'); assert.equal(add.body.eventScenarioUpdate.node.parent, 'mep2');
  const process = add.body.eventScenarioUpdate.node.nodeDataUnion.process;
  assert.equal(process.name, 'pb-ipe-mep2'); assert.equal(process.id, 'id-pb-ipe-mep2');
  assert.deepEqual(process.serviceConfig.ports, [{ protocol: 'TCP', port: 18080, externalPort: 31882 }]);
  assert.equal(process.serviceConfig.meSvcName, 'pb-onem2m-ipe');
  const env = Object.fromEntries(process.environment.split(',').map((item) => item.split('=')));
  assert.equal(env.MEC_MEP, 'mep2'); assert.equal(env.MEC_APP_INSTANCE_ID, 'id-pb-ipe-mep2'); assert.equal(env.MEC_CALLBACK_PUBLIC_URL, 'http://192.0.2.103:31882');
  assert.ok(process.environment.split(',').every((item) => item.split('=').length === 2), 'virt-engine splits on , and =');
  assert.equal(placed.nodePort, 31882);
  await orchestrator.remove('pb-ipe-mep1', { gracePeriod: 30 });
  assert.deepEqual(events.at(-1).body.eventScenarioUpdate, { action: 'REMOVE', node: { type: 'EDGE-APP', nodeDataUnion: { process: { name: 'pb-ipe-mep1' } } }, gracePeriod: 30 });
  const first = await orchestrator.writeOwnership({ owner: 'id-pb-ipe-mep1', mep: 'mep1', decisionId: 'dec-1', reason: 'initial-placement' });
  const second = await orchestrator.writeOwnership({ owner: 'id-pb-ipe-mep2', mep: 'mep2', decisionId: 'dec-2', reason: 'MEC021' });
  assert.deepEqual([first.epoch, second.epoch], [1, 2]);
  assert.equal(writes[1].body['m2m:cin'].con.schema, IPE_OWNERSHIP_SCHEMA); assert.equal(writes[1].body['m2m:cin'].cr, null);
});

test('R13: ownership epoch moves the oneM2M bridge between two MEPs without duplicate writers', async (t) => {
  let now = Date.now();
  const clock = () => now;
  const cse = await startFakeCse({ specializations: MEC_IPE_SPECIALIZATIONS });
  const sims = { mep1: await startMecSandboxSimulator({ mep: 'mep1', now: clock }), mep2: await startMecSandboxSimulator({ mep: 'mep2', now: clock }) };
  const ids = { ipe: 'Cmec-ipe-reloc', app: 'Capp-reloc', orch: 'Corch-reloc', device: 'Ckeyring-reloc' };
  const client = (originator) => new Onem2mHttpClient({ endpoint: cse.endpoint, originator });
  const device = client(ids.device); const app = client(ids.app); const orch = client(ids.orch);
  const deviceAe = await device.registerAe({ rn: 'keyring-reloc', api: 'N.test.keyring' });
  for (const rn of ['location', 'rnis']) await device.ensure(deviceAe.path, 3, { 'm2m:cnt': { rn } });
  const trace = [];
  const make = (mep, appInstanceId) => new RelocatableMecIpe({ instance: { mep, appInstanceId }, orchestrators: [ids.orch], cse: { endpoint: cse.endpoint, cseId: cse.cseId }, originator: ids.ipe, aeName: 'pb-mec-ipe', platform: new MecPlatformClient({ platformRoot: sims[mep].platformRoot, simulation: true, appInstanceId }), requesters: { Location: [ids.app], RNIS: [ids.app] }, readers: [ids.app, ids.orch], encryptionKey: randomBytes(32).toString('base64'), clock, renewCheckMs: 3600000, simulation: true, trace: (entry) => trace.push({ mep, ...entry }) });
  const a = make('mep1', 'app-a'); const b = make('mep2', 'app-b');
  t.after(async () => { await a.stop(); await b.stop(); await sims.mep1.close(); await sims.mep2.close(); await cse.close(); });
  const started = await a.start(); await b.start();
  const settle = async () => { for (let i = 0; i < 3; i += 1) { await a.idle(); await b.idle(); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  const ownership = (epoch, owner, mep, by = orch) => by.create(`${started.aePath}/ownership`, 4, { 'm2m:cin': { con: { schema: IPE_OWNERSHIP_SCHEMA, epoch, owner, mep, decisionId: `dec-${epoch}` }, cr: null } });
  const lifecycle = () => cse.children(started.paths.lifecycle, 4).map((item) => parseContent(item.attrs.con));
  const observations = () => cse.children(`${deviceAe.path}/location`, 4).map((item) => parseContent(item.attrs.con));
  assert.deepEqual(lifecycle().filter((item) => item.event === 'READY').map((item) => item.mep).sort(), ['mep1', 'mep2']);
  assert.equal(cse.children(`${started.aePath}/mecServices`, 28).length, 0, 'a standby does not publish the catalog');

  await ownership(1, 'app-a', 'mep1'); await settle();
  assert.equal(a.owner, true); assert.equal(b.owner, false);
  assert.ok(cse.children(`${started.aePath}/mecServices`, 28).length >= 4, 'the owner publishes its MEP catalog');
  await app.create(started.paths.Location, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'subscribe', requestId: 'loc-1', deviceAe: 'keyring-reloc', ueAddress: '10.100.0.1', type: 'periodic', durationSec: 600 }, cr: null } });
  await waitFor(async () => { await settle(); return a.store.list('ipeRequests').some((item) => item.state === 'ACTIVE'); });
  assert.ok(trace.some((item) => item.mep === 'mep2' && item.step === 'ONEM2M_REQUEST_DEFERRED'));
  assert.equal(sims.mep1.subscriptions.size + sims.mep2.subscriptions.size, 1);
  await sims.mep1.moveUe('10.100.0.1', { lat: 43.7369, lon: 7.4179, zoneId: 'home-district' }); await settle();
  assert.deepEqual(observations().map((item) => item.servedBy), [{ mep: 'mep1', appInstanceId: 'app-a', epoch: 1 }]);

  // A forged or stale ownership record changes nothing.
  await ownership(5, 'app-b', 'mep2', app); await ownership(1, 'app-b', 'mep2'); await settle();
  assert.equal(a.owner, true); assert.equal(a.epoch, 1);
  assert.ok(trace.some((item) => item.step === 'IPE_OWNERSHIP_REVIEW')); assert.ok(trace.some((item) => item.step === 'IPE_OWNERSHIP_STALE'));

  // Relocation: epoch 2 names the mep2 instance.
  await ownership(2, 'app-b', 'mep2'); await settle();
  await waitFor(async () => { await settle(); return b.store.list('ipeRequests').some((item) => item.state === 'ACTIVE'); });
  assert.deepEqual([a.owner, b.owner, a.epoch, b.epoch], [false, true, 2, 2]);
  assert.equal(sims.mep1.subscriptions.size, 0, 'the former owner deleted its MEC subscription');
  assert.equal(sims.mep2.subscriptions.size, 1, 'the new owner re-created it on its own MEP');
  assert.equal(a.store.list('ipeRequests')[0].state, 'HANDED_OVER');
  const events = lifecycle().map((item) => `${item.event}@${item.mep}`);
  for (const event of ['OWNER@mep1', 'RESUMED@mep1', 'DRAINED@mep1', 'OWNER@mep2', 'RESUMED@mep2']) assert.ok(events.includes(event), event);
  await sims.mep1.moveUe('10.100.0.1', { lat: 43.7340, lon: 7.4162, zoneId: 'home-district' });
  await sims.mep2.moveUe('10.100.0.1', { lat: 43.7334, lon: 7.4153, zoneId: 'park-district' }); await settle();
  assert.deepEqual(observations().map((item) => item.servedBy.mep), ['mep1', 'mep2'], 'same container, one writer at a time');
  const statuses = cse.children(started.paths.status, 4).map((item) => parseContent(item.attrs.con)).map((item) => `${item.state}@${item.servedBy.mep}`);
  assert.deepEqual(statuses, ['ACTIVE@mep1', 'HANDED_OVER@mep1', 'ACTIVE@mep2']);
  // Late MEC callbacks at the former owner are fenced.
  const fenced = await a.writeObservation(a.store.list('ipeRequests')[0], { location: { lat: 1, lon: 1 } }, 'k', 's');
  assert.deepEqual(fenced, { rsc: 4103, fenced: true });

  // The guardian ends the request; the current owner deletes the mep2 subscription.
  await app.create(started.paths.Location, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'unsubscribe', requestId: 'loc-1' }, cr: null } });
  await waitFor(async () => { await settle(); return sims.mep2.subscriptions.size === 0; });
  now += 1000;
});
