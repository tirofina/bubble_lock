import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateDashboardEvent } from '../shared/index.ts';
import type { DashboardEvent } from '../shared/index.ts';
import { activeLease, reduceGuardianAlerts } from '../shared/guardian-alert.ts';
import type { AlertCard, GuardianAlertView } from '../shared/guardian-alert.ts';
import { Icon } from './Icon.tsx';
import { Metric } from './PortalShell.tsx';
import { Badge } from './ui.tsx';
import { isRecord } from './client.ts';
import { useLang } from './i18n.tsx';
import { label, leasePurposeLabels, leasePurposeLabelsEn } from './labels.ts';
const LocationMap = lazy(() => import('./LocationMap.tsx').then((module) => ({ default: module.LocationMap })));

type Tr = (ko: string, en: string) => string;
type FeedConnection = 'connecting' | 'connected' | 'disconnected';

/** `guardian.alert` events from one SSE feed (same contract and cursor rules as /events), folded into cards. */
export function useAlertFeed(url: string | null) {
  const [events, setEvents] = useState<readonly DashboardEvent[]>([]);
  const [connection, setConnection] = useState<FeedConnection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const last = useRef(0);
  const reconnect = useCallback(() => { last.current = 0; setEvents([]); setGeneration((value) => value + 1); }, []);
  useEffect(() => {
    if (!url) return;
    let disposed = false; let retry: ReturnType<typeof setTimeout> | undefined;
    const source = new EventSource(`${url}?lastSequence=${last.current}`);
    source.onopen = () => { if (!disposed) { setConnection('connected'); setError(null); } };
    source.onmessage = (message: MessageEvent<string>) => {
      if (disposed) return;
      const result = validateDashboardEvent(message.data);
      if (!result.valid || result.event.type !== 'guardian.alert' || message.lastEventId !== String(result.event.sequence)) { setError(result.valid ? 'sequence' : result.error); return; }
      if (result.event.sequence <= last.current) return;
      last.current = result.event.sequence;
      const event = result.event;
      setEvents((current) => [...current.slice(-999), event]);
    };
    source.onerror = () => {
      if (disposed) return;
      setConnection('disconnected');
      // A closed stream (409 resync or server restart) restarts from the beginning; an open one reconnects with Last-Event-ID.
      if (source.readyState === EventSource.CLOSED) retry = setTimeout(() => { if (!disposed) reconnect(); }, 3000);
    };
    return () => { disposed = true; clearTimeout(retry); source.close(); };
  }, [url, generation, reconnect]);
  const view: GuardianAlertView = useMemo(() => reduceGuardianAlerts(events), [events]);
  const latest = events.at(-1);
  return { view, events, connection, error, reconnect, source: latest?.source ?? null, simulation: latest?.simulation ?? null };
}
export type AlertFeedController = ReturnType<typeof useAlertFeed>;

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [intervalMs]);
  return now;
}

/** "17:13" + seconds elapsed on the resident's local story clock. */
function addToLocal(local: string | null, ms: number): string | null {
  const match = local ? /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(local) : null;
  if (!match) return null;
  const total = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) + Math.round(ms / 1000)) % 86400;
  return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}`;
}
export function elapsedText(ms: number, tr: Tr): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return tr('방금', 'just now');
  if (minutes < 60) return tr(`${minutes}분 전`, minutes === 1 ? '1 min ago' : `${minutes} min ago`);
  return tr(`${Math.floor(minutes / 60)}시간 전`, `${Math.floor(minutes / 60)} h ago`);
}
export function durationText(seconds: number, tr: Tr): string {
  const minutes = Math.floor(seconds / 60); const rest = seconds % 60;
  return minutes ? tr(`${minutes}분 ${rest}초`, `${minutes} min ${rest} s`) : tr(`${rest}초`, `${rest} s`);
}
function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
const shortHash = (hash: string | null | undefined) => (hash ? hash.slice(0, 12) : '-');

export function alertTitle(card: Pick<AlertCard, 'kind'>, tr: Tr): string {
  switch (card.kind) {
    case 'WANDERING': return tr('평소와 다른 멈춤', 'Unusual stop');
    case 'SIGNAL_GAP': return tr('위치 소식이 끊겼어요', 'Location updates paused');
    case 'DEVICE_SEPARATION': return tr('키링을 두고 나갔어요', 'Keyring left behind');
    case 'PANIC': return tr('도움 요청 버튼이 눌렸어요', 'PANIC button pressed');
    default: return tr('살펴볼 알림', 'Alert to check');
  }
}
export const severityText = (severity: string | null, tr: Tr) => severity === 'urgent' ? tr('긴급', 'Urgent') : severity === 'watch' ? tr('주의', 'Watch') : severity === 'info' ? tr('참고', 'Info') : tr('확인 중', 'Checking');
export function stateText(card: Pick<AlertCard, 'state' | 'review' | 'decision'>, tr: Tr): string {
  if (card.state === 'escalated') return tr('긴급 구조', 'Emergency Rescue');
  if (card.state === 'dismissed') return tr('괜찮음으로 표시', 'Marked fine');
  if (card.state === 'approved') return tr('위치 공유 승인', 'Share approved');
  if (card.decision?.decision === 'REJECT') return tr('공유 거절', 'Share declined');
  if (card.review) return tr('승인 전달 중', 'Sending approval');
  return tr('새 알림', 'New');
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(isRecord(value) && typeof value['message'] === 'string' ? value['message'] : isRecord(value) && typeof value['error'] === 'string' ? value['error'] : `HTTP ${response.status}`);
  return isRecord(value) ? value : {};
}

export function AlertCardView({ card, source, now }: { readonly card: AlertCard; readonly source: string | null; readonly now: number }) {
  const { lang, tr } = useLang();
  const [pending, setPending] = useState<'approve' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lease = activeLease(card, now);
  const alertedMs = card.alertedAt ? Date.parse(card.alertedAt) : null;
  const purpose = card.draft ? label(lang === 'en' ? leasePurposeLabelsEn : leasePurposeLabels, card.draft.purpose) : '';
  const minutes = card.draft?.durationMinutes ?? 5;
  const leaseEndLocal = card.lease && alertedMs !== null ? addToLocal(card.alertedLocal, Date.parse(card.lease.expiresAt) - alertedMs) : null;
  const escalatedAfter = card.escalation && alertedMs !== null ? Math.round((Date.parse(card.escalation.at) - alertedMs) / 1000) : null;
  const leadTime = card.escalation?.leadTimeSec ?? escalatedAfter;
  const act = async (kind: 'approve' | 'dismiss') => {
    setPending(kind); setError(null);
    try {
      if (kind === 'approve' && card.draft) await post('/api/portal/alerts/decide', { approvalRequestId: card.draft.approvalRequestId, reviewedDraftHash: card.draft.draftHash, decision: 'APPROVE' });
      else await post('/api/portal/alerts/dismiss', { key: card.key });
    } catch (cause) { setError(cause instanceof Error ? cause.message : tr('요청을 보내지 못했어요.', 'The request did not reach the server.')); }
    finally { setPending(null); }
  };
  const canApprove = Boolean(card.draft) && !card.decision && !card.review && card.draft!.findings.length === 0;
  const canDismiss = card.state !== 'escalated' && card.state !== 'dismissed' && card.kind !== 'PANIC';
  const tone = card.state === 'escalated' || card.kind === 'PANIC' ? 'danger' : card.state === 'dismissed' ? '' : card.state === 'approved' ? 'success' : card.severity === 'urgent' ? 'danger' : 'warning';
  return <article className={`alert-card alert-${card.state}${card.kind === 'PANIC' ? ' alert-panic' : ''}`} aria-labelledby={`alert-${card.key}`}>
    <div className="alert-card-head">
      <span className={`alert-symbol ${tone}`}><Icon name={card.state === 'escalated' || card.kind === 'PANIC' ? 'bolt' : 'bell'} size={22} /></span>
      <div className="alert-card-title">
        <p className="eyebrow">{tr('어머니', 'Mom')}, {severityText(card.severity, tr)}</p>
        <h2 id={`alert-${card.key}`}>{card.state === 'escalated' ? tr('긴급 구조', 'Emergency Rescue') : alertTitle(card, tr)}</h2>
        <p className="small muted">{card.segment && <span className="alert-place">{card.segment}</span>}{card.alertedLocal && <span>{tr(`${card.alertedLocal.slice(0, 5)} 알림`, `Alert at ${card.alertedLocal.slice(0, 5)}`)}</span>}{alertedMs !== null && <span>{elapsedText(now - alertedMs, tr)}</span>}</p>
      </div>
      <Badge tone={tone}>{stateText(card, tr)}</Badge>
    </div>
    {card.escalation && <div className="alert-escalation" role="alert"><Icon name="bolt" />
      <div><strong>{tr(`${card.escalation.panicLocal?.slice(0, 5) ?? ''} 도움 요청 버튼이 눌렸어요`, `PANIC pressed at ${card.escalation.panicLocal?.slice(0, 5) ?? ''}`)}</strong>
        <p>{leadTime !== null ? tr(`같은 알림을 이어서 긴급으로 올렸어요. 첫 알림보다 ${durationText(leadTime, tr)} 뒤예요.`, `Escalated on this same alert, ${durationText(leadTime, tr)} after the first alert.`) : tr('같은 알림을 이어서 긴급으로 올렸어요.', 'Escalated on this same alert.')}</p></div></div>}
    {card.explanation && <blockquote className="alert-explanation"><p>{card.explanation}</p>
      <footer>{tr('분류 에이전트의 설명', 'Explained by the triage agent')}{card.startedLocal ? tr(`, ${card.startedLocal}부터`, `, since ${card.startedLocal}`) : ''}</footer></blockquote>}
    {card.draft && !lease && card.state !== 'approved' && <div className="alert-draft"><span className="row-symbol"><Icon name="pin" /></span>
      <div><strong>{tr(`위치 공유 초안: ${minutes}분 동안 나에게`, `Draft: share her location with you for ${minutes} min`)}</strong>
        <p className="small muted">{purpose}, {tr('승인한 뒤에만 시작해요.', 'starts only after you approve.')} <span className="mono">{tr('초안', 'draft')} {shortHash(card.draft.draftHash)}</span></p></div></div>}
    {card.decision?.decision === 'APPROVE' && <div className={`notice ${lease ? 'success-notice' : ''}`} role="status"><Icon name="check" />
      {lease ? tr(`${leaseEndLocal ?? ''}까지 위치를 공유해요, ${countdown(Date.parse(lease.expiresAt) - now)} 남음`, `Sharing her location with you until ${leaseEndLocal ?? ''}, ${countdown(Date.parse(lease.expiresAt) - now)} left`)
        : card.lease ? tr(`위치 공유가 ${leaseEndLocal ?? ''}에 끝났어요.`, `The location share ended at ${leaseEndLocal ?? ''}.`) : tr('승인했어요. 서버가 공유를 여는 중이에요.', 'Approved. The server is opening the share.')}</div>}
    {lease && card.incidentId && <div className="alert-map"><Suspense fallback={<p role="status">{tr('지도를 불러오고 있어요…', 'Loading the map…')}</p>}>
      <LocationMap refresh={0} variant="user" locationUrl={`/api/portal/alerts/location?incidentId=${encodeURIComponent(card.incidentId)}&lang=${lang}`} /></Suspense></div>}
    {card.feedback && <p className="small muted alert-feedback"><Icon name="check" size={16} />{card.feedback.learn ? tr('괜찮다고 알려 주셨어요. 이 산책은 평소 장소 학습에 들어가요.', 'You marked this as fine. This walk now counts toward her usual places.') : tr(`괜찮다고 알려 주셨어요. 학습 제외: ${card.feedback.reason}`, `You marked this as fine. Not learned: ${card.feedback.reason}`)}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="alert-actions">
      {canApprove && <button className="primary" disabled={pending !== null} onClick={() => void act('approve')}><Icon name="pin" size={18} />{tr(`${minutes}분 위치 공유 승인`, `Approve ${minutes}-min share`)}</button>}
      <a className={`button${card.draft || card.state === 'escalated' ? '' : ' primary'}`} href="tel:"><Icon name="bell" size={18} />{tr('전화하기', 'Call')}</a>
      {canDismiss && <button className="quiet-button" disabled={pending !== null} onClick={() => void act('dismiss')}>{tr('괜찮아요', "It's fine")}</button>}
    </div>
    <p className="caption muted alert-source">{source === 'onem2m-cse-live' ? tr('oneM2M CSE에서 실시간으로 받은 알림이에요.', 'Received live from the oneM2M CSE.') : tr('기록을 재생한 알림이에요 (모의).', 'Replayed from a run record (simulated).')}{card.agent ? `, ${card.agent}` : ''}</p>
  </article>;
}

export function GuardianAlertList({ feed }: { readonly feed: AlertFeedController }) {
  const now = useNow(1000);
  const cards = feed.view.cards.filter((card) => card.notified).slice().reverse();
  if (cards.length === 0) return null;
  return <section className="alert-list" aria-label="Alerts">{cards.map((card) => <AlertCardView key={card.key} card={card} source={feed.source} now={now} />)}</section>;
}

export function ResidentStatusMetric({ feed }: { readonly feed: AlertFeedController }) {
  const { tr } = useLang();
  const status = feed.view.status;
  const value = !status ? tr('확인 중', 'Checking') : status.state === 'AT_HOME' ? tr('집에 있음', 'At Home') : status.state === 'MOVING' ? tr('이동 중', 'Moving')
    : status.state === 'STOPPED' ? tr('평소와 다른 멈춤', 'Unusual stop') : tr('긴급 상황', 'Emergency');
  const place = status?.place === 'home' ? tr('집', 'home') : status?.place;
  return <Metric label={tr('어머니 지금', 'Mom right now')} value={value} compact icon={status?.state === 'AT_HOME' ? 'home' : 'activity'}
    note={status ? [place, status.localTime].filter(Boolean).join(', ') : tr('위치 소식을 기다리고 있어요.', 'Waiting for her next update.')} />;
}

/** Operator audit entry per triage run: tools per MCP server, approval hash, evidence hash. */
export function TriageAudit({ feed }: { readonly feed: AlertFeedController }) {
  const { tr } = useLang();
  const runs = feed.view.cards.filter((card) => card.runId).slice().reverse();
  const replayed = feed.source !== 'onem2m-cse-live';
  return <div className="content-card stack triage-audit"><div className="card-heading"><div><h2>{tr('이상 징후 분류 기록 (anomaly triage)', 'Anomaly triage audit')}</h2><p>{tr('경보마다 에이전트가 부른 MCP 도구와 보호자 승인 hash예요.', 'MCP tools the agent called per alert, and the guardian approval hash.')}</p></div>
    <Badge tone={replayed ? 'warning' : 'info'}>{replayed ? tr('기록 재생', 'Replayed') : tr('실시간 CSE', 'Live CSE')}</Badge></div>
    {runs.length === 0 && <p className="empty-state">{tr('분류 실행이 들어오면 여기에 표시돼요.', 'Triage runs appear here when they arrive.')}</p>}
    {runs.map((card) => {
      const tools = card.evidence?.toolsByServer ?? { oneM2M: card.checked.filter((tool) => !tool.startsWith('query')), MEC: card.checked.filter((tool) => tool.startsWith('query')), Audit: [] };
      return <article className="triage-run" key={card.runId}>
        <div className="row"><div className="stack-tight"><strong className="mono">{card.runId}</strong><span className="small muted">{card.kind}, {card.action ?? '-'} ({severityText(card.severity, tr)}){card.agent ? `, ${card.agent}` : ''}</span></div>
          <Badge tone={card.decision?.decision === 'APPROVE' ? 'success' : 'warning'}>{card.decision ? tr('보호자 결정 기록', 'Guardian decision recorded') : card.draft ? tr('보호자 승인 대기', 'Waiting for guardian') : tr('승인 단계 없음', 'No approval step')}</Badge></div>
        <dl className="triage-tools">{Object.entries(tools).map(([server, list]) => <div key={server}><dt>{server}</dt><dd>{list.length ? list.map((tool) => <code key={tool}>{tool}</code>) : <span className="muted">{tr('호출 없음', 'not called')}</span>}</dd></div>)}</dl>
        <dl className="triage-hashes">
          <div><dt>{tr('초안 hash (draftHash)', 'Draft hash')}</dt><dd><code>{card.draft?.draftHash ?? '-'}</code></dd></div>
          <div><dt>{tr('승인 hash (approvalHash)', 'Approval hash')}</dt><dd><code>{card.decision?.approvalHash ?? card.evidence?.approvalHash ?? '-'}</code></dd></div>
          <div><dt>{tr('실행 증거 hash', 'Evidence hash')}</dt><dd><code>{card.evidence?.evidenceHash ?? '-'}</code></dd></div>
        </dl>
      </article>;
    })}
  </div>;
}
