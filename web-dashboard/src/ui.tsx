import type { ReactNode } from 'react';
import type { Stage, TimelineStages } from '../shared/index.ts';
import { useLang } from './i18n.tsx';

export function Badge({ children, tone = '' }: { readonly children: ReactNode; readonly tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Section({ id, number, title, children }: {
  readonly id: string; readonly number: string; readonly title: string; readonly children: ReactNode;
}) {
  return <section className="section" id={id} aria-labelledby={`${id}-title`}>
    <div className="section-heading"><h2 id={`${id}-title`}><span className="section-number">{number}</span>{title}</h2></div>
    {children}
  </section>;
}

const friendlyFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const friendlyFormatEn = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/**
 * precise: KST with milliseconds for command and audit records.
 * friendly: "Nov 19, 3:20 PM" (or the Korean form) for family screens.
 * Both keep the original offset-bearing value in dateTime and the title.
 */
export function Timestamp({ at, variant = 'precise' }: { readonly at: string; readonly variant?: 'precise' | 'friendly' }) {
  const { lang } = useLang();
  const time = new Date(at).getTime();
  const original = `${lang === 'en' ? 'Original' : '원본'}: ${at}`;
  if (Number.isNaN(time)) return <time className="stage-time" title={original}>{at}</time>;
  if (variant === 'friendly') {
    return <time className="friendly-time" dateTime={at} title={original}>{(lang === 'en' ? friendlyFormatEn : friendlyFormat).format(time)}</time>;
  }
  const korean = new Date(time + 9 * 60 * 60 * 1000).toISOString();
  return <time className="stage-time" dateTime={at} title={original}>
    <span className="stage-date">{korean.slice(0, 10)}</span>{' '}{korean.slice(11, -1)} <span className="caption">KST</span>
  </time>;
}

function StageTime({ stage }: { readonly stage: Stage }) {
  const { tr } = useLang();
  switch (stage.status) {
    case 'pending': return <span className="muted small">{tr('기다리는 중', 'Waiting')}</span>;
    case 'complete': return <span title={stage.source}><Timestamp at={stage.at} /></span>;
  }
}

export function Stages({ stages }: { readonly stages: TimelineStages }) {
  const { tr } = useLang();
  const steps = [
    ['accepted', tr('수락', 'Accepted')], ['sent', tr('전송', 'Sent')], ['applied', tr('적용', 'Applied')], ['verified', tr('확인', 'Confirmed')],
  ] as const;
  return <ol className="stages" aria-label={tr('명령 처리 단계', 'Command steps')}>
    {steps.map(([key, title]) => <li className={`stage${stages[key].status === 'complete' ? ' complete' : ''}`} key={key}>
      <strong className="small">{title}</strong><StageTime stage={stages[key]} />
    </li>)}
  </ol>;
}

export function BooleanState({ value }: { readonly value: unknown }) {
  const { tr } = useLang();
  return <Badge tone={value === true ? 'success' : typeof value === 'boolean' ? 'info' : ''}>
    {value === true ? tr('켜짐 (ON)', 'ON') : value === false ? tr('꺼짐 (OFF)', 'OFF') : tr('받기 전', 'Not received')}
  </Badge>;
}
