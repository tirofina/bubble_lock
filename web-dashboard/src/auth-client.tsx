import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { isRecord } from './client.ts';
import { LangToggle, useLang } from './i18n.tsx';
import { pick, translateServerMessage } from './server-messages.ts';

interface AuthSession {mode:'demo'|'live';authenticated:boolean;method?:'password'|'oidc';principal?:{principalId:string;scopes:string[]};expiresAt?:string}
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
      const response=await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin',redirect:'error'});
      if(!response.ok)throw Error();
      const data:unknown=await response.json();
      if(!isRecord(data)||typeof data['logoutUrl']!=='string')throw Error(pick('로그아웃 이동 경로를 확인해 주세요.', 'The sign-out redirect is missing.'));
      setSession((current)=>({mode:'live',authenticated:false,...(current?.method?{method:current.method}:{})}));setError(null);
      window.location.assign(data['logoutUrl']);
    }catch{setError(pick('로그아웃 요청이 서버에 닿지 않았어요. 다시 시도해 주세요.', 'The sign-out request did not reach the server. Try again.'));}
  },[reload]);
  return <AuthContext.Provider value={{session,error,reload,logout}}>{children}</AuthContext.Provider>;
}

export function AccountAction() {
  const {session,logout}=useAuth();
  const {tr}=useLang();
  return session?.mode==='live'&&session.authenticated?<button className="portal-switch" onClick={()=>void logout()} title={session.principal?.principalId}>{tr('로그아웃','Sign out')}</button>:null;
}

/** Password form for self-hosted local accounts (LOCAL_ACCOUNTS_FILE). */
function LocalLoginForm({onSuccess}:{onSuccess:()=>void}) {
  const {tr,lang}=useLang();
  const [error,setError]=useState<string|null>(null);
  const [pending,setPending]=useState(false);
  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const values=new FormData(event.currentTarget);
    setPending(true);setError(null);
    try{
      const response=await fetch('/api/auth/local-login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:String(values.get('username')??''),password:String(values.get('password')??'')}),signal:AbortSignal.timeout(15000)});
      const data:unknown=await response.json().catch(()=>null);
      if(!response.ok)throw Error(isRecord(data)&&typeof data['message']==='string'?data['message']:pick('아이디 또는 비밀번호를 확인해 주세요.','Check the username or password.'));
      onSuccess();
    }catch(cause){setError(cause instanceof Error&&cause.name!=='TimeoutError'?cause.message:pick('로그인 서버와 연결이 끊겼어요. 잠시 후 다시 시도해 주세요.','Lost the connection to the sign-in server. Try again in a moment.'));}
    finally{setPending(false);}
  };
  return <form className="stack" onSubmit={(event)=>void submit(event)}><label>{tr('아이디','Username')}<input name="username" autoComplete="username" required maxLength={64} autoCapitalize="none" spellCheck={false} /></label><label>{tr('비밀번호','Password')}<input name="password" type="password" autoComplete="current-password" required maxLength={1024} /></label>{error&&<p className="error" role="alert">{translateServerMessage(error,lang)}</p>}<button className="button primary" disabled={pending}>{pending?tr('확인하고 있어요…','Checking…'):tr('로그인','Sign in')}</button></form>;
}

export function AuthGate({role,children}:{role:'operator'|'user';children:ReactNode}) {
  const auth=useAuth();
  const {tr}=useLang();
  const allowed=auth.session?.mode==='demo'||(auth.session?.authenticated&&(role==='user'||auth.session.principal?.scopes.includes('dashboard:read')));
  if(allowed)return <>{children}</>;
  const returnTo=`/${window.location.hash}`;
  return <main className="auth-gate"><div className="auth-gate-top"><a className="portal-brand" href="#/">BubbleLock</a><LangToggle /></div><div className="content-card stack"><p className="eyebrow">{tr('계정','Account')}</p><h1>{auth.session===null&&auth.error===null?tr('잠시만 기다려 주세요','One moment'):auth.session?.authenticated?tr('운영자 계정이 필요해요','An operator account is needed'):tr('로그인하고 시작하세요','Sign in to start')}</h1><p>{auth.error??(auth.session?.authenticated?tr('운영 화면을 볼 수 있는 계정으로 다시 로그인해 주세요.','Sign in again with an account that can open the operator view.'):auth.session?tr('가족과 키링이 연결된 계정으로 로그인해 주세요.','Sign in with the account linked to your family and keyrings.'):tr('계정을 확인하고 있어요…','Checking your account…'))}</p>{auth.session?.mode==='live'&&!auth.session.authenticated&&auth.session.method==='password'&&<LocalLoginForm onSuccess={auth.reload}/>}{auth.session?.mode==='live'&&!auth.session.authenticated&&auth.session.method!=='password'&&<a className="button primary" href={`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>{tr('로그인','Sign in')}</a>}{auth.session?.authenticated&&<AccountAction/>}{auth.error&&<button onClick={auth.reload}>{tr('다시 시도','Try again')}</button>}<a href="#/">{tr('시작 화면으로','Back to start')}</a></div></main>;
}
