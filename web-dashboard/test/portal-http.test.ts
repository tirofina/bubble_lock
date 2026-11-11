import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReplayServer } from '../server/sse.ts';
import { estimateBleProximity, parseLocationSnapshot } from '../shared/location.ts';
import type { OidcSessionManager } from '../server/oidc-session.ts';
import type { PortalUpstream, PortalUpstreamRequest } from '../server/portal-upstream.ts';

async function fixture(t:TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'bubble-portal-http-'));
  const service=await startReplayServer({port:0,portalStatePath:join(dir,'portal.json')});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const get=(path:string,role='guardian')=>fetch(`${service.url}/api/portal/${path}?role=${role}`);
  const post=async(path:string,payload:Record<string,unknown>,role='guardian')=>{
    const response=await fetch(`${service.url}/api/portal/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:crypto.randomUUID(),...payload,role})});
    return {status:response.status,body:await response.json()};
  };
  return {get,post,service};
}

test('포털 HTTP: 동의→위치권한→방문자 위치→회수 경로',async(t)=>{
  const f=await fixture(t);
  const guardian=await f.get('snapshot');
  assert.equal(guardian.headers.get('cache-control'),'no-store');
  assert.equal((await guardian.json()).snapshot.devices.length,3);
  const locations=async(role:string)=>parseLocationSnapshot(await (await f.get('locations',role)).json());
  assert.equal((await locations('guardian')).devices.length,3);
  assert.equal((await locations('visitor')).devices.length,0);
  assert.equal((await locations('operator')).devices.length,0);
  const consent=await f.post('consents',{householdId:'household-demo',purpose:'위치 공유 시험',scopes:['location:read'],ttlSec:900});
  assert.equal(consent.status,200);
  const grant=await f.post('grants',{consentId:consent.body.result.consentId,scopes:['location:read'],ttlSec:300});
  assert.equal(grant.status,200);
  assert.equal((await locations('visitor')).devices.length,0);
  const incident=await f.post('incidents',{householdId:'household-demo',kind:'SAFETY',message:'위치 승인 시험'});
  const lease=await f.post('location-leases',{grantId:grant.body.result.grantId,recipientId:'visitor-demo',deviceIds:['keyring-A','keyring-B','keyring-C'],purpose:grant.body.result.purpose,incidentId:incident.body.result.incidentId,ttlSec:60});
  assert.equal(lease.status,200);
  assert.equal((await locations('visitor')).devices.length,3);
  const revoked=await f.post('grants/revoke',{grantId:grant.body.result.grantId});
  assert.equal(revoked.status,200);
  const after=await locations('visitor');
  assert.equal(after.devices.length,0);
  assert.equal(after.gateways.length,0);
});

test('포털 HTTP: 방문자 요청을 보호자가 승인하고 같은 재전송을 복구',async(t)=>{
  const f=await fixture(t);
  const consent=await f.post('consents',{householdId:'household-demo',purpose:'명령 시험',scopes:['bubble:command'],ttlSec:900});
  const grant=await f.post('grants',{consentId:consent.body.result.consentId,scopes:['bubble:command'],ttlSec:300});
  const request=await f.post('commands/request',{householdId:'household-demo',deviceIds:['keyring-A'],desiredState:{state:true},reason:'브라우저 동작 시험'},'visitor');
  assert.equal(request.body.result.status,'PENDING');
  const payload={requestId:request.body.result.requestId,grantId:grant.body.result.grantId,idempotencyKey:'approve-http-once'};
  assert.equal((await f.post('commands/approve',payload,'visitor')).status,403);
  const approved=await f.post('commands/approve',payload);
  assert.equal(approved.body.result.status,'QUEUED');
  const repeated=await f.post('commands/approve',payload);
  assert.deepEqual(approved,repeated);
  const incident=await f.post('incidents',{householdId:'household-demo',kind:'HELP',message:'도움 요청 시험'},'visitor');
  assert.equal(incident.status,200);
  assert.equal((await f.post('incidents/resolve',{incidentId:incident.body.result.incidentId})).body.result.status,'RESOLVED');
  const current=(await (await f.get('snapshot')).json()).snapshot;
  assert.equal(current.commandRequests.length,1);
  assert.equal(current.commandRequests[0].commands.length,1);
});

test('포털 HTTP: 출처·역할·JSON·본문 경계와 principal 위조',async(t)=>{
  const f=await fixture(t);
  const endpoint=`${f.service.url}/api/portal/consents`;
  const external=await fetch(endpoint,{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{}'});
  assert.equal(external.status,403);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'Sec-Fetch-Site':'cross-site','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(endpoint,{method:'POST',body:'{}'})).status,415);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'x'.repeat(66000)})})).status,400);
  assert.equal((await f.get('snapshot','admin')).status,400);
  assert.equal((await f.post('consents',{principal:{principalId:'guardian-demo',scopes:['*']},householdId:'household-demo',purpose:'위조',scopes:['location:read']},'visitor')).status,403);
  assert.equal((await f.post('unexpected',{})).status,404);
});

test('체험 사용자 위치는 실측 JSONL과 실제 수신기 좌표에서 격리',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'bubble-portal-location-isolation-'));
  const positionPath=join(dir,'locations.jsonl');
  const gatewayPath=join(dir,'gateways.json');
  await writeFile(positionPath,JSON.stringify({deviceId:'keyring-A',gatewayId:'pi-01',observedAt:new Date().toISOString(),rssi:-67,sensorValues:{location:{lat:37.5,lon:127,source:'gps',accuracyM:3}}})+'\n');
  await writeFile(gatewayPath,JSON.stringify([{gatewayId:'pi-01',label:'실측 수신기',position:{lat:37.5,lon:127},simulation:false,referenceRssiDbm:-59,pathLossExponent:2}]));
  const service=await startReplayServer({port:0,locationFile:positionPath,gatewayLocationsFile:gatewayPath,locationSimulation:false});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  assert.equal((await (await fetch(`${service.url}/api/locations`)).json()).devices.length,1);
  const snapshot=parseLocationSnapshot(await (await fetch(`${service.url}/api/portal/locations?role=guardian`)).json());
  assert.equal(snapshot.devices.length,0);
  assert.equal(snapshot.gateways.length,0);
});

test('실계정 BFF는 서버 세션의 토큰·위치 범위·운영 scope를 적용',async(t)=>{
  const calls:PortalUpstreamRequest[]=[];
  const auth:OidcSessionManager={
    handle:async()=>false,close:()=>{},
    assertMutationOrigin(request){if(request.headers.origin!=='https://dashboard.example.test')throw Error('origin');},
    async authenticate(request){
      const value=request.headers.cookie;
      if(!['session=user','session=operator'].includes(value??''))return null;
      return {accessToken:'verified-server-token',expiresAt:'2099-01-01T00:00:00Z',principal:{principalId:'user-1',originator:'CUser',scopes:value==='session=operator'?['portal:read','dashboard:read']:['portal:read'],authentication:'oidc',issuer:'https://id.example.test',subject:'sub-1',expiresAt:'2099-01-01T00:00:00Z'}};
    },
  };
  const service=await startReplayServer({port:0,portal:{auth,upstream:async(input)=>{
    calls.push(input);
    if(input.path.endsWith('/locations'))return {status:200,body:{readExpiresAt:new Date(Date.now()+5000).toISOString(),deviceIds:['keyring-B'],observations:[
      {deviceId:'keyring-B',observedAt:new Date().toISOString(),simulation:false,location:{lat:37.57,lon:126.98,source:'mec',accuracyM:4}},
      {deviceId:'foreign-device',observedAt:new Date().toISOString(),simulation:false,location:{lat:38,lon:127,source:'gps'}},
    ]}};
    return {status:200,body:input.path.endsWith('/location-access')?{deviceIds:['keyring-B']}:{principal:{principalId:'user-1',role:'visitor'}}};
  }}});
  t.after(service.close);
  assert.equal((await fetch(`${service.url}/api/portal/snapshot?role=guardian`)).status,401);
  assert.equal(calls.length,0);
  const snapshot=await fetch(`${service.url}/api/portal/snapshot?role=guardian`,{headers:{Cookie:'session=user'}});
  assert.equal((await snapshot.json()).snapshot.principal.role,'visitor');
  assert.equal(calls[0]?.accessToken,'verified-server-token');
  const locations=await fetch(`${service.url}/api/portal/locations?role=guardian`,{headers:{Cookie:'session=user'}});
  const located=parseLocationSnapshot(await locations.json());
  assert.deepEqual(located.devices.map((device)=>device.deviceId),['keyring-B']);
  assert.equal(located.source,'portal-api');assert.equal(located.simulation,false);
  assert.equal(located.devices[0]?.position?.coordinates.lat,37.57);
  for(const path of ['/api/audit','/api/evidence','/events'])assert.equal((await fetch(`${service.url}${path}`,{headers:{Cookie:'session=user'}})).status,403);
  for(const session of ['session=user','session=operator']){
    const response=await fetch(`${service.url}/api/locations`,{headers:{Cookie:session}});
    assert.equal(response.status,200);assert.deepEqual(parseLocationSnapshot(await response.json()).devices.map((device)=>device.deviceId),['keyring-B']);
  }
  const input={role:'guardian',principal:{principalId:'admin',scopes:['*']},name:'new',idempotencyKey:'live-test'};
  const post=(origin:string)=>fetch(`${service.url}/api/portal/households`,{method:'POST',headers:{Cookie:'session=user',Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal((await post('https://third-party.example')).status,403);
  assert.equal((await post('https://dashboard.example.test')).status,200);
  assert.deepEqual(calls.at(-1)?.body,{name:'new',idempotencyKey:'live-test'});
});

async function liveLocationFixture(t:TestContext,options:{records?:unknown[];upstream:PortalUpstream}) {
  const dir=await mkdtemp(join(tmpdir(),'bubble-live-location-http-'));
  const gatewayLocationsFile=join(dir,'gateways.json');
  await writeFile(gatewayLocationsFile,JSON.stringify([
    {gatewayId:'pi-01',label:'등록 수신기',position:{lat:37.5,lon:127},simulation:false,referenceRssiDbm:-59,pathLossExponent:2},
    {gatewayId:'pi-foreign',label:'다른 가구 수신기',position:{lat:38,lon:128},simulation:false,referenceRssiDbm:-59,pathLossExponent:2},
  ]));
  let locationFile:string|undefined;
  if(options.records){locationFile=join(dir,'locations.jsonl');await writeFile(locationFile,options.records.map((entry)=>JSON.stringify(entry)).join('\n')+'\n');}
  const auth:OidcSessionManager={handle:async()=>false,close:()=>{},assertMutationOrigin:()=>{},async authenticate(request){
    if(request.headers.cookie!=='session=live')return null;
    return {accessToken:'server-held-token',expiresAt:'2099-01-01T00:00:00Z',principal:{principalId:'visitor-1',originator:'CVisitor',scopes:['portal:read'],authentication:'oidc',issuer:'https://id.example.test',subject:'sub-1',expiresAt:'2099-01-01T00:00:00Z'}};
  }};
  const upstream:PortalUpstream=async(input)=>{
    const response=await options.upstream(input);
    if(input.path.endsWith('/locations')&&response.status===200&&response.body&&typeof response.body==='object')return {...response,body:{readExpiresAt:new Date(Date.now()+5000).toISOString(),...response.body}};
    return response;
  };
  const service=await startReplayServer({port:0,gatewayLocationsFile,locationSimulation:false,...(locationFile?{locationFile}:{}),portal:{auth,upstream}});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const get=()=>fetch(`${service.url}/api/portal/locations`,{headers:{Cookie:'session=live'}});
  return {get,read:async()=>parseLocationSnapshot(await(await get()).json())};
}

test('LIVE 위치 HTTP: 중앙 BLE와 등록 anchor를 연결하고 가구 밖 수신기를 분리',async(t)=>{
  const observedAt=new Date().toISOString();
  const f=await liveLocationFixture(t,{upstream:async({path})=>({status:200,body:path.endsWith('/location-access')?{deviceIds:['keyring-A']}:{deviceIds:['keyring-A'],observations:[
    {deviceId:'keyring-A',gatewayId:'pi-01',observedAt,rssiDbm:-69,simulation:false},
    {deviceId:'foreign-device',gatewayId:'pi-foreign',observedAt,rssiDbm:-60,simulation:false},
  ]}})});
  const snapshot=await f.read();
  assert.equal(snapshot.source,'portal-api');assert.equal(snapshot.simulation,false);
  assert.deepEqual(snapshot.devices.map((entry)=>entry.deviceId),['keyring-A']);
  assert.deepEqual(snapshot.gateways.map((entry)=>entry.gatewayId),['pi-01']);
  const device=snapshot.devices[0];assert.ok(device?.ble);assert.equal(device.position,null);
  const proximity=estimateBleProximity(device.ble,snapshot.gateways);assert.ok(proximity);
  assert.deepEqual(proximity.center,{lat:37.5,lon:127});
  assert.ok(Math.abs(proximity.distanceM-Math.sqrt(10))<1e-10);
  assert.equal(proximity.simulation,false);assert.equal(device.ble.observedAt,observedAt);
});

test('LIVE 위치 HTTP: JSONL·중앙 GPS/BLE를 각각의 최신 관측 시각으로 병합',async(t)=>{
  const now=Date.now();const at=(seconds:number)=>new Date(now-seconds*1000).toISOString();
  const gps=(deviceId:string,seconds:number,lat:number)=>({deviceId,observedAt:at(seconds),simulation:false,location:{lat,lon:127,source:'gps',accuracyM:3}});
  const ble=(deviceId:string,seconds:number,rssiDbm:number)=>({deviceId,gatewayId:'pi-01',observedAt:at(seconds),simulation:false,rssiDbm});
  const f=await liveLocationFixture(t,{records:[gps('keyring-A',4,37.54),ble('keyring-A',8,-80),gps('keyring-B',8,37.58),ble('keyring-B',2,-62),gps('foreign-device',1,38)],upstream:async({path})=>({status:200,body:path.endsWith('/location-access')?{deviceIds:['keyring-A','keyring-B']}:{deviceIds:['keyring-A','keyring-B'],observations:[gps('keyring-A',10,37.51),ble('keyring-A',2,-69),gps('keyring-B',1,37.59),ble('keyring-B',10,-90)]}})});
  const snapshot=await f.read();assert.equal(snapshot.source,'combined');assert.equal(snapshot.devices.length,2);
  const a=snapshot.devices.find((entry)=>entry.deviceId==='keyring-A');const b=snapshot.devices.find((entry)=>entry.deviceId==='keyring-B');
  assert.equal(a?.position?.coordinates.lat,37.54);assert.equal(a?.position?.observedAt,at(4));
  assert.equal(a?.ble?.rssiDbm,-69);assert.equal(a?.ble?.observedAt,at(2));
  assert.equal(b?.position?.coordinates.lat,37.59);assert.equal(b?.position?.observedAt,at(1));
  assert.equal(b?.ble?.rssiDbm,-62);assert.equal(b?.ble?.observedAt,at(2));
});

test('LIVE 위치 HTTP: 현재 grant 회수와 조회 중 회수는 로컬·중앙·anchor를 함께 비운다',async(t)=>{
  let accessIds=['keyring-A'];let currentIds=['keyring-A'];
  const observation={deviceId:'keyring-A',gatewayId:'pi-01',observedAt:new Date().toISOString(),simulation:false,rssiDbm:-67,location:{lat:37.5,lon:127,source:'gps'}};
  const f=await liveLocationFixture(t,{records:[observation],upstream:async({path})=>({status:200,body:path.endsWith('/location-access')?{deviceIds:accessIds}:{deviceIds:currentIds,observations:[observation]}})});
  assert.equal((await f.read()).devices.length,1);
  currentIds=[];
  const concurrent=await f.read();assert.deepEqual(concurrent.devices,[]);assert.deepEqual(concurrent.gateways,[]);
  accessIds=[];
  const revoked=await f.read();assert.deepEqual(revoked.devices,[]);assert.deepEqual(revoked.gateways,[]);
});

test('LIVE 위치 HTTP: 중앙 오류·권한 응답 결손 시 좌표 응답을 오류로 전환',async(t)=>{
  let behavior:'success'|'unavailable'|'throw'|'scope-missing'|'scope-malformed'='success';
  const observation={deviceId:'keyring-A',gatewayId:'pi-01',observedAt:new Date().toISOString(),simulation:false,rssiDbm:-67,location:{lat:37.5,lon:127,source:'gps'}};
  const f=await liveLocationFixture(t,{records:[observation],upstream:async({path})=>{
    if(path.endsWith('/location-access'))return {status:200,body:{deviceIds:['keyring-A']}};
    if(behavior==='throw')throw Error('upstream transport');
    if(behavior==='unavailable')return {status:503,body:{message:'upstream unavailable'}};
    if(behavior==='scope-missing')return {status:200,body:{observations:[observation]}};
    if(behavior==='scope-malformed')return {status:200,body:{deviceIds:['keyring-A',{}],observations:[observation]}};
    return {status:200,body:{deviceIds:['keyring-A'],observations:[observation]}};
  }});
  assert.equal((await f.read()).devices.length,1);
  for(const [next,status] of [['unavailable',503],['throw',400],['scope-missing',502],['scope-malformed',502]] as const){
    behavior=next;const response=await f.get();assert.equal(response.status,status);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const result=await response.json();assert.equal(typeof result.message,'string');
    assert.equal(result.devices,undefined);assert.equal(result.gateways,undefined);assert.equal(result.observations,undefined);
  }
});

test('LIVE 위치 HTTP: JSONL 24시간 보관 경계와 응답 lease 만료를 적용',async(t)=>{
  let expired=false;const now=Date.now();
  const records=[{deviceId:'keyring-A',observedAt:new Date(now-86400001).toISOString(),simulation:false,location:{lat:37.5,lon:127,source:'gps'}},{deviceId:'keyring-A',gatewayId:'pi-01',observedAt:new Date(now-1000).toISOString(),simulation:false,rssiDbm:-67}];
  const f=await liveLocationFixture(t,{records,upstream:async({path})=>({status:200,body:path.endsWith('/location-access')?{deviceIds:['keyring-A']}:{deviceIds:['keyring-A'],observations:[],readExpiresAt:new Date(Date.now()+(expired?-1:5000)).toISOString()}})});
  const active=await f.read();assert.equal(active.devices[0]?.position,null);assert.equal(active.devices[0]?.ble?.rssiDbm,-67);assert.ok(active.readExpiresAt);
  expired=true;const ended=await f.read();assert.deepEqual(ended.devices,[]);assert.deepEqual(ended.gateways,[]);
});
