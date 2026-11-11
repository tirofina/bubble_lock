import { lazy, Suspense, useEffect, useState } from 'react';
import { Icon } from './Icon.tsx';
import { Metric, PortalShell } from './PortalShell.tsx';
import { Resources } from './Resources.tsx';
import { Audit, CommandDetail, EventDetails } from './Operations.tsx';
import { Badge, Timestamp } from './ui.tsx';
import { useEventStream } from './useEventStream.ts';
import { integrationServices } from '../shared/integration.ts';
import { summarizeCommand } from '../shared/index.ts';
import { isRecord } from './client.ts';
import { useAuth } from './auth-client.tsx';
const LocationMap=lazy(()=>import('./LocationMap.tsx').then((module)=>({default:module.LocationMap})));
const commandLabels:Record<string,string>={pending:'대기', 'in-flight':'진행 중',partial:'부분 확인',verified:'확인 완료',failure:'재시도 대기'};

function Evidence() {
  const [audit,setAudit]=useState<unknown>(null);
  const [error,setError]=useState(false);
  useEffect(()=>{const controller=new AbortController();void fetch('/api/evidence',{signal:controller.signal}).then((response)=>{if(!response.ok)throw Error();return response.json();}).then(setAudit).catch(()=>{if(!controller.signal.aborted)setError(true);});return()=>controller.abort();},[]);
  const rubric=isRecord(audit)&&Array.isArray(audit['rubrics'])?audit['rubrics']:[];
  return <div className="stack"><div className="content-card"><div className="card-heading"><div><h2>구현과 검증을 구분한 기록</h2><p>ZIP 원본과 루브릭 요구사항을 코드·시험·실증 자료에 연결합니다.</p></div><Icon name="shield"/></div><div className="evidence-links"><a href="https://github.com/tirofina/bubble_lock" target="_blank" rel="noreferrer"><Icon name="file"/><span><strong>공동 개발 저장소</strong><small>소스·계약·실행 안내</small></span><Icon name="arrow"/></a><a href="/api/evidence" target="_blank" rel="noreferrer"><Icon name="activity"/><span><strong>요구사항 추적 기록</strong><small>원본 ZIP · R01–R17 · A01–A26</small></span><Icon name="arrow"/></a></div></div>
    {error?<p className="notice">요구사항 대조 기록을 준비하고 있습니다.</p>:rubric.length===0?<p className="notice">구현 감사 자료를 불러오는 중입니다.</p>:<div className="content-card"><div className="card-heading"><h2>루브릭별 현황</h2><Badge>{rubric.length}개 항목</Badge></div><div className="rubric-table">{rubric.filter(isRecord).map((item,index)=><article key={String(item['id']??index)}><span className="rubric-id">{String(item['id']??item['rubricId']??`R${index+1}`)}</span><div><h3>{String(item['title']??item['requirement']??'요구사항')}</h3><p>{String(item['design']??'상세 구현·시험 근거는 추적 기록에서 확인할 수 있습니다.')}</p></div><Badge>{String(isRecord(item['audit'])?item['audit']['status']:'대조 중')}</Badge></article>)}</div></div>}
  </div>;
}

export function OperatorDashboard({page}:{page:string}) {
  const {session}=useAuth();
  const stream=useEventStream();
  const [refresh,setRefresh]=useState(0);
  const [selectedId,setSelectedId]=useState('');
  const commands=Object.values(stream.timeline.commands);
  const selected=commands.find((command)=>command.commandId===selectedId)??commands[0];
  const services=integrationServices(stream.events);
  const latest=stream.events.at(-1);
  const connectionLabels={connecting:'연결 중',connected:'이벤트 연결됨',offline:'오프라인',disconnected:'재연결 대기',invalid:'계약 확인',resync:'재동기화 필요'};
  const verified=commands.filter((command)=>summarizeCommand(command).status==='verified').length;
  return <PortalShell role="operator" page={page} actions={<button className="button-with-icon" onClick={()=>{stream.reconnect();setRefresh((value)=>value+1);}}><Icon name="refresh" size={17}/>새로고침</button>}>
    <div className="context-strip"><span className={`connection-pill ${stream.connection==='connected'?'connected':''}`}><i/>{connectionLabels[stream.connection]}</span><span>명령·연동 영수증 재생 · sequence {stream.timeline.lastSequence}</span><Badge tone="warning">모의 관측</Badge></div>
    {stream.error&&<div className="notice error" role="alert">{stream.error}<button onClick={()=>stream.reconnect(true)}>처음부터 재동기화</button></div>}
    {page==='overview'&&<><div className="metrics-grid"><Metric label="수신 이벤트" value={stream.timeline.lastSequence} note="현재 연결된 journal 기준" icon="activity"/><Metric label="추적 중인 명령" value={commands.length} note={`${verified}개 readback 확인 완료`} icon="bolt"/><Metric label="연동 서비스" value={`${services.filter((service)=>service.receipt).length} / 4`} note="최신 receipt가 도착한 서비스" icon="server"/><Metric label="재개 커서" value={stream.timeline.lastSequence} note="다음 이벤트부터 이어받기" icon="refresh"/></div>
      <div className="operator-welcome"><div><p className="eyebrow">CONNECTED OPERATIONS</p><h2>현장의 흐름을 한눈에.</h2><p>키링 위치와 명령 처리, 연동 서비스의 상태를 확인하세요.</p><a className="button primary" href="#/operator/map">위치 지도 열기<Icon name="arrow" size={18}/></a></div><div className="network-visual" aria-hidden="true"><Icon name="server" size={44}/><i/><Icon name="bubble" size={62}/><i/><Icon name="key" size={40}/></div></div>
      <div className="two-columns"><div className="content-card"><div className="card-heading"><h2>명령 처리 현황</h2><a href="#/operator/commands">전체 보기</a></div>{commands.length?commands.map((command)=>{const summary=summarizeCommand(command);return <a className="overview-row" href="#/operator/commands" key={command.commandId}><span className="row-symbol"><Icon name="bolt"/></span><div><strong>{command.commandId}</strong><small>ACK {summary.ackCount}/{summary.memberCount} · readback {summary.verifiedCount}/{summary.memberCount}</small></div><Badge tone={summary.status==='verified'?'success':'warning'}>{commandLabels[summary.status]}</Badge></a>;}):<p className="empty-state">명령 영수증을 기다리고 있습니다.</p>}</div>
        <div className="content-card"><div className="card-heading"><h2>서비스 연결 기록</h2><a href="#/operator/services">상세 보기</a></div>{services.map((service)=><div className="overview-row" key={service.title}><span className="row-symbol"><Icon name="server"/></span><div><strong>{service.title.split(' · ')[0]}</strong><small>{service.receipt?.state??service.receipt?.action??(service.receipt?'관측 수신':'관측 대기')}</small></div><span className={`status-dot ${service.receipt?'active':''}`}/></div>)}</div></div>
      <div className="content-card"><div className="card-heading"><h2>최근 이벤트</h2><a href="#/operator/audit">감사 기록 보기</a></div><div className="recent-events">{stream.events.slice(-6).reverse().map((event)=><div key={event.sequence}><span className="event-sequence">#{event.sequence}</span><strong>{event.type==='integration.receipt'?event.receipt.type??event.receipt.eventType:event.type}</strong><span className="small muted"><Timestamp at={event.receivedAt}/></span></div>)}</div></div></>}
    {page==='map'&&<div className="content-card map-content"><Suspense fallback={<p>위치 지도를 준비하고 있습니다…</p>}><LocationMap refresh={refresh} variant="operator" locationUrl={session?.mode==='live'?'/api/portal/locations':'/api/locations'}/></Suspense></div>}
    {page==='devices'&&<div className="content-card"><Resources refresh={refresh}/></div>}
    {page==='commands'&&<div className="stack"><div className="content-card row"><div><h2>명령 타임라인</h2><p className="small muted">전송부터 장치 적용·readback 확인까지 추적합니다.</p></div><label>명령 선택<select value={selected?.commandId??''} onChange={(event)=>setSelectedId(event.target.value)} disabled={!commands.length}>{!commands.length&&<option>명령 대기</option>}{commands.map((command)=><option key={command.commandId} value={command.commandId}>{command.commandId} · {commandLabels[summarizeCommand(command).status]}</option>)}</select></label></div>{selected&&<div className="content-card"><CommandDetail command={selected}/></div>}<EventDetails events={stream.events}/></div>}
    {page==='audit'&&<div className="content-card"><Audit refresh={refresh} integrated={latest?.source==='integration-journal-replay'}/></div>}
    {page==='services'&&<div className="service-grid">{services.map((service)=><article className="content-card stack" key={service.title}><div className="card-heading"><span className="row-symbol"><Icon name="server"/></span><Badge tone={service.receipt?'success':'warning'}>{service.receipt?'receipt 수신':'수신 대기'}</Badge></div><h2>{service.title}</h2>{service.receipt?<><p className="small muted"><Timestamp at={service.receipt.timestamp}/> · 기록 재생</p><dl>{service.values.map(([label,value])=><div className="field-wide" key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl></>:<p className="small muted">통합 영수증이 도착하면 상태를 표시합니다.</p>}</article>)}</div>}
    {page==='evidence'&&<Evidence/>}
  </PortalShell>;
}
