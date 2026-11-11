import { useEffect, useState } from 'react';
import type { AuditFixture, CommandTimeline, DashboardEvent } from '../shared/index.ts';
import { summarizeCommand } from '../shared/index.ts';
import { errorMessage, fixtureAudit } from './client.ts';
import { Badge, BooleanState, Stages, Timestamp } from './ui.tsx';

const commandLabels: Readonly<Record<string, string>> = {
  pending: '대기', 'in-flight': '진행 중', partial: '부분 확인', verified: '확인 완료', failure: '실패 / 재시도 대기',
} as const;

export function CommandDetail({ command }: { readonly command: CommandTimeline }) {
  const summary = summarizeCommand(command);
  const durations = [
    ['수락 → 전송', summary.acceptedToSentMs],
    ['전송 → 적용', summary.sentToAppliedMs],
    ['적용 → 확인', summary.appliedToVerifiedMs],
  ] as const;
  return <div className="stack">
    <div className="row">
      <div className="stack-tight"><h3>{command.commandId}</h3><code className="muted">{command.groupId ?? 'Group ID 미수신'}</code></div>
      <Badge tone={summary.status === 'verified' ? 'success' : summary.status === 'failure' ? 'danger' : 'warning'}>{commandLabels[summary.status] ?? summary.status}</Badge>
    </div>
    <Stages stages={command} />
    <div className="row small muted">
      <span>ACK 관측 {summary.ackCount}/{summary.memberCount} · readback 확인 {summary.verifiedCount}/{summary.memberCount} · 재시도 대기 {summary.retryPendingCount}</span>
      <span>{durations.map(([label, duration]) => `${label} ${duration === null ? '미확인' : `${duration} ms`}`).join(' / ')}</span>
    </div>
    <div className="panel stack">
      <h3>구성원별 ACK / readback</h3>
      <p className="small muted">ACK 수신은 적용 성공과 다릅니다. 구성원 수락 시각은 계약에 없으므로 대기로 표시합니다.</p>
      {Object.values(command.members).length === 0 && <p>구성원 receipt 대기 중입니다.</p>}
      {Object.values(command.members).map((member) => <article className="member" key={member.memberId}>
        <div className="row">
          <div><h4>{member.memberId}</h4><p className="small muted">{member.deviceId} · {member.gatewayId ?? 'Gateway 미수신'}</p></div>
          <div className="cluster">
            <Badge tone={member.retryPending ? 'danger' : member.readbackVerified ? 'success' : 'warning'}>
              {member.retryPending ? '실패 / 재시도 대기' : member.ackState ?? 'ACK 대기'}
            </Badge>
            <span className="small">readback <BooleanState value={member.readback} /></span>
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
    <summary>수신 메타데이터 / 이벤트 기록</summary>
    {latest === undefined ? <p className="muted">아직 유효한 이벤트가 없습니다.</p> : <div className="stack">
      <dl>
        <dt>마지막 수신 시각</dt><dd><Timestamp at={latest.receivedAt} /></dd>
        <dt>자원 URI</dt><dd><code>{latest.resourceUri}</code></dd>
        <dt>현재 revision</dt><dd>{latest.currentRevision ?? <>미제공 · sequence로 <span className="keep-phrase">대체하지 않음</span></>}</dd>
        <dt>role scope</dt><dd>{latest.roleScope.join(', ')} · 메타데이터이며 권한 판정 아님</dd>
        <dt>원본</dt><dd>{latest.source} · 모의 replay</dd>
      </dl>
      <ol className="audit-list" aria-label="최근 수신 이벤트">
        {events.map((event) => <li key={event.sequence}>
          <span className="mono">#{event.sequence} · {event.type}</span><Badge tone="warning">모의</Badge>
          <span className="audit-meta"><Timestamp at={event.receivedAt} /> · {event.resourceUri}</span>
        </li>)}
      </ol>
      <p className="caption muted">최근 100개까지만 표시합니다. 누적 명령 상태와 재개 cursor는 유지합니다.</p>
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
    <div className="row"><p className="small muted">{integrated ? '통합 journal의 정책·MEC·handover·FL·MCP 기록을 검색합니다.' : '정책·ACP·consent 검색용 fixture입니다.'}</p><Badge tone="warning">{integrated ? '통합 journal 재생' : '모의 감사 기록'}</Badge></div>
    <form className="row" onSubmit={(event) => { event.preventDefault(); setQuery(input); setRequest((value) => value + 1); }}>
      <div className="stack-tight">
        <label>감사 기록 검색
          <input type="search" value={input} onChange={(event) => setInput(event.target.value)} placeholder="검색어 입력"
            aria-describedby="audit-search-scope" list="audit-search-suggestions" />
        </label>
        <p id="audit-search-scope" className="small muted">검색 범위: actor, commandId, action, URI</p>
        <datalist id="audit-search-suggestions"><option value="grp-demo" /><option value="grp-partial" /><option value="demo-operator" /></datalist>
      </div>
      <button type="submit">검색</button>
    </form>
    <div className={`panel audit-results${loading ? ' loading-placeholder' : ''}`} aria-live="polite" aria-busy={loading}>
      {loading ? <><p role="status">감사 기록 조회 중…</p>{[1, 2, 3, 4].map((row) => <div className="placeholder-row" aria-hidden="true" key={row} />)}</> : error !== null ?
        <p className="error" role="alert">{error} · 검색어와 서버 상태를 확인한 뒤 다시 검색하세요.</p> : <>
          <p className="small muted">{records.length}개 검색 결과{query && ` · “${query}”`}</p>
          {records.length === 0 && <p>일치하는 기록이 없습니다. 검색어를 지우고 다시 검색하세요.</p>}
          <ul className="audit-list">
            {records.map((record) => <li key={record.id}>
              <div className="stack-tight"><strong className="small">{record.action}</strong><span className="small">{record.actor} · {record.commandId ?? 'commandId 없음'}</span></div>
              <div className="cluster"><Badge tone="warning">모의</Badge><Badge tone={record.outcome === 'denied' ? 'danger' : record.outcome === 'allowed' ? 'success' : 'warning'}>{record.outcome}</Badge></div>
              <div className="audit-meta"><Timestamp at={record.receivedAt} /><br /><code>{record.resourceUri}</code><br />{record.id}</div>
            </li>)}
          </ul>
        </>}
    </div>
  </div>;
}

