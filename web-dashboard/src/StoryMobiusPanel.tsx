import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';
import { useLang } from './i18n.tsx';
import { StoryMobiusTree } from './StoryMobiusTree.tsx';
import { VirtualKeyring } from './VirtualKeyring.tsx';
import type { StoryScene } from './StoryDemo.tsx';
import type { StoryActionPhase, StoryServerAction, StorySessionSnapshot } from './story-session.ts';

type Copy = readonly [string, string];

interface FlowCopy {
  readonly title: Copy;
  readonly summary: Copy;
  readonly guard: Copy;
  readonly steps: readonly [Copy, Copy, Copy];
}

const flows: Record<StoryScene, FlowCopy> = {
  login: {
    title: ['이 브라우저만 쓰는 세션', 'A session for this browser only'],
    summary: ['웹서버가 이 브라우저 전용 Mobius 자원을 짧은 시간 동안 만들어요.', 'The web server creates a short-lived Mobius resource used only by this browser.'],
    guard: ['HttpOnly 쿠키, 20분 뒤 만료, 자격 증명은 서버에만 있어요.', 'HttpOnly cookie, expires after 20 minutes, credentials stay on the server.'],
    steps: [['자동 로그인', 'Auto sign-in'], ['세션 자원 만들기', 'Create session resource'], ['기록 다시 읽기', 'Read the record back']],
  },
  'activity-away': {
    title: ['외출 여부만 공개', 'Away status only'],
    summary: ['좌표 대신 외출 상태 하나만 이 세션의 자원에 기록해요.', 'Only the away status is written to this session, never coordinates.'],
    guard: ['꼭 필요한 정보만 공개하고, 브라우저마다 자원을 나눠요.', 'Minimum disclosure, with resources separated per browser.'],
    steps: [['외출 상태 요청', 'Request away status'], ['상태 기록 만들기', 'Create status record'], ['상태만 다시 읽기', 'Read back status only']],
  },
  'activity-home': {
    title: ['귀가 상태 확인', 'Home status verified'],
    summary: ['같은 세션에 귀가 기록(contentInstance)을 만들고 다시 읽어요.', 'The same session creates a home record (contentInstance) and reads it back.'],
    guard: ['필요한 상태만 보관하고 세션이 끝나면 정리해요.', 'Only the needed status is kept, and it is cleared with the session.'],
    steps: [['귀가 상태 요청', 'Request home status'], ['귀가 기록 만들기', 'Create home record'], ['기록 다시 읽기', 'Read the record back']],
  },
  'care-request': {
    title: ['공간과 시간을 정한 승인', 'Approval bound to a room and a time'],
    summary: ['거실 기기 세 대와 서버 마감 시각을 하나의 승인으로 묶어요.', 'One approval binds three living-room devices to a server deadline.'],
    guard: ['최소 권한, 서버 기준 만료, 같은 요청은 한 번만 처리해요.', 'Least privilege, server-side expiry, and each request is handled once.'],
    steps: [['보호자 승인', 'Guardian approval'], ['승인 기록 만들기', 'Create approval record'], ['범위와 시간 확인', 'Check scope and time']],
  },
  'caregiver-shared': {
    title: ['세 기기를 한 번에 제어', 'Three devices in one command'],
    summary: ['그룹 명령(fopt) 한 번을 조명, TV, 선풍기에 나눠 보내고 세 결과를 다시 읽어요.', 'One group command (fopt) reaches the light, TV and fan, then all three are read back.'],
    guard: ['승인된 그룹만 실행하고 기기마다 결과를 확인해요.', 'Only the approved group runs, and each device is read back.'],
    steps: [['모두 켜기', 'Turn all on'], ['그룹 명령 보내기', 'Send group command'], ['세 기기 확인', 'Check all three']],
  },
  'caregiver-ended': {
    title: ['서버가 마감 시각을 지켜요', 'The server enforces the deadline'],
    summary: ['마감 시각이 되면 서버가 그룹을 끄고 임시 권한을 지운 뒤 만료를 기록해요.', 'At the deadline the server turns the group off, removes the temporary access and records the expiry.'],
    guard: ['브라우저 시계와 상관없이 권한을 자동으로 거둬요.', 'Access is revoked automatically, independent of the browser clock.'],
    steps: [['마감 시각 도달', 'Deadline reached'], ['그룹 끄기', 'Turn the group off'], ['만료 기록 확인', 'Check expiry record']],
  },
  'check-in': {
    title: ['이유 먼저, 위치는 승인 뒤', 'Reason first, location after approval'],
    summary: ['평소와 다른 이유를 먼저 기록하고, 보호자가 승인하면 5분짜리 위치 공유를 열어요.', 'The reason is recorded first. A five-minute location share opens only after the guardian approves.'],
    guard: ['목적을 제한하고, 명시적으로 승인하고, 5분 뒤 자동으로 닫아요.', 'Purpose-limited, explicitly approved, and closed after five minutes.'],
    steps: [['안부 확인 요청', 'Request check-in'], ['공유 승인', 'Approve share'], ['종료 시각 확인', 'Check end time']],
  },
};

const stepSources: readonly [Copy, Copy, Copy] = [['브라우저', 'Browser'], ['Mobius', 'Mobius'], ['다시 읽기', 'Read back']];

const eventLabels: Readonly<Record<string, Copy>> = {
  SESSION_STARTED: ['브라우저 세션 시작', 'Browser session started'],
  PRESENCE_CHANGED: ['외출, 귀가 상태 기록', 'Presence status recorded'],
  CARE_GRANT_APPROVED: ['돌봄 권한 승인', 'Care access approved'],
  ROOM_GROUP_ON: ['거실 기기 3대 켜짐', 'Three room devices on'],
  ROOM_GROUP_OFF: ['거실 기기 3대 꺼짐', 'Three room devices off'],
  GRANT_EXPIRED: ['돌봄 권한 자동 종료', 'Care access ended'],
  ROUTINE_ALERT: ['안부 확인 알림', 'Check-in alert'],
  CHECK_IN_CALL_STARTED: ['안부 전화 요청', 'Check-in call requested'],
  SHARE_DRAFT: ['위치 공유 초안', 'Location-share draft'],
  GUARDIAN_DECISION: ['보호자 위치 공유 승인', 'Location share approved'],
  LOCATION_LEASE: ['5분 위치 공유 열림', 'Five-minute location share opened'],
  LOCATION_LEASE_EXPIRED: ['위치 공유 자동 종료', 'Location share ended'],
  KEYRING_BUTTON_OBSERVATION: ['키링 버튼 입력', 'Keyring button input'],
  RESIDENT_CONFIRMED: ['키링으로 안전 확인', 'Safe check from the keyring'],
  PANIC_ALERT: ['키링 비상 알림', 'Keyring emergency alert'],
};

function readableType(type: string): string {
  const words = type.toLowerCase().split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatTime(value: string, locale: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : value;
}

type PanelId = 'keyring' | 'flow' | 'tree' | 'events' | 'scenes';

const mobileScenes: readonly StoryScene[] = ['login', 'activity-away', 'activity-home', 'care-request', 'caregiver-shared', 'caregiver-ended', 'check-in'];

function relatedPanels(type: string): ReadonlySet<PanelId> {
  const panels = new Set<PanelId>(['tree', 'events']);
  if (['KEYRING_BUTTON_OBSERVATION', 'RESIDENT_CONFIRMED', 'PANIC_ALERT'].includes(type)) panels.add('keyring');
  else panels.add('flow');
  return panels;
}

export function StoryMobiusPanel({ scene, snapshot, phase, message, runAction, refresh, onKeyringVerified }: {
  readonly scene: StoryScene;
  readonly snapshot: StorySessionSnapshot | null;
  readonly phase: StoryActionPhase;
  readonly message: string | null;
  readonly runAction: (action: StoryServerAction, idempotencyKey: string) => Promise<StorySessionSnapshot>;
  readonly refresh?: () => Promise<StorySessionSnapshot | null>;
  readonly onKeyringVerified?: (action: 'keyring-confirm' | 'keyring-panic') => void;
}) {
  const { lang, tr } = useLang();
  const flow = flows[scene];
  const pick = (copy: Copy) => copy[lang === 'en' ? 1 : 0];
  const actual = snapshot?.mobius.actual === true;
  const completed = phase === 'verified' ? 3 : phase === 'sending' ? 2 : snapshot ? 1 : 0;
  const events = snapshot?.mobius.events.slice(0, 4) ?? [];
  const locale = lang === 'en' ? 'en-US' : 'ko-KR';
  const verifiedCount = snapshot?.mobius.createRetrieveVerified ?? 0;
  const [mobilePanel, setMobilePanel] = useState<PanelId | null>(null);
  const [flashes, setFlashes] = useState<ReadonlySet<PanelId>>(new Set());
  const seenSequence = useRef<number | null>(null);
  const latestSequence = events[0]?.sequence ?? 0;
  const latestType = events[0]?.type ?? '';
  const guidedAction = scene === 'check-in' ? 'keyring-panic'
    : scene === 'activity-away' || scene === 'activity-home' ? 'keyring-confirm' : null;
  const sceneLabels: Record<StoryScene, string> = {
    login: tr('자동 로그인', 'Sign in'),
    'activity-away': tr('외출 알림', 'Went out'),
    'activity-home': tr('귀가 알림', 'Came home'),
    'care-request': tr('돌봄 승인', 'Care approval'),
    'caregiver-shared': tr('거실 제어', 'Room control'),
    'caregiver-ended': tr('자동 종료', 'Automatic end'),
    'check-in': tr('키링과 안부 확인', 'Keyring and check-in'),
  };
  const panelLabels: Record<PanelId, string> = {
    keyring: tr('키링', 'Keyring'), flow: tr('흐름', 'Flow'), tree: 'Mobius', events: tr('기록', 'Records'), scenes: tr('장면', 'Scenes'),
  };

  useEffect(() => {
    if (latestSequence === 0) return;
    if (seenSequence.current === null) {
      seenSequence.current = latestSequence;
      return;
    }
    if (latestSequence <= seenSequence.current) return;
    const next = relatedPanels(latestType);
    seenSequence.current = latestSequence;
    setFlashes(next);
    setMobilePanel((current) => current ?? (next.has('keyring') ? 'keyring' : 'tree'));
    const timer = window.setTimeout(() => setFlashes(new Set()), 3600);
    return () => window.clearTimeout(timer);
  }, [latestSequence, latestType]);

  const choosePanel = (panel: PanelId) => {
    setMobilePanel((current) => current === panel ? null : panel);
    setFlashes((current) => {
      const next = new Set(current);
      next.delete(panel);
      return next;
    });
  };
  const panelClass = (panel: PanelId, extra: string) => `story-panel-card story-mobile-panel ${extra}${mobilePanel === panel ? ' is-mobile-open' : ''}${flashes.has(panel) ? ' has-new-event' : ''}`;

  return <aside className="story-mobius" aria-labelledby="story-mobius-title">
    <header className="story-mobius-head">
      <div>
        <h2 id="story-mobius-title">{tr('웹서버와 Mobius', 'Web server and Mobius')}</h2>
        <p className="story-mobius-meta">{snapshot
          ? <>{tr('세션', 'Session')} <code>{snapshot.browserSession.id}</code>, {tr(`남은 동작 ${snapshot.budget.actionsLeft}/${snapshot.budget.limit}`, `${snapshot.budget.actionsLeft} of ${snapshot.budget.limit} actions left`)}</>
          : tr('이 브라우저의 세션을 만드는 중이에요', 'Creating a session for this browser')}</p>
      </div>
      <span className={`badge ${actual ? 'success' : 'warning'}`}>{actual ? tr('실제 Mobius', 'Live Mobius') : tr('로컬 검증', 'Local check')}</span>
    </header>

    {message ? <p className="story-server-message" role="status">{message}</p> : null}

    <nav className="story-panel-tabs" aria-label={tr('시연 패널', 'Demo panels')}>
      {(Object.keys(panelLabels) as PanelId[]).map((panel) => <button
        key={panel}
        type="button"
        className={`${mobilePanel === panel ? 'active' : ''}${flashes.has(panel) ? ' has-new-event' : ''}`}
        aria-expanded={mobilePanel === panel}
        aria-controls={`story-panel-${panel}`}
        onClick={() => choosePanel(panel)}
      >{panelLabels[panel]}<span className="story-panel-alert" aria-hidden="true" /></button>)}
    </nav>

    <section id="story-panel-keyring" className={panelClass('keyring', 'virtual-keyring-card')} aria-labelledby="virtual-keyring-title">
      <VirtualKeyring snapshot={snapshot} runAction={runAction} guidedAction={guidedAction} {...(onKeyringVerified ? { onVerified: onKeyringVerified } : {})} />
    </section>

    <section id="story-panel-flow" className={panelClass('flow', 'story-flow')} aria-labelledby="story-flow-title">
      <div className="story-flow-copy">
        <h3 id="story-flow-title">{pick(flow.title)}</h3>
        <p>{pick(flow.summary)}</p>
      </div>
      <ol className="story-server-flow" aria-label={tr('처리 단계', 'Processing steps')}>
        {flow.steps.map((step, index) => {
          const state = index < completed ? 'complete' : phase === 'sending' && index === completed ? 'active' : '';
          return <li className={state} key={step[0]}>
            <span className="story-step-marker" aria-hidden="true">{index < completed ? <Icon name="check" size={14} /> : index + 1}</span>
            <strong>{pick(step)}</strong>
            <small>{pick(stepSources[index]!)}</small>
            {state ? <span className="story-sr">{state === 'complete' ? tr('완료', 'Done') : tr('진행 중', 'In progress')}</span> : null}
          </li>;
        })}
      </ol>
      <p className="story-flow-guard"><Icon name="shield" size={18} />{pick(flow.guard)}</p>
    </section>

    <section id="story-panel-tree" className={panelClass('tree', 'story-mobius-tree-card')} aria-labelledby="story-tree-title">
      <div className="story-events-head">
        <h3 id="story-tree-title">{tr('실제 Mobius 트리', 'Live Mobius tree')}</h3>
        <span>{actual ? tr('CSE readback', 'CSE readback') : tr('동일 계약 재생', 'Contract replay')}</span>
      </div>
      <StoryMobiusTree snapshot={snapshot} {...(refresh ? { onRefresh: refresh } : {})} />
    </section>

    <section id="story-panel-events" className={panelClass('events', 'story-mobius-events')} aria-labelledby="story-events-title">
      <div className="story-events-head">
        <h3 id="story-events-title">{tr('확인한 기록', 'Verified records')}</h3>
        <span>{tr(`${verifiedCount}건`, `${verifiedCount} total`)}</span>
      </div>
      <div aria-live="polite">
        {events.length > 0 ? <ul>{events.map((event, index) => <li className={index === 0 && flashes.has('events') ? 'is-new-event' : ''} key={`${event.sequence}-${event.type}`} data-event-type={event.type}>
          <span className="story-event-check" aria-hidden="true"><Icon name="check" size={14} /></span>
          <div>
            <strong>{eventLabels[event.type]?.[lang === 'en' ? 1 : 0] ?? readableType(event.type)}</strong>
            <small>{formatTime(event.at, locale)}, {tr('응답 코드(RSC)', 'response (RSC)')} {event.createRsc}/{event.retrieveRsc}</small>
            <code>{event.resource}</code>
          </div>
        </li>)}</ul> : <p className="story-server-wait">{tr('웹서버가 이 브라우저의 첫 기록을 준비하고 있어요.', 'The web server is preparing the first record for this browser.')}</p>}
      </div>
      <p className="story-mobius-root"><span>{snapshot?.mobius.cse ?? 'Mobius4'}</span><code>{snapshot?.mobius.root ?? '/Mobius/story-demo/session'}</code></p>
    </section>

    <section id="story-panel-scenes" className={panelClass('scenes', 'story-scene-panel')} aria-labelledby="story-scenes-title">
      <h3 id="story-scenes-title">{tr('이야기 장면', 'Story scenes')}</h3>
      <nav aria-label={tr('이야기 장면', 'Story scenes')}><ol>{mobileScenes.map((item, index) => <li key={item}>
        <a className={item === scene ? 'active' : ''} aria-current={item === scene ? 'page' : undefined} href={`#/story/${item}`}>
          <span>{index + 1}</span>{sceneLabels[item]}
        </a>
      </li>)}</ol></nav>
      <a className="story-mobile-dashboard-link" href="#/user/overview">{tr('가족 대시보드', 'Family dashboard')}<Icon name="arrow" size={17} /></a>
    </section>
  </aside>;
}
