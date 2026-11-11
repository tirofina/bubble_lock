import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';

async function fixture() {
  let now = '2026-11-10T10:00:00.000Z'; const clock = () => now;
  const runtime = await createIntegrationRuntime({ clock, core: { locationDeviceBindings: { 'ue-provider-1': 'keyring-A', 'ue-cross-household': 'keyring-A' } } });
  const guardian = { principalId: 'guardian-1', scopes: ['portal:read', 'device:write', 'consent:write', 'grant:write', 'grant:revoke','incident:write','incident:resolve'] };
  const visitor = { principalId: 'visitor-1', scopes: ['portal:read'] };
  const gateway = { principalId: 'gateway-1', scopes: [], mtlsFingerprint: 'trusted-cert' };
  await runtime.portalService.provisionHousehold({ householdId: 'home-1', name: '가구 1', ownerId: guardian.principalId, members: [{ principalId: visitor.principalId, role: 'visitor' }] });
  await runtime.gatewayControl.enroll({ gatewayId: 'gateway-1', principalId: gateway.principalId, fingerprint: gateway.mtlsFingerprint, credentialRevision: '1', devices: { 'keyring-A': 'home-1', 'keyring-B': 'home-1' } });
  for (const deviceId of ['keyring-A', 'keyring-B']) await runtime.portalService.registerDevice(guardian, { householdId: 'home-1', gatewayId: 'gateway-1', deviceId, label: deviceId, idempotencyKey: `register-${deviceId}` });
  const consent = await runtime.policyService.createConsent({ principal: guardian, subjectId: 'home-1', purpose: '위치 연동', scopes: ['location:read', 'mec:location'], ttlSec: 172800 });
  const grant = await runtime.policyService.createGrant({ principal: guardian, consentId: consent.consentId, scopes: ['location:read', 'mec:location'], ttlSec: 172800 });
  const incident=await runtime.portalService.createIncident(guardian,{householdId:'home-1',kind:'SAFETY',message:'위치 검증 사건',idempotencyKey:'incident-1'});
  const leases={};
  for(const recipient of [guardian,visitor])leases[recipient.principalId]=await runtime.locationPrivacy.createLease(guardian,{grantId:grant.grantId,recipientId:recipient.principalId,deviceIds:['keyring-A','keyring-B'],purpose:grant.purpose,incidentId:incident.incidentId,ttlSec:300,idempotencyKey:`lease-${recipient.principalId}`});
  const association=await runtime.locationPrivacy.approveAssociation(guardian,{grantId:grant.grantId,ueId:'ue-provider-1',deviceId:'keyring-A',gatewayId:'gateway-1',maxDistanceM:100,maxAgeMs:10000,gatewayPosition:{lat:37.5,lon:127},referenceRssiDbm:-59,pathLossExponent:2,idempotencyKey:'association-1'});
  const observation = (changes = {}) => ({ version: 1, gatewayId: 'gateway-1', deviceId: 'keyring-A', bootId: 'boot-1', sequence: 1, observedAt: clock(), receivedAt: clock(), rssi: -65, battery: 70,
    buttonState: 'released', sensorValues: { location: { lat: 37.5, lon: 127, source: 'gps', accuracyM: 8 } }, state: true, firmwareRevision: 'test-1', timestampSource: 'gateway-received', ...changes });
  const api = (principal, method, path, body = {}) => runtime.api.handle({ principal, method, path, body });
  const ingest = (value) => api(gateway, 'POST', '/api/v1/gateways/gateway-1/telemetry', value);
  const read = async (principal = guardian) => (await api(principal, 'GET', '/v1/portal/locations')).body.observations;
  const mec = async ({ eventKey = 'a'.repeat(64), ueId = 'ue-provider-1', grant: sourceGrant = grant, observedAt = clock(), simulation = false, revision = sourceGrant.revision, expiresAt = '2026-11-11T10:00:00.000Z', ...changes } = {}) => {
    const event = { eventKey, eventId: eventKey, service: 'Location', ueId, observedAt, simulation, clockQuality: 'VERIFIED', location: { lat: 37.50005, lon: 127.00005, accuracyM: 12 }, intent: { grantId: sourceGrant.grantId }, ...changes };
    await runtime.store.put('mecPayloads', eventKey, { eventKey, grantId: sourceGrant.grantId, grantRevision: revision, expiresAt, cipher: runtime.mecIngress.cipher.seal(event, eventKey) });
  };
  return { runtime, guardian, visitor, gateway, grant, consent,incident,leases,association, observation, api, ingest, read, mec, clock, setTime: (value) => { now = value; } };
}

test('지도는 인증된 Gateway GPS/RSSI와 현재 MEC 좌표·출처·정확도를 연결한다', async () => {
  const f = await fixture();
  assert.equal((await f.ingest(f.observation())).body.status, 'ACCEPTED');
  await f.mec(); const data = await f.read();
  assert.equal(data.length, 2);
  assert.deepEqual(data.find((entry) => entry.location?.source === 'gps'), { deviceId: 'keyring-A', gatewayId: 'gateway-1', observedAt: f.clock(), simulation: false, location: { lat: 37.5, lon: 127, source: 'gps', accuracyM: 8 }, rssiDbm: -65 });
  assert.ok(data.find((entry) => entry.location?.source === 'mec').location.accuracyM>12);
  assert.equal((await f.read(f.visitor)).length, 2);
  assert.deepEqual(await f.read({ principalId: 'outsider', scopes: ['portal:read'] }), []);
});

test('Gateway 인증·기기 연결·관측 식별자·시간을 검사하고 RSSI 단독 자료를 보존한다', async () => {
  const f = await fixture();
  assert.equal((await f.api(f.guardian, 'POST', '/api/v1/gateways/gateway-1/telemetry', f.observation())).status, 403);
  assert.equal((await f.ingest(f.observation({ deviceId: 'foreign' }))).status, 403);
  const value = f.observation({ sensorValues: {} });
  assert.equal((await f.ingest(value)).body.status, 'ACCEPTED');
  assert.equal((await f.ingest(value)).body.status, 'DUPLICATE');
  assert.equal((await f.ingest({ ...value, rssi: -80 })).status, 403);
  assert.equal((await f.ingest(f.observation({ sequence: 0 }))).body.status, 'STALE');
  assert.equal((await f.ingest(f.observation({ sequence: 2, observedAt: '2026-11-10T10:01:00.000Z' }))).status, 403);
  const [current] = await f.read(); assert.equal(current.location, undefined); assert.equal(current.rssiDbm, -65);
  assert.equal(f.runtime.store.list('gatewayTelemetry').length, 1);
  assert.equal((await f.ingest(f.observation({ bootId: 'boot-2', sequence: 0 }))).body.status, 'ACCEPTED');
  assert.equal(f.runtime.store.get('gatewayTelemetrySequences', 'keyring-A').sequence, 1);
});

test('MEC UE mapping은 서버 설정과 등록 device에 결속되고 다른 가구 grant를 분리한다', async () => {
  const f = await fixture();
  await f.mec({ ueId: 'unregistered-ue', deviceId: 'keyring-A' }); assert.equal((await f.read()).length, 0);
  await f.mec({ eventKey: 'b'.repeat(64), ueId: 'keyring-B' }); assert.equal((await f.read()).length,0);
  await f.runtime.portalService.provisionHousehold({ householdId: 'home-2', name: '가구 2', ownerId: f.guardian.principalId });
  const consent = await f.runtime.policyService.createConsent({ principal: f.guardian, subjectId: 'home-2', purpose: '다른 가구', scopes: ['mec:location'] });
  const grant = await f.runtime.policyService.createGrant({ principal: f.guardian, consentId: consent.consentId, scopes: ['mec:location'] });
  await f.mec({ eventKey: 'c'.repeat(64), ueId: 'ue-cross-household', grant });
  assert.equal((await f.read()).some((entry) => entry.deviceId === 'keyring-A'), false);
});

test('위치 grant 회수·consent revision·MEC retention은 조회에 즉시 반영된다', async () => {
  const f = await fixture(); await f.ingest(f.observation()); await f.mec();
  await f.runtime.policyService.revokeGrant({ principal: f.guardian, grantId: f.grant.grantId });
  assert.equal((await f.read(f.visitor)).length, 0);
  assert.equal((await f.read()).length, 0);
  const second = await fixture(); await second.mec({ revision: 999 }); assert.equal((await second.read()).length, 0);
  await second.mec(); await second.ingest(second.observation());
  second.setTime('2026-11-11T10:00:00.001Z'); assert.equal((await second.read()).length, 0);
  assert.equal(second.runtime.store.list('gatewayTelemetry').length, 0);
  assert.equal(second.runtime.policyService.evaluateGrant(second.grant.grantId).allowed, true);
});

test('최신 MEC 자료를 기기별로 선택하고 simulation과 좌표 출처를 보존한다', async () => {
  const f = await fixture();await f.ingest(f.observation()); await f.mec({ observedAt: '2026-11-10T09:59:59.000Z' });
  await f.mec({ eventKey: 'b'.repeat(64), simulation: true });
  const point = (await f.read()).find((entry)=>entry.sourceType==='BLE_RELAY_OBSERVATION'); assert.equal(point.simulation, true); assert.equal(point.location.source, 'mec'); assert.equal(point.observedAt, f.clock());
  const consent = f.runtime.store.get('consents', f.consent.consentId);
  await f.runtime.store.put('consents', consent.consentId, { ...consent, revision: consent.revision + 1 });
  assert.equal((await f.read()).length, 0);
});

test('Gateway 자격 회수는 기존 관측에도 적용되고 접근 기기 목록은 같은 조회에서 반환된다', async () => {
  const f = await fixture(); await f.ingest(f.observation());
  const before = await f.api(f.visitor, 'GET', '/v1/portal/locations');
  assert.deepEqual(before.body.deviceIds.sort(), ['keyring-A', 'keyring-B']);
  assert.equal(before.body.observations.length, 1);
  const gateway = f.runtime.store.get('gateways', 'gateway-1');
  await f.runtime.store.put('gateways', gateway.gatewayId, { ...gateway, status: 'REVOKED' });
  assert.equal((await f.read()).length, 0);
  await f.runtime.policyService.revokeGrant({ principal: f.guardian, grantId: f.grant.grantId });
  const revoked = await f.api(f.visitor, 'GET', '/v1/portal/locations');
  assert.deepEqual(revoked.body.deviceIds,[]);assert.deepEqual(revoked.body.observations,[]);assert.ok(revoked.body.readExpiresAt);
});

test('정밀 위치 원문은 암호화하며 handover·CSE 전송에는 참조와 최소 metadata를 저장한다',async()=>{
  const f=await fixture();const value=f.observation({sensorValues:{location:{lat:37.543210987,lon:127.012345678,source:'gps'}}});await f.ingest(value);
  const row=f.runtime.store.list('gatewayTelemetry')[0];assert.equal(row.observation,undefined);assert.equal(row.reference.type,'encrypted-location-reference');
  const ciphertext=f.runtime.store.list('locationPayloads')[0];assert.equal(ciphertext.cipher.algorithm,'AES-256-GCM');
  const handover=f.runtime.store.list('handoverObservations')[0];assert.equal(handover.payload.payloadRef,row.reference.payloadRef);assert.equal(handover.payload.sensorValues,undefined);
  const serialized=JSON.stringify([row,ciphertext,handover]);assert.equal(serialized.includes('37.543210987'),false);assert.equal(serialized.includes('127.012345678'),false);
  assert.equal((await f.read())[0].location.lat,37.543210987);
});

test('위치 decrypt는 수신자·목적·사건·lease·grant revision을 매 조회에서 검사한다',async()=>{
  const f=await fixture();await f.ingest(f.observation());
  const reference=f.runtime.store.list('gatewayTelemetry')[0].reference;const lease=f.leases[f.visitor.principalId];
  const context={principal:f.visitor,leaseId:lease.leaseId,purpose:lease.purpose,incidentId:lease.incidentId,deviceId:'keyring-A'};
  const open=(patch={})=>f.runtime.locationPrivacy.open(reference,{...context,...patch});
  assert.ok(await open());
  for(const patch of [{principal:f.guardian},{purpose:'다른 목적'},{incidentId:'incident-other'},{leaseId:'lease-other'},{deviceId:'foreign'}])assert.equal(await open(patch),null);
  await f.runtime.portalService.resolveIncident(f.guardian,{incidentId:f.incident.incidentId,idempotencyKey:'resolve'});assert.equal(await open(),null);assert.deepEqual(await f.read(),[]);
  const expired=await fixture();await expired.ingest(expired.observation());expired.setTime('2026-11-10T10:05:00.001Z');assert.deepEqual(await expired.read(),[]);
  const revised=await fixture();await revised.ingest(revised.observation());const grant=revised.runtime.store.get('grants',revised.grant.grantId);await revised.runtime.store.put('grants',grant.grantId,{...grant,revision:grant.revision+1});assert.deepEqual(await revised.read(),[]);
});

test('relay UE 결합은 현재 household 승인·거리·시차·RSSI 범위를 충족한 관측만 제공한다',async()=>{
  const f=await fixture();await f.ingest(f.observation());await f.mec();
  assert.equal((await f.read()).filter((entry)=>entry.sourceType==='BLE_RELAY_OBSERVATION').length,1);
  await f.mec({location:{lat:38,lon:128}});assert.equal((await f.read()).some((entry)=>entry.sourceType==='BLE_RELAY_OBSERVATION'),false);
  await f.mec({observedAt:'2026-11-10T09:59:40.000Z'});assert.equal((await f.read()).some((entry)=>entry.sourceType==='BLE_RELAY_OBSERVATION'),false);
  await f.mec();await f.ingest(f.observation({sequence:2,rssi:-110}));assert.equal((await f.read()).some((entry)=>entry.sourceType==='BLE_RELAY_OBSERVATION'),false);
  await f.ingest(f.observation({sequence:3}));const association=f.runtime.store.get('relayAssociations',f.association.associationId);await f.runtime.store.put('relayAssociations',association.associationId,{...association,status:'REVOKED'});assert.equal((await f.read()).some((entry)=>entry.sourceType==='BLE_RELAY_OBSERVATION'),false);
});

test('위치 승인 HTTP는 guardian과 현재 목적·사건 범위를 검사하고 회수 뒤 좌표를 비운다',async()=>{
  const f=await fixture();const input={grantId:f.grant.grantId,recipientId:f.visitor.principalId,deviceIds:['keyring-A'],purpose:f.grant.purpose,incidentId:f.incident.incidentId,ttlSec:60,idempotencyKey:'api-lease'};
  assert.equal((await f.api(f.visitor,'POST','/v1/portal/location-leases',input)).status,403);
  assert.equal((await f.api(f.guardian,'POST','/v1/portal/location-leases',{...input,purpose:'다른 목적'})).status,403);
  const created=await f.api(f.guardian,'POST','/v1/portal/location-leases',input);assert.equal(created.status,200);assert.equal(created.body.recipientId,f.visitor.principalId);
  assert.deepEqual((await f.api(f.guardian,'POST','/v1/portal/location-leases',input)).body,created.body);
  assert.ok(f.runtime.portalService.snapshot(f.visitor).locationLeases.some((lease)=>lease.leaseId===created.body.leaseId));
  for(const lease of f.runtime.locationPrivacy.list(f.visitor))await f.api(f.visitor,'POST','/v1/portal/location-leases/revoke',{leaseId:lease.leaseId,idempotencyKey:`revoke-${lease.leaseId}`});
  await f.ingest(f.observation());assert.deepEqual(await f.read(f.visitor),[]);assert.equal((await f.read()).length,1);
});
