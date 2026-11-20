import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { AccountAction, useAuth } from './auth-client.tsx';
import { LangToggle, useLang } from './i18n.tsx';
import keyringImage from './assets/privacy-bubble-keyring.png';

type NavItem = readonly [id: string, title: string, short: string, icon: IconName, titleEn: string, shortEn: string];
const operatorNav: readonly NavItem[] = [
  ['overview', '한눈에 보기', '한눈에', 'grid', 'Overview', 'Overview'], ['map', '위치 지도', '지도', 'pin', 'Location map', 'Map'], ['devices', '장치와 자원', '장치', 'key', 'Devices and resources', 'Devices'],
  ['commands', '명령 처리', '명령', 'bolt', 'Commands', 'Commands'], ['audit', '활동 기록', '기록', 'file', 'Activity log', 'Log'], ['services', '연결 서비스', '서비스', 'server', 'Connected services', 'Services'],
  ['evidence', '개발 현황', '현황', 'shield', 'Build status', 'Status'],
];
const userNav: readonly NavItem[] = [
  ['overview', '내 대시보드', '홈', 'home', 'My dashboard', 'Home'], ['map', '키링 위치', '위치', 'pin', 'Keyring location', 'Location'], ['devices', '가족과 키링', '가족', 'users', 'Family and keyrings', 'Family'],
  ['privacy', '공유 권한', '권한', 'shield', 'Sharing', 'Sharing'], ['activity', '알림과 요청', '알림', 'bell', 'Alerts and requests', 'Alerts'],
];

function Brand({ tagline = true }: { readonly tagline?: boolean }) {
  const { tr } = useLang();
  return <a className="portal-brand" href="#/"><span className="brand-symbol"><Icon name="bubble" size={22} /></span>
    <span>BubbleLock{tagline && <small>{tr('가까이서 지키는 프라이버시', 'Privacy that stays close')}</small>}</span></a>;
}

export function PortalShell({ role, page, children, actions }: { role: 'operator' | 'user'; page: string; children: ReactNode; actions?: ReactNode }) {
  const auth = useAuth();
  const { lang, tr } = useLang();
  const canSwitch = role === 'operator' || auth.session?.mode === 'demo' || auth.session?.principal?.scopes.includes('dashboard:read');
  const nav = role === 'operator' ? operatorNav : userNav;
  const title = (item: NavItem) => (lang === 'en' ? item[4] : item[1]);
  const label = title(nav.find(([id]) => id === page) ?? nav[0]!);
  const area = role === 'operator' ? tr('운영 대시보드', 'Operator dashboard') : tr('가족 대시보드', 'Family dashboard');
  return <div className={`portal-app ${role}-portal`}>
    <a className="skip" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus(); }}>{tr('본문으로 건너뛰기', 'Skip to content')}</a>
    <aside className="portal-sidebar">
      <Brand />
      <div className="workspace-label"><span className="workspace-dot" />{role === 'operator' ? tr('운영자 화면', 'Operator view') : tr('내 프라이버시', 'My privacy')}</div>
      <nav aria-label={tr(`${area} 메뉴`, `${area} menu`)}>{nav.map((item) =>
        <a className={page === item[0] ? 'active' : ''} aria-current={page === item[0] ? 'page' : undefined} href={`#/${role}/${item[0]}`} key={item[0]}><Icon name={item[3]} /><span>{title(item)}</span></a>)}</nav>
      <div className="sidebar-bottom">
        <a className="workspace-info" href={role === 'operator' ? '#/operator/audit' : '#/user/privacy'}><Icon name="shield" /><div><strong>{tr('받은 그대로 보여요', 'Shown as received')}</strong>{tr('위치, 공유 권한, 실행 기록', 'Location, sharing and run records')}</div></a>
        <a href="#/"><Icon name="exit" />{tr('시작 화면으로', 'Back to start')}</a>
      </div>
    </aside>
    <div className="portal-main">
      <header className="portal-topbar">
        <div className="breadcrumb">{area}<Icon name="chevron" size={14} /><strong>{label}</strong></div>
        <LangToggle />
        <AccountAction />
        {canSwitch && <a className="button portal-switch" href={role === 'operator' ? '#/user/overview' : '#/operator/overview'}>{role === 'operator' ? tr('가족 화면', 'Family view') : tr('운영 화면', 'Operator view')}<Icon name="arrow" size={16} /></a>}
      </header>
      <main id="main" tabIndex={-1} className="portal-content">
        <div className="page-heading"><h1>{label}</h1>{actions}</div>
        {children}
      </main>
      <footer className="portal-footer"><span>{tr('BubbleLock, 프라이버시 버블 키링', 'BubbleLock, the Privacy Bubble Keyring')}</span><span>{tr('모든 기록에는 받은 시각과 출처가 함께 표시돼요.', 'Every record shows when it arrived and where it came from.')}</span></footer>
    </div>
    {role === 'user' && <nav className="tab-bar" aria-label={tr(`${area} 탭`, `${area} tabs`)}>{nav.map((item) =>
      <a className={page === item[0] ? 'active' : ''} aria-current={page === item[0] ? 'page' : undefined} href={`#/${role}/${item[0]}`} key={item[0]}><Icon name={item[3]} size={22} /><span>{lang === 'en' ? item[5] : item[2]}</span></a>)}</nav>}
  </div>;
}

export function Landing() {
  const auth = useAuth();
  const { tr } = useLang();
  const mode = auth.session?.mode;
  return <div className="welcome-page">
    <header className="welcome-header"><Brand tagline={false} /><div className="cluster">
      <span className={`environment-tag${mode === 'live' ? '' : ' demo'}`}><i />{mode === 'live' ? tr('계정에 연결됨', 'Signed in') : mode === 'demo' ? tr('체험 모드', 'Demo mode') : tr('연결 확인 중', 'Checking connection')}</span><LangToggle /><AccountAction />
    </div></header>
    <main>
      <section className="welcome-band welcome-hero" aria-labelledby="welcome-title">
        {/* The keyring illustration sits behind the top band as a background layer. */}
        <div className="welcome-visual" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" />
          <div className="floating-mark mark-shield"><Icon name="shield" size={30} /></div>
          <img className="keyring-photo" src={keyringImage} alt="" width={271} height={359} />
          <div className="floating-mark mark-pin"><Icon name="pin" size={28} /></div><div className="floating-mark mark-key"><Icon name="key" size={26} /></div>
        </div>
        <div className="welcome-hero-inner">
        <div className="welcome-copy">
          <p className="eyebrow">{tr('일상에 안심을', 'Peace of mind, every day')}</p>
          <h1 id="welcome-title">{tr('안전은 버블 안에,', 'Safe in a bubble,')}<br />{tr('위치는 락 아래에.', 'private under lock.')}</h1>
          <p className="welcome-description">{tr('키링이 어디 있는지 확인하고 누구와 얼마 동안 공유할지 직접 정하세요.', 'See where the keyring is, and decide who sees it and for how long.')}</p>
        </div>
        <div className="welcome-channels">
        <p className="eyebrow">{tr('화면 선택', 'Choose a view')}</p>
        <h2 id="channels-title">{tr('어떤 화면으로 시작할까요?', 'Where would you like to start?')}</h2>
        <div className="entrance-grid">
          <a className="entrance-card user-entrance" href="#/user/overview"><span className="entrance-icon"><Icon name="users" size={26} /></span>
            <div><p className="eyebrow">{tr('가족과 나', 'You and your family')}</p><h3>{tr('가족 화면', 'Family view')}</h3><p>{tr('키링 위치, 가족, 공유 권한, 알림을 한곳에서 확인해요.', 'Keyring location, family, sharing and alerts in one place.')}</p></div>
            <span className="entrance-link">{tr('가족 화면 열기', 'Open the family view')}<Icon name="arrow" /></span></a>
          <a className="entrance-card operator-entrance" href="#/operator/overview"><span className="entrance-icon"><Icon name="grid" size={26} /></span>
            <div><p className="eyebrow">{tr('운영자', 'Operators')}</p><h3>{tr('운영 화면', 'Operator view')}</h3><p>{tr('장치 상태, 명령 처리, 연결 서비스, 활동 기록을 한 화면에서 살펴봐요.', 'Devices, commands, connected services and the activity log on one screen.')}</p></div>
            <span className="entrance-link">{tr('운영 화면 열기', 'Open the operator view')}<Icon name="arrow" /></span></a>
        </div>
        </div>
        </div>
      </section>
      <section className="welcome-band welcome-promises" aria-labelledby="promise-title"><div>
        <h2 id="promise-title">{tr('안심하고 쓰도록 이렇게 만들었어요', 'Built so you can trust it')}</h2>
        <ul className="promise-grid">
          <li><a href="#/user/map"><span><Icon name="pin" /></span><h3>{tr('필요할 때만 보여요', 'Shown only when needed')}</h3><p>{tr('위치 공유에는 시간을 정해요. 정한 시간이 지나면 공유가 끝나요.', 'Every location share has a time limit and ends when it runs out.')}</p></a></li>
          <li><a href="#/user/privacy"><span><Icon name="shield" /></span><h3>{tr('보호자가 정해요', 'Guardians decide')}</h3><p>{tr('공유할 항목과 기간은 보호자가 정하고 언제든 취소할 수 있어요.', 'Guardians choose what is shared and for how long, and can revoke it at any time.')}</p></a></li>
          <li><a href="#/operator/audit"><span><Icon name="file" /></span><h3>{tr('모두 기록돼요', 'Everything is recorded')}</h3><p>{tr('모든 요청과 승인은 받은 시각과 함께 기록으로 남아요.', 'Every request and approval is logged with the time it arrived.')}</p></a></li>
        </ul>
      </div></section>
    </main>
    <footer className="welcome-footer"><span>{tr('BubbleLock, 프라이버시 버블 키링', 'BubbleLock, the Privacy Bubble Keyring')}</span><span>{tr('체험 데이터와 실제 데이터는 화면에 따로 표시돼요.', 'Demo data and real data are labelled separately.')}</span></footer>
  </div>;
}

/** A metric card; with `href` it is a link, with `onClick` a button, so every card leads somewhere. */
export function Metric({ label, value, note, icon, compact = false, href, onClick }: { label: string; value: ReactNode; note: ReactNode; icon: IconName; compact?: boolean; href?: string; onClick?: () => void }) {
  const body = <><span className="metric-icon"><Icon name={icon} /></span><p>{label}</p>
    <strong className={compact ? 'metric-text' : undefined}>{value}</strong><small>{note}</small></>;
  if (href) return <a className="metric-card metric-link" href={href}>{body}</a>;
  if (onClick) return <button type="button" className="metric-card metric-link" onClick={onClick}>{body}</button>;
  return <article className="metric-card">{body}</article>;
}
