import { request as httpsRequest } from 'node:https';

export interface PortalApiResult {status:number;body:unknown}
export interface PortalUpstreamRequest {method:string;path:string;accessToken:string;body?:unknown}
export type PortalUpstream=(input:PortalUpstreamRequest)=>Promise<PortalApiResult>;

/** 서버 설정의 단일 HTTPS API로만 전달하고 브라우저에는 토큰을 노출하지 않습니다. */
export function createPortalUpstream(options:{baseUrl:string;ca?:string;timeoutMs?:number}):PortalUpstream {
  const base=new URL(options.baseUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw Error('포털 API HTTPS 주소를 확인하세요.');
  return async(input)=>{
    if(!/^\/v1\/portal\/[a-z/-]+$/.test(input.path)||!['GET','POST'].includes(input.method))throw Error('포털 API 경로를 확인하세요.');
    if(!input.accessToken||/[\r\n]/.test(input.accessToken))throw Error('사용자 토큰을 확인하세요.');
    const payload=input.method==='POST'?Buffer.from(JSON.stringify(input.body??{})):null;
    return new Promise((resolve,reject)=>{
      const request=httpsRequest(new URL(input.path,base),{method:input.method,minVersion:'TLSv1.3',
        ...(options.ca===undefined?{}:{ca:options.ca}),
        headers:{Authorization:`Bearer ${input.accessToken}`,Accept:'application/json',...(payload?{'Content-Type':'application/json','Content-Length':String(payload.length)}:{})},
      },(response)=>{
        const chunks:Buffer[]=[];let size=0;
        response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024){request.destroy(Error('포털 응답 크기를 확인하세요.'));return;}chunks.push(chunk);});
        response.on('error',reject);
        response.on('end',()=>{try{resolve({status:response.statusCode??502,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(Error('포털 API 응답 형식을 확인하세요.'));}});
      });
      const timer=setTimeout(()=>request.destroy(Error('포털 API 연결 시간을 확인하세요.')),options.timeoutMs??10000);
      timer.unref();request.on('close',()=>clearTimeout(timer));request.on('error',reject);
      request.end(payload);
    });
  };
}
