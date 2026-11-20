import { useEffect, useState } from 'react';
import { Landing } from './PortalShell.tsx';
import { OperatorDashboard } from './OperatorDashboard.tsx';
import { UserDashboard } from './UserDashboard.tsx';
import { AuthProvider, AuthGate } from './auth-client.tsx';
import { LangProvider, useLang } from './i18n.tsx';

const aliases: Record<string,string> = {locations:'map',commands:'commands',resources:'devices',audit:'audit',services:'services',evidence:'evidence'};
export function resolveRoute(hash: string): {role:'landing'|'operator'|'user';page:string} {
  const path=hash.replace(/^#\/?/,'');
  if(aliases[path])return {role:'operator',page:aliases[path]!};
  const [role,page]=path.split('/');
  if(role==='operator')return {role,page:['overview','map','devices','commands','audit','services','evidence'].includes(page??'')?page!:'overview'};
  if(role==='user')return {role,page:['overview','map','devices','privacy','activity'].includes(page??'')?page!:'overview'};
  return {role:'landing',page:'home'};
}
function PortalRoutes() {
  const [route,setRoute]=useState(()=>resolveRoute(window.location.hash));
  const {tr}=useLang();
  useEffect(()=>{const change=()=>{setRoute(resolveRoute(window.location.hash));window.scrollTo({top:0});};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  useEffect(()=>{document.title=route.role==='landing'?'BubbleLock':route.role==='user'?tr('가족 대시보드 - BubbleLock','Family dashboard - BubbleLock'):tr('운영 대시보드 - BubbleLock','Operator dashboard - BubbleLock');},[route,tr]);
  return route.role==='landing'?<Landing/>:<AuthGate role={route.role}>{route.role==='operator'?<OperatorDashboard page={route.page}/>:<UserDashboard page={route.page}/>}</AuthGate>;
}
export function App(){return <LangProvider><AuthProvider><PortalRoutes/></AuthProvider></LangProvider>;}
