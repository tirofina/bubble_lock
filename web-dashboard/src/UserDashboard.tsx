import { lazy, Suspense, useState } from 'react';
import { Icon } from './Icon.tsx';
import { Metric, PortalShell } from './PortalShell.tsx';
import { Badge, Timestamp } from './ui.tsx';
import { usePortal } from './portal-client.ts';
import { useAuth } from './auth-client.tsx';
import type { PortalController } from './portal-client.ts';
const LocationMap = lazy(() => import('./LocationMap.tsx').then((module) => ({default:module.LocationMap})));
const stateLabels: Record<string,string> = {ACTIVE:'사용 중',REVOKED:'회수 완료',EXPIRED:'기간 종료',INACTIVE:'동의 확인 필요',PENDING:'승인 대기',PARTIAL:'일부 등록 · 재시도',QUEUED:'실행 대기열',OPEN:'접수',RESOLVED:'처리 완료'};
const statusName = (status:string) => stateLabels[status] ?? status;

function Empty({children}: {children:React.ReactNode}) { return <div className="empty-state"><Icon name="bubble" size={30}/><p>{children}</p></div>; }
function HouseholdSelect({portal,value,onChange}: {portal:PortalController;value:string;onChange:(value:string)=>void}) {
  return <label>가족 공간<select value={value} onChange={(event)=>onChange(event.target.value)} required><option value="">공간 선택</option>{portal.snapshot?.households.map((house)=> <option key={house.householdId} value={house.householdId}>{house.name}</option>)}</select></label>;
}

function Devices({portal}: {portal:PortalController}) {
  const [householdId,setHouseholdId]=useState('');
  return <div className="stack">
    <div className="content-card"><div className="card-heading"><div><h2>우리 가족과 키링</h2><p>공간별로 연결된 키링을 관리하세요.</p></div><Icon name="users"/></div>
      {portal.snapshot?.households.map((house)=> <div className="household-block" key={house.householdId}><div className="row"><h3>{house.name}</h3><Badge>{house.members.length}명 연결</Badge></div>
        <div className="device-card-grid">{portal.snapshot?.devices.filter((device)=>device.householdId===house.householdId).map((device)=> <article className="mini-device" key={device.deviceId}><span className="device-glyph"><Icon name="key" size={25}/></span><div><h4>{device.label}</h4><p>{device.deviceId}</p><small>{device.gatewayId}</small></div><a href="#/user/map" aria-label={`${device.label} 위치 지도`}><Icon name="arrow"/></a></article>)}</div>
        {portal.snapshot?.devices.every((device)=>device.householdId!==house.householdId)&&<Empty>키링을 등록하면 이 공간에 표시됩니다.</Empty>}
      </div>)}
      {portal.snapshot?.households.length===0&&<Empty>첫 가족 공간을 만들어 보세요.</Empty>}
    </div>
    {portal.snapshot?.principal.role==='guardian'&&<div className="two-columns"><form className="content-card stack" onSubmit={async(event)=>{event.preventDefault(); const form=event.currentTarget; const values=new FormData(form); if(await portal.action('households',{name:values.get('name')},'가족 공간을 만들었습니다.'))form.reset();}}><div className="card-heading"><h2>가족 공간 만들기</h2><Icon name="plus"/></div><label>공간 이름<input name="name" required maxLength={80} placeholder="예: 우리 가족"/></label><button className="primary" disabled={portal.pending}>공간 만들기</button></form>
      <form className="content-card stack" onSubmit={async(event)=>{event.preventDefault();const form=event.currentTarget;const values=new FormData(form);if(await portal.action('devices',{householdId,deviceId:values.get('deviceId'),gatewayId:values.get('gatewayId'),label:values.get('label')},'키링을 등록했습니다.'))form.reset();}}><div className="card-heading"><h2>키링 연결</h2><Icon name="key"/></div><HouseholdSelect portal={portal} value={householdId} onChange={setHouseholdId}/><div className="field-grid"><label>키링 이름<input name="label" required maxLength={80} placeholder="키링 이름"/></label><label>장치 ID<input name="deviceId" required placeholder="keyring-A"/></label></div><label>등록된 수신기 ID<input name="gatewayId" required defaultValue="pi-01"/></label><button className="primary" disabled={portal.pending||!householdId}>키링 연결하기</button></form></div>}
  </div>;
}

function Privacy({portal}: {portal:PortalController}) {
  const [householdId,setHouseholdId]=useState('');
  const [consentId,setConsentId]=useState('');
  const guardian=portal.snapshot?.principal.role==='guardian';
  const consents=portal.snapshot?.consents??[];
  return <div className="stack">
    <div className="privacy-banner"><Icon name="shield" size={35}/><div><h2>공유 범위는 내가 선택해요.</h2><p>목적과 유효기간을 확인하고, 필요한 권한만 승인하세요.</p></div></div>
    {guardian&&<div className="two-columns"><form className="content-card stack" onSubmit={async(event)=>{event.preventDefault();const values=new FormData(event.currentTarget);await portal.action('consents',{householdId,purpose:values.get('purpose'),scopes:values.getAll('scopes'),ttlSec:Number(values.get('ttlSec'))},'동의 내용을 저장했습니다.');}}><div className="card-heading"><h2>새로운 동의</h2><Icon name="file"/></div><HouseholdSelect portal={portal} value={householdId} onChange={setHouseholdId}/><label>사용 목적<input name="purpose" required maxLength={180} placeholder="예: 가족 외출 중 위치 확인"/></label><fieldset><legend>동의할 범위</legend><label className="check-label"><input type="checkbox" name="scopes" value="location:read" defaultChecked/>위치 조회</label><label className="check-label"><input type="checkbox" name="scopes" value="bubble:command" defaultChecked/>키링 명령</label></fieldset><label>유효기간<select name="ttlSec" defaultValue="3600"><option value="900">15분</option><option value="3600">1시간</option><option value="86400">24시간</option></select></label><button className="primary" disabled={portal.pending||!householdId}>동의 저장</button></form>
      <form className="content-card stack" onSubmit={async(event)=>{event.preventDefault();const values=new FormData(event.currentTarget);const consent=consents.find((item)=>item.consentId===consentId);if(consent)await portal.action('grants',{consentId,scopes:consent.scopes,ttlSec:Number(values.get('ttlSec'))},'선택한 동의에 실행 권한을 승인했습니다.');}}><div className="card-heading"><h2>권한 승인</h2><Icon name="check"/></div><p className="small muted">저장한 동의 범위 안에서 실행 권한과 기간을 정합니다.</p><label>동의 선택<select value={consentId} onChange={(event)=>setConsentId(event.target.value)} required><option value="">동의 선택</option>{consents.filter((item)=>item.effectiveStatus==='ACTIVE').map((item)=><option key={item.consentId} value={item.consentId}>{item.purpose}</option>)}</select></label><label>권한 유효기간<select name="ttlSec" defaultValue="900"><option value="300">5분</option><option value="900">15분</option><option value="3600">1시간</option></select></label><button className="primary" disabled={portal.pending||!consentId}>권한 승인</button></form></div>}
    <div className="content-card stack"><div className="card-heading"><h2>나의 동의와 권한</h2><Badge>{consents.length}개 동의</Badge></div>
      {consents.map((consent)=><article className="permission-item" key={consent.consentId}><div className="row"><h3>{consent.purpose}</h3><Badge tone={consent.effectiveStatus==='ACTIVE'?'success':''}>{statusName(consent.effectiveStatus)}</Badge></div><p className="small muted">{consent.scopes.map((scope)=>scope==='location:read'?'위치 조회':scope==='bubble:command'?'키링 명령':scope).join(' · ')}</p><div className="row"><p className="small">종료 <Timestamp at={consent.expiresAt}/></p>{guardian&&consent.effectiveStatus==='ACTIVE'&&<button disabled={portal.pending} onClick={()=>void portal.action('consents/revoke',{consentId:consent.consentId},'동의와 연결 권한을 회수했습니다.')}>동의 회수</button>}</div>
        {portal.snapshot?.grants.filter((grant)=>grant.consentId===consent.consentId).map((grant)=><div className="grant-row" key={grant.grantId}><div><strong className="small">실행 권한 · {statusName(grant.effectiveStatus)}</strong><p className="caption muted">{grant.scopes.join(' · ')}</p></div>{guardian&&grant.effectiveStatus==='ACTIVE'&&<button disabled={portal.pending} onClick={()=>void portal.action('grants/revoke',{grantId:grant.grantId},'실행 권한을 회수했습니다.')}>권한 회수</button>}</div>)}
      </article>)}{consents.length===0&&<Empty>저장한 동의가 여기에 표시됩니다.</Empty>}
    </div>
  </div>;
}

function CommandActions({portal}: {portal:PortalController}) {
  const [householdId,setHouseholdId]=useState('');
  const [grantId,setGrantId]=useState('');
  const snapshot=portal.snapshot;
  return <div className="two-columns"><form className="content-card stack" onSubmit={async(event)=>{event.preventDefault();const values=new FormData(event.currentTarget);await portal.action('commands/request',{householdId,deviceIds:values.getAll('deviceIds'),desiredState:{state:values.get('state')==='on'},reason:values.get('reason'),ttlSec:300},'명령 승인 요청을 접수했습니다.');}}><div className="card-heading"><h2>키링 동작 요청</h2><Icon name="bolt"/></div><HouseholdSelect portal={portal} value={householdId} onChange={setHouseholdId}/><fieldset><legend>키링 선택</legend>{snapshot?.devices.filter((item)=>item.householdId===householdId).map((device)=><label className="check-label" key={device.deviceId}><input name="deviceIds" type="checkbox" value={device.deviceId}/>{device.label}</label>)}</fieldset><label>동작<select name="state"><option value="on">프라이버시 보호 켜기</option><option value="off">프라이버시 보호 끄기</option></select></label><label>요청 이유<input name="reason" required maxLength={160} placeholder="예: 가족 외출 시작"/></label><button className="primary" disabled={portal.pending||!householdId}>승인 요청</button></form>
    <div className="content-card stack"><div className="card-heading"><h2>승인과 실행 상태</h2><Icon name="activity"/></div>{snapshot?.principal.role==='guardian'&&<label>승인에 사용할 권한<select value={grantId} onChange={(event)=>setGrantId(event.target.value)}><option value="">실행 권한 선택</option>{snapshot.grants.filter((grant)=>grant.effectiveStatus==='ACTIVE'&&grant.scopes.includes('bubble:command')).map((grant)=><option key={grant.grantId} value={grant.grantId}>{snapshot.consents.find((consent)=>consent.consentId===grant.consentId)?.purpose??grant.subjectId}</option>)}</select></label>}
      {snapshot?.commandRequests.map((request)=><article className="request-row" key={request.requestId}><div className="row"><strong>{request.desiredState.state?'보호 켜기':'보호 끄기'}</strong><Badge tone={request.status==='QUEUED'?'info':'warning'}>{statusName(request.effectiveStatus)}</Badge></div><p className="small muted">{request.deviceIds.join(', ')} · {request.reason}</p>{['PENDING','PARTIAL'].includes(request.effectiveStatus)&&snapshot.principal.role==='guardian'&&<button className="primary" disabled={portal.pending||!grantId} onClick={()=>void portal.action('commands/approve',{requestId:request.requestId,grantId},'승인한 명령을 실행 대기열에 등록했습니다.')}>명령 승인</button>}</article>)}
      {snapshot?.commandRequests.length===0&&<Empty>요청한 명령의 진행 상태가 여기에 표시됩니다.</Empty>}<p className="small muted">장치의 적용 결과는 ACK와 readback 수신으로 확인합니다.</p>
    </div>
  </div>;
}

function LocationSharing({portal}:{portal:PortalController}) {
  const [grantId,setGrantId]=useState('');
  const [incidentId,setIncidentId]=useState('');
  const snapshot=portal.snapshot;
  const guardian=snapshot?.principal.role==='guardian';
  const grants=snapshot?.grants.filter((grant)=>grant.effectiveStatus==='ACTIVE'&&grant.scopes.includes('location:read'))??[];
  const grant=grants.find((item)=>item.grantId===grantId);
  const household=snapshot?.households.find((item)=>item.householdId===grant?.subjectId);
  const purpose=snapshot?.consents.find((item)=>item.consentId===grant?.consentId)?.purpose??'';
  const incident=snapshot?.incidents.find((item)=>item.incidentId===incidentId);
  const recipients=household?[...new Set([household.ownerId,...household.members.map((item)=>item.principalId)])]:[];
  const leases=snapshot?.locationLeases??[];
  return <div className="two-columns">{guardian&&<form className="content-card stack" onSubmit={async(event)=>{
    event.preventDefault();const values=new FormData(event.currentTarget);
    await portal.action('location-leases',{grantId,recipientId:values.get('recipientId'),deviceIds:values.getAll('deviceIds'),purpose,incidentId:values.get('incidentId'),ttlSec:Number(values.get('ttlSec'))},'선택한 대상과 기간으로 위치 조회를 승인했습니다.');
  }}><div className="card-heading"><div><h2>위치 공유 승인</h2><p>도움 요청의 목적에 맞춰 조회 대상과 기간을 선택하세요.</p></div><Icon name="shield"/></div>
    <label>위치 조회 동의<select value={grantId} onChange={(event)=>{setGrantId(event.target.value);setIncidentId('');}} required><option value="">권한 선택</option>{grants.map((item)=><option key={item.grantId} value={item.grantId}>{snapshot?.consents.find((consent)=>consent.consentId===item.consentId)?.purpose??item.subjectId}</option>)}</select></label>
    {grants.length===0&&<p className="small muted"><a href="#/user/privacy">동의와 권한</a>에서 위치 조회를 승인하세요.</p>}
    <div key={grantId} className="stack"><label>관련 도움 요청<select name="incidentId" value={incidentId} onChange={(event)=>setIncidentId(event.target.value)} required><option value="">요청 선택</option>{snapshot?.incidents.filter((item)=>item.householdId===household?.householdId&&item.status==='OPEN').map((item)=><option key={item.incidentId} value={item.incidentId}>{item.message}</option>)}</select></label>
      <label>위치를 볼 사람<select name="recipientId" required><option value="">대상 선택</option>{recipients.map((id)=><option key={id} value={id}>{id===snapshot?.principal.principalId?'나':id}</option>)}</select></label>
      <fieldset key={incidentId}><legend>공유할 키링</legend>{snapshot?.devices.filter((item)=>item.householdId===household?.householdId&&(!incident?.deviceId||item.deviceId===incident.deviceId)).map((item)=><label className="check-label" key={item.deviceId}><input type="checkbox" name="deviceIds" value={item.deviceId}/>{item.label}</label>)}</fieldset>
      <label>조회 기간<select name="ttlSec" defaultValue="180"><option value="60">1분</option><option value="180">3분</option><option value="300">5분</option></select></label></div>
    <button className="primary" disabled={portal.pending||!grant}>위치 공유 승인</button><a className="small" href="#/user/activity">도움 요청 만들기</a>
  </form>}
    <div className="content-card stack"><div className="card-heading"><h2>위치 공유 기록</h2><Icon name="activity"/></div>{leases.map((lease)=>{
      const status=lease.effectiveStatus??(lease.status==='ACTIVE'&&Date.parse(lease.expiresAt)<=Date.now()?'EXPIRED':lease.status);
      return <article className="permission-item" key={lease.leaseId}><div className="row"><strong>{lease.purpose}</strong><Badge tone={status==='ACTIVE'?'success':''}>{statusName(status)}</Badge></div><p className="small muted">{lease.recipientId===snapshot?.principal.principalId?'나에게 공유':lease.recipientId} · {lease.deviceIds.map((id)=>snapshot?.devices.find((item)=>item.deviceId===id)?.label??id).join(', ')}</p><div className="row"><p className="small">종료 <Timestamp at={lease.expiresAt}/></p>{status==='ACTIVE'&&<button disabled={portal.pending} onClick={()=>void portal.action('location-leases/revoke',{leaseId:lease.leaseId},'선택한 위치 공유를 종료했습니다.')}>공유 종료</button>}</div></article>;
    })}{leases.length===0&&<Empty>승인한 위치 공유 내역이 여기에 표시됩니다.</Empty>}<p className="small muted">조회 기간과 도움 요청 상태, 현재 동의 범위를 함께 확인합니다.</p></div>
  </div>;
}

function Activity({portal}: {portal:PortalController}) {
  const [householdId,setHouseholdId]=useState('');
  return <div className="stack"><CommandActions portal={portal}/><div className="two-columns"><form className="content-card stack" onSubmit={async(event)=>{event.preventDefault();const values=new FormData(event.currentTarget);await portal.action('incidents',{householdId,kind:values.get('kind'),message:values.get('message')},'도움 요청을 가족 공간에 전달했습니다.');}}><div className="card-heading"><h2>도움 요청</h2><Icon name="bell"/></div><HouseholdSelect portal={portal} value={householdId} onChange={setHouseholdId}/><label>요청 종류<select name="kind"><option value="HELP">도움이 필요해요</option><option value="LOST">키링을 찾고 있어요</option><option value="SAFETY">안전을 확인해 주세요</option></select></label><label>내용<textarea name="message" required rows={3} maxLength={500} placeholder="가족에게 전달할 내용을 입력하세요."/></label><button className="primary" disabled={portal.pending||!householdId}>요청 보내기</button></form>
      <div className="content-card stack"><div className="card-heading"><h2>가족 요청 기록</h2><Icon name="users"/></div>{portal.snapshot?.incidents.map((incident)=><article className="request-row" key={incident.incidentId}><div className="row"><strong>{incident.message}</strong><Badge>{statusName(incident.status)}</Badge></div><p className="small muted"><Timestamp at={incident.createdAt}/></p>{incident.status==='OPEN'&&portal.snapshot?.principal.role==='guardian'&&<button disabled={portal.pending} onClick={()=>void portal.action('incidents/resolve',{incidentId:incident.incidentId},'요청을 처리 완료로 기록했습니다.')}>처리 완료</button>}</article>)}{portal.snapshot?.incidents.length===0&&<Empty>가족의 요청이 여기에 모입니다.</Empty>}</div></div>
      <div className="content-card stack"><div className="card-heading"><h2>알림</h2><Icon name="bell"/></div>{portal.snapshot?.notifications.map((item)=><article className="notification-row" key={item.notificationId}><span className={`notification-dot ${item.readAt?'read':''}`}/><div><strong>{item.title}</strong><p className="small muted"><Timestamp at={item.createdAt}/></p></div>{!item.readAt&&<button disabled={portal.pending} onClick={()=>void portal.action('notifications/read',{notificationId:item.notificationId},'알림을 확인했습니다.')}>읽음 표시</button>}</article>)}{portal.snapshot?.notifications.length===0&&<Empty>새로운 소식이 도착하면 알려드릴게요.</Empty>}</div>
    </div>;
}

export function UserDashboard({page}: {page:string}) {
  const [role,setRole]=useState<'guardian'|'visitor'>('guardian');
  const portal=usePortal(role);
  const auth=useAuth();
  const snapshot=portal.snapshot;
  return <PortalShell role="user" page={page} actions={<div className="cluster">{auth.session?.mode==='demo'&&<label className="compact-label">체험 역할<select value={role} onChange={(event)=>setRole(event.target.value as typeof role)}><option value="guardian">보호자</option><option value="visitor">방문자</option></select></label>}<button className="icon-button" onClick={portal.reload} aria-label="사용자 상태 새로고침"><Icon name="refresh"/></button></div>}>
    <div className="context-strip"><span className="environment-tag"><i/>{portal.data?.mode==='live'?'연결된 계정':'사용자 체험 · 모의 환경'}</span><span>가족의 동의와 현재 권한을 기준으로 요청을 처리합니다.</span></div>
    {portal.error&&<div className="notice error" role="alert">{portal.error}</div>}{portal.notice&&<div className="notice success-notice" role="status"><Icon name="check"/>{portal.notice}</div>}
    {page==='overview'&&<><div className="user-greeting"><div><p className="eyebrow">MY PRIVACY, MY CHOICE</p><h2>나와 가족의 연결을<br/>차분하게 살펴보세요.</h2><p>키링 위치부터 동의와 알림까지, 필요한 순간에 한눈에.</p><a className="button primary" href="#/user/map">키링 위치 보기<Icon name="arrow" size={18}/></a></div><div className="greeting-bubble" aria-hidden="true"><Icon name="shield" size={68}/></div></div>
      <div className="metrics-grid"><Metric label="연결된 키링" value={snapshot?.devices.length??'—'} note="가족 공간에 등록된 장치" icon="key"/><Metric label="사용 중인 권한" value={snapshot?.grants.filter((grant)=>grant.effectiveStatus==='ACTIVE').length??'—'} note="동의 범위 안의 실행 권한" icon="shield"/><Metric label="확인할 알림" value={snapshot?.notifications.filter((item)=>!item.readAt).length??'—'} note="내 계정에 도착한 소식" icon="bell"/></div>
      <div className="content-card"><div className="card-heading"><div><h2>빠른 시작</h2><p>오늘 필요한 일부터 시작하세요.</p></div></div><div className="quick-actions"><a href="#/user/devices"><Icon name="users"/><strong>가족과 키링 연결</strong><Icon name="arrow"/></a><a href="#/user/privacy"><Icon name="shield"/><strong>동의와 권한 관리</strong><Icon name="arrow"/></a><a href="#/user/activity"><Icon name="bolt"/><strong>명령 승인과 요청</strong><Icon name="arrow"/></a></div></div>
      <div className="content-card"><div className="card-heading"><h2>내 키링</h2><a href="#/user/devices">전체 보기</a></div><div className="device-card-grid">{snapshot?.devices.map((device)=><a className="mini-device" href="#/user/map" key={device.deviceId}><span className="device-glyph"><Icon name="key" size={25}/></span><div><h3>{device.label}</h3><p>{snapshot.households.find((house)=>house.householdId===device.householdId)?.name}</p></div><Icon name="arrow"/></a>)}</div>{snapshot?.devices.length===0&&<Empty>가족 공간에 첫 키링을 연결하세요.</Empty>}</div></>}
    {page==='map'&&<div className="stack"><div className="content-card map-content"><Suspense fallback={<p role="status">키링 지도를 준비하고 있습니다…</p>}><LocationMap refresh={portal.revision} variant="user" locationUrl={`/api/portal/locations?role=${role}`}/></Suspense></div><LocationSharing portal={portal}/></div>}
    {page==='devices'&&<Devices portal={portal}/>}{page==='privacy'&&<Privacy portal={portal}/>}{page==='activity'&&<Activity portal={portal}/>}
  </PortalShell>;
}
