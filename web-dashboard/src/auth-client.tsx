import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { isRecord } from './client.ts';

interface AuthSession {mode:'demo'|'live';authenticated:boolean;principal?:{principalId:string;scopes:string[]};expiresAt?:string}
interface AuthContextValue {session:AuthSession|null;error:string|null;reload:()=>void;logout:()=>Promise<void>}
const AuthContext=createContext<AuthContextValue>({session:null,error:null,reload:()=>{},logout:async()=>{}});
export const useAuth=()=>useContext(AuthContext);

export function AuthProvider({children}:{children:ReactNode}) {
  const [session,setSession]=useState<AuthSession|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [revision,setRevision]=useState(0);
  const reload=useCallback(()=>setRevision((value)=>value+1),[]);
  useEffect(()=>{
    let active=true;
    const controller=new AbortController();
    const read=async()=>{
      try{
        const response=await fetch('/api/auth/session',{credentials:'same-origin',signal:controller.signal});
        const data:unknown=await response.json();
        if(!response.ok||!isRecord(data)||!['demo','live'].includes(String(data['mode']))||typeof data['authenticated']!=='boolean')throw Error('로그인 연결 상태를 확인해 주세요.');
        if(data['authenticated']&&(!isRecord(data['principal'])||!Array.isArray(data['principal']['scopes'])||typeof data['principal']['principalId']!=='string'))throw Error('계정 정보를 확인해 주세요.');
        if(active){setSession(data as unknown as AuthSession);setError(null);}
      }catch{if(active){setSession(null);setError('로그인 연결 상태를 확인해 주세요.');}}
    };
    void read();const timer=setInterval(()=>void read(),30000);
    window.addEventListener('focus',reload);
    return()=>{active=false;controller.abort();clearInterval(timer);window.removeEventListener('focus',reload);};
  },[reload,revision]);
  const logout=useCallback(async()=>{
    try{
      const response=await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});
      if(!response.ok)throw Error();
      setSession({mode:'live',authenticated:false});setError(null);reload();
    }catch{setError('로그아웃 연결 상태를 확인해 주세요.');}
  },[reload]);
  return <AuthContext.Provider value={{session,error,reload,logout}}>{children}</AuthContext.Provider>;
}

export function AccountAction() {
  const {session,logout}=useAuth();
  return session?.mode==='live'&&session.authenticated?<button className="button-with-icon" onClick={()=>void logout()}>{session.principal?.principalId} · 로그아웃</button>:null;
}

export function AuthGate({role,children}:{role:'operator'|'user';children:ReactNode}) {
  const auth=useAuth();
  const allowed=auth.session?.mode==='demo'||(auth.session?.authenticated&&(role==='user'||auth.session.principal?.scopes.includes('dashboard:read')));
  if(allowed)return <>{children}</>;
  const returnTo=`/${window.location.hash}`;
  return <main className="auth-gate"><a className="portal-brand" href="#/">BubbleLock</a><div className="content-card stack"><p className="eyebrow">YOUR ACCOUNT</p><h1>{auth.session?.authenticated?'운영 계정 연결':'계정으로 시작하기'}</h1><p>{auth.error??(auth.session?.authenticated?'운영 조회 권한이 연결된 계정으로 시작하세요.':auth.session?'가족과 키링에 연결된 계정으로 로그인하세요.':'계정 연결을 확인하고 있습니다…')}</p>{auth.session?.mode==='live'&&!auth.session.authenticated&&<a className="button primary" href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>계정 로그인</a>}{auth.session?.authenticated&&<AccountAction/>}{auth.error&&<button onClick={auth.reload}>다시 연결</button>}<a href="#/">시작 화면으로</a></div></main>;
}
