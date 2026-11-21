import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { LangToggle, useLang } from './i18n.tsx';
import { StoryMobiusPanel } from './StoryMobiusPanel.tsx';
import { VirtualKeyring } from './VirtualKeyring.tsx';
import { useStorySession } from './story-session.ts';
import type { StorySessionSnapshot } from './story-session.ts';

export const storyScenes = ['login', 'activity-away', 'activity-home', 'care-request', 'caregiver-shared', 'caregiver-ended', 'check-in'] as const;
export type StoryScene = (typeof storyScenes)[number];

export function resolveStoryScene(value: string | undefined): StoryScene {
  return storyScenes.includes(value as StoryScene) ? value as StoryScene : 'login';
}

type PendingAction = 'approve' | 'all-on' | 'expire' | 'call' | 'share' | null;
type DemoStage = 'intro' | 'sending' | 'system';
type PortraitChoice = 'ask' | 'continue';
type KeyringAction = 'keyring-confirm' | 'keyring-panic';

function careCycle(snapshot: StorySessionSnapshot | null): number {
  return snapshot?.mobius.events.filter((event) => event.type === 'CARE_GRANT_APPROVED').length ?? 0;
}

const sceneTime: Record<StoryScene, string> = {
  login: '4:28',
  'activity-away': '4:31',
  'activity-home': '5:36',
  'care-request': '2:04',
  'caregiver-shared': '2:05',
  'caregiver-ended': '4:00',
  'check-in': '5:13',
};

function StoryStatus({ time }: { readonly time: string }) {
  return <div className="story-status" aria-hidden="true"><strong>{time}</strong><span className="story-battery"><i /></span></div>;
}

function StoryHeader({ time }: { readonly time: string }) {
  return <><StoryStatus time={time} /><header className="story-header"><span className="story-app-name">Privacy Bubble</span></header></>;
}

function PrivacyNote({ children }: { readonly children: ReactNode }) {
  return <p className="story-privacy-note"><Icon name="shield" size={18} />{children}</p>;
}

function LoginScreen({ step, snapshot, onStart }: {
  readonly step: number;
  readonly snapshot: StorySessionSnapshot | null;
  readonly onStart: () => void;
}) {
  const { tr } = useLang();
  const account = snapshot?.browserSession.account ?? 'guardian.demo@privacybubble.local';
  const ready = step >= 3 && snapshot !== null;
  return <section className="story-content story-login" aria-labelledby="story-title">
    <span className="story-login-mark" aria-hidden="true"><Icon name="shield" size={24} /></span>
    <div className="story-title-block">
      <h1 id="story-title">{tr('가족의 하루를 안전하게', 'A safer day for your family')}</h1>
      <p className="story-subtitle">{tr('이 브라우저만 쓰는 시연 계정으로 자동 로그인해요.', 'You are signed in to a demo account for this browser only.')}</p>
    </div>
    <div className={`story-auto-form step-${step}`} role="group" aria-label={tr('자동 로그인', 'Automatic sign-in')}>
      <label>{tr('계정', 'Account')}<input type="text" readOnly value={step >= 1 ? account : ''} autoComplete="off" spellCheck={false} /></label>
      <label>{tr('일회용 암호', 'One-time passcode')}<input type="text" readOnly value={step >= 2 ? '•'.repeat(10) : ''} autoComplete="off" aria-describedby="story-passcode-note" /></label>
      <button type="button" className="story-primary" disabled={!ready} onClick={onStart}>
        {step < 2 ? tr('자동으로 입력하는 중', 'Filling in') : !ready ? tr('로그인 확인 중', 'Checking sign-in') : tr('시작하기', 'Start')}
      </button>
    </div>
    <PrivacyNote><span id="story-passcode-note">{tr('암호와 서버 자격 증명은 서버에만 있어요.', 'Passcodes and server credentials stay on the server.')}</span></PrivacyNote>
  </section>;
}

function ActivityScreen({ home }: { readonly home: boolean }) {
  const { tr } = useLang();
  return <section className="story-content story-activity" aria-labelledby="story-title">
    <div className="story-title-block">
      <h1 id="story-title">{tr('오늘', 'Today')}</h1>
      <p className="story-subtitle">{tr('활동', 'Activity')}</p>
    </div>
    <ol className="story-event-list">
      <li className="story-event"><span className="story-dot" aria-hidden="true" /><div><time>{tr('오후 4:31', '4:31 PM')}</time><strong>{tr('어머니가 외출했어요', 'Mom went out')}</strong></div></li>
      {home && <li className="story-event home"><span className="story-dot" aria-hidden="true" /><div><time>{tr('오후 5:36', '5:36 PM')}</time><strong>{tr('어머니가 집에 있어요', 'Mom is home')}</strong></div></li>}
    </ol>
    <PrivacyNote>{tr('평소에는 외출과 귀가만 보여요.', 'Day to day, you see only leaving and coming home.')}</PrivacyNote>
  </section>;
}

function CareRequestScreen({ pending, approved, onApprove }: {
  readonly pending: boolean;
  readonly approved: boolean;
  readonly onApprove: () => void;
}) {
  const { tr } = useLang();
  return <section className="story-content story-care-request" aria-labelledby="story-title">
    <h1 id="story-title">{tr('돌봄 방문', 'Care visit')}</h1>
    <p className="story-message">{tr('미나가 잠깐 거실 기기만 쓰도록 허용해 주세요.', 'Let Mina use only the living-room devices for a short visit.')}</p>
    <article className="story-access-card">
      <p className="story-eyebrow">{tr('접근 요청', 'Access request')}</p>
      <h2>{tr('미나의 거실 접근', 'Living room access for Mina')}</h2>
      <p>{tr('조명, TV, 선풍기', 'Lights, TV, Fan')}</p>
      <strong className="story-deadline">{tr('30초 뒤 자동 종료', 'Ends automatically in 30 seconds')}</strong>
      <small>{tr('집 안의 다른 기기는 포함하지 않아요', 'Nothing else in the home')}</small>
    </article>
    <button type="button" className={`story-primary${approved ? ' done' : ''}`} disabled={pending || approved} onClick={onApprove}>
      {pending ? tr('승인을 기록하는 중', 'Recording approval') : approved ? tr('승인했어요', 'Approved') : tr('30초 동안 승인', 'Approve for 30 seconds')}
    </button>
    <PrivacyNote>{tr('기기 범위와 종료 시각을 함께 승인해요.', 'The devices and the end time are approved together.')}</PrivacyNote>
  </section>;
}

function CaregiverSharedScreen({ pending, status, onAllOn, onExpire }: {
  readonly pending: boolean;
  readonly status: StorySessionSnapshot['care']['status'];
  readonly onAllOn: () => void;
  readonly onExpire: () => void;
}) {
  const { tr } = useLang();
  const applied = status === 'active';
  const ended = status === 'expired';
  return <section className="story-content story-care-shared" aria-labelledby="story-title">
    <h1 id="story-title">{tr('나에게 공유됨', 'Shared with you')}</h1>
    <article className="story-access-card story-shared-card">
      <h2>{tr('거실', 'Living room')}</h2>
      <p>{tr('조명, TV, 선풍기', 'Lights, TV, Fan')}</p>
      <strong className="story-deadline">{ended ? tr('접근이 끝났어요', 'Access has ended') : tr('30초 뒤 자동 종료', 'Ends automatically in 30 seconds')}</strong>
    </article>
    <button type="button" className={`story-primary${applied ? ' done' : ''}`} disabled={pending || ended || applied} onClick={onAllOn}>
      {pending ? tr('켜는 중', 'Turning on') : applied ? tr('모두 켜짐, 3/3 확인', 'All on, 3/3 verified') : tr('모두 켜기', 'All on')}
    </button>
    {applied && <button type="button" className="story-text-action" disabled={pending} onClick={onExpire}>{tr('종료 시각으로 건너뛰기', 'Skip to the end time')}<Icon name="arrow" size={16} /></button>}
    <PrivacyNote>{tr('공유받은 거실 기기만 제어할 수 있어요.', 'You can control only the shared living-room devices.')}</PrivacyNote>
  </section>;
}

function CaregiverEndedScreen({ pending, expired }: { readonly pending: boolean; readonly expired: boolean }) {
  const { tr } = useLang();
  return <section className="story-content story-care-ended" aria-labelledby="story-title">
    <h1 id="story-title">{tr('돌봄 방문', 'Care visit')}</h1>
    <article className="story-access-card story-ended-card">
      <p className="story-card-caption">{tr('거실', 'Living room')}</p>
      <h2>{expired ? tr('접근이 자동으로 끝났어요', 'Access ended automatically') : tr('곧 접근이 끝나요', 'Access is ending')}</h2>
      <p className="story-card-body" role="status">{expired && !pending
        ? tr('거실 기기를 끄고 미나의 권한을 지웠어요.', 'The living-room devices are off and Mina\'s access is removed.')
        : tr('거실 기기를 끄고 있어요.', 'Turning off the living-room devices.')}</p>
    </article>
    <PrivacyNote>{tr('다음 방문에는 새로 승인해야 해요.', 'The next visit needs a new approval.')}</PrivacyNote>
  </section>;
}

function useSecondClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function CheckInScreen({ pending, snapshot, callReady, onCall, onShare }: {
  readonly pending: PendingAction;
  readonly snapshot: StorySessionSnapshot | null;
  readonly callReady: boolean;
  readonly onCall: () => void;
  readonly onShare: () => void;
}) {
  const { tr } = useLang();
  const sharedUntil = snapshot?.location.sharedUntil ? Date.parse(snapshot.location.sharedUntil) : 0;
  const now = useSecondClock(sharedUntil > Date.now());
  const remaining = Math.max(0, Math.ceil((sharedUntil - now) / 1000));
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  const drafted = snapshot?.location.status === 'drafted';
  const panicCount = snapshot?.keyring.panicPresses ?? 0;
  return <section className="story-content story-check-in" aria-labelledby="story-title">
    <h1 id="story-title">{tr('어머니 확인', 'Check on Mom')}</h1>
    <article className="story-check-card">
      <p className="story-eyebrow">{panicCount > 0 ? tr('키링 비상 버튼', 'Keyring emergency button') : tr('평소와 다른 멈춤', 'Unusual stop')}</p>
      <p className="story-card-body">{panicCount > 0
        ? tr('어머니가 키링의 비상 버튼을 눌렀어요. 먼저 안부를 확인해 주세요.', 'Mom pressed the emergency button on her keyring. Check on her first.')
        : tr('어머니가 평소 산책길의 갈림길에서 4분째 멈춰 있어요. 평소에는 이곳에서 멈추지 않아요.', 'Mom has stopped at the fork on her usual walk for 4 minutes. She does not usually stop here.')}</p>
      <small>{tr('시험 실행 기준', 'Based on a test run')}</small>
    </article>
    <div className="story-actions">
      <button type="button" className={`story-primary${callReady ? ' done' : ''}`} disabled={pending === 'call' || callReady} onClick={onCall}>
        {pending === 'call' ? tr('전화를 요청하는 중', 'Requesting the call') : callReady ? tr('안부 전화를 요청했어요', 'Call requested') : tr('안부 전화', 'Call')}
      </button>
      <button type="button" className={`story-secondary${remaining > 0 ? ' done' : ''}`} disabled={pending === 'share' || remaining > 0} onClick={onShare}>
        {pending === 'share' ? tr('공유 내용을 확인하는 중', 'Checking the share')
          : remaining > 0 ? tr(`위치 보는 중 ${countdown}`, `Viewing location ${countdown}`)
            : drafted ? tr('확인하고 5분 공유', 'Review and share for 5 min')
              : tr('위치 공유 준비', 'Prepare location share')}
      </button>
    </div>
    {drafted && snapshot?.location.draftHash ? <div className="story-draft-proof">
      <span>{tr('공유할 내용', 'What will be shared')}</span>
      <strong>{tr('현재 위치, 나에게만, 5분 동안', 'Current location, to you only, for 5 minutes')}</strong>
      <code title={snapshot.location.draftHash}>{tr('초안', 'Draft')} {snapshot.location.draftHash.slice(0, 16)}</code>
    </div> : null}
    {callReady && <p className="story-result" role="status"><Icon name="check" size={18} />{tr('전화번호를 드러내지 않고 통화를 요청했어요.', 'The call was requested without sharing a phone number.')}</p>}
    {remaining > 0 && <p className="story-result" role="status"><Icon name="pin" size={18} />{tr('확인한 내용 그대로 5분 동안 위치를 볼 수 있어요.', 'You can see the location for 5 minutes, exactly as reviewed.')}</p>}
    <PrivacyNote>{tr('목적, 받는 사람, 시간이 맞을 때만 위치가 열려요.', 'Location opens only for the approved purpose, recipient and time.')}</PrivacyNote>
  </section>;
}

function StoryGuide({ scene }: { readonly scene: StoryScene }) {
  const { tr } = useLang();
  const labels: Record<StoryScene, string> = {
    login: tr('자동 로그인', 'Sign in'),
    'activity-away': tr('외출 알림', 'Went out'),
    'activity-home': tr('귀가 알림', 'Came home'),
    'care-request': tr('돌봄 승인', 'Care approval'),
    'caregiver-shared': tr('거실 제어', 'Room control'),
    'caregiver-ended': tr('자동 종료', 'Automatic end'),
    'check-in': tr('키링과 안부 확인', 'Keyring and check-in'),
  };
  return <aside className="story-guide" aria-labelledby="story-guide-title">
    <div className="story-guide-inner">
      <div className="story-guide-intro">
        <h2 id="story-guide-title">{tr('필요할 때만 열리고, 끝나면 닫혀요.', 'Open only when needed, closed when done.')}</h2>
        <p>{tr('앱, 키링, 웹서버, Mobius가 한 흐름으로 움직여요.', 'The app, keyring, web server and Mobius move as one flow.')}</p>
      </div>
      <nav aria-label={tr('이야기 장면', 'Story scenes')}>
        <ol>{storyScenes.map((item, index) => <li key={item}>
          <a className={item === scene ? 'active' : ''} aria-current={item === scene ? 'page' : undefined} href={`#/story/${item}`}>
            <span className="story-step-number" aria-hidden="true">{index + 1}</span>{labels[item]}
          </a>
        </li>)}</ol>
      </nav>
      <a className="story-dashboard-link" href="#/user/overview">{tr('가족 대시보드 열기', 'Open the family dashboard')}<Icon name="arrow" size={18} /></a>
    </div>
  </aside>;
}

function StoryFooter({ scene }: { readonly scene: StoryScene }) {
  const { tr } = useLang();
  const index = storyScenes.indexOf(scene);
  const previous = storyScenes[(index + storyScenes.length - 1) % storyScenes.length]!;
  const next = storyScenes[(index + 1) % storyScenes.length]!;
  return <nav className="story-footer" aria-label={tr('장면 이동', 'Scene navigation')}>
    <a className="button" href={`#/story/${previous}`}>{tr('이전', 'Previous')}</a>
    <span>{tr(`장면 ${index + 1} / ${storyScenes.length}`, `Scene ${index + 1} of ${storyScenes.length}`)}</span>
    <a className="button" href={`#/story/${next}`}>{tr('다음', 'Next')}</a>
  </nav>;
}

function StoryStepper({ scene }: { readonly scene: StoryScene }) {
  const { tr } = useLang();
  const labels: Record<StoryScene, string> = {
    login: tr('시작', 'Start'),
    'activity-away': tr('외출', 'Went out'),
    'activity-home': tr('귀가', 'Came home'),
    'care-request': tr('돌봄 승인', 'Care approval'),
    'caregiver-shared': tr('거실 제어', 'Room control'),
    'caregiver-ended': tr('자동 종료', 'Automatic end'),
    'check-in': tr('안부 확인', 'Check-in'),
  };
  const index = storyScenes.indexOf(scene);
  const previous = storyScenes[(index + storyScenes.length - 1) % storyScenes.length]!;
  const next = storyScenes[(index + 1) % storyScenes.length]!;
  return <nav className="story-stepper story-bottom-nav" aria-label={tr('이야기 장면', 'Story scenes')}>
    <a className="story-stepper-prev" href={`#/story/${previous}`} aria-label={tr('이전 장면', 'Previous scene')}><Icon name="chevron" size={18} style={{ transform: 'rotate(180deg)' }} /></a>
    <span className="story-stepper-compact" aria-live="polite">{index + 1}/{storyScenes.length} {labels[scene]}</span>
    <a className="story-stepper-next" href={`#/story/${next}`} aria-label={tr('다음 장면', 'Next scene')}><Icon name="chevron" size={18} /></a>
  </nav>;
}

export function StoryDemo({ scene }: { readonly scene: StoryScene }) {
  const { tr } = useLang();
  const capture = new URLSearchParams(window.location.search).get('capture') === '1';
  const [loginStep, setLoginStep] = useState(capture ? 3 : scene === 'login' ? 0 : 3);
  const [demoStage, setDemoStage] = useState<DemoStage>(capture || scene !== 'login' ? 'system' : 'intro');
  const [portraitChoice, setPortraitChoice] = useState<PortraitChoice>('ask');
  const [portraitViewport, setPortraitViewport] = useState(() => window.matchMedia('(max-width: 760px) and (orientation: portrait)').matches);
  const [standalone, setStandalone] = useState(false);
  const [fullscreenEligible, setFullscreenEligible] = useState(false);
  const [fullscreenPromptOpen, setFullscreenPromptOpen] = useState(false);
  const [focusAction, setFocusAction] = useState<KeyringAction | null>(null);
  const [focusAfterSequence, setFocusAfterSequence] = useState(0);
  const [freshPath, setFreshPath] = useState<string | null>(null);
  const sessionEnabled = true;
  const { snapshot, phase, message, refresh, runAction } = useStorySession(sessionEnabled);
  const [pending, setPending] = useState<PendingAction>(null);
  const [callReady, setCallReady] = useState(false);
  const automatic = useRef(new Set<string>());
  const transitionStarted = useRef(0);
  const stageTimer = useRef<number | null>(null);
  const focusAfterSequenceRef = useRef(0);
  const freshTimer = useRef<number | null>(null);
  const rotateContinue = useRef<HTMLButtonElement | null>(null);
  const fullscreenContinue = useRef<HTMLButtonElement | null>(null);
  const promptReturnFocus = useRef<HTMLElement | null>(null);
  const guidedAction: KeyringAction | null = scene === 'check-in' ? 'keyring-panic'
    : scene === 'login' || scene === 'activity-away' || scene === 'activity-home' ? 'keyring-confirm' : null;
  const orientationPromptOpen = !capture && portraitViewport && portraitChoice === 'ask';
  const modalOpen = orientationPromptOpen || fullscreenPromptOpen;

  useEffect(() => () => {
    if (freshTimer.current !== null) window.clearTimeout(freshTimer.current);
    if (stageTimer.current !== null) window.clearTimeout(stageTimer.current);
  }, []);

  useEffect(() => {
    if (capture) return;
    const root = document.documentElement;
    const body = document.body;
    const previous = {
      rootOverflow: root.style.overflow,
      rootOverscroll: root.style.overscrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
    };
    root.style.overflow = 'hidden';
    root.style.overscrollBehavior = 'none';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    return () => {
      root.style.overflow = previous.rootOverflow;
      root.style.overscrollBehavior = previous.rootOverscroll;
      body.style.overflow = previous.bodyOverflow;
      body.style.overscrollBehavior = previous.bodyOverscroll;
    };
  }, [capture]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px) and (orientation: portrait)');
    const syncOrientation = () => setPortraitViewport(query.matches);
    syncOrientation();
    query.addEventListener('change', syncOrientation);
    return () => query.removeEventListener('change', syncOrientation);
  }, []);

  useEffect(() => {
    const standaloneQuery = window.matchMedia('(display-mode: standalone)');
    const fullscreenQuery = window.matchMedia('(display-mode: fullscreen)');
    const appleMobile = /iPhone|iPad|iPod/i.test(window.navigator.userAgent)
      || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    const syncDisplayMode = () => {
      const appleStandalone = (window.navigator as Navigator & { readonly standalone?: boolean }).standalone === true;
      const nextStandalone = appleStandalone || standaloneQuery.matches || fullscreenQuery.matches;
      setStandalone(nextStandalone);
      setFullscreenEligible(appleMobile && !nextStandalone);
      if (nextStandalone) setFullscreenPromptOpen(false);
    };
    syncDisplayMode();
    standaloneQuery.addEventListener('change', syncDisplayMode);
    fullscreenQuery.addEventListener('change', syncDisplayMode);
    return () => {
      standaloneQuery.removeEventListener('change', syncDisplayMode);
      fullscreenQuery.removeEventListener('change', syncDisplayMode);
    };
  }, []);

  useEffect(() => {
    if (capture || !fullscreenEligible || portraitViewport || demoStage !== 'intro') return;
    const key = 'bubblelock-story-fullscreen-guide';
    if (window.sessionStorage.getItem(key) === 'shown') return;
    window.sessionStorage.setItem(key, 'shown');
    setFullscreenPromptOpen(true);
  }, [capture, demoStage, fullscreenEligible, portraitViewport]);

  useEffect(() => {
    if (!orientationPromptOpen) return;
    promptReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => rotateContinue.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = promptReturnFocus.current;
      promptReturnFocus.current = null;
      if (previous && previous !== document.body && previous.isConnected) previous.focus();
    };
  }, [orientationPromptOpen]);

  useEffect(() => {
    if (!fullscreenPromptOpen) return;
    const frame = window.requestAnimationFrame(() => fullscreenContinue.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [fullscreenPromptOpen]);

  useEffect(() => {
    if (capture || scene !== 'login' || demoStage !== 'intro') return;
    const hasKeyringPress = snapshot?.mobius.events.some((event) => event.action === 'keyring-confirm' || event.action === 'keyring-panic') === true;
    if (hasKeyringPress) setDemoStage('system');
  }, [capture, demoStage, scene, snapshot]);

  useEffect(() => {
    if (scene !== 'login') { setLoginStep(3); return; }
    if (capture) { setLoginStep(3); return; }
    setLoginStep(0);
    const account = setTimeout(() => setLoginStep(1), 350);
    const password = setTimeout(() => setLoginStep(2), 1250);
    return () => { clearTimeout(account); clearTimeout(password); };
  }, [capture, scene]);

  useEffect(() => {
    if (scene !== 'login' || loginStep < 2 || !snapshot) return;
    if (loginStep === 2) {
      const verified = setTimeout(() => setLoginStep(3), 350);
      return () => clearTimeout(verified);
    }
  }, [capture, loginStep, scene, snapshot]);

  useEffect(() => {
    if (!snapshot || demoStage !== 'system') return;
    const action = scene === 'activity-away' ? 'activity-away' : scene === 'activity-home' ? 'activity-home' : scene === 'check-in' ? 'check-in' : null;
    if (!action) return;
    const key = `${snapshot.browserSession.id}:scene:${action}`;
    if (automatic.current.has(key)) return;
    automatic.current.add(key);
    void runAction(action, `scene:${action}:v1`).catch(() => automatic.current.delete(key));
  }, [demoStage, runAction, scene, snapshot]);

  useEffect(() => {
    if (scene !== 'caregiver-ended' || !snapshot || snapshot.care.status === 'expired' || pending === 'expire') return;
    const key = `${snapshot.browserSession.id}:scene:caregiver-ended`;
    if (automatic.current.has(key)) return;
    automatic.current.add(key);
    setPending('expire');
    void (async () => {
      try {
        let current = snapshot;
        if (current.care.status === 'ready') current = await runAction('care-approve', `care:approve:${careCycle(current) + 1}`);
        if (current.care.status === 'approved') current = await runAction('room-all-on', `care:all-on:${careCycle(current)}`);
        if (current.care.status === 'active' || current.care.status === 'approved') await runAction('care-expire', `care:expire:${careCycle(current)}`);
      } catch {
        automatic.current.delete(key);
      } finally {
        setPending(null);
      }
    })();
  }, [pending, runAction, scene, snapshot]);

  const approveCare = async () => {
    setPending('approve');
    try {
      await runAction('care-approve', `care:approve:${careCycle(snapshot) + 1}`);
      window.location.hash = '#/story/caregiver-shared';
    } finally { setPending(null); }
  };

  const allOn = async () => {
    setPending('all-on');
    try {
      let current = snapshot;
      if (!current || current.care.status === 'ready' || current.care.status === 'expired') current = await runAction('care-approve', `care:approve:${careCycle(current) + 1}`);
      if (current.care.status === 'approved' || current.care.status === 'active') await runAction('room-all-on', `care:all-on:${careCycle(current)}`);
    } finally { setPending(null); }
  };

  const expireNow = async () => {
    setPending('expire');
    try {
      await runAction('care-expire', `care:expire:${careCycle(snapshot)}`);
      window.location.hash = '#/story/caregiver-ended';
    } finally { setPending(null); }
  };

  const callMom = async () => {
    setPending('call');
    try {
      await runAction('call', 'check-in:call:v1');
      setCallReady(true);
    } finally { setPending(null); }
  };

  const shareLocation = async () => {
    setPending('share');
    try {
      if (snapshot?.location.status === 'drafted') await runAction('location-approve', 'location:approve:v1');
      else await runAction('location-draft', 'location:draft:v1');
    } finally { setPending(null); }
  };

  const keyringStarted = (action: KeyringAction) => {
    const sequence = snapshot?.mobius.events[0]?.sequence ?? 0;
    focusAfterSequenceRef.current = sequence;
    setFocusAfterSequence(sequence);
    setFocusAction(action);
    setFreshPath(null);
    if (demoStage === 'intro') {
      transitionStarted.current = performance.now();
      setDemoStage('sending');
    } else {
      transitionStarted.current = 0;
    }
  };

  const keyringVerified = (action: KeyringAction, next: StorySessionSnapshot) => {
    const actionEvents = next.mobius.events.filter((event) => event.action === action && event.sequence > focusAfterSequenceRef.current);
    const primary = actionEvents.find((event) => event.type !== 'KEYRING_BUTTON_OBSERVATION') ?? actionEvents[0];
    if (primary) {
      setFreshPath(primary.resource);
      if (freshTimer.current !== null) window.clearTimeout(freshTimer.current);
      freshTimer.current = window.setTimeout(() => setFreshPath(null), 4000);
    }
    const settle = () => {
      transitionStarted.current = 0;
      stageTimer.current = null;
      setDemoStage('system');
      if (scene === 'login') window.location.hash = action === 'keyring-panic' ? '#/story/check-in' : '#/story/activity-away';
      else if (action === 'keyring-panic') window.location.hash = '#/story/check-in';
    };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const elapsed = transitionStarted.current > 0 ? performance.now() - transitionStarted.current : 640;
    if (stageTimer.current !== null) window.clearTimeout(stageTimer.current);
    stageTimer.current = window.setTimeout(settle, reduced ? 0 : Math.max(0, 640 - elapsed));
  };

  const keyringFailed = () => {
    if (stageTimer.current !== null) window.clearTimeout(stageTimer.current);
    stageTimer.current = null;
    if (transitionStarted.current > 0) setDemoStage('intro');
    transitionStarted.current = 0;
    setFreshPath(null);
  };

  const continueUpright = () => {
    setPortraitChoice('continue');
    if (demoStage !== 'intro') return;
    transitionStarted.current = performance.now();
    setDemoStage('sending');
    const settle = () => {
      transitionStarted.current = 0;
      stageTimer.current = null;
      setDemoStage('system');
      if (scene === 'login') window.location.hash = '#/story/activity-away';
    };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (stageTimer.current !== null) window.clearTimeout(stageTimer.current);
    stageTimer.current = window.setTimeout(settle, reduced ? 0 : 640);
  };

  const startStory = () => { window.location.hash = '#/story/activity-away'; };
  const retry = () => { void refresh(); };
  const careStatus = snapshot?.care.status ?? 'ready';

  return <div className={`story-demo${capture ? ' capture' : ''}`} data-stage={demoStage} data-portrait={portraitChoice} data-display-mode={standalone ? 'standalone' : 'browser'}>
    <a className="skip" href="#story-app" tabIndex={modalOpen ? -1 : undefined} aria-hidden={modalOpen} onClick={(event) => { event.preventDefault(); document.getElementById('story-app')?.focus(); }}>{tr('앱 화면으로 건너뛰기', 'Skip to the app')}</a>
    <header className="story-topbar" inert={modalOpen}>
      <a className="story-brand" href="#/"><span aria-hidden="true"><Icon name="bubble" size={22} /></span>BubbleLock</a>
      <a className="story-topbar-link" href="#/user/overview">{tr('가족 대시보드', 'Family dashboard')}</a>
      <LangToggle />
    </header>
    <section className="story-intro" inert={demoStage !== 'intro' || fullscreenPromptOpen} aria-hidden={demoStage !== 'intro' || fullscreenPromptOpen}>
      <h1 className="story-sr">{tr('Privacy Bubble 키링 시연', 'Privacy Bubble keyring demo')}</h1>
      <p className="story-intro-hint" aria-live="polite"><i className={`story-intro-dot ${guidedAction === 'keyring-panic' ? 'panic' : 'confirm'}`} aria-hidden="true" />
        {message ?? (guidedAction === 'keyring-panic' ? tr('주황 버튼을 눌러 보세요', 'Press the orange button') : tr('파란 버튼을 눌러 보세요', 'Press the blue button'))}
      </p>
    </section>
    {fullscreenEligible && demoStage === 'intro' ? <button className="story-fullscreen-launch" type="button" aria-haspopup="dialog" aria-expanded={fullscreenPromptOpen} inert={fullscreenPromptOpen} onClick={() => setFullscreenPromptOpen(true)}>
      <Icon name="arrow" size={17} style={{ transform: 'rotate(-45deg)' }} />{tr('전체 화면', 'Full screen')}
    </button> : null}
    {(fullscreenEligible || fullscreenPromptOpen) ? <div className="story-fullscreen-guide" role="dialog" aria-modal="true" aria-labelledby="story-fullscreen-title" aria-describedby="story-fullscreen-body" aria-hidden={!fullscreenPromptOpen} inert={!fullscreenPromptOpen} hidden={!fullscreenPromptOpen}>
      <span className="story-fullscreen-glyph" aria-hidden="true"><Icon name="bubble" size={24} /></span>
      <p className="story-fullscreen-title" id="story-fullscreen-title">{tr('Safari 막대 없이 전체 화면으로 보기', 'Open the demo without Safari bars')}</p>
      <p className="story-fullscreen-body" id="story-fullscreen-body">{tr('공유 버튼을 누르고 홈 화면에 추가한 다음, BubbleLock 아이콘을 열어 가로로 돌리세요.', 'Tap Share, choose Add to Home Screen, open the BubbleLock icon, then turn your phone sideways.')}</p>
      <ol>
        <li>{tr('Safari 공유 버튼', 'Safari Share')}</li>
        <li>{tr('홈 화면에 추가', 'Add to Home Screen')}</li>
        <li>{tr('BubbleLock 열기', 'Open BubbleLock')}</li>
      </ol>
      <button className="story-fullscreen-continue" ref={fullscreenContinue} type="button" onClick={() => setFullscreenPromptOpen(false)}>{tr('Safari에서 계속', 'Continue in Safari')}</button>
    </div> : null}
    <div className="story-rotate" role="dialog" aria-modal="true" aria-labelledby="story-rotate-title" aria-describedby="story-rotate-body" aria-hidden={!orientationPromptOpen} inert={!orientationPromptOpen}>
      <span className="story-rotate-glyph" aria-hidden="true"><Icon name="activity" size={28} /></span>
      <p className="story-rotate-title" id="story-rotate-title">{tr('최적화된 데모를 위해 가로로 돌려 주세요', 'Turn your phone sideways for the optimized demo')}</p>
      <p className="story-rotate-body" id="story-rotate-body">{tr('키링, Mobius 리소스 브라우저, 앱 동작을 한 화면에서 함께 볼 수 있습니다.', 'See the keyring, Mobius Resource Browser and app behavior together on one screen.')}</p>
      <button className="story-rotate-continue" ref={rotateContinue} type="button" onClick={continueUpright}>{tr('세로로 계속 보기', 'Continue upright')}</button>
    </div>
    <main className="story-stage" inert={demoStage !== 'system' || modalOpen}>
      <StoryMobiusPanel scene={scene} snapshot={snapshot} phase={phase} message={message} refresh={refresh} focusAction={focusAction} focusAfterSequence={focusAfterSequence} freshPath={freshPath} />
      <div className="story-app-column">
        <div className="story-device">
          <div className="story-phone" id="story-app" role="region" aria-label={tr('Privacy Bubble 앱', 'Privacy Bubble app')} tabIndex={-1}>
            <StoryHeader time={sceneTime[scene]} />
            {message ? <div className="story-inline-error" role="status"><span>{message}</span><button type="button" onClick={retry}>{tr('다시 연결', 'Reconnect')}</button></div> : null}
            {scene === 'login' && <LoginScreen step={loginStep} snapshot={snapshot} onStart={startStory} />}
            {scene === 'activity-away' && <ActivityScreen home={false} />}
            {scene === 'activity-home' && <ActivityScreen home />}
            {scene === 'care-request' && <CareRequestScreen pending={pending === 'approve'} approved={careStatus === 'approved' || careStatus === 'active'} onApprove={() => void approveCare()} />}
            {scene === 'caregiver-shared' && <CaregiverSharedScreen pending={pending === 'all-on' || pending === 'expire'} status={careStatus} onAllOn={() => void allOn()} onExpire={() => void expireNow()} />}
            {scene === 'caregiver-ended' && <CaregiverEndedScreen pending={pending === 'expire'} expired={careStatus === 'expired'} />}
            {scene === 'check-in' && <CheckInScreen pending={pending} snapshot={snapshot} callReady={callReady} onCall={() => void callMom()} onShare={() => void shareLocation()} />}
            <span className="story-home-indicator" aria-hidden="true" />
          </div>
        </div>
      </div>
    </main>
    <StoryStepper scene={scene} />
    <div className="keyring-dock" inert={modalOpen} data-guided={guidedAction === 'keyring-panic' ? 'panic' : guidedAction === 'keyring-confirm' ? 'confirm' : 'none'}>
      <VirtualKeyring
        snapshot={snapshot}
        runAction={runAction}
        guidedAction={guidedAction}
        onActionStart={keyringStarted}
        onVerified={keyringVerified}
        onFailed={keyringFailed}
      />
    </div>
  </div>;
}
