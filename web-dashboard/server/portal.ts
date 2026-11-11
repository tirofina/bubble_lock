import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LocationFeed } from './location-feed.ts';
import type { OidcSessionManager } from './oidc-session.ts';
import type { PortalUpstream } from './portal-upstream.ts';
import { ingestLocationRecord } from '../shared/location.ts';
import type { LocationState, LocationSnapshot } from '../shared/location.ts';

type Role='guardian'|'visitor'|'operator';
interface ApiResult { status:number;body:unknown }
interface DemoRuntime {runtime:{api:{handle(request:{method:string;path:string;principal:unknown;body?:unknown}):Promise<ApiResult>}};principals:Record<Role,unknown>}
interface DemoModule {createPortalDemo(options:{statePath?:string}):Promise<DemoRuntime>}
export interface PortalOptions {statePath?:string;auth?:OidcSessionManager;upstream?:PortalUpstream}
export interface PortalHandler {
  readonly mode:'live'|'demo';
  handle(request:IncomingMessage,response:ServerResponse,url:URL):Promise<void>;
  handleAuth(request:IncomingMessage,response:ServerResponse):Promise<boolean>;
  authorizeOperator(request:IncomingMessage,response:ServerResponse):Promise<boolean>;
}
const actions=new Set(['households','devices','consents','grants','consents/revoke','grants/revoke','incidents','incidents/resolve','commands/request','commands/approve','notifications/read','location-leases','location-leases/revoke','relay-associations']);
function json(response:ServerResponse,status:number,body:unknown) {
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(body));
}
function record(value:unknown):value is Record<string,unknown> {return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function deviceScope(value:unknown):Set<string>|null {
  if(!record(value)||!Array.isArray(value['deviceIds'])||value['deviceIds'].length>1000
    ||value['deviceIds'].some((id:unknown)=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)))return null;
  return new Set(value['deviceIds'] as string[]);
}
function roleOf(value:unknown):Role {if(value===undefined||value===null)return 'guardian';if(value==='guardian'||value==='visitor'||value==='operator')return value;throw Error('역할을 확인해 주세요.');}
function localOrigin(request:IncomingMessage) {
  let host:string;
  try {host=new URL(`http://${request.headers.host??''}`).hostname;}catch{return false;}
  if(!['127.0.0.1','localhost','[::1]'].includes(host))return false;
  if(request.headers['sec-fetch-site']==='cross-site')return false;
  const origin=request.headers.origin;
  if(!origin)return true;
  try {const parsed=new URL(origin);return ['http:','https:'].includes(parsed.protocol)&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)&&['4174','5173'].includes(parsed.port);}catch{return false;}
}
async function body(request:IncomingMessage):Promise<Record<string,unknown>> {
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>65536)throw Error('요청 크기를 확인해 주세요.');chunks.push(bytes);}
  const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
  if(!record(value))throw Error('요청 형식을 확인해 주세요.');return value;
}
export async function createPortalHandler(locationFeed:LocationFeed,options:PortalOptions={}):Promise<PortalHandler> {
  if(Boolean(options.auth)!==Boolean(options.upstream))throw Error('OIDC와 포털 API를 함께 설정하세요.');
  const mode=options.auth?'live':'demo';
  let demo:DemoRuntime|null=null;
  if(mode==='demo'){
    const module=await import(new URL('../../pc-mobius/integration/src/portal-demo.mjs',import.meta.url).href) as DemoModule;
    demo=await module.createPortalDemo(options);
  }
  return {
  mode,
  async handleAuth(request,response) {
    if(options.auth)return options.auth.handle(request,response);
    if(request.url==='/api/auth/session'&&request.method==='GET'){json(response,200,{mode:'demo',authenticated:false});return true;}
    return false;
  },
  async authorizeOperator(request,response) {
    if(!options.auth)return true;
    const identity=await options.auth.authenticate(request);
    if(!identity){json(response,401,{mode,message:'로그인하여 대시보드에 연결하세요.'});return false;}
    if(!identity.principal.scopes.includes('dashboard:read')){json(response,403,{mode,message:'운영 조회 권한을 확인하세요.'});return false;}
    return true;
  },
  async handle(request,response,url) {
    try {
      if(!options.auth&&!localOrigin(request)){json(response,403,{message:'등록된 로컬 화면에서 접근해 주세요.'});return;}
      const identity=options.auth?await options.auth.authenticate(request):null;
      if(options.auth&&!identity){json(response,401,{mode,message:'로그인하여 사용자 공간에 연결하세요.'});return;}
      if(options.auth&&request.method==='POST'){
        try{options.auth.assertMutationOrigin(request);}catch{json(response,403,{message:'로그인한 화면에서 요청하세요.'});return;}
      }
      const api=async(method:string,path:string,role:Role,payload?:unknown):Promise<ApiResult>=>{
        if(identity&&options.upstream)return options.upstream({method,path,accessToken:identity.accessToken,...(payload===undefined?{}:{body:payload})});
        if(!demo)throw Error('포털 환경을 확인하세요.');
        return demo.runtime.api.handle({method,path,principal:demo.principals[role],...(payload===undefined?{}:{body:payload})});
      };
      const action=url.pathname.slice('/api/portal/'.length);
      if(request.method==='GET'&&(action==='snapshot'||action==='locations')) {
        const result=await api('GET',action==='snapshot'?'/v1/portal/snapshot':'/v1/portal/location-access',identity?'guardian':roleOf(url.searchParams.get('role')));
        if(result.status!==200){json(response,result.status,{message:'사용자 범위를 확인해 주세요.'});return;}
        if(action==='snapshot'){json(response,200,{mode,snapshot:result.body});return;}
        const allowed=deviceScope(result.body);
        if(!allowed){json(response,502,{message:'현재 기기 접근 범위를 확인하세요.'});return;}
        const locations=await locationFeed.readSnapshot();
        const simulatedGateways=new Set(locations.gateways.filter((gateway)=>gateway.simulation).map((gateway)=>gateway.gatewayId));
        let devices=locations.devices.filter((device)=>allowed.has(device.deviceId)).map((device)=>({...device,
          position:identity?(device.position&&Date.parse(device.position.observedAt)>Date.now()-86400000?device.position:null):device.position?.simulation?device.position:null,
          ble:identity?(device.ble&&Date.parse(device.ble.observedAt)>Date.now()-86400000?device.ble:null):(device.ble?.simulation&&simulatedGateways.has(device.ble.gatewayId))?device.ble:null,
        })).filter((device)=>device.position!==null||device.ble!==null);
        let source=locations.source;
        let rejectedRecords=locations.rejectedRecords;
        let readExpiresAt:string|undefined;
        {
          const current=await api('GET','/v1/portal/locations',identity?'guardian':roleOf(url.searchParams.get('role')));
          if(current.status!==200||!record(current.body)||!Array.isArray(current.body['observations'])||current.body['observations'].length>2000){json(response,current.status===200?502:current.status,{message:'현재 위치 관측 연결을 확인하세요.'});return;}
          const currentAllowed=deviceScope(current.body);
          if(!currentAllowed){json(response,502,{message:'현재 기기 접근 범위를 확인하세요.'});return;}
          for(const deviceId of allowed)if(!currentAllowed.has(deviceId))allowed.delete(deviceId);
          if(typeof current.body['readExpiresAt']!=='string'||!Number.isFinite(Date.parse(current.body['readExpiresAt']))||Date.parse(current.body['readExpiresAt'])>Date.now()+10000){json(response,502,{message:'위치 응답의 조회 유효기간을 확인하세요.'});return;}
          readExpiresAt=current.body['readExpiresAt'];
          if(Date.parse(readExpiresAt)<=Date.now())allowed.clear();
          devices=devices.filter((device)=>allowed.has(device.deviceId));
          let state:LocationState=Object.fromEntries(devices.map((device)=>[device.deviceId,device]));
          for(const observation of current.body['observations']){
            if(!record(observation)||typeof observation['deviceId']!=='string'||!allowed.has(observation['deviceId']))continue;
            const result=ingestLocationRecord(state,observation,{simulation:observation['simulation']!==false});
            state=result.state;if(!result.accepted)rejectedRecords+=1;
          }
          devices=Object.values(state);if(identity)source=locations.source==='local-jsonl'?'combined':'portal-api';
        }
        const gatewayIds=new Set(devices.flatMap((device)=>device.ble?[device.ble.gatewayId]:[]));
        const gateways=locations.gateways.filter((gateway)=>gatewayIds.has(gateway.gatewayId));
        const provenance=[...devices.flatMap((device)=>[device.position?.simulation,device.ble?.simulation]),...gateways.map((gateway)=>gateway.simulation)].filter((value)=>value!==undefined);
        const snapshot:LocationSnapshot={...locations,mode:identity?'live':locations.mode,source,rejectedRecords,simulation:identity?provenance.length>0&&provenance.every(Boolean):locations.simulation,devices,gateways,...(readExpiresAt?{readExpiresAt}:{})};
        json(response,200,snapshot);return;
      }
      if(request.method!=='POST'){json(response,405,{message:'이 경로의 요청 방식을 확인해 주세요.'});return;}
      if(!actions.has(action)){json(response,404,{message:'요청 경로를 확인해 주세요.'});return;}
      if(!String(request.headers['content-type']).startsWith('application/json')){json(response,415,{message:'JSON 요청 형식을 사용해 주세요.'});return;}
      const input=await body(request);const role=identity?'guardian':roleOf(input['role']);
      const {role:discardRole,principal:discardPrincipal,...payload}=input;
      void discardRole;void discardPrincipal;
      const result=await api('POST',`/v1/portal/${action}`,role,payload);
      if(result.status>=400){json(response,result.status,{message:record(result.body)&&typeof result.body['error']==='string'?result.body['error']:'입력값과 현재 권한을 확인해 주세요.'});return;}
      json(response,result.status,{mode,result:result.body});
    }catch{if(!response.headersSent)json(response,400,{message:'입력값과 요청 형식을 확인해 주세요.'});}
  }};
}
