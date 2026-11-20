import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { isRecord } from './client.ts';
import { LangToggle, useLang } from './i18n.tsx';
import { pick } from './server-messages.ts';

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
        if(!response.ok||!isRecord(data)||!['demo','live'].includes(String(data['mode']))||typeof data['authenticated']!=='boolean')throw Error('session');
        if(data['authenticated']&&(!isRecord(data['principal'])||!Array.isArray(data['principal']['scopes'])||typeof data['principal']['principalId']!=='string'))throw Error('session');
        if(active){setSession(data as unknown as AuthSession);setError(null);}
      }catch{if(active){setSession(null);setError(pick('로그인 서버와 연결이 끊겼어요. 잠시 후 다시 시도해 주세요.', 'Lost the connection to the sign-in server. Try again in a moment.'));}}
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
    }catch{setError(pick('로그아웃 요청이 서버에 닿지 않았어요. 다시 시도해 주세요.', 'The sign-out request did not reach the server. Try again.'));}
  },[reload]);
  return <AuthContext.Provider value={{session,error,reload,logout}}>{children}</AuthContext.Provider>;
}

export function AccountAction() {
  const {session,logout}=useAuth();
  const {tr}=useLang();
  return session?.mode==='live'&&session.authenticated?<button className="portal-switch" onClick={()=>void logout()} title={session.principal?.principalId}>{tr('로그아웃','Sign out')}</button>:null;
}

export function AuthGate({role,children}:{role:'operator'|'user';children:ReactNode}) {
  const auth=useAuth();
  const {tr}=useLang();
  const allowed=auth.session?.mode==='demo'||(auth.session?.authenticated&&(role==='user'||auth.session.principal?.scopes.includes('dashboard:read')));
  if(allowed)return <>{children}</>;
  const returnTo=`/${window.location.hash}`;
  return <main className="auth-gate"><div className="auth-gate-top"><a className="portal-brand" href="#/">BubbleLock</a><LangToggle /></div><div className="content-card stack"><p className="eyebrow">{tr('계정','Account')}</p><h1>{auth.session===null&&auth.error===null?tr('잠시만 기다려 주세요','One moment'):auth.session?.authenticated?tr('운영자 계정이 필요해요','An operator account is needed'):tr('로그인하고 시작하세요','Sign in to start')}</h1><p>{auth.error??(auth.session?.authenticated?tr('운영 화면을 볼 수 있는 계정으로 다시 로그인해 주세요.','Sign in again with an account that can open the operator view.'):auth.session?tr('가족과 키링이 연결된 계정으로 로그인해 주세요.','Sign in with the account linked to your family and keyrings.'):tr('계정을 확인하고 있어요…','Checking your account…'))}</p>{auth.session?.mode==='live'&&!auth.session.authenticated&&<a className="button primary" href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>{tr('로그인','Sign in')}</a>}{auth.session?.authenticated&&<AccountAction/>}{auth.error&&<button onClick={auth.reload}>{tr('다시 시도','Try again')}</button>}<a href="#/">{tr('시작 화면으로','Back to start')}</a></div></main>;
}
