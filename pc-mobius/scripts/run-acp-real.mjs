import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { randomBytes,createHash } from 'node:crypto';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OneM2mEdgeClient } from '../integration/src/handover-cse.mjs';
import { encodeBinarySwitch } from '../src/sdt-adapter.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const configArg=process.argv.find((arg)=>arg.startsWith('--config='))?.slice(9);
const configPath=configArg??JSON.parse(await readFile(join(root,'.local/handover-cse/current.json'),'utf8')).configPath;
const configurations=JSON.parse(await readFile(resolve(configPath),'utf8'));assert.equal(configurations.length,2);
const run=randomBytes(5).toString('hex');const results=[];const notifications=[];
const receiver=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);notifications.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString()),origin:req.headers['x-m2m-origin']});res.writeHead(200,{'X-M2M-RSC':'2000','X-M2M-RI':req.headers['x-m2m-ri']??''});res.end();}catch{res.writeHead(400);res.end();}});
receiver.listen(Number(process.env.ACP_SINK_PORT??0),'127.0.0.1');await once(receiver,'listening');const sinkUrl=`http://127.0.0.1:${receiver.address().port}`;
async function request(config,originator,method,path,payload,ty){
  const rqi=`acp-${randomBytes(6).toString('hex')}`;const response=await fetch(`${config.endpoint}${path}`,{method,redirect:'error',headers:{Accept:'application/json','X-M2M-Origin':originator,'X-M2M-RI':rqi,'X-M2M-RVI':'4',...(payload?{'content-type':`application/json${ty?`;ty=${ty}`:''}`}:{})},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(5000)});
  const text=await response.text();const body=text?JSON.parse(text):null;assert.equal(response.headers.get('X-M2M-RI'),rqi);return {rsc:Number(response.headers.get('X-M2M-RSC')),httpStatus:response.status,rqi,body};
}
function check(provider,name,response,expected,details={}){const actual=details.actual??response.rsc;results.push({provider,name,status:actual===expected?'PASS':'REVIEW',expected,actual,rsc:response.rsc,requestId:response.rqi,...details});}
try{
  for(const [index,config] of configurations.entries()){
    const provider=`provider-${index+1}`;const admin=new OneM2mEdgeClient(config);
    const parent=await admin.ensure(config.cseBase,2,{'m2m:ae':{rn:`acp-${run}-${index}`,api:'N.privacy.bubble.acp',rr:true}},{update:false});
    const roles={};for(const name of ['guardian','visitor','relay','mecIPE','executor','operator','policyDeployer']){const resource=await admin.ensure(config.cseBase,2,{'m2m:ae':{rn:`acp-${run}-${index}-${name}`,api:'N.privacy.bubble.role',rr:true,poa:[sinkUrl]}},{update:false});roles[name]={...resource,id:resource.aei};}
    const resources=[];
    const add=async(name,masks,ty=3)=>{
      const policy={pv:{acr:[{acor:[config.originator],acop:63},...Object.entries(masks).map(([role,acop])=>({acor:[roles[role].id],acop}))]},pvs:{acr:[{acor:[config.originator],acop:63},{acor:[roles.policyDeployer.id],acop:14}]}};
      const acp=await admin.ensure(parent.path,1,{'m2m:acp':{rn:`${name}-acp`,...policy}});
      const body=ty===28?encodeBinarySwitch({rn:name,state:false,acpi:[acp.ri]},{operation:'CREATE'}):ty===9?{'m2m:grp':{rn:name,mt:3,mnm:1,mid:[resources[0].path.replace(/^\//,'')],csy:1,acpi:[acp.ri]}}:{'m2m:cnt':{rn:name,acpi:[acp.ri]}};
      const resource=await admin.ensure(parent.path,ty,body);resources.push({...resource,name,masks,acp,policy});return resources.at(-1);
    };
    await add('abstract',{guardian:34});await add('incident',{guardian:1});await add('group',{visitor:34},9);await add('intent',{visitor:1});await add('observation',{relay:1});await add('receipt',{relay:1});const desired=await add('desired',{mecIPE:2});await add('actual',{mecIPE:5});const actuator=await add('actuator',{executor:6},28);await add('health',{operator:2});
    const notifyPolicy=await admin.ensure(parent.path,1,{'m2m:acp':{rn:'notify-acp',pv:{acr:[{acor:[config.originator],acop:63},{acor:[roles.mecIPE.id,config.cseId],acop:16}]},pvs:{acr:[{acor:[config.originator],acop:63},{acor:[roles.policyDeployer.id],acop:14}]}}});
    const sink=await admin.ensure(config.cseBase,2,{'m2m:ae':{rn:`acp-${run}-${index}-sink`,api:'N.privacy.bubble.receiver',rr:true,poa:[sinkUrl],acpi:[notifyPolicy.ri]}},{update:false});resources.push({...sink,name:'notification',masks:{mecIPE:16},acp:notifyPolicy});
    for(const [role,identity] of Object.entries(roles).filter(([role])=>role!=='policyDeployer'))for(const resource of resources){
      const mask=resource.masks[role]??0;
      for(const [operation,bit,method,payload,ty] of [
        ['CREATE',1,'POST',{'m2m:cin':{rn:`sample-${role}`,cnf:'application/json',con:{abstractState:'SAFE'}}},4],
        ['RETRIEVE',2,'GET',undefined,undefined],
        ['UPDATE',4,'PUT',resource.ty===28?encodeBinarySwitch({state:true}):{[resource.ty===9?'m2m:grp':resource.ty===2?'m2m:ae':'m2m:cnt']:{lbl:[`updated-${role}`]}},undefined],
        ['DELETE',8,'DELETE',undefined,undefined],
        ['NOTIFY',16,'POST',{'m2m:sgn':{sur:resource.path,nev:{net:1,rep:{'m2m:cnt':{rn:'notification-probe'}}}}},undefined],
      ]){
        const response=await request(config,identity.id,method,resource.path,payload,ty);const expected=mask&bit?operation==='CREATE'?2001:operation==='UPDATE'?2004:operation==='DELETE'?2002:2000:4103;
        check(provider,`${role}:${resource.name}:${operation}`,response,expected,{role,resource:resource.name,operation,mask});
      }
      const discovery=await request(config,identity.id,'GET',`${parent.path}?fu=1&ty=${resource.ty}`);
      const uris=discovery.body?.['m2m:uril']??[];const found=uris.some((uri)=>uri.replace(/^\//,'')===resource.path.replace(/^\//,''));
      check(provider,`${role}:${resource.name}:DISCOVER`,discovery,Boolean(mask&32),{role,resource:resource.name,operation:'DISCOVER',mask,actual:found});
    }
    for(const [role,identity] of Object.entries(roles).filter(([role])=>role!=='policyDeployer')){
      check(provider,`${role}:ACP:self-update`,await request(config,identity.id,'PUT',desired.acp.path,{'m2m:acp':{pv:{acr:[{acor:[identity.id],acop:63}]}}}),4103);
      check(provider,`${role}:ACP:self-delete`,await request(config,identity.id,'DELETE',desired.acp.path),4103);
    }
    check(provider,'policyDeployer:ACP:update',await request(config,roles.policyDeployer.id,'PUT',desired.acp.path,{'m2m:acp':{pv:desired.policy.pv}}),2004);
    check(provider,'executor:resource:acpi-replacement',await request(config,roles.executor.id,'PUT',actuator.path,{'cod:binSh':{acpi:[desired.acp.ri]}}),4103);
    let subscribed=await request(config,roles.mecIPE.id,'POST',desired.path,{'m2m:sub':{rn:'desired-events',nu:[sink.path.replace(/^\//,'')],enc:{net:[1]},nct:1}},23);
    check(provider,'mecIPE:RETRIEVE-only:SUBSCRIBE',subscribed,2001);
    if(subscribed.rsc!==2001){
      await admin.request('PUT',desired.acp.path,{'m2m:acp':{pv:{acr:[{acor:[config.originator],acop:63},{acor:[roles.mecIPE.id],acop:3}]}}});
      subscribed=await request(config,roles.mecIPE.id,'POST',desired.path,{'m2m:sub':{rn:'desired-events',nu:[sink.path.replace(/^\//,'')],enc:{net:[1]},nct:1}},23);
      await admin.request('PUT',desired.acp.path,{'m2m:acp':{pv:desired.policy.pv}});
    }
    const relayResource=resources.find((resource)=>resource.name==='observation');
    check(provider,'relay:CREATE-only:SUBSCRIBE',await request(config,roles.relay.id,'POST',relayResource.path,{'m2m:sub':{rn:'unreadable-events',nu:[sinkUrl],enc:{net:[1]},nct:1}},23),4103);
    check(provider,'mecIPE:RETRIEVE:SUBSCRIBE-foreign-url',await request(config,roles.mecIPE.id,'POST',desired.path,{'m2m:sub':{rn:'foreign-url',nu:['http://127.0.0.1:1/audit-ssrf'],enc:{net:[1]},nct:1}},23),4000);
    if(subscribed.rsc===2001){
      const matches=(label)=>notifications.filter((entry)=>{
        const signal=entry.body?.['m2m:sgn'];
        return signal?.sur?.replace(/^\//,'') === `${desired.path.replace(/^\//,'')}/desired-events` && signal.nev?.rep?.['m2m:cnt']?.lbl?.includes(label);
      });
      await admin.request('PUT',desired.path,{'m2m:cnt':{lbl:['before-revoke']}});
      for(let attempt=0;attempt<100&&matches('before-revoke').length===0;attempt++)await delay(10);
      check(provider,'subscription:authorized-notification',subscribed,true,{actual:matches('before-revoke').length>0});
      await admin.request('PUT',desired.acp.path,{'m2m:acp':{pv:{acr:[{acor:[config.originator],acop:63}]}}});
      await admin.request('PUT',desired.path,{'m2m:cnt':{lbl:['after-revoke']}});await delay(500);
      check(provider,'subscription:current-RETRIEVE-revocation',subscribed,0,{actual:matches('after-revoke').length});
    }
  }
  await writeFile(join(root,'.local/acp-notifications.json'),JSON.stringify({notifications,paths:configurations.map(c=>c.cseBase)},null,2));
  const evidence={status:results.every((item)=>item.status==='PASS')?'PASS':'REVIEW',recordedAt:new Date().toISOString(),transport:'actual-Mobius4-two-CSE-HTTP',rubricIds:['R10','A07'],coreRoles:['guardian','visitor','relay','mecIPE','executor'],additionalRole:'operator',operations:['CREATE','RETRIEVE','UPDATE','DELETE','NOTIFY','DISCOVER'],caseCount:results.length,passed:results.filter((item)=>item.status==='PASS').length,failed:results.filter((item)=>item.status==='REVIEW').length,results,runnerSHA256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')};
  await mkdir(join(root,'pc-mobius/receipts'),{recursive:true});await writeFile(join(root,'pc-mobius/receipts/acp-real-cse.json'),`${JSON.stringify(evidence,null,2)}\n`);
  console.log(JSON.stringify({status:evidence.status,cases:evidence.caseCount,passed:evidence.passed,failed:evidence.failed,review:results.filter((item)=>item.status==='REVIEW').map(({name,expected,actual})=>({name,expected,actual}))},null,2));if(evidence.failed)process.exitCode=1;
}finally{receiver.closeAllConnections();await new Promise((resolve)=>receiver.close(resolve));}


