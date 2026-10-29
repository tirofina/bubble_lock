import type { ReactNode } from 'react';
import type { Stage, TimelineStages } from '../shared/index.ts';

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

export function Timestamp({ at }: { readonly at: string }) {
  const korean = new Date(new Date(at).getTime() + 9 * 60 * 60 * 1000).toISOString();
  return <time className="stage-time" dateTime={at} title={`원본: ${at}`}>
    <span className="stage-date">{korean.slice(0, 10)}</span>{korean.slice(11, -1)} <span className="caption">KST</span>
  </time>;
}

function StageTime({ stage }: { readonly stage: Stage }) {
  switch (stage.status) {
    case 'pending': return <span className="muted small">대기 · 시각 미수신</span>;
    case 'complete': return <span title={stage.source}><Timestamp at={stage.at} /></span>;
  }
}

export function Stages({ stages }: { readonly stages: TimelineStages }) {
  const steps = [
    ['accepted', '수락'], ['sent', '전송'], ['applied', '적용'], ['verified', '확인'],
  ] as const;
  return <ol className="stages" aria-label="명령 처리 시각">
    {steps.map(([key, label]) => <li className="stage" key={key}>
      <strong className="small">{label}</strong><StageTime stage={stages[key]} />
    </li>)}
  </ol>;
}

export function BooleanState({ value }: { readonly value: unknown }) {
  return <Badge tone={typeof value === 'boolean' ? 'info' : ''}>
    {value === true ? 'ON · true' : value === false ? 'OFF · false' : '미수신'}
  </Badge>;
}
