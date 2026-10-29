import { useEffect, useState } from 'react';
import type { AuditFixture, CommandTimeline, DashboardEvent } from '../shared/index.ts';
import { summarizeCommand } from '../shared/index.ts';
import { errorMessage, fixtureAudit } from './client.ts';
import { Resources } from './Resources.tsx';
import { Badge, BooleanState, Section, Stages, Timestamp } from './ui.tsx';
import { useEventStream } from './useEventStream.ts';

const sections = [
  ['commands', '01', '명령 타임라인'],
  ['resources', '02', '자원과 장치'],
  ['audit', '03', '감사 기록'],
  ['services', '04', '연동 현황'],
  ['evidence', '05', '증거 인덱스'],
] as const;

const commandLabels: Readonly<Record<string, string>> = {
  pending: '대기', 'in-flight': '진행 중', partial: '부분 확인', verified: '확인 완료', failure: '실패 / 재시도 대기',
} as const;

function CommandDetail({ command }: { readonly command: CommandTimeline }) {
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

function EventDetails({ events }: { readonly events: readonly DashboardEvent[] }) {
  const latest = events.at(-1);
  return <details className="panel">
    <summary>수신 메타데이터 / 이벤트 기록</summary>
    {latest === undefined ? <p className="muted">아직 유효한 이벤트가 없습니다.</p> : <div className="stack">
      <dl>
        <dt>마지막 수신 시각</dt><dd><Timestamp at={latest.receivedAt} /></dd>
        <dt>자원 URI</dt><dd><code>{latest.resourceUri}</code></dd>
        <dt>현재 revision</dt><dd>{latest.currentRevision ?? '미제공 · sequence로 대체하지 않음'}</dd>
        <dt>role scope</dt><dd>{latest.roleScope.join(', ')} · 메타데이터이며 권한 판정 아님</dd>
        <dt>원본</dt><dd>{latest.source} · 모의 replay</dd>
      </dl>
      <ol className="audit-list" aria-label="최근 수신 이벤트">
        {events.map((event) => <li key={event.sequence}>
          <span className="mono">#{event.sequence} · {event.type}</span><Badge tone="warning">모의</Badge>
          <span className="audit-meta">{event.receivedAt} · {event.resourceUri}</span>
        </li>)}
      </ol>
      <p className="caption muted">최근 100개까지만 표시합니다. 누적 명령 상태와 재개 cursor는 유지합니다.</p>
    </div>}
  </details>;
}

function Audit({ refresh }: { readonly refresh: number }) {
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
    <div className="row"><p className="small muted">정책·ACP·consent 감사 API 연동 전의 검색용 fixture입니다.</p><Badge tone="warning">모의 감사 기록</Badge></div>
    <form className="row" onSubmit={(event) => { event.preventDefault(); setQuery(input); setRequest((value) => value + 1); }}>
      <label>감사 기록 검색
        <input type="search" value={input} onChange={(event) => setInput(event.target.value)} placeholder="actor, commandId, action, URI" />
      </label>
      <button type="submit">검색</button>
    </form>
    <div className="panel" aria-live="polite">
      {loading ? <p role="status">감사 기록 조회 중…</p> : error !== null ?
        <p className="error" role="alert">{error}</p> : <>
          <p className="small muted">{records.length}개 검색 결과{query && ` · “${query}”`}</p>
          {records.length === 0 && <p>일치하는 기록이 없습니다. 검색어를 지우고 다시 검색하세요.</p>}
          <ul className="audit-list">
            {records.map((record) => <li key={record.id}>
              <div className="stack-tight"><strong className="small">{record.action}</strong><span className="small">{record.actor} · {record.commandId ?? 'commandId 없음'}</span></div>
              <div className="cluster"><Badge tone="warning">모의</Badge><Badge tone={record.outcome === 'denied' ? 'danger' : record.outcome === 'allowed' ? 'success' : 'warning'}>{record.outcome}</Badge></div>
              <div className="audit-meta">{record.receivedAt}<br /><code>{record.resourceUri}</code><br />{record.id}</div>
            </li>)}
          </ul>
        </>}
    </div>
  </div>;
}

const serviceShells = [
  { title: 'MEC · Location / RNIS', fields: [['Service discovery', '미연결'], ['Subscription / callback', '미수신'], ['위치 · geofence', '관측 없음']] },
  { title: 'Handover · Edge A → B', fields: [['상태 / ownership epoch', '미수신'], ['QUIESCING → CUTOVER', '전환 receipt 없음'], ['자원 · 구독 · 보안 복원', '미검증']] },
  { title: 'FL · round / model lineage', fields: [['Participant / dataset', '미연결'], ['Task → round → model', 'artifact 미수신'], ['Model hash / parent model', 'lineage 미확인']] },
  { title: 'MCP · 승인 / 실행', fields: [['Run / checkpoint', '미연결'], ['approvalHash', '미수신'], ['oneM2M · MEC · Audit tools', '실행 없음']] },
] as const;

const repository = 'https://github.com/tirofina/bubble_lock';
const branch = `${repository}/tree/feature/web-dashboard`;
const evidence = [
  ['실행 / 재현 안내', 'web-dashboard/README.md', 'R06 · 실행 명령 및 통합 gate', '문서'],
  ['Article / 프로토콜 조사', 'web-dashboard/docs', 'R04, R07 · Article와 공식 조사', '문서'],
  ['이벤트 JSON Schema', 'web-dashboard/contracts/dashboard-event.schema.json', 'R03 · 버전 1.0.0', '계약'],
  ['계약 / SSE / 타임라인 시험', 'web-dashboard/test', 'R03, R06 · 실행 결과는 receipt 참조', '시험 코드'],
  ['HTTP / 브라우저 artifacts', 'web-dashboard/evidence', 'R06, R09 · 부모 통합 검증 산출물', '부모 검증'],
  ['공통 구현 기준', 'PROJECT_IMPLEMENTATION_RUBRIC_PLAN.md', 'DOC-REV 2.0.0 · 역할과 Rubric', '기준'],
] as const;

export function App() {
  const stream = useEventStream();
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const commands = Object.values(stream.timeline.commands);
  const selected = commands.find((command) => command.commandId === selectedId) ?? commands[0];
  const latest = stream.events.at(-1);
  const connectionLabels = {
    connecting: '연결 중', connected: 'SSE 연결됨', offline: '오프라인',
    disconnected: '연결 끊김', invalid: '계약 오류 · 중지', resync: '재동기화 필요',
  } as const;
  return <>
    <a className="skip" href="#main">본문으로 건너뛰기</a>
    <div className="app">
      <aside className="sidebar"><div className="sidebar-inner">
        <div className="brand">Privacy Bubble<small>운영 대시보드</small></div>
        <nav aria-label="대시보드 섹션">
          {sections.map(([id, number, label]) => <a key={id} href={`#${id}`}><span>{number}</span>{label}</a>)}
        </nav>
        <p className="sidebar-note">읽기 전용<br />WEB-DASHBOARD<br />DOC-REV 2.0.0</p>
      </div></aside>
      <main id="main">
        <header className="page-header">
          <div><p className="eyebrow">PRIVACY BUBBLE / OPERATIONS</p><h1>명령과 상태 확인</h1></div>
          <button className="primary" type="button" onClick={() => {
            stream.reconnect(); setRefresh((value) => value + 1);
          }}>다시 연결 / 새로고침</button>
        </header>
        <div className="connection">
          <div className="row">
            <div className="cluster" aria-live="polite">
              <Badge tone={stream.connection === 'connected' ? 'success' : 'warning'}>{connectionLabels[stream.connection]}</Badge>
              <span className="small">sequence <strong>{stream.timeline.lastSequence}</strong> · 중복/이전 이벤트 제외 {stream.timeline.ignoredEvents}</span>
            </div>
            <Badge tone="warning">{latest?.source === 'core-journal-replay' ? '모의 · CORE journal replay' : '모의 · fixture replay'}</Badge>
          </div>
          <p className="small muted">실제 SSE로 모의 receipt를 재생합니다. 장치 실물 연결이나 인증 완료를 의미하지 않습니다.</p>
          {stream.error !== null && <p className="error small" role="alert">{stream.error}</p>}
          <details><summary>재개 / 초기화 안내</summary>
            <div className="stack-tight">
              <p className="small">다시 연결은 마지막 유효 sequence 이후부터 재개합니다. 서버 snapshot이 바뀌었거나 기록이 누락되면 처음부터 읽으세요. 초기화는 이 화면의 기록만 지웁니다.</p>
              <div><button type="button" onClick={() => { setSelectedId(''); stream.reconnect(true); }}>처음부터 재동기화</button></div>
            </div>
          </details>
        </div>
        <Section id="commands" number="01" title="명령 타임라인">
          <div className="row">
            <label>명령 선택
              <select value={selected?.commandId ?? ''} disabled={commands.length === 0} onChange={(event) => setSelectedId(event.target.value)}>
                {commands.length === 0 && <option value="">명령 수신 대기</option>}
                {commands.map((command) => <option key={command.commandId} value={command.commandId}>{command.commandId} · {commandLabels[summarizeCommand(command).status] ?? '상태 미확인'}</option>)}
              </select>
            </label>
            <span className="small muted">시각 기준 UTC · receipt에 없는 시각은 대기</span>
          </div>
          {selected === undefined ?
            <p className="notice">{stream.connection === 'connecting' ? '이벤트 stream에 연결하고 있습니다…' : '수신한 명령이 없습니다. 연결 상태를 확인하거나 처음부터 재동기화하세요.'}</p> :
            <CommandDetail command={selected} />}
          <EventDetails events={stream.events} />
        </Section>
        <Section id="resources" number="02" title="자원과 장치"><Resources refresh={refresh} /></Section>
        <Section id="audit" number="03" title="감사 기록"><Audit refresh={refresh} /></Section>
        <Section id="services" number="04" title="연동 현황">
          <p className="notice">아래는 모두 모의 화면 틀입니다. MEC·handover·FL·MCP의 실제 통합, 승인 또는 실행 기능은 없습니다.</p>
          <div className="service-grid">
            {serviceShells.map((service) => <article className="panel" key={service.title}>
              <div className="row"><h3>{service.title}</h3><Badge tone="warning">모의 · 미연결</Badge></div>
              <dl>{service.fields.map(([label, value]) => <div className="field-wide" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            </article>)}
          </div>
        </Section>
        <Section id="evidence" number="05" title="증거 인덱스">
          <p className="small muted">저장소의 파일 경로를 연결합니다. 코드·문서는 시험 성공 receipt와 구분합니다. feature branch 게시 전에는 원격 링크가 없을 수 있습니다.</p>
          <table className="evidence">
            <caption className="small muted">구현·재현·공개 증거 연결표</caption>
            <thead><tr><th scope="col">산출물</th><th scope="col" className="evidence-description">연결 기준</th><th scope="col">구분</th></tr></thead>
            <tbody>{evidence.map(([label, path, description, status]) => <tr key={path}>
              <td><a href={`${branch}/${path}`} target="_blank" rel="noreferrer">{label}</a><br /><code className="caption">{path}</code></td>
              <td className="evidence-description">{description}</td><td>{status}</td>
            </tr>)}
              <tr><td>5분 미만 실물 / 모의 구분 영상</td><td className="evidence-description">R05 · 공개 artifact 미제출</td><td><Badge tone="warning">대기</Badge></td></tr>
              <tr><td>공개 기술 질문 / 응답 / 후속 기여</td><td className="evidence-description">R08 · 실제 토론 URL 미제출</td><td><Badge tone="warning">대기</Badge></td></tr>
            </tbody>
          </table>
        </Section>
        <footer>읽기 전용 · 장치 쓰기 없음 · role scope는 표시용 메타데이터 · 인증과 권한 판정은 INTEGRATION 소유</footer>
      </main>
    </div>
  </>;
}
