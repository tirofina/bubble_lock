import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { HandoverCoordinator } from '../integration/src/handover-coordinator.mjs';
import { MecPolicyReconciler } from '../integration/src/mec-adapter.mjs';
import { distanceInsideGeofence } from '../integration/src/mec-state.mjs';

async function fixture(kind='zone'){
  let time=Date.parse('2026-11-10T00:00:00Z');let sequence=0;const clock=()=>new Date(time).toISOString();
  const store=await new IntegrationStore().init();const policyService=new PolicyService({store,clock});
  const principal={principalId:'guardian-trigger',scopes:['consent:write','grant:write','grant:revoke','policy:approve']};
  const consent=await policyService.createConsent({principal,subjectId:'home-trigger',purpose:'자동 이동',scopes:['mec:location','mec:rnis'],ttlSec:3600});
  const grant=await policyService.createGrant({principal,consentId:consent.consentId,scopes:['mec:location','mec:rnis'],ttlSec:1800});
  const coordinator=new HandoverCoordinator({store,policyService,clock});for(const edgeId of ['edge-a','edge-b'])coordinator.registerEdge({edgeId,health:'HEALTHY',load:0});
  await coordinator.handover({ueId:'keyring-trigger',targetEdgeId:'edge-a',grantId:grant.grantId});
  const geofence={type:'circle',lat:37.5,lon:127,radiusM:100};
  const approve=(targetEdgeId='edge-b')=>policyService.approvePolicy({principal,idempotencyKey:`policy-${++sequence}`,policy:{ueId:'keyring-trigger',grantId:grant.grantId,targetEdgeId,geofence,trigger:{kind}}});
  let policy=await approve();const reconciler=new MecPolicyReconciler({store,policyService,handoverCoordinator:coordinator,clock});
  const event=(patch={})=>({eventId:`event-${++sequence}`,eventKey:`key-${sequence}`,service:kind==='health'?'RNIS':'Location',ueId:'keyring-trigger',observedAt:clock(),clockQuality:'VERIFIED',location:{lat:37.5,lon:127},health:{status:kind==='health'?'UNHEALTHY':'HEALTHY'},simulation:true,intent:{policyId:policy.policyId,policyRevision:policy.revision,grantId:grant.grantId,grantRevision:grant.revision},...patch});
  return {store,policyService,principal,grant,coordinator,reconciler,geofence,event,clock,advance(ms){time+=ms;},async retarget(target){policy=await approve(target);},send(patch={}){return reconciler.reconcileApprovedIntent(event(patch));}};
}

test('자동 zone 이동은 실제 경계 20m와 원본 관측 10초 연속 체류를 사용한다',async()=>{
  const f=await fixture();f.advance(31000);
  assert.equal(distanceInsideGeofence({lat:37.5,lon:127},f.geofence),100);
  assert.ok(distanceInsideGeofence({lat:37.50081,lon:127},f.geofence)<20);
  assert.equal((await f.send({location:{lat:37.50081,lon:127}})).triggerState,'WAITING');
  f.advance(1000);assert.equal((await f.send()).triggerState,'WAITING');
  f.advance(5000);assert.equal((await f.send()).triggerState,'WAITING');
  f.advance(5000);assert.equal((await f.send()).triggerState,'ACTIVE');
  assert.equal(f.coordinator.status('keyring-trigger').edgeId,'edge-b');assert.equal(f.coordinator.status('keyring-trigger').epoch,2);
  const bbox={type:'bbox',minLat:37.499,minLon:126.999,maxLat:37.501,maxLon:127.001};assert.ok(distanceInsideGeofence({lat:37.5,lon:127},bbox)>80);
});

test('zone 밖 관측과 uncertainty가 경계 체류를 초기화하고 같은 event 재시도는 시간을 늘리지 않는다',async()=>{
  const f=await fixture();f.advance(31000);const first=f.event();await f.reconciler.reconcileApprovedIntent(first);
  f.advance(5000);assert.equal((await f.send({location:{lat:38,lon:127}})).reason,'geofence-review');
  f.advance(5000);assert.equal((await f.send()).triggerState,'WAITING');
  f.advance(5000);assert.equal((await f.send({location:{lat:37.5,lon:127,accuracyM:90}})).triggerState,'WAITING');
  f.advance(5000);await f.reconciler.reconcileApprovedIntent(first);assert.equal(f.coordinator.status('keyring-trigger').edgeId,'edge-a');
  assert.equal((await f.send()).triggerState,'WAITING');f.advance(5000);await f.send();f.advance(5000);assert.equal((await f.send()).triggerState,'ACTIVE');
});

test('RNIS 건강 이동은 1초 간격 실패 3회와 최소 체류·이동 후 cooldown을 함께 검사한다',async()=>{
  const f=await fixture('health');f.advance(31000);
  const first=f.event();assert.equal((await f.reconciler.reconcileApprovedIntent(first)).triggerState,'WAITING');
  await f.reconciler.reconcileApprovedIntent(first);f.advance(500);await f.send();
  assert.equal(f.store.list('handoverTriggers')[0].failures,1);
  f.advance(500);assert.equal((await f.send()).triggerState,'WAITING');f.advance(1000);assert.equal((await f.send()).triggerState,'ACTIVE');
  await f.retarget('edge-a');f.advance(1000);await f.send();f.advance(1000);await f.send();f.advance(1000);assert.equal((await f.send()).triggerState,'WAITING');
  f.advance(57000);await f.send();f.advance(1000);await f.send();f.advance(1000);assert.equal((await f.send()).triggerState,'ACTIVE');
  assert.equal(f.coordinator.status('keyring-trigger').edgeId,'edge-a');
});

test('현재 grant 회수·policy revision·오래된 source 시각은 자동 이동보다 먼저 검사한다',async()=>{
  const f=await fixture();f.advance(31000);await f.send();f.advance(5000);await f.send();
  await f.policyService.revokeGrant({principal:f.principal,grantId:f.grant.grantId});f.advance(5000);
  assert.equal((await f.send()).allowed,false);assert.equal(f.coordinator.status('keyring-trigger').epoch,1);
  await assert.rejects(f.coordinator.considerTrigger({ueId:'keyring-trigger',targetEdgeId:'edge-b',grantId:f.grant.grantId,observedAt:f.clock(),distanceInsideM:100}),/revision/);
  const other=await fixture();other.advance(31000);const stale=other.event({observedAt:'2026-11-10T00:00:00Z'});assert.equal((await other.reconciler.reconcileApprovedIntent(stale)).reason,'source-time-review');
  const wrong=other.event();wrong.intent.policyRevision=999;assert.equal((await other.reconciler.reconcileApprovedIntent(wrong)).allowed,false);
});
