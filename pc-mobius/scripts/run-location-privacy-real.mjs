import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { OneM2mEdgeClient } from '../integration/src/handover-cse.mjs';
import { encodeBinarySwitch } from '../src/sdt-adapter.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const configArg=process.argv.find((argument)=>argument.startsWith('--config='))?.slice(9);
const configPath=configArg??JSON.parse(await readFile(join(root,'.local/handover-cse/current.json'),'utf8')).configPath;
const edges=JSON.parse(await readFile(resolve(configPath),'utf8'));
if(!Array.isArray(edges)||edges.length!==2)throw Error('두 CSE 연결 설정을 확인하세요.');
const runId=randomBytes(5).toString('hex');const directory=join(root,'.local/location-privacy',runId);await mkdir(directory,{recursive:true});
const statePath=join(directory,'state.json');const aeName=`privacy-${runId}`;const deviceId=`keyring-${runId}`;
const options={statePath,core:{handover:{edges},mec:{autoReconcile:false},retention:{autoPrune:false}}};
let runtime=await createIntegrationRuntime(options);const checks=[];
try{
  const guardian={principalId:`guardian-${runId}`,scopes:['portal:read','consent:write','grant:write','grant:revoke','device:write','incident:write'],simulation:true};
  const visitor={principalId:`visitor-${runId}`,scopes:['portal:read'],simulation:true};
  const gateway={principalId:`gateway-${runId}`,mtlsFingerprint:`local-fixture-${runId}`,simulation:true};
  const householdId=`home-${runId}`;
  await runtime.portalService.provisionHousehold({householdId,name:'정밀 위치 HTTP 검증',ownerId:guardian.principalId,members:[{principalId:visitor.principalId,role:'visitor'}]});
  await runtime.gatewayControl.enroll({gatewayId:gateway.principalId,principalId:gateway.principalId,fingerprint:gateway.mtlsFingerprint,credentialRevision:'1',devices:{[deviceId]:householdId}});
  await runtime.portalService.registerDevice(guardian,{householdId,deviceId,gatewayId:gateway.principalId,label:'모의 관측 키링',idempotencyKey:'register'});
  const consent=await runtime.policyService.createConsent({principal:guardian,subjectId:householdId,purpose:'안전 사건 검증',scopes:['location:read','mec:location'],ttlSec:900});
  const grant=await runtime.policyService.createGrant({principal:guardian,consentId:consent.consentId,purpose:'안전 사건 검증',scopes:['location:read','mec:location'],ttlSec:900});
  const incident=await runtime.portalService.createIncident(guardian,{householdId,kind:'SAFETY',message:'모의 정밀 위치 보호 시험',idempotencyKey:'incident'});
  const lease=await runtime.locationPrivacy.createLease(guardian,{grantId:grant.grantId,recipientId:visitor.principalId,deviceIds:[deviceId],purpose:grant.purpose,incidentId:incident.incidentId,ttlSec:300,idempotencyKey:'lease'});
  await runtime.handoverCoordinator.registerManifest(deviceId,{aeName,requireCallbackVerification:false,resources:[
    {logicalId:'observations',ty:3,body:{'m2m:cnt':{rn:'observations'}}},
    {logicalId:'switch',ty:28,body:encodeBinarySwitch({rn:'switch',state:false},{operation:'CREATE'}),verifyFields:['state']},
  ]});
  const initial=await runtime.handoverCoordinator.handover({ueId:deviceId,targetEdgeId:edges[0].edgeId,grantId:grant.grantId});assert.equal(initial.state,'ACTIVE',initial.reviewReason);
  const timestamp=new Date().toISOString();
  const observation={version:1,gatewayId:gateway.principalId,deviceId,bootId:'privacy-test',sequence:1,observedAt:timestamp,receivedAt:timestamp,rssi:-67,battery:80,buttonState:'released',sensorValues:{location:{lat:37.543210987,lon:127.012345678,source:'gps',accuracyM:8}},state:false,firmwareRevision:'simulated-fixture',timestampSource:'gateway-received'};
  await runtime.portalLocations.ingestGateway({gatewayId:gateway.principalId,principal:gateway,observation});
  const moved=await runtime.handoverCoordinator.handover({ueId:deviceId,targetEdgeId:edges[1].edgeId,grantId:grant.grantId});assert.equal(moved.state,'ACTIVE',moved.reviewReason);
  const target=runtime.store.get('logicalBindings',`${deviceId}:${edges[1].edgeId}`);const client=new OneM2mEdgeClient(edges[1]);
  const response=await client.request('GET',`${target.resources.observations.path}/obs-0`);const cin=response.payload['m2m:cin'];
  assert.equal(cin.con.type,'encrypted-location-reference');assert.equal(cin.con.sensorValues,undefined);assert.ok(cin.et);assert.equal(response.rsc,2000);
  checks.push({name:'actual-cse-encrypted-reference-readback',status:'PASS',rsc:response.rsc,requestId:response.rqi,resourceId:cin.ri,referenceHash:createHash('sha256').update(JSON.stringify(cin.con)).digest('hex'),expiry:cin.et});
  const clear=await runtime.portalLocations.read(visitor);assert.equal(clear.observations[0].location.lat,37.543210987);assert.equal(clear.observations[0].simulation,true);
  const wrong=await runtime.locationPrivacy.open(cin.con,{principal:guardian,leaseId:lease.leaseId,purpose:lease.purpose,incidentId:lease.incidentId,deviceId});assert.equal(wrong,null);
  checks.push({name:'approved-recipient-read-and-other-recipient-review',status:'PASS',readExpiresAt:clear.readExpiresAt});
  const state=await readFile(statePath,'utf8');assert.equal(state.includes('37.543210987'),false);assert.equal(state.includes('127.012345678'),false);
  checks.push({name:'state-json-contains-ciphertext-and-references',status:'PASS',stateHash:createHash('sha256').update(state).digest('hex')});
  await runtime.close();runtime=await createIntegrationRuntime(options);
  assert.equal((await runtime.portalLocations.read(visitor)).observations[0].location.lat,37.543210987);
  checks.push({name:'restart-key-and-current-lease-read',status:'PASS'});
  await runtime.policyService.revokeGrant({principal:guardian,grantId:grant.grantId});const revoked=await runtime.portalLocations.read(visitor);assert.deepEqual(revoked.deviceIds,[]);assert.deepEqual(revoked.observations,[]);
  checks.push({name:'revocation-committed-before-next-decrypt-read',status:'PASS'});
  const receipt={status:'PASS',recordedAt:new Date().toISOString(),transport:'actual-mobius4-http',observationSource:'simulated-gps-ble-fixture',simulation:true,providers:edges.length,checks,sourceHash:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')};
  const output=join(root,'pc-mobius/receipts/location-privacy-real-cse.json');await writeFile(output,`${JSON.stringify(receipt,null,2)}\n`);
  console.log(JSON.stringify({status:receipt.status,transport:receipt.transport,checks:checks.length,observationSource:receipt.observationSource},null,2));
}finally{await runtime.close();}
