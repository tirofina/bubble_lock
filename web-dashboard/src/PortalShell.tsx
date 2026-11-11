import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { AccountAction, useAuth } from './auth-client.tsx';

const operatorNav: readonly [string,string,IconName][] = [['overview','운영 개요','grid'],['map','위치 지도','pin'],['devices','자원과 장치','key'],['commands','명령 관리','bolt'],['audit','감사 기록','file'],['services','연동 서비스','server'],['evidence','구현·검증 현황','shield']];
const userNav: readonly [string,string,IconName][] = [['overview','내 대시보드','grid'],['map','키링 위치','pin'],['devices','가족과 키링','users'],['privacy','동의와 권한','shield'],['activity','알림과 요청','bell']];
export function PortalShell({ role, page, children, actions }: {role:'operator'|'user'; page:string; children:ReactNode; actions?:ReactNode}) {
  const auth=useAuth();
  const canSwitch=role==='operator'||auth.session?.mode==='demo'||auth.session?.principal?.scopes.includes('dashboard:read');
  const nav = role === 'operator' ? operatorNav : userNav;
  const label = nav.find(([id]) => id === page)?.[1] ?? nav[0]![1];
  return <div className={`portal-app ${role}-portal`}>
    <a className="skip" href="#main" onClick={(event)=>{event.preventDefault();document.getElementById('main')?.focus();}}>본문으로 건너뛰기</a>
    <aside className="portal-sidebar">
      <a className="portal-brand" href="#/"><span className="brand-symbol"><Icon name="bubble" size={24}/></span><span>BubbleLock<small>PRIVACY, CONNECTED</small></span></a>
      <div className="workspace-label"><span className="workspace-dot"/>{role === 'operator' ? '운영 워크스페이스' : '나의 프라이버시'}</div>
      <nav aria-label={role === 'operator' ? '운영 대시보드 메뉴' : '사용자 대시보드 메뉴'}>{nav.map(([id,title,icon]) =>
        <a className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} href={`#/${role}/${id}`} key={id}><Icon name={icon}/><span>{title}</span>{page === id && <span className="nav-indicator"/>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="workspace-info"><Icon name="shield"/><div><strong>관측 기반 상태 확인</strong><small>위치 · 동의 · 실행 기록</small></div></div><a href="#/"><Icon name="exit"/>시작 화면으로</a></div>
    </aside>
    <div className="portal-main">
      <header className="portal-topbar"><div className="breadcrumb">{role === 'operator' ? '운영 대시보드' : '사용자 대시보드'}<Icon name="chevron" size={14}/><strong>{label}</strong></div><AccountAction/>{canSwitch&&<a className="portal-switch" href={role === 'operator' ? '#/user/overview' : '#/operator/overview'}>{role === 'operator' ? '사용자 화면' : '운영 화면'}<Icon name="arrow" size={16}/></a>}</header>
      <main id="main" tabIndex={-1} className="portal-content"><div className="page-heading"><div><p className="eyebrow">{role === 'operator' ? 'OPERATIONS' : 'MY BUBBLE'}</p><h1>{label}</h1></div>{actions}</div>{children}</main>
      <footer className="portal-footer"><span>BubbleLock · Privacy Bubble Keyring</span><span>관측별 출처와 시각을 함께 확인하세요.</span></footer>
    </div>
  </div>;
}

export function Landing() {
  const auth=useAuth();
  return <div className="welcome-page"><header className="welcome-header"><a className="portal-brand" href="#/"><span className="brand-symbol"><Icon name="bubble" size={25}/></span><span>BubbleLock<small>PRIVACY, CONNECTED</small></span></a><div className="cluster"><span className="environment-tag"><i/>{auth.session?.mode==='live'?'계정 연결 워크스페이스':auth.session?'로컬 데모 워크스페이스':'워크스페이스 연결 중'}</span><AccountAction/></div></header>
    <main className="welcome-main"><div className="welcome-copy"><p className="eyebrow">당신의 일상에, 한 겹의 안심</p><h1>가까이 있는 연결.<br/><span>내가 정하는 프라이버시.</span></h1><p className="welcome-description">키링의 위치를 확인하고, 공유 범위를 선택하세요.<br/>일상과 운영에 맞는 화면으로 시작할 수 있습니다.</p></div>
      <div className="welcome-visual" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><div className="floating-mark mark-shield"><Icon name="shield" size={32}/></div><div className="bubble-device"><span className="device-hole"/><Icon name="bubble" size={62}/><span>BUBBLE LOCK</span><i/></div><div className="floating-mark mark-pin"><Icon name="pin" size={29}/></div><div className="floating-mark mark-key"><Icon name="key" size={27}/></div></div>
      <div className="entrance-grid"><a className="entrance-card user-entrance" href="#/user/overview"><span className="entrance-icon"><Icon name="users" size={26}/></span><div><p className="eyebrow">FOR YOU & YOUR FAMILY</p><h2>사용자 대시보드</h2><p>내 키링 위치, 가족 연결, 동의와 알림을<br className="desktop-only"/> 한눈에 확인하세요.</p></div><span className="entrance-link">내 대시보드로<Icon name="arrow"/></span></a>
        <a className="entrance-card operator-entrance" href="#/operator/overview"><span className="entrance-icon"><Icon name="grid" size={26}/></span><div><p className="eyebrow">FOR OPERATIONS</p><h2>운영 대시보드</h2><p>장치와 명령, 서비스 연동, 감사 기록을<br className="desktop-only"/> 하나의 콘솔에서 관리하세요.</p></div><span className="entrance-link">운영 콘솔로<Icon name="arrow"/></span></a></div>
    </main><footer className="welcome-footer"><span>Privacy Bubble Keyring</span><span>데모 관측과 실측 관측은 화면에서 각각 표시됩니다.</span></footer></div>;
}

export function Metric({label,value,note,icon}: {label:string;value:ReactNode;note:string;icon:IconName}) {
  return <article className="metric-card"><span className="metric-icon"><Icon name={icon}/></span><p>{label}</p><strong>{value}</strong><small>{note}</small></article>;
}
