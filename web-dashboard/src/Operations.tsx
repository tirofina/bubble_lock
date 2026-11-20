import { useEffect, useState } from 'react';
import type { AuditFixture, CommandTimeline, DashboardEvent } from '../shared/index.ts';
import { summarizeCommand } from '../shared/index.ts';
import { errorMessage, fixtureAudit } from './client.ts';
import { Badge, BooleanState, Stages, Timestamp } from './ui.tsx';
import { ackStateLabels, ackStateLabelsEn, commandStatusLabels, commandStatusLabelsEn, eventTypeLabels, eventTypeLabelsEn, label, labelsFor, outcomeLabels, outcomeLabelsEn, receiptTypeLabels, receiptTypeLabelsEn } from './labels.ts';
import { useLang } from './i18n.tsx';
import { uiLang } from './server-messages.ts';
import type { UiLang } from './server-messages.ts';

export function eventTitle(event: DashboardEvent, lang: UiLang = uiLang()): string {
  const types = labelsFor(lang, eventTypeLabels, eventTypeLabelsEn);
  if (event.type !== 'integration.receipt') return label(types, event.type);
  return label(labelsFor(lang, receiptTypeLabels, receiptTypeLabelsEn), event.receipt.type ?? event.receipt.eventType, label(types, event.type));
}

export function CommandDetail({ command }: { readonly command: CommandTimeline }) {
  const { lang, tr } = useLang();
  const summary = summarizeCommand(command);
  const notYet = tr('확인 전', 'Not yet');
  const durations = [
    [tr('수락에서 전송까지', 'Accepted to sent'), summary.acceptedToSentMs],
    [tr('전송에서 적용까지', 'Sent to applied'), summary.sentToAppliedMs],
    [tr('적용에서 확인까지', 'Applied to confirmed'), summary.appliedToVerifiedMs],
  ] as const;
  return <div className="stack">
    <div className="row">
      <div className="stack-tight"><h2 className="mono">{command.commandId}</h2><span className="small muted">{tr('그룹', 'Group')} <code>{command.groupId ?? notYet}</code></span></div>
      <Badge tone={summary.status === 'verified' ? 'success' : summary.status === 'failure' ? 'danger' : 'warning'}>{label(labelsFor(lang, commandStatusLabels, commandStatusLabelsEn), summary.status)}</Badge>
    </div>
    <Stages stages={command} />
    <div className="row small muted">
      <span>{tr('장치 응답(ACK)', 'Device ACK')} {summary.ackCount}/{summary.memberCount}, {tr('적용 확인(readback)', 'readback confirmed')} {summary.verifiedCount}/{summary.memberCount}, {tr('다시 시도 대기', 'waiting to retry')} {summary.retryPendingCount}</span>
      <span>{durations.map(([title, duration]) => `${title} ${duration === null ? tr('기록 없음', 'no record') : `${duration} ms`}`).join(' / ')}</span>
    </div>
    <div className="panel stack">
      <h3>{tr('장치별 응답과 적용 확인', 'Response and confirmation per device')}</h3>
      <p className="small muted">{tr('장치 응답(ACK)은 명령을 받았다는 뜻이고 실제 적용 여부는 상태 재확인(readback)으로 판단해요. 장치별 수락 시각은 데이터 규격에 들어 있지 않아서 대기로 표시해요.', 'An ACK means the device received the command; whether it was applied is decided by reading the state back (readback). Per-device accept times are not in the data contract, so they show as waiting.')}</p>
      {Object.values(command.members).length === 0 && <p>{tr('장치 응답을 기다리고 있어요.', 'Waiting for device responses.')}</p>}
      {Object.values(command.members).map((member) => <article className="member" key={member.memberId}>
        <div className="row">
          <div><h4>{member.memberId}</h4><p className="small muted">{member.deviceId}, {tr('수신기', 'receiver')} {member.gatewayId ?? notYet}</p></div>
          <div className="cluster">
            <Badge tone={member.retryPending ? 'danger' : member.readbackVerified ? 'success' : 'warning'}>
              {member.retryPending ? tr('실패, 다시 시도 대기', 'Failed, waiting to retry') : label(labelsFor(lang, ackStateLabels, ackStateLabelsEn), member.ackState, tr('응답 대기', 'Waiting for response'))}
            </Badge>
            <span className="small">{tr('적용 상태', 'Applied state')} <BooleanState value={member.readback} /></span>
          </div>
        </div>
        <code className="caption muted">{member.commandId}</code>
        <Stages stages={member} />
      </article>)}
    </div>
  </div>;
}

export function EventDetails({ events }: { readonly events: readonly DashboardEvent[] }) {
  const { lang, tr } = useLang();
  const latest = events.at(-1);
  return <details className="panel">
    <summary>{tr('받은 기록 자세히 보기', 'Show received records')}</summary>
    {latest === undefined ? <p className="muted">{tr('받은 기록이 생기면 여기에 표시돼요.', 'Records appear here once they arrive.')}</p> : <div className="stack">
      <dl>
        <dt>{tr('마지막으로 받은 시각', 'Last received')}</dt><dd><Timestamp at={latest.receivedAt} /></dd>
        <dt>{tr('자원 주소 (URI)', 'Resource URI')}</dt><dd><code>{latest.resourceUri}</code></dd>
        <dt>{tr('현재 버전 (revision)', 'Current revision')}</dt><dd>{latest.currentRevision ?? tr('서버가 버전 정보를 보내지 않았어요. 기록 번호(sequence)와는 따로 관리해요.', 'The server sent no revision. It is tracked separately from the sequence number.')}</dd>
        <dt>{tr('역할 범위', 'Role scope')}</dt><dd>{latest.roleScope.join(', ')} {tr('(화면 표시용 정보이고 권한 판단에는 쓰지 않아요)', '(display only, not used for authorization)')}</dd>
        <dt>{tr('출처', 'Source')}</dt><dd>{latest.source}, {latest.source === 'onem2m-cse-live' ? tr('oneM2M CSE 실시간 알림', 'live oneM2M CSE notification') : tr('모의 재생', 'simulated replay')}</dd>
      </dl>
      <ol className="audit-list" aria-label={tr('최근 받은 기록', 'Recent records')}>
        {events.map((event) => <li key={event.sequence}>
          <span><span className="mono muted">#{event.sequence}</span> {eventTitle(event, lang)}</span><Badge tone={event.simulation ? 'warning' : 'info'}>{event.simulation ? tr('모의', 'Simulated') : tr('실측', 'Measured')}</Badge>
          <span className="audit-meta"><Timestamp at={event.receivedAt} />, <code>{event.type}</code>, {event.resourceUri}</span>
        </li>)}
      </ol>
      <p className="caption muted">{tr('최근 100개를 보여 줘요. 명령 상태와 이어받을 위치는 전체 기록을 기준으로 유지해요.', 'Showing the latest 100. Command state and the resume point are kept from the full record.')}</p>
    </div>}
  </details>;
}

export function Audit({ refresh, integrated }: { readonly refresh: number; readonly integrated: boolean }) {
  const { lang, tr } = useLang();
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
    <div className="row"><p className="small muted">{integrated ? tr('정책, 위치 서비스, 엣지 전환, 연합 학습, 자동화 실행 기록을 검색해요.', 'Search policy, location service, edge handover, federated learning and automation records.') : tr('정책, 접근 권한, 동의 기록을 검색해 볼 수 있는 모의 데이터예요.', 'Simulated data for searching policy, access and consent records.')}</p>
      <Badge tone="warning">{integrated ? tr('통합 기록 재생', 'Integrated record replay') : tr('모의 데이터', 'Simulated data')}</Badge></div>
    <form className="row" onSubmit={(event) => { event.preventDefault(); setQuery(input); setRequest((value) => value + 1); }}>
      <div className="stack-tight" style={{ flex: '1 1 18rem' }}>
        <label>{tr('활동 기록 검색', 'Search the activity log')}
          <input type="search" value={input} onChange={(event) => setInput(event.target.value)} placeholder={tr('명령 ID, 계정, 동작으로 검색', 'Search by command ID, account or action')}
            aria-describedby="audit-search-scope" list="audit-search-suggestions" />
        </label>
        <p id="audit-search-scope" className="caption muted">{tr('계정, 명령 ID, 동작, 자원 주소에서 찾아요.', 'Searches account, command ID, action and resource URI.')}</p>
        <datalist id="audit-search-suggestions"><option value="grp-demo" /><option value="grp-partial" /><option value="demo-operator" /></datalist>
      </div>
      <button type="submit" className="primary">{tr('검색', 'Search')}</button>
    </form>
    <div className={`panel audit-results${loading ? ' loading-placeholder' : ''}`} aria-live="polite" aria-busy={loading}>
      {loading ? <><p role="status">{tr('기록을 찾고 있어요…', 'Searching records…')}</p>{[1, 2, 3, 4].map((row) => <div className="placeholder-row" aria-hidden="true" key={row} />)}</> : error !== null ?
        <p className="error" role="alert">{error} {tr('검색어를 바꾸거나 잠시 후 다시 검색해 주세요.', 'Change the search or try again in a moment.')}</p> : <>
          <p className="small muted">{tr(`검색 결과 ${records.length}개`, `${records.length} ${records.length === 1 ? 'result' : 'results'}`)}{query && `, "${query}"`}</p>
          {records.length === 0 && <p>{tr('찾는 기록이 없어요. 검색어를 지우고 전체 기록을 확인해 보세요.', 'No matching records. Clear the search to see all records.')}</p>}
          <ul className="audit-list">
            {records.map((record) => <li key={record.id}>
              <div className="stack-tight"><strong>{label(labelsFor(lang, receiptTypeLabels, receiptTypeLabelsEn), record.action)}</strong><span className="small muted">{record.actor}, {tr('명령', 'command')} {record.commandId ?? tr('해당 없음', 'none')}</span></div>
              <div className="cluster"><Badge tone="warning">{tr('모의', 'Simulated')}</Badge><Badge tone={record.outcome === 'denied' ? 'danger' : record.outcome === 'allowed' ? 'success' : 'warning'}>{label(labelsFor(lang, outcomeLabels, outcomeLabelsEn), record.outcome)}</Badge></div>
              <div className="audit-meta"><Timestamp at={record.receivedAt} /><br /><code>{record.resourceUri}</code><br />{record.id}</div>
            </li>)}
          </ul>
        </>}
    </div>
  </div>;
}
