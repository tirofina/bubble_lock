import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon.tsx';
import { Badge, Timestamp } from './ui.tsx';
import { isRecord } from './client.ts';
import { useLang } from './i18n.tsx';
import { useNow } from './GuardianAlerts.tsx';

interface Member { deviceId: string; status: string; cseRsc?: number | null; readback?: boolean | null; cseReadback?: boolean | null; claimId?: string | null; receipt?: string }
interface Result { id: string; at: string; state: boolean; outcome: string; stage?: string; reason?: string; approvalHash?: string; groupPath?: string; fanoutPoint?: string; aggregateRsc?: number | null; groupEt?: string | null; members: Member[]; grantExpiresAt: string | null }
interface Status {
  householdId: string; live: boolean; cse: { cseId: string; version?: string } | null; devices: { deviceId: string; label: string; labelEn: string }[];
  grant: { grantId: string; expiresAt: string; active: boolean; storyExpiryLocal: string } | null; results: Result[];
}

function useCaregiver(url: string) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try { const response = await fetch(url, { credentials: 'same-origin' }); if (response.status === 404) { if (active) setStatus(null); return; } const value: unknown = await response.json(); if (active && isRecord(value) && Array.isArray(value['results'])) { setStatus(value as unknown as Status); setError(null); } }
      catch { if (active) setError('connection'); }
      finally { if (active) timer = setTimeout(() => void read(), 3000); }
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [url, generation]);
  return { status, error, reload };
}

const countdown = (ms: number) => { const seconds = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };

function MemberRows({ result, devices }: { readonly result: Result; readonly devices: Status['devices'] }) {
  const { lang, tr } = useLang();
  const name = (deviceId: string) => { const device = devices.find((item) => item.deviceId === deviceId); return device ? (lang === 'en' ? device.labelEn : device.label) : deviceId; };
  return <dl className="triage-hashes">{result.members.map((member) => <div key={member.deviceId}><dt>{name(member.deviceId)}</dt>
    <dd>{member.status === 'REJECTED' ? <Badge tone="danger">{tr('거절', 'REJECTED')}</Badge> : <Badge tone={member.status === 'READBACK_VERIFIED' ? 'success' : 'warning'}>{member.status === 'READBACK_VERIFIED' ? tr('적용 확인', 'ACK, readback verified') : member.status}</Badge>}
      {member.status !== 'REJECTED' && <span className="small muted"> rsc {member.cseRsc ?? '-'}, {tr('기기', 'device')} {member.readback === true ? 'ON' : member.readback === false ? 'OFF' : '-'}, CSE {member.cseReadback === true ? 'ON' : member.cseReadback === false ? 'OFF' : '-'}</span>}
      {member.receipt && <span className="small muted"> {member.receipt}</span>}</dd></div>)}</dl>;
}

/** Visitor (caregiver) view: Living Room On/Off through the household <grp>/fopt, allowed while the delegation grant is valid. */
export function CaregiverLivingRoom() {
  const { lang, tr } = useLang();
  const now = useNow(1000);
  const { status, reload } = useCaregiver('/api/portal/caregiver?role=visitor');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status) return null;
  const grantActive = Boolean(status.grant && Date.parse(status.grant.expiresAt) > now);
  const last = status.results[0];
  const press = async (state: boolean) => {
    setPending(true); setError(null);
    try {
      const response = await fetch('/api/portal/caregiver', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'visitor', state }) });
      if (!response.ok) { const value: unknown = await response.json().catch(() => null); throw new Error(isRecord(value) && typeof value['message'] === 'string' ? value['message'] : `HTTP ${response.status}`); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'error'); }
    finally { setPending(false); reload(); }
  };
  return <article className={`alert-card caregiver-card ${last?.outcome === 'REJECTED' ? 'alert-escalated' : last?.outcome === 'APPLIED' ? 'alert-approved' : ''}`}>
    <div className="alert-card-head"><span className="alert-symbol"><Icon name="home" size={22} /></span>
      <div className="alert-card-title"><p className="eyebrow">{tr('방문 돌봄', 'Caregiver visit')}</p><h2>{tr('거실', 'Living room')}</h2>
        <p className="small muted">{status.devices.map((device) => (lang === 'en' ? device.labelEn : device.label)).join(', ')}</p></div>
      <Badge tone={grantActive ? 'success' : 'danger'}>{grantActive ? tr(`${status.grant?.storyExpiryLocal}까지 허용`, `Allowed until ${status.grant?.storyExpiryLocal}`) : tr('허용 시간 끝남', 'Permission expired')}</Badge></div>
    <p className="small muted">{grantActive && status.grant ? tr(`보호자가 위임한 권한이에요 (이야기 시각 ${status.grant.storyExpiryLocal}까지, ${countdown(Date.parse(status.grant.expiresAt) - now)} 남음).`, `Delegated by the guardian until ${status.grant.storyExpiryLocal} story time, ${countdown(Date.parse(status.grant.expiresAt) - now)} left.`)
      : tr(`위임 권한이 ${status.grant?.storyExpiryLocal ?? ''}에 끝났어요. 누르면 거절돼요.`, `The delegation ended at ${status.grant?.storyExpiryLocal ?? ''}. A press is rejected.`)}</p>
    {last && <div className={`notice ${last.outcome === 'APPLIED' ? 'success-notice' : 'error'}`} role="status"><Icon name={last.outcome === 'APPLIED' ? 'check' : 'shield'} />
      {last.outcome === 'APPLIED' ? tr(`거실 ${last.state ? '켜짐' : '꺼짐'}: 기기 ${last.members.length}개가 그룹 명령 한 번으로 적용됐어요.`, `Living room ${last.state ? 'on' : 'off'}: ${last.members.length} devices applied by one group command.`)
        : tr(`거절됨: ${last.stage === 'grant' ? '위임 권한이 끝나 명령을 보내지 않았어요.' : last.reason ?? ''}`, `REJECTED: ${last.stage === 'grant' ? 'the delegation grant expired, no command was sent.' : last.reason ?? ''}`)}</div>}
    {last && <MemberRows result={last} devices={status.devices} />}
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="alert-actions"><button className="primary" disabled={pending} onClick={() => void press(true)}><Icon name="bolt" size={18} />{tr('거실 켜기', 'Living Room On')}</button>
      <button disabled={pending} onClick={() => void press(false)}>{tr('거실 끄기', 'Living Room Off')}</button></div>
    <p className="caption muted alert-source">{status.live ? tr(`실제 Mobius4 CSE ${status.cse?.cseId ?? ''}의 <grp>/fopt, 기기와 Gateway는 모의`, `<grp>/fopt on the real Mobius4 CSE ${status.cse?.cseId ?? ''}; devices and Gateway emulated`) : tr('모의 fanOutPoint와 모의 기기 (CSE 없이 재생)', 'Emulated fanOutPoint and devices (no CSE)')}</p>
  </article>;
}

/** Operator commands view: the household group commands with per-member ACK/readback or the rejection receipt. */
export function GroupCommandsPanel() {
  const { tr } = useLang();
  const { status } = useCaregiver('/api/group-commands');
  if (!status) return null;
  return <div className="content-card stack agent-runs"><div className="card-heading"><div><h2>{tr('가구 그룹 명령 (거실)', 'Household group commands (living room)')}</h2>
    <p>{tr('방문 돌봄자 요청, 위임 권한 판정, <grp>/fopt 결과와 구성원별 응답이에요.', 'Caregiver requests, the delegation grant decision, the <grp>/fopt result and each member receipt.')}</p></div>
    <Badge tone={status.live ? 'info' : 'warning'}>{status.live ? tr('실제 CSE, 모의 기기', 'Real CSE, emulated devices') : tr('모의', 'Simulated')}</Badge></div>
    {status.results.length === 0 && <p className="empty-state">{tr('방문 돌봄자가 누르면 여기에 기록돼요.', 'Recorded here when the caregiver presses a button.')}</p>}
    {status.results.map((result) => <article className="triage-run" key={result.id}>
      <div className="row"><div className="stack-tight"><strong>{result.state ? 'Living Room On' : 'Living Room Off'}</strong><span className="small muted"><Timestamp at={result.at} />{result.fanoutPoint ? `, ${result.fanoutPoint}` : ''}{result.aggregateRsc ? `, rsc ${result.aggregateRsc}` : ''}</span></div>
        <Badge tone={result.outcome === 'APPLIED' ? 'success' : 'danger'}>{result.outcome}</Badge></div>
      {result.outcome === 'REJECTED' && <p className="small">{tr('거절 사유', 'Rejection')}: {result.stage === 'grant' ? tr(`위임 권한 만료 (${result.grantExpiresAt ?? ''})`, `delegation grant expired at ${result.grantExpiresAt ?? ''}`) : result.reason}</p>}
      <MemberRows result={result} devices={status.devices} />
      {result.approvalHash && <p className="caption muted">approvalHash <code>{result.approvalHash}</code></p>}
    </article>)}
  </div>;
}
