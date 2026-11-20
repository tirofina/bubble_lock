import { useEffect, useState } from 'react';
import type { DashboardEvent } from '../shared/index.ts';
import { Icon } from './Icon.tsx';
import { Badge, Timestamp } from './ui.tsx';
import { getJson, isRecord } from './client.ts';
import { useLang } from './i18n.tsx';

interface Step { key: string; at: string | null; ms: number | null; detail: string | null; eligibilityMs?: number | null }
interface Summary {
  source: string; receipt: { path: string; status: string; generatedAt: string; checks: string; sha256: string; sandbox: string | null };
  from: { mep: string; edge: string; zone: string | null }; to: { mep: string; edge: string; zone: string | null }; storyTime: string | null;
  steps: Step[]; gap: { arrivalGapMs: number | null; sourceGapMs: number | null; periodMs: number | null; missedReports: number | null; duplicates: number | null };
}
function parse(value: unknown): Summary | null {
  return isRecord(value) && isRecord(value['receipt']) && Array.isArray(value['steps']) && isRecord(value['gap']) && isRecord(value['from']) && isRecord(value['to']) ? value as unknown as Summary : null;
}
const ms = (value: number | null | undefined) => (typeof value === 'number' ? `${value.toLocaleString('en-US')} ms` : '-');

/** MEC IPE relocation mep1 (Edge-A) to mep2 (Edge-B) from the R13 receipt, plus live handover records when the stream has them. */
export function EdgeRelocation({ events }: { readonly events: readonly DashboardEvent[] }) {
  const { tr } = useLang();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void getJson('/api/relocation', controller.signal).then(({ value }) => { const next = parse(value); if (next) setSummary(next); else setError(true); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);
  const liveHandover = events.filter((event) => event.type === 'integration.receipt' && /HANDOVER/.test(String(event.receipt.type ?? event.receipt.eventType ?? ''))).slice(-3);
  const titles: Record<string, [string, string]> = {
    preplacement: ['Edge-B 사전 배치 (pod 준비)', 'Edge-B pre-placement (pod ready)'],
    trigger: ['MEC021 이동 알림', 'MEC021 move-out trigger'],
    decision: ['재배치 결정 (ownership epoch 2)', 'Relocation decision (ownership epoch 2)'],
    drain: ['Edge-A 구독 정리', 'Edge-A subscriptions drained'],
    resubscribe: ['Edge-B 구독 재생성', 'Edge-B subscriptions re-created'],
    firstObservation: ['Edge-B 첫 관측', 'First Edge-B observation'],
  };
  const note = (step: Step) => {
    switch (step.key) {
      case 'preplacement': return tr(`ADD 요청에서 IPE READY까지 ${ms(step.ms)}, 계기 ${step.detail ?? ''}`, `${ms(step.ms)} from ADD to IPE READY, triggered at ${step.detail ?? ''}`);
      case 'trigger': return tr(`구역 진입에서 알림까지 ${ms(step.ms)}`, `${ms(step.ms)} from zone entry, ${step.detail ?? ''}`);
      case 'decision': return tr(`결정 ${ms(step.ms)}, 그중 적격성 평가 ${ms(step.eligibilityMs)}`, `decided in ${ms(step.ms)}, eligibility check ${ms(step.eligibilityMs)}`);
      case 'drain': return tr(`요청 ${step.detail}건 DELETE 204, ${ms(step.ms)}`, `${step.detail} requests, DELETE 204, ${ms(step.ms)}`);
      case 'resubscribe': return tr(`요청 ${step.detail}건을 mep2 pod에서 ${ms(step.ms)}에 다시 구독`, `${step.detail} requests re-subscribed in the mep2 pod in ${ms(step.ms)}`);
      case 'firstObservation': return tr(`결정에서 ${ms(step.ms)}`, `${ms(step.ms)} after the decision`);
      default: return '';
    }
  };
  return <div className="content-card stack relocation-panel">
    <div className="card-heading"><div><h2>{tr('MEC IPE 재배치', 'MEC IPE relocation')}</h2>
      <p>{summary ? tr(`${summary.from.mep} (${summary.from.edge}, ${summary.from.zone ?? ''})에서 ${summary.to.mep} (${summary.to.edge}, ${summary.to.zone ?? ''})로, 이야기 시각 ${summary.storyTime ?? ''}`, `${summary.from.mep} (${summary.from.edge}, ${summary.from.zone ?? ''}) to ${summary.to.mep} (${summary.to.edge}, ${summary.to.zone ?? ''}), story time ${summary.storyTime ?? ''}`) : tr('mep1 (Edge-A)에서 mep2 (Edge-B)로', 'mep1 (Edge-A) to mep2 (Edge-B)')}</p></div>
      <Badge tone="warning">{tr('기록 재생', 'Replayed')}</Badge></div>
    {error && <p className="notice error" role="alert">{tr('재배치 기록을 불러오지 못했어요.', 'The relocation record could not be loaded.')}</p>}
    {summary && <>
      <div className="relocation-route" aria-hidden="true"><span><Icon name="server" />{summary.from.mep}<small>{summary.from.edge}</small></span><i /><span className="target"><Icon name="server" />{summary.to.mep}<small>{summary.to.edge}</small></span></div>
      <ol className="relocation-timeline">{summary.steps.map((step) => <li key={step.key}>
        <span className="relocation-dot" aria-hidden="true" />
        <div><strong>{tr(...(titles[step.key] ?? [step.key, step.key]))}</strong><p className="small muted">{note(step)}</p></div>
        <span className="small">{step.at ? <Timestamp at={step.at} /> : <span className="muted">{tr('pod 안 측정', 'measured in pod')}</span>}</span>
      </li>)}</ol>
      <dl className="relocation-gap">
        <div><dt>{tr('관측 공백 (수신 기준)', 'Observation gap (arrival)')}</dt><dd>{ms(summary.gap.arrivalGapMs)}</dd></div>
        <div><dt>{tr('관측 공백 (원천 시각)', 'Observation gap (source time)')}</dt><dd>{ms(summary.gap.sourceGapMs)}{summary.gap.periodMs ? tr(`, 주기 ${ms(summary.gap.periodMs)}`, `, period ${ms(summary.gap.periodMs)}`) : ''}</dd></div>
        <div><dt>{tr('빠진 보고, 중복 보고', 'Missed, duplicate reports')}</dt><dd>{summary.gap.missedReports ?? '-'}, {summary.gap.duplicates ?? '-'}</dd></div>
      </dl>
      <p className="caption muted">{tr(`재생 원본: ${summary.receipt.path} (${summary.receipt.status}, 검사 ${summary.receipt.checks}, sandbox ${summary.receipt.sandbox ?? ''})`, `Replayed from ${summary.receipt.path} (${summary.receipt.status}, ${summary.receipt.checks} checks, sandbox ${summary.receipt.sandbox ?? ''})`)}, <Timestamp at={summary.receipt.generatedAt} />, sha256 <code>{summary.receipt.sha256.slice(0, 16)}</code></p>
    </>}
    {liveHandover.length > 0 && <div className="panel stack"><h3>{tr('스트림의 엣지 전환 기록', 'Handover records in the stream')}</h3>{liveHandover.map((event) => <p className="small" key={event.sequence}><span className="mono muted">#{event.sequence}</span> {String(event.type === 'integration.receipt' ? event.receipt.type ?? event.receipt.eventType : '')}, {String(event.type === 'integration.receipt' ? event.receipt['previousEdgeId'] ?? '' : '')} {'->'} {String(event.type === 'integration.receipt' ? event.receipt['edgeId'] ?? '' : '')}, {event.source}</p>)}</div>}
  </div>;
}
