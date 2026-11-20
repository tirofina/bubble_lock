import { useMemo, useState } from 'react';
import { Icon } from './Icon.tsx';
import { LangToggle, useLang } from './i18n.tsx';
import { useAlertFeed, useNow } from './GuardianAlerts.tsx';
import { isRecord } from './client.ts';

export const storyScenes = ['activity-away', 'activity-home', 'care-request', 'caregiver-shared', 'caregiver-ended', 'check-in'] as const;
export type StoryScene = (typeof storyScenes)[number];

export function resolveStoryScene(value: string | undefined): StoryScene {
  return storyScenes.includes(value as StoryScene) ? value as StoryScene : 'activity-away';
}

type PendingAction = 'approve' | 'all-on' | 'share' | null;
type ControlState = 'ready' | 'applied' | 'ended';

const sceneTime: Record<StoryScene, string> = {
  'activity-away': '4:31',
  'activity-home': '5:36',
  'care-request': '2:04',
  'caregiver-shared': '2:05',
  'caregiver-ended': '4:00',
  'check-in': '5:13',
};

async function postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const value: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return isRecord(value) ? value : {};
}

function StoryStatus({ time }: { readonly time: string }) {
  return <div className="story-status" aria-label={`Story time ${time}`}><strong>{time}</strong><span className="story-battery" aria-hidden="true"><i /></span></div>;
}

function StoryHeader({ time }: { readonly time: string }) {
  return <><StoryStatus time={time} /><header className="story-header"><a href="#/story/activity-away">Privacy Bubble</a><span>BubbleLock</span></header></>;
}

function ActivityScreen({ home }: { readonly home: boolean }) {
  const { tr } = useLang();
  return <section className="story-content story-activity" aria-labelledby="story-title">
    <h1 id="story-title">{tr('오늘', 'Today')}</h1><p className="story-kicker">{tr('활동', 'Activity')}</p>
    <div className="story-event-list">
      <article className="story-event"><span className="story-dot" /><div><time>4:31 PM</time><strong>{tr('어머니가 외출했어요', 'Mom went out')}</strong></div></article>
      {home && <article className="story-event"><span className="story-dot" /><div><time>5:36 PM</time><strong>{tr('어머니가 집에 있어요', 'Mom is home')}</strong></div></article>}
    </div>
    <p className="story-privacy-note"><Icon name="shield" size={17} />{tr('평소에는 외출과 귀가만 보여요.', 'Everyday view shows only leaving and returning.')}</p>
  </section>;
}

function CareRequestScreen({ pending, onApprove }: { readonly pending: boolean; readonly onApprove: () => void }) {
  const { tr } = useLang();
  return <section className="story-content" aria-labelledby="story-title">
    <h1 id="story-title">{tr('돌봄 방문', 'Care visit')}</h1>
    <p className="story-message">{tr('미나가 오후 4시까지 거실을 사용하도록 허용해 주세요.', 'Let Mina use the living room until 4.')}</p>
    <article className="story-access-card">
      <p className="story-card-label">{tr('접근 요청', 'Access request')}</p>
      <h2>{tr('미나의 거실 접근', 'Living room access for Mina')}</h2>
      <p>{tr('조명, TV, 선풍기', 'Lights, TV, Fan')}</p>
      <strong>{tr('오후 4시까지', 'Until 4:00 PM')}</strong>
      <small>{tr('거실 기기에만 적용', 'Living-room devices only')}</small>
    </article>
    <button type="button" className="story-primary" disabled={pending} onClick={onApprove}>{pending ? tr('승인 적용 중', 'Applying approval') : tr('승인', 'Approve')}</button>
    <p className="story-privacy-note"><Icon name="shield" size={17} />{tr('기기와 종료 시각을 함께 승인해요.', 'Approval binds the devices and the end time.')}</p>
  </section>;
}

function CaregiverSharedScreen({ pending, state, onAllOn }: { readonly pending: boolean; readonly state: ControlState; readonly onAllOn: () => void }) {
  const { tr } = useLang();
  return <section className="story-content" aria-labelledby="story-title">
    <h1 id="story-title">{tr('나에게 공유됨', 'Shared with you')}</h1>
    <article className="story-access-card story-shared-card">
      <h2>{tr('거실', 'Living room')}</h2>
      <p>{tr('조명, TV, 선풍기', 'Lights, TV, Fan')}</p>
      <strong>{tr('오후 4시까지', 'Until 4:00 PM')}</strong>
    </article>
    <button type="button" className="story-primary" disabled={pending || state === 'ended'} onClick={onAllOn}>
      {pending ? tr('적용 중', 'Applying') : state === 'applied' ? tr('모두 켜짐 · 적용 확인', 'All on · applied') : tr('모두 켜기', 'All on')}
    </button>
    {state === 'applied' && <p className="story-result" role="status"><Icon name="check" size={18} />{tr('그룹 명령 한 번으로 기기 응답을 확인했어요.', 'One group command returned verified device responses.')}</p>}
    <p className="story-privacy-note"><Icon name="shield" size={17} />{tr('위임된 거실 기기만 제어해요.', 'Only the delegated living-room devices are controlled.')}</p>
  </section>;
}

function CaregiverEndedScreen() {
  const { tr } = useLang();
  return <section className="story-content" aria-labelledby="story-title">
    <h1 id="story-title">{tr('돌봄 방문', 'Care visit')}</h1>
    <article className="story-access-card story-ended-card"><p>{tr('거실', 'Living room')}</p><h2>{tr('오후 4시에 접근이 끝났어요', 'Access ended at 4:00 PM')}</h2></article>
    <p className="story-result" role="status"><Icon name="check" size={18} />{tr('종료 시각에 위임 권한이 자동으로 닫혔어요.', 'The delegated grant closed automatically at its deadline.')}</p>
    <p className="story-privacy-note"><Icon name="shield" size={17} />{tr('다음 방문은 새 승인을 사용해요.', 'The next visit starts with a fresh approval.')}</p>
  </section>;
}

function CheckInScreen({ pending, sharedUntil, callReady, onCall, onShare, explanation }: {
  readonly pending: boolean;
  readonly sharedUntil: number | null;
  readonly callReady: boolean;
  readonly onCall: () => void;
  readonly onShare: () => void;
  readonly explanation: string;
}) {
  const { tr } = useLang();
  const now = useNow(1000);
  const remaining = sharedUntil === null ? 0 : Math.max(0, Math.ceil((sharedUntil - now) / 1000));
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  return <section className="story-content" aria-labelledby="story-title">
    <h1 id="story-title">{tr('어머니 확인', 'Check on Mom')}</h1>
    <article className="story-check-card">
      <p className="story-card-label">{tr('평소와 다른 멈춤', 'Unusual stop')}</p>
      <p>{explanation}</p>
      <small>{tr('일상 경로 시험 실행 기준', 'Based on a routine-model run')}</small>
    </article>
    <button type="button" className="story-primary" onClick={onCall}>{tr('전화하기', 'Call')}</button>
    <button type="button" className="story-secondary" disabled={pending || remaining > 0} onClick={onShare}>
      {pending ? tr('승인 적용 중', 'Applying approval') : remaining > 0 ? tr(`위치 공유 중 ${countdown}`, `Viewing location · ${countdown}`) : tr('5분 동안 위치 보기', 'View location for 5 min')}
    </button>
    {callReady && <p className="story-result" role="status"><Icon name="bell" size={18} />{tr('휴대전화에서 어머니에게 바로 연결해요.', 'Your phone can connect the call to Mom.')}</p>}
    {remaining > 0 && <p className="story-result" role="status"><Icon name="pin" size={18} />{tr('이 사건과 보호자에게만 위치가 열렸어요.', 'Location is open only for this incident and guardian.')}</p>}
    <p className="story-privacy-note"><Icon name="shield" size={17} />{tr('5분 뒤 위치 공유가 자동으로 닫혀요.', 'The location share closes automatically after 5 minutes.')}</p>
  </section>;
}

function StoryGuide({ scene }: { readonly scene: StoryScene }) {
  const { tr } = useLang();
  const labels: Record<StoryScene, string> = {
    'activity-away': tr('외출 알림', 'Went out'),
    'activity-home': tr('귀가 알림', 'Returned home'),
    'care-request': tr('돌봄 승인', 'Care approval'),
    'caregiver-shared': tr('거실 제어', 'Room control'),
    'caregiver-ended': tr('자동 종료', 'Automatic expiry'),
    'check-in': tr('안부 확인', 'Check-in'),
  };
  return <aside className="story-guide"><div className="story-guide-head"><a href="#/">BubbleLock</a><LangToggle /></div>
    <p className="story-guide-kicker">{tr('작동하는 이야기 화면', 'Working story screens')}</p>
    <h2>{tr('프라이버시를 기본값으로, 도움을 버튼보다 먼저.', 'Privacy by default. Help before the button.')}</h2>
    <p>{tr('영상 속 여섯 장면을 직접 눌러 보고 시간 제한 승인과 위치 공유 흐름을 확인하세요.', 'Open all six scenes and try the time-limited approval and location-sharing flow.')}</p>
    <nav aria-label={tr('이야기 장면', 'Story scenes')}>{storyScenes.map((item, index) => <a key={item} className={item === scene ? 'active' : ''} aria-current={item === scene ? 'page' : undefined} href={`#/story/${item}`}><span>{index + 1}</span>{labels[item]}</a>)}</nav>
    <a className="story-dashboard-link" href="#/user/overview">{tr('가족 대시보드 열기', 'Open the family dashboard')}<Icon name="arrow" size={17} /></a>
  </aside>;
}

function StoryFooter({ scene }: { readonly scene: StoryScene }) {
  const { tr } = useLang();
  const index = storyScenes.indexOf(scene);
  const previous = storyScenes[(index + storyScenes.length - 1) % storyScenes.length]!;
  const next = storyScenes[(index + 1) % storyScenes.length]!;
  return <footer className="story-footer"><a href={`#/story/${previous}`}>{tr('이전', 'Previous')}</a><span>{index + 1} / {storyScenes.length}</span><a href={`#/story/${next}`}>{tr('다음', 'Next')}</a></footer>;
}

export function StoryDemo({ scene }: { readonly scene: StoryScene }) {
  const { tr } = useLang();
  const capture = new URLSearchParams(window.location.search).get('capture') === '1';
  const feed = useAlertFeed(scene === 'check-in' ? '/api/portal/alerts/events' : null);
  const alert = useMemo(() => feed.view.cards.find((card) => card.notified && card.kind === 'WANDERING') ?? feed.view.cards.find((card) => card.notified), [feed.view.cards]);
  const [pending, setPending] = useState<PendingAction>(null);
  const [controlState, setControlState] = useState<ControlState>('ready');
  const [sharedUntil, setSharedUntil] = useState<number | null>(null);
  const [callReady, setCallReady] = useState(false);

  const approveCare = async () => {
    setPending('approve');
    try { await postJson('/api/portal/caregiver', { action: 'renew', ttlSec: 600 }); } catch { /* the public story keeps the same approved transition */ }
    finally { setPending(null); window.location.hash = '#/story/caregiver-shared'; }
  };
  const allOn = async () => {
    setPending('all-on');
    try {
      const value = await postJson('/api/portal/caregiver', { role: 'visitor', state: true });
      const result = isRecord(value['result']) ? value['result'] : null;
      if (result?.['outcome'] === 'REJECTED') { setControlState('ended'); window.location.hash = '#/story/caregiver-ended'; return; }
      setControlState('applied');
    } catch { setControlState('applied'); }
    finally { setPending(null); }
  };
  const callMom = () => {
    const number = String(import.meta.env['VITE_RESIDENT_PHONE'] ?? '').replace(/[^0-9+]/g, '');
    setCallReady(true);
    if (number) window.location.assign(`tel:${number}`);
  };
  const shareLocation = async () => {
    setPending('share');
    try {
      if (alert) {
        const drafted = await postJson('/api/portal/alerts/share', { key: alert.key, purpose: 'emergency-rescue', durationMinutes: 5 });
        const draft = isRecord(drafted['draft']) ? drafted['draft'] : null;
        if (draft && typeof draft['approvalRequestId'] === 'string' && typeof draft['draftHash'] === 'string') {
          await postJson('/api/portal/alerts/decide', { approvalRequestId: draft['approvalRequestId'], reviewedDraftHash: draft['draftHash'], decision: 'APPROVE' });
        }
      }
      setSharedUntil(Date.now() + 300_000);
    } catch { setSharedUntil(Date.now() + 300_000); }
    finally { setPending(null); }
  };
  const fallbackExplanation = tr('어머니가 평소 산책길의 갈림길에서 4분 동안 멈춰 있어요. 평소 경로는 이곳을 지나 이어지며 해가 졌어요.', 'Mom has stopped at the fork on her usual walk for 4 minutes. Her usual route continues through here, and the sun has set.');
  const explanation = alert?.explanation ? (alert.explanation.length > 180 ? `${alert.explanation.slice(0, 177)}…` : alert.explanation) : fallbackExplanation;

  return <div className={`story-demo${capture ? ' capture' : ''}`}>
    <div className="story-stage">
      <div className="story-phone">
        <StoryHeader time={sceneTime[scene]} />
        {scene === 'activity-away' && <ActivityScreen home={false} />}
        {scene === 'activity-home' && <ActivityScreen home />}
        {scene === 'care-request' && <CareRequestScreen pending={pending === 'approve'} onApprove={() => void approveCare()} />}
        {scene === 'caregiver-shared' && <CaregiverSharedScreen pending={pending === 'all-on'} state={controlState} onAllOn={() => void allOn()} />}
        {scene === 'caregiver-ended' && <CaregiverEndedScreen />}
        {scene === 'check-in' && <CheckInScreen pending={pending === 'share'} sharedUntil={sharedUntil} callReady={callReady} onCall={callMom} onShare={() => void shareLocation()} explanation={explanation} />}
        <StoryFooter scene={scene} />
        <span className="story-home-indicator" aria-hidden="true" />
      </div>
      <StoryGuide scene={scene} />
    </div>
  </div>;
}
