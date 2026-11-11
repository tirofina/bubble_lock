import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpsRequest, Agent } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { GatewayCredentialIssuer } from '../integration/src/gateway-credential-issuer.mjs';
import { GatewayRegistrationCse } from '../integration/src/gateway-registration-cse.mjs';
import { sha256 } from '../integration/src/integration-utils.mjs';
import { createIntegrationServer } from '../integration/src/api-server.mjs';

const exec=promisify(execFile), openssl=process.env.OPENSSL_BIN??'openssl';
async function fixture(t,{loseCreateResponse=false,failIssue=false,realTls=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'bubble-registration-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const caFile=join(directory,'ca.pem'),caKeyFile=join(directory,'ca.key'),csrFile=join(directory,'device.csr');
  const config=join(directory,'request.cnf');await writeFile(config,'[req]\ndistinguished_name=dn\n[dn]\n');
  await exec(openssl,['req','-config',config,'-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=RegistrationTestCA','-addext','basicConstraints=critical,CA:TRUE','-keyout',caKeyFile,'-out',caFile],{windowsHide:true});
  await exec(openssl,['req','-config',config,'-new','-newkey','rsa:2048','-nodes','-subj','/CN=untrusted-request-name','-addext','basicConstraints=critical,CA:TRUE','-keyout',join(directory,'device.key'),'-out',csrFile],{windowsHide:true});
  const csrPem=await readFile(csrFile,'utf8'), token='bootstrap-fixture-token-with-256-bit-material';
  const principal={principalId:'gateway-1',scopes:['gateway:register'],mtlsFingerprint:'bootstrap-certificate'};
  const guardian={principalId:'guardian',scopes:['gateway:manage','consent:write','grant:write']};
  const calls=[];let ae=null;
  const server=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;
    calls.push({method:req.method,path:req.url,origin:req.headers['x-m2m-origin'],authorization:req.headers.authorization});
    res.setHeader('X-M2M-RI',req.headers['x-m2m-ri']);res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){
      assert.equal(req.headers.authorization,`Bearer ${token}`);assert.equal(req.headers['content-type'],'application/json;ty=2');assert.equal(req.url,'/Mobius');
      if(ae){res.statusCode=409;res.setHeader('X-M2M-RSC','4105');res.end('{}');return;}
      ae={...JSON.parse(text)['m2m:ae'],aei:'C-gateway1',ri:'ae-resource-1'};
      res.statusCode=201;res.setHeader('X-M2M-RSC','2001');res.end(JSON.stringify({'m2m:ae':ae}));
    }else{
      assert.equal(req.headers.authorization,'Bearer workload-reader');assert.equal(req.headers['x-m2m-origin'],'C-workload');
      res.setHeader('X-M2M-RSC','2000');res.end(JSON.stringify({'m2m:ae':ae}));
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const cse=new GatewayRegistrationCse({endpoint:`http://127.0.0.1:${server.address().port}`,allowLoopbackHttp:true,workloadOriginator:'C-workload',workloadHeaders:{authorization:'Bearer workload-reader'}});
  const issuer=new GatewayCredentialIssuer({caFile,caKeyFile,openssl});let issued=0,terminated=0;
  const bootstrapCredential=realTls?await issuer.issue({csrPem,principalId:principal.principalId,aei:'C-bootstrap',registrationId:'b'.repeat(64)}):null;
  if(bootstrapCredential)principal.mtlsFingerprint=bootstrapCredential.fingerprint;
  const registration={
    createAe:async(input)=>{const result=await cse.createAe(input);if(loseCreateResponse){loseCreateResponse=false;throw new Error('injected response loss');}return result;},
    issueCredential:async(input)=>{issued++;if(failIssue){failIssue=false;throw new Error('injected issuer restart');}return issuer.issue(input);},
    terminateSessions:async()=>{terminated++;return 2;},
    bootstraps:[{bootstrapId:'bootstrap-1',gatewayId:'gateway-1',principalId:principal.principalId,fingerprint:principal.mtlsFingerprint,devices:{'keyring-A':'home-1'},tokenHash:sha256(token),expiresAt:new Date(Date.now()+60000).toISOString()}]
  };
  const statePath=join(directory,'state.json');let runtime=await createIntegrationRuntime({statePath,core:{registration}});t.after(()=>runtime.close());
  await runtime.portalService.provisionHousehold({householdId:'home-1',name:'테스트 가구',ownerId:guardian.principalId});
  const input={principal,bootstrapId:'bootstrap-1',bootstrapToken:token,requestId:'request-1',csrPem};
  return {get runtime(){return runtime;},input,principal,guardian,calls,issuer,directory,caFile,caKeyFile,bootstrapCredential,get issued(){return issued;},get terminated(){return terminated;},restart:async()=>{await runtime.close();runtime=await createIntegrationRuntime({statePath,core:{registration}});}};
}

test('AE 생성과 실제 CA CSR 서명은 원자 binding·bootstrap 소진·한 번 발급으로 연결된다',async(t)=>{
  const f=await fixture(t);const service=f.runtime.gatewayRegistration;
  assert.equal((await service.resolveCertificatePrincipal('bootstrap-certificate')).status,'BOOTSTRAP');
  const [first,second]=await Promise.all([service.register(f.input),service.register(f.input)]);assert.deepEqual(first,second);
  assert.equal(first.aei,'C-gateway1');assert.equal(f.calls.length,1);assert.equal(f.issued,1);
  const certificate=new X509Certificate(first.credential.certificatePem);assert.equal(certificate.ca,false);assert.equal(certificate.subject,'CN=gateway-1');assert.match(certificate.subjectAltName,/urn:privacy-bubble:ae:C-gateway1/);
  assert.ok(certificate.keyUsage.includes('1.3.6.1.5.5.7.3.2'));assert.equal(certificate.verify(new X509Certificate(first.credential.caPem).publicKey),true);
  const resolved=await service.resolveCertificatePrincipal(certificate.fingerprint256);assert.equal(resolved.status,'ACTIVE');assert.equal(resolved.principal.originator,'C-gateway1');
  assert.equal(f.runtime.store.get('gatewayBootstraps','bootstrap-1').status,'CONSUMED');
  assert.equal(JSON.stringify(f.runtime.store.snapshot()).includes(f.input.bootstrapToken),false);
  await f.restart();assert.deepEqual(await f.runtime.gatewayRegistration.register(f.input),first);
  assert.equal(f.issued,1);
});

test('bootstrap 등록은 인증 주체·인증서·token·원래 CSR intent를 검사한다',async(t)=>{
  const f=await fixture(t);const service=f.runtime.gatewayRegistration;
  for(const change of [{bootstrapToken:'x'.repeat(48)},{principal:{...f.principal,principalId:'other'}},{principal:{...f.principal,mtlsFingerprint:'foreign'}},{principal:{...f.principal,scopes:[]}}])await assert.rejects(()=>service.register({...f.input,...change}));
  const bootstrap=f.runtime.store.get('gatewayBootstraps','bootstrap-1');
  await assert.rejects(()=>service.provisionBootstrap({...bootstrap,bootstrapId:'second',gatewayId:'second',fingerprint:'second'}));
  await f.runtime.store.put('gatewayBootstraps',bootstrap.bootstrapId,{...bootstrap,expiresAt:'2000-01-01T00:00:00.000Z'});await assert.rejects(()=>service.register(f.input));
  await f.runtime.store.put('gatewayBootstraps',bootstrap.bootstrapId,bootstrap);
  assert.equal(f.calls.length,0);await service.register(f.input);
  await assert.rejects(()=>service.register({...f.input,requestId:'changed'}));await assert.rejects(()=>service.register({...f.input,csrPem:f.input.csrPem+'\n'}));
  assert.equal(f.calls.length,1);
});

test('AE CREATE 응답 손실은 workload GET으로 복구하고 소진 후 issuer 재시작을 이어간다',async(t)=>{
  const f=await fixture(t,{loseCreateResponse:true,failIssue:true});
  await assert.rejects(()=>f.runtime.gatewayRegistration.register(f.input),/response loss/);
  assert.equal(f.runtime.store.get('gatewayBootstraps','bootstrap-1').status,'RESERVED');
  await assert.rejects(()=>f.runtime.gatewayRegistration.register(f.input),/issuer restart/);
  assert.deepEqual(f.calls.map(call=>call.method),['POST','POST','GET']);
  assert.equal(f.runtime.store.get('gatewayBootstraps','bootstrap-1').status,'CONSUMED');
  assert.equal(f.runtime.store.get('principalBindings','gateway-1').status,'CREDENTIAL_PENDING');
  await f.restart();const result=await f.runtime.gatewayRegistration.register(f.input);assert.equal(result.status,'ACTIVE');assert.equal(f.calls.length,3);
});

test('LOST는 binding revision·credential·정본 grant·세션 종료를 묶고 재시작 provisioning에도 보존한다',async(t)=>{
  const f=await fixture(t);const registered=await f.runtime.gatewayRegistration.register(f.input);
  const consent=await f.runtime.policyService.createConsent({principal:f.guardian,subjectId:'home-1',purpose:'분실 시험',scopes:['bubble:command']});
  const grant=await f.runtime.policyService.createGrant({principal:f.guardian,consentId:consent.consentId,scopes:['bubble:command']});
  const input={principal:f.guardian,gatewayId:'gateway-1',reason:'분실 신고',idempotencyKey:'lost-1'};
  await assert.rejects(()=>f.runtime.gatewayRegistration.markLost({...input,principal:{principalId:'other',scopes:['gateway:manage']}}));
  const first=await f.runtime.gatewayRegistration.markLost(input);assert.equal(first.bindingRevision,2);assert.deepEqual(first.revokedGrantIds,[grant.grantId]);assert.equal(first.sessionTermination,'COMPLETED');assert.equal(f.terminated,1);
  assert.deepEqual(await f.runtime.gatewayRegistration.markLost(input),first);assert.equal(f.terminated,1);
  assert.equal(f.runtime.policyService.evaluateGrant(grant.grantId).allowed,false);
  const fingerprint=new X509Certificate(registered.credential.certificatePem).fingerprint256;
  assert.equal((await f.runtime.gatewayRegistration.resolveCertificatePrincipal(fingerprint)).status,'LOST');
  await f.runtime.gatewayControl.enroll({gatewayId:'gateway-1',principalId:'gateway-1',fingerprint,devices:{'keyring-A':'home-1'},credentialRevision:'1'});
  assert.equal(f.runtime.gatewayControl.gateway('gateway-1').status,'LOST');
  await f.restart();await assert.rejects(()=>f.runtime.gatewayRegistration.register(f.input));
  assert.equal((await f.runtime.gatewayRegistration.resolveCertificatePrincipal(fingerprint)).status,'LOST');
});

test('상실 트랜잭션 저장 장애는 함께 롤백하고 세션 종료 장애는 현재 권한 회수 상태로 재개한다',async(t)=>{
  const f=await fixture(t);await f.runtime.gatewayRegistration.register(f.input);
  const input={principal:f.guardian,gatewayId:'gateway-1',idempotencyKey:'atomic-lost'};
  const store=f.runtime.store,flush=store.flush.bind(store);let fail=true;
  store.flush=async()=>{if(fail){fail=false;throw new Error('injected storage failure');}return flush();};
  await assert.rejects(()=>f.runtime.gatewayRegistration.markLost(input),/storage failure/);
  assert.equal(f.runtime.gatewayControl.gateway('gateway-1').status,'ACTIVE');assert.equal(store.get('principalBindings','gateway-1').revision,1);assert.equal(f.terminated,0);
  f.runtime.gatewayRegistration.terminateSessions=async()=>{throw new Error('injected socket close interruption');};
  const pending=await f.runtime.gatewayRegistration.markLost(input);assert.equal(pending.status,'LOST');assert.equal(pending.sessionTermination,'PENDING');
  f.runtime.gatewayRegistration.terminateSessions=async()=>1;
  const recovered=await f.runtime.gatewayRegistration.markLost(input);assert.equal(recovered.bindingRevision,2);assert.equal(recovered.sessionTermination,'COMPLETED');
  assert.equal(store.list('receipts').filter((entry)=>entry.type==='GATEWAY_LOST').length,1);
});

test('실제 TLS1.3 API는 bootstrap 전용 경로·새 인증서 binding·LOST socket 종료와 상태 polling을 집행한다',async(t)=>{
  const f=await fixture(t,{realTls:true});
  const serverKey=join(f.directory,'server.key'),serverCsr=join(f.directory,'server.csr'),serverCert=join(f.directory,'server.pem'),extensions=join(f.directory,'server.ext');
  await exec(openssl,['req','-config',join(f.directory,'request.cnf'),'-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',serverKey,'-out',serverCsr],{windowsHide:true});
  await writeFile(extensions,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');
  await exec(openssl,['x509','-req','-in',serverCsr,'-CA',f.caFile,'-CAkey',f.caKeyFile,'-set_serial','42','-days','1','-extfile',extensions,'-out',serverCert],{windowsHide:true});
  const guardianCredential=await f.issuer.issue({csrPem:f.input.csrPem,principalId:'guardian',aei:'C-guardian',registrationId:'c'.repeat(64)});
  const ca=await readFile(f.caFile),key=await readFile(join(f.directory,'device.key'));
  const server=createIntegrationServer({api:f.runtime.api,tls:{ca,cert:await readFile(serverCert),key:await readFile(serverKey)},principals:[{...f.guardian,mtlsFingerprint:guardianCredential.fingerprint}],certificateResolver:(fingerprint)=>f.runtime.gatewayRegistration.resolveCertificatePrincipal(fingerprint)});
  f.runtime.gatewayRegistration.terminateSessions=async({fingerprint})=>server.terminateCertificateSessions(fingerprint);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const agent=new Agent({keepAlive:true});t.after(()=>agent.destroy());
  const call=(cert,method,path,body={},keep=false)=>new Promise((resolve,reject)=>{
    const req=httpsRequest({hostname:'127.0.0.1',port:server.address().port,method,path,ca,key,cert,minVersion:'TLSv1.3',agent:keep?agent:false,headers:{'content-type':'application/json'}},res=>{
      let text='';const socket=res.socket;res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),socket,protocol:socket.getProtocol()}));
    });req.on('error',reject);req.end(method==='GET'?undefined:JSON.stringify(body));
  });
  assert.equal((await call(f.bootstrapCredential.certificatePem,'GET','/api/v1/gateways/gateway-1/commands')).status,403);
  const registered=await call(f.bootstrapCredential.certificatePem,'POST','/v1/gateway-registrations',f.input);
  assert.equal(registered.status,201);assert.equal(registered.protocol,'TLSv1.3');
  const deviceCert=registered.body.credential.certificatePem;
  const active=await call(deviceCert,'GET','/api/v1/gateways/gateway-1/commands',{},true);assert.equal(active.status,200);
  const closed=new Promise(resolve=>active.socket.once('close',resolve));
  const lost=await call(guardianCredential.certificatePem,'POST','/v1/gateway-lifecycle/lost',{gatewayId:'gateway-1',idempotencyKey:'tls-lost'});
  assert.equal(lost.status,200);assert.equal(lost.body.sessionTermination,'COMPLETED');assert.equal(lost.body.sessionsClosed,1);
  await closed;
  assert.equal((await call(deviceCert,'GET','/api/v1/gateways/gateway-1/commands')).status,403);
  const status=await call(deviceCert,'GET','/api/v1/gateways/gateway-1/credentials/status');assert.equal(status.status,200);assert.equal(status.body.status,'LOST');
  assert.equal((await call(deviceCert,'GET','/api/v1/gateways/other/credentials/status')).status,403);
});
