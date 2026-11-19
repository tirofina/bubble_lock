import { useEffect, useState } from 'react';
import type { AuditFixture, CommandTimeline, DashboardEvent } from '../shared/index.ts';
import { summarizeCommand } from '../shared/index.ts';
import { errorMessage, fixtureAudit } from './client.ts';
import { Badge, BooleanState, Stages, Timestamp } from './ui.tsx';
import { ackStateLabels, commandStatusLabels, eventTypeLabels, label, outcomeLabels, receiptTypeLabels } from './labels.ts';

export function eventTitle(event: DashboardEvent): string {
  if (event.type !== 'integration.receipt') return label(eventTypeLabels, event.type);
  return label(receiptTypeLabels, event.receipt.type ?? event.receipt.eventType, label(eventTypeLabels, event.type));
}

export function CommandDetail({ command }: { readonly command: CommandTimeline }) {
  const summary = summarizeCommand(command);
  const durations = [
    ['수락에서 전송까지', summary.acceptedToSentMs],
    ['전송에서 적용까지', summary.sentToAppliedMs],
    ['적용에서 확인까지', summary.appliedToVerifiedMs],
  ] as const;
  return <div className="stack">
    <div className="row">
      <div className="stack-tight"><h2 className="mono">{command.commandId}</h2><span className="small muted">그룹 <code>{command.groupId ?? '확인 전'}</code></span></div>
      <Badge tone={summary.status === 'verified' ? 'success' : summary.status === 'failure' ? 'danger' : 'warning'}>{label(commandStatusLabels, summary.status)}</Badge>
    </div>
    <Stages stages={command} />
    <div className="row small muted">
      <span>장치 응답(ACK) {summary.ackCount}/{summary.memberCount}, 적용 확인(readback) {summary.verifiedCount}/{summary.memberCount}, 다시 시도 대기 {summary.retryPendingCount}</span>
      <span>{durations.map(([title, duration]) => `${title} ${duration === null ? '기록 없음' : `${duration} ms`}`).join(' / ')}</span>
    </div>
    <div className="panel stack">
      <h3>장치별 응답과 적용 확인</h3>
      <p className="small muted">장치 응답(ACK)은 명령을 받았다는 뜻이고 실제 적용 여부는 상태 재확인(readback)으로 판단해요. 장치별 수락 시각은 데이터 규격에 들어 있지 않아서 대기로 표시해요.</p>
      {Object.values(command.members).length === 0 && <p>장치 응답을 기다리고 있어요.</p>}
      {Object.values(command.members).map((member) => <article className="member" key={member.memberId}>
        <div className="row">
          <div><h4>{member.memberId}</h4><p className="small muted">{member.deviceId}, 수신기 {member.gatewayId ?? '확인 전'}</p></div>
          <div className="cluster">
            <Badge tone={member.retryPending ? 'danger' : member.readbackVerified ? 'success' : 'warning'}>
              {member.retryPending ? '실패, 다시 시도 대기' : label(ackStateLabels, member.ackState, '응답 대기')}
            </Badge>
            <span className="small">적용 상태 <BooleanState value={member.readback} /></span>
          </div>
        </div>
        <code className="caption muted">{member.commandId}</code>
        <Stages stages={member} />
      </article>)}
    </div>
  </div>;
}

export function EventDetails({ events }: { readonly events: readonly DashboardEvent[] }) {
  const latest = events.at(-1);
  return <details className="panel">
    <summary>받은 기록 자세히 보기</summary>
    {latest === undefined ? <p className="muted">받은 기록이 생기면 여기에 표시돼요.</p> : <div className="stack">
      <dl>
        <dt>마지막으로 받은 시각</dt><dd><Timestamp at={latest.receivedAt} /></dd>
        <dt>자원 주소 (URI)</dt><dd><code>{latest.resourceUri}</code></dd>
        <dt>현재 버전 (revision)</dt><dd>{latest.currentRevision ?? '서버가 버전 정보를 보내지 않았어요. 기록 번호(sequence)와는 따로 관리해요.'}</dd>
        <dt>역할 범위</dt><dd>{latest.roleScope.join(', ')} (화면 표시용 정보이고 권한 판단에는 쓰지 않아요)</dd>
        <dt>출처</dt><dd>{latest.source}, {latest.source === 'onem2m-cse-live' ? 'oneM2M CSE 실시간 알림' : '모의 재생'}</dd>
      </dl>
      <ol className="audit-list" aria-label="최근 받은 기록">
        {events.map((event) => <li key={event.sequence}>
          <span><span className="mono muted">#{event.sequence}</span> {eventTitle(event)}</span><Badge tone={event.simulation ? 'warning' : 'info'}>{event.simulation ? '모의' : '실측'}</Badge>
          <span className="audit-meta"><Timestamp at={event.receivedAt} />, <code>{event.type}</code>, {event.resourceUri}</span>
        </li>)}
      </ol>
      <p className="caption muted">최근 100개를 보여 줘요. 명령 상태와 이어받을 위치는 전체 기록을 기준으로 유지해요.</p>
    </div>}
  </details>;
}

export function Audit({ refresh, integrated }: { readonly refresh: number; readonly integrated: boolean }) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [request, setRequest] = useState(0);
  const [records, setRecords] = useState<readonly AuditFixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError(null); setRecords([]);
    void fixtureAudit(query, controller.signal).then((data) => {
      if (active) setRecords(data);
    }).catch((cause: unknown) => {
      if (active) setError(errorMessage(cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [query, request, refresh]);

  return <div className="stack">
    <div className="row"><p className="small muted">{integrated ? '정책, 위치 서비스, 엣지 전환, 연합 학습, 자동화 실행 기록을 검색해요.' : '정책, 접근 권한, 동의 기록을 검색해 볼 수 있는 모의 데이터예요.'}</p>
      <Badge tone="warning">{integrated ? '통합 기록 재생' : '모의 데이터'}</Badge></div>
    <form className="row" onSubmit={(event) => { event.preventDefault(); setQuery(input); setRequest((value) => value + 1); }}>
      <div className="stack-tight" style={{ flex: '1 1 18rem' }}>
        <label>활동 기록 검색
          <input type="search" value={input} onChange={(event) => setInput(event.target.value)} placeholder="명령 ID, 계정, 동작으로 검색"
            aria-describedby="audit-search-scope" list="audit-search-suggestions" />
        </label>
        <p id="audit-search-scope" className="caption muted">계정, 명령 ID, 동작, 자원 주소에서 찾아요.</p>
        <datalist id="audit-search-suggestions"><option value="grp-demo" /><option value="grp-partial" /><option value="demo-operator" /></datalist>
      </div>
      <button type="submit" className="primary">검색</button>
    </form>
    <div className={`panel audit-results${loading ? ' loading-placeholder' : ''}`} aria-live="polite" aria-busy={loading}>
      {loading ? <><p role="status">기록을 찾고 있어요…</p>{[1, 2, 3, 4].map((row) => <div className="placeholder-row" aria-hidden="true" key={row} />)}</> : error !== null ?
        <p className="error" role="alert">{error} 검색어를 바꾸거나 잠시 후 다시 검색해 주세요.</p> : <>
          <p className="small muted">검색 결과 {records.length}개{query && `, "${query}"`}</p>
          {records.length === 0 && <p>찾는 기록이 없어요. 검색어를 지우고 전체 기록을 확인해 보세요.</p>}
          <ul className="audit-list">
            {records.map((record) => <li key={record.id}>
              <div className="stack-tight"><strong>{label(receiptTypeLabels, record.action)}</strong><span className="small muted">{record.actor}, 명령 {record.commandId ?? '해당 없음'}</span></div>
              <div className="cluster"><Badge tone="warning">모의</Badge><Badge tone={record.outcome === 'denied' ? 'danger' : record.outcome === 'allowed' ? 'success' : 'warning'}>{label(outcomeLabels, record.outcome)}</Badge></div>
              <div className="audit-meta"><Timestamp at={record.receivedAt} /><br /><code>{record.resourceUri}</code><br />{record.id}</div>
            </li>)}
          </ul>
        </>}
    </div>
  </div>;
}
