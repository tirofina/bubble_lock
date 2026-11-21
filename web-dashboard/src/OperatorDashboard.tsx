import { lazy, Suspense, useEffect, useState } from 'react';
import { Icon } from './Icon.tsx';
import { Metric, PortalShell } from './PortalShell.tsx';
import { Resources } from './Resources.tsx';
import { Audit, CommandDetail, EventDetails, eventTitle } from './Operations.tsx';
import { Badge, Timestamp } from './ui.tsx';
import { useEventStream } from './useEventStream.ts';
import { integrationServices } from '../shared/integration.ts';
import { summarizeCommand } from '../shared/index.ts';
import { isRecord } from './client.ts';
import { useAuth } from './auth-client.tsx';
import { commandStatusLabels, commandStatusLabelsEn, connectionLabels, connectionLabelsEn, label, serviceFieldLabels, serviceFieldLabelsEn, serviceMeta, serviceMetaEn, serviceStateLabels, serviceStateLabelsEn } from './labels.ts';
import { useLang } from './i18n.tsx';
import { EdgeRelocation } from './EdgeRelocation.tsx';
import { AgentRuns } from './AgentRuns.tsx';
import { KeyringEnrollment } from './KeyringEnrollment.tsx';
import { CseAccess } from './CseAccess.tsx';
import { rubricDesignEn, rubricStatusEn } from './rubric-en.ts';
import { GroupCommandsPanel } from './Caregiver.tsx';
import { TriageAudit, useAlertFeed } from './GuardianAlerts.tsx';
import { OperatorMobiusBrowser } from './OperatorMobiusBrowser.tsx';
const LocationMap = lazy(() => import('./LocationMap.tsx').then((module) => ({ default: module.LocationMap })));

function Evidence() {
  const { tr, lang } = useLang();
  const [audit, setAudit] = useState<unknown>(null);
  const [error, setError] = useState(false);
  useEffect(() => { const controller = new AbortController(); void fetch('/api/evidence', { signal: controller.signal }).then((response) => { if (!response.ok) throw Error(); return response.json(); }).then(setAudit).catch(() => { if (!controller.signal.aborted) setError(true); }); return () => controller.abort(); }, []);
  const rubric = isRecord(audit) && Array.isArray(audit['rubrics']) ? audit['rubrics'] : [];
  return <div className="stack"><div className="content-card"><div className="card-heading"><div><h2>{tr('요구사항과 근거', 'Requirements and evidence')}</h2><p>{tr('요구사항마다 코드, 시험, 실증 자료를 연결해 두었어요.', 'Each requirement links to its code, tests and field evidence.')}</p></div><Icon name="shield" /></div>
    <div className="evidence-links"><a href="https://github.com/tirofina/bubble_lock" target="_blank" rel="noreferrer"><Icon name="file" /><span><strong>{tr('소스 저장소', 'Source repository')}</strong><small>{tr('코드, 데이터 규격, 실행 방법', 'Code, data contracts, how to run')}</small></span><Icon name="arrow" /></a>
      <a href="/api/evidence" target="_blank" rel="noreferrer"><Icon name="activity" /><span><strong>{tr('요구사항 추적 기록', 'Requirement trace')}</strong><small>{tr('원본 ZIP, R01-R17, A01-A26', 'Source ZIP, R01-R17, A01-A26')}</small></span><Icon name="arrow" /></a></div></div>
    {error ? <p className="notice error" role="alert">{tr('진행 현황을 받아오는 중에 문제가 생겼어요. 새로고침해 주세요.', 'The status could not be loaded. Please refresh.')}</p> : rubric.length === 0 ? <p className="notice" role="status">{tr('진행 현황을 불러오고 있어요…', 'Loading status…')}</p> :
      <div className="content-card"><div className="card-heading"><h2>{tr('요구사항별 현황', 'Status by requirement')}</h2><Badge>{tr(`${rubric.length}개 항목`, `${rubric.length} items`)}</Badge></div><div className="rubric-table">{rubric.filter(isRecord).map((item, index) =>
        <a className="rubric-row" href="/api/evidence" target="_blank" rel="noreferrer" key={String(item['id'] ?? index)}><span className="rubric-id">{String(item['id'] ?? item['rubricId'] ?? `R${index + 1}`)}</span>
          <div><h3>{String(item['title'] ?? item['requirement'] ?? tr('요구사항', 'Requirement'))}</h3><p>{String((lang === 'en' ? rubricDesignEn[String(item['id'])] : undefined) ?? item['design'] ?? tr('자세한 근거는 요구사항 추적 기록에서 볼 수 있어요.', 'See the requirement trace for details.'))}</p></div>
          <Badge>{(() => { const status = String(isRecord(item['audit']) ? item['audit']['status'] : tr('확인 중', 'Checking')); return lang === 'en' ? rubricStatusEn[status] ?? status : status; })()}</Badge></a>)}</div></div>}
  </div>;
}

export function OperatorDashboard({ page }: { page: string }) {
  const { session } = useAuth();
  const { lang, tr } = useLang();
  const en = lang === 'en';
  const stream = useEventStream();
  const alertFeed = useAlertFeed(page === 'services' || page === 'audit' ? '/api/alerts/events' : null);
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const commands = Object.values(stream.timeline.commands);
  const selected = commands.find((command) => command.commandId === selectedId) ?? commands[0];
  const metaMap = en ? serviceMetaEn : serviceMeta;
  const services = integrationServices(stream.events).map((service) => ({ ...service, meta: metaMap[service.prefix] ?? { label: service.title, description: '' } }));
  const latest = stream.events.at(-1);
  const verified = commands.filter((command) => summarizeCommand(command).status === 'verified').length;
  const processing = commands.length - verified;
  const connected = stream.connection === 'connected';
  const live = latest?.source === 'onem2m-cse-live';
  const connectionText = label(en ? connectionLabelsEn : connectionLabels, stream.connection);
  return <PortalShell role="operator" page={page} actions={<button className="primary" onClick={() => { stream.reconnect(); alertFeed.reconnect(); setRefresh((value) => value + 1); }}><Icon name="refresh" size={17} />{tr('새로고침', 'Refresh')}</button>}>
    <div className="operator-live-layout"><section className="operator-workspace" aria-label={tr('운영자 작업 화면', 'Operator workspace')}>
    <div className="context-strip" role="status"><span className={`connection-pill${connected ? ' connected' : ''}`}><i />{connectionText}</span>
      <span>{live ? tr('oneM2M CSE 알림을 실시간으로 받고 있어요.', 'Receiving oneM2M CSE notifications live.') : tr('명령과 서비스 기록을 재생하고 있어요.', 'Replaying command and service records.')} {tr(`지금까지 ${stream.timeline.lastSequence}번째 기록을 받았어요.`, `${stream.timeline.lastSequence} records received so far.`)}</span><Badge tone={latest?.simulation === false ? 'info' : 'warning'}>{live ? (latest?.simulation === false ? tr('실제 CSE', 'Real CSE') : tr('모의 장치, 실제 CSE', 'Simulated devices, real CSE')) : tr('모의 데이터', 'Simulated data')}</Badge></div>
    {stream.error && <div className="notice error" role="alert">{stream.error}<button onClick={() => stream.reconnect(true)}>{tr('처음부터 다시 받기', 'Reload from the start')}</button></div>}
    {page === 'overview' && <>
      <div className="operator-welcome"><div><p className="eyebrow">{tr('운영 현황', 'Operations')}</p><h2>{tr('현장 상태와 처리 흐름', 'Field status and command flow')}</h2><p>{tr('키링 위치, 명령 처리, 연결 서비스 상태를 확인하세요.', 'Keyring locations, command handling and connected services.')}</p>
        <a className="button primary" href="#/operator/map">{tr('위치 지도 열기', 'Open the location map')}<Icon name="arrow" size={18} /></a></div>
        <div className="network-visual" aria-hidden="true"><Icon name="server" size={44} /><i /><Icon name="bubble" size={60} /><i /><Icon name="key" size={40} /></div></div>
      <div className="metrics-grid">
        <Metric href="#/operator/audit" label={tr('받은 기록', 'Records received')} value={stream.timeline.lastSequence} note={live ? tr('CSE 알림과 재동기화로 받은 기록 수예요.', 'Records from CSE notifications and resyncs.') : tr('연결 기록 파일을 기준으로 센 숫자예요.', 'Counted from the integration journal.')} icon="activity" />
        <Metric href="#/operator/commands" label={tr('처리 중인 명령', 'Commands')} value={processing} note={tr(`${verified}개 적용 확인 완료`, `${verified} confirmed applied`)} icon="bolt" />
        <Metric href="#/operator/services" label={tr('연결 서비스', 'Connected services')} value={`${services.filter((service) => service.receipt).length} / ${services.length}`} note={tr('최근 응답이 온 서비스 수예요.', 'Services that responded recently.')} icon="server" />
        <Metric onClick={() => { stream.reconnect(); alertFeed.reconnect(); setRefresh((value) => value + 1); }} label={tr('연결 상태', 'Connection')} value={connectionText} compact note={tr('누르면 다시 연결해요. 끊기면 마지막 기록 다음부터 이어서 받아요.', 'Select to reconnect. After a drop it resumes from the last record.')} icon="refresh" />
      </div>
      <div className="two-columns">
        <div className="content-card"><div className="card-heading"><h2>{tr('명령 처리 현황', 'Command status')}</h2><a href="#/operator/commands">{tr('전체 보기', 'See all')}</a></div>
          {commands.length ? commands.map((command) => { const summary = summarizeCommand(command); return <a className="overview-row" href="#/operator/commands" key={command.commandId} onClick={() => setSelectedId(command.commandId)}>
            <span className="row-symbol"><Icon name="bolt" /></span><div><strong className="mono">{command.commandId}</strong><small>{tr(`장치 응답 ${summary.ackCount}/${summary.memberCount}, 적용 확인 ${summary.verifiedCount}/${summary.memberCount}`, `Device ACK ${summary.ackCount}/${summary.memberCount}, applied ${summary.verifiedCount}/${summary.memberCount}`)}</small></div>
            <Badge tone={summary.status === 'verified' ? 'success' : summary.status === 'failure' ? 'danger' : 'warning'}>{label(en ? commandStatusLabelsEn : commandStatusLabels, summary.status)}</Badge></a>; })
            : <p className="empty-state">{tr('명령이 들어오면 여기에 표시돼요.', 'Commands appear here as they arrive.')}</p>}</div>
        <div className="content-card"><div className="card-heading"><h2>{tr('연결 서비스', 'Connected services')}</h2><a href="#/operator/services">{tr('자세히 보기', 'Details')}</a></div>
          {services.map((service) => <a className="overview-row" href="#/operator/services" key={service.prefix}><span className="row-symbol"><Icon name="server" /></span>
            <div><strong>{service.meta.label}</strong><small>{service.receipt ? label(en ? serviceStateLabelsEn : serviceStateLabels, service.receipt.state ?? service.receipt.action, tr('응답 받음', 'Responded')) : tr('응답 기다리는 중', 'Waiting for a response')}</small></div>
            <span className={`status-dot${service.receipt ? ' active' : ''}`} aria-hidden="true" /></a>)}</div>
      </div>
      <div className="content-card"><div className="card-heading"><h2>{tr('최근 기록', 'Recent records')}</h2><a href="#/operator/audit">{tr('활동 기록 보기', 'Open the activity log')}</a></div>
        <div className="recent-events">{stream.events.length === 0 ? <p className="empty-state">{tr('받은 기록이 생기면 여기에 표시돼요.', 'Records appear here as they arrive.')}</p> : stream.events.slice(-6).reverse().map((event) =>
          <a href="#/operator/commands" key={event.sequence}><span className="event-sequence">#{event.sequence}</span><strong>{eventTitle(event, lang)}</strong><span className="small muted"><Timestamp at={event.receivedAt} /></span></a>)}</div></div>
    </>}
    {page === 'map' && <div className="content-card map-content"><Suspense fallback={<p role="status">{tr('지도를 불러오고 있어요…', 'Loading the map…')}</p>}><LocationMap refresh={refresh} variant="operator" locationUrl={session?.mode === 'live' ? '/api/portal/locations' : '/api/locations'} /></Suspense></div>}
    {page === 'devices' && <div className="stack"><KeyringEnrollment refresh={refresh} /><div className="content-card"><Resources refresh={refresh} /></div></div>}
    {page === 'commands' && <div className="stack">
      <div className="content-card row"><div><h2>{tr('명령 진행 과정', 'Command progress')}</h2><p className="card-note">{tr('명령을 보낸 뒤 장치에 적용되고 상태가 다시 확인될 때까지 단계별로 보여 줘요.', 'Each step from sending a command until the device applies it and its state is read back.')}</p></div>
        <label>{tr('명령 선택', 'Command')}<select value={selected?.commandId ?? ''} onChange={(event) => setSelectedId(event.target.value)} disabled={!commands.length}>{!commands.length && <option>{tr('명령을 기다리는 중', 'Waiting for commands')}</option>}
          {commands.map((command) => <option key={command.commandId} value={command.commandId}>{command.commandId} ({label(en ? commandStatusLabelsEn : commandStatusLabels, summarizeCommand(command).status)})</option>)}</select></label></div>
      <GroupCommandsPanel />
      {selected && <div className="content-card"><CommandDetail command={selected} /></div>}
      <EventDetails events={stream.events} />
    </div>}
    {page === 'audit' && <div className="stack"><div className="two-columns"><AgentRuns /><TriageAudit feed={alertFeed} /></div><div className="content-card"><Audit refresh={refresh} integrated={latest?.source === 'integration-journal-replay'} /></div></div>}
    {page === 'services' && <div className="stack services-page"><CseAccess refresh={refresh} /><div className="two-columns"><EdgeRelocation events={stream.events} /><TriageAudit feed={alertFeed} /></div>
    <div className="service-grid">{services.map((service) => <article className="content-card stack" key={service.prefix}>
      <div className="card-heading"><span className="row-symbol"><Icon name="server" /></span><Badge tone={service.receipt ? 'success' : 'warning'}>{service.receipt ? tr('응답 받음', 'Responded') : tr('응답 기다리는 중', 'Waiting for a response')}</Badge></div>
      <div><h2>{service.meta.label}</h2><p className="card-note">{service.meta.description}</p></div>
      {service.receipt ? <><p className="small muted"><Timestamp at={service.receipt.timestamp} />, {live ? tr('실시간', 'live') : tr('기록 재생', 'replayed')}</p>
        <dl>{service.values.map(([name, value]) => <div key={name}><dt>{label(en ? serviceFieldLabelsEn : serviceFieldLabels, name)}</dt><dd>{['state', 'status', 'allowed'].includes(name) ? label(en ? serviceStateLabelsEn : serviceStateLabels, value) : <code>{value}</code>}</dd></div>)}</dl></>
        : <p className="small muted">{tr('서비스 응답이 오면 상태를 보여 드려요.', 'The status appears when the service responds.')}</p>}
    </article>)}</div></div>}
    {page === 'evidence' && <Evidence />}
    </section><OperatorMobiusBrowser refresh={refresh} /></div>
  </PortalShell>;
}
