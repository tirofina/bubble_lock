import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OneM2mEdgeClient } from '../integration/src/handover-cse.mjs';
import { encodeBinarySwitch, BINARY_SWITCH_CND } from '../src/sdt-adapter.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const configArg = process.argv.find((argument) => argument.startsWith('--config='))?.slice(9);
const configPath = configArg ?? JSON.parse(await readFile(join(root, '.local/handover-cse/current.json'), 'utf8')).configPath;
const configurations = JSON.parse(await readFile(resolve(configPath), 'utf8'));
if (!Array.isArray(configurations) || configurations.length !== 2) throw new Error('두 CSE 연결 설정 배열을 확인하세요.');
const run = randomBytes(5).toString('hex');
const sourceHash = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const receipts = [];
async function direct(config, originator, method, path, payload, ty) {
  const requestId = `interop-${randomBytes(6).toString('hex')}`;
  const response = await fetch(`${config.endpoint}${path}`, { method, redirect: 'error', headers: { accept: 'application/json', 'X-M2M-Origin': originator, 'X-M2M-RI': requestId, 'X-M2M-RVI': '4', ...(payload ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  assert.equal(response.headers.get('X-M2M-RI'), requestId, '직접 클라이언트 requestId 일치');
  return { status: response.status, rsc: Number(response.headers.get('X-M2M-RSC')), requestId, payload: body };
}
function paths(payload) { return payload['m2m:uril']?.map((path) => path.startsWith('/') ? path : `/${path}`) ?? []; }
function results(payload) { return payload['m2m:agr']?.['m2m:rsp'] ?? []; }

try {
  for (const [providerIndex, configuration] of configurations.entries()) {
    const admin = new OneM2mEdgeClient(configuration);
    const provider = await admin.ensure(configuration.cseBase, 2, { 'm2m:ae': { rn: `interop-${run}-p${providerIndex}`, api: 'N.privacy.bubble.interop', rr: true } }, { update: false });
    const clients = [];
    for (let index = 0; index < 2; index++) {
      const identity = await admin.ensure(configuration.cseBase, 2, { 'm2m:ae': { rn: `interop-${run}-c${providerIndex}${index}`, api: 'N.privacy.bubble.client', rr: true } }, { update: false });
      clients.push({ id: identity.aei, mode: index === 0 ? 'direct-http' : 'independent-sdk', sdk: new OneM2mEdgeClient({ ...configuration, originator: identity.aei }) });
    }
    const publicAcp = await admin.ensure(provider.path, 1, { 'm2m:acp': { rn: 'clients-acp', pv: { acr: [{ acor: [configuration.originator], acop: 63 }, { acor: clients.map((client) => client.id), acop: 38 }] }, pvs: { acr: [{ acor: [configuration.originator], acop: 63 }] } } });
    await admin.request('PUT', provider.path, { 'm2m:ae': { acpi: [publicAcp.ri] } });
    const members = [];
    for (let index = 0; index < 2; index++) members.push(await admin.ensure(provider.path, 28, encodeBinarySwitch({ rn: `switch-${index}`, state: false, acpi: [publicAcp.ri] }, { operation: 'CREATE' })));
    const group = await admin.ensure(provider.path, 9, { 'm2m:grp': { rn: 'switch-group', acpi: [publicAcp.ri], mt: 28, mnm: 2, mid: members.map((member) => member.path.replace(/^\//, '')), csy: 1 } });
    const providerReceipt = { providerId: `provider-${providerIndex + 1}`, cseId: configuration.cseId, cseEndpoint: configuration.endpoint, providerAeId: provider.aei, providerAePath: provider.path, members: members.map(({ path, ri }) => ({ path, ri })), clients: [], fanout: [] };
    for (const client of clients) {
      const discovery = client.mode === 'direct-http'
        ? await direct(configuration, client.id, 'GET', `${provider.path}?fu=1&ty=28&cnd=${encodeURIComponent(BINARY_SWITCH_CND)}`)
        : await client.sdk.discover(provider.path, { ty: 28, cnd: BINARY_SWITCH_CND });
      assert.equal(discovery.rsc, 2000); assert.deepEqual(paths(discovery.payload).sort(), members.map((member) => member.path).sort());
      const unknownDiscovery = client.mode === 'direct-http'
        ? await direct(configuration, client.id, 'GET', `${provider.path}?fu=1&ty=28&cnd=${encodeURIComponent('urn:interop:unregistered')}`)
        : await client.sdk.discover(provider.path, { ty: 28, cnd: 'urn:interop:unregistered' });
      assert.equal(paths(unknownDiscovery.payload).length, 0, 'cnd 필터가 다른 정의를 구분');
      const operations = [];
      for (const state of [true, false]) {
        const updated = client.mode === 'direct-http' ? await direct(configuration, client.id, 'PUT', members[0].path, encodeBinarySwitch({ state })) : await client.sdk.request('PUT', members[0].path, encodeBinarySwitch({ state }));
        assert.equal(updated.rsc, 2004);
        const readback = client.mode === 'direct-http' ? await direct(configuration, client.id, 'GET', members[0].path) : await client.sdk.request('GET', members[0].path);
        assert.equal(readback.rsc, 2000); assert.equal(readback.payload?.['cod:binSh']?.state, state);
        operations.push({ state, updateRsc: updated.rsc, readbackRsc: readback.rsc, readback: readback.payload['cod:binSh'].state });
      }
      providerReceipt.clients.push({ clientAeId: client.id, mode: client.mode, discovery: { filter: { fu: 1, ty: 28, cnd: BINARY_SWITCH_CND }, rsc: discovery.rsc, resourceUris: paths(discovery.payload), unmatchedCndCount: 0 }, stateOperations: operations });
    }
    for (const state of [true, false]) {
      const fanout = await direct(configuration, clients[0].id, 'PUT', `${group.path}/fopt`, encodeBinarySwitch({ state }));
      const membersResponse = results(fanout.payload); assert.equal(membersResponse.length, 2); assert.ok(membersResponse.every((member) => member.rsc === 2004));
      const readback = await Promise.all(members.map(async (member) => { const result = await direct(configuration, clients[0].id, 'GET', member.path); assert.equal(result.payload['cod:binSh'].state, state); return { uri: member.path, state: result.payload['cod:binSh'].state, rsc: result.rsc }; }));
      providerReceipt.fanout.push({ operation: 'ACTUAL_CSE_FOPT_SET', state, aggregateRsc: fanout.rsc, memberResults: membersResponse.map(({ fr, rsc }) => ({ uri: fr, rsc })), readback });
    }
    const restrictedAcp = await admin.ensure(provider.path, 1, { 'm2m:acp': { rn: 'partial-acp', pv: { acr: [{ acor: [configuration.originator], acop: 63 }, { acor: [clients[0].id], acop: 38 }, { acor: [clients[1].id], acop: 34 }] }, pvs: { acr: [{ acor: [configuration.originator], acop: 63 }] } } });
    await admin.request('PUT', members[1].path, { 'cod:binSh': { acpi: [restrictedAcp.ri] } });
    const partial = await clients[1].sdk.request('PUT', `${group.path}/fopt`, encodeBinarySwitch({ state: true }));
    const memberResults = results(partial.payload); assert.equal(memberResults.length, 2); assert.deepEqual(memberResults.map((member) => member.rsc).sort(), [2004, 4103]);
    const partialReadback = await Promise.all(members.map(async (member, index) => { const result = await clients[1].sdk.request('GET', member.path); assert.equal(result.payload['cod:binSh'].state, index === 0); return { uri: member.path, state: result.payload['cod:binSh'].state, rsc: result.rsc }; }));
    providerReceipt.fanout.push({ operation: 'ACTUAL_CSE_FOPT_PARTIAL_PERMISSION', clientMode: clients[1].mode, aggregateRsc: partial.rsc, desiredState: true, memberResults: memberResults.map(({ fr, rsc }) => ({ uri: fr, rsc })), readback: partialReadback, settledMembers: 1, permissionReviewMembers: 1 });
    receipts.push(providerReceipt);
  }
  const evidence = { contractId: 'privacy-bubble.actual-two-provider-interop.v1', generatedAt: new Date().toISOString(), status: 'PASS', rubricIds: ['A01', 'A02', 'A03', 'A04', 'R11'], providers: 2, clientImplementations: ['direct-fetch-http', 'OneM2mEdgeClient-sdk'], providerClientCombinations: 4, transport: 'actual-Mobius4-two-CSE-HTTP', cseImplementation: 'Mobius4 4.24.5', schema: { envelope: 'cod:binSh', cnd: BINARY_SWITCH_CND, stateType: 'boolean' }, groupScope: 'oneM2M CSE /fopt aggregate member RSC + member GET readback', applicationGroupScope: 'GroupDispatcher command/claim/Gateway/readback 별도 계약', physicalHardware: '별도 키링·BLE receipt', runnerSHA256: sourceHash, receipts };
  await mkdir(join(root, 'pc-mobius/receipts'), { recursive: true }); await writeFile(join(root, 'pc-mobius/receipts/interop-real-cse.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ status: evidence.status, providers: 2, independentClients: 2, combinations: 4, actualFanoutOperations: 6, partialMemberRsc: [2004, 4103], receipt: 'pc-mobius/receipts/interop-real-cse.json' }, null, 2));
} catch (error) { console.error(`상호운용 실증 ${error.message}`); process.exitCode = 1; }
