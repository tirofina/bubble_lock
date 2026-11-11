import { useCallback, useEffect, useRef, useState } from 'react';
import { isRecord } from './client.ts';

export type PortalRole = 'guardian' | 'visitor' | 'operator';
export interface Household { householdId: string; name: string; ownerId: string; members: {principalId: string; role: string}[] }
export interface PortalDevice { deviceId: string; householdId: string; gatewayId: string; label: string; registeredAt: string }
export interface Consent { consentId: string; subjectId: string; purpose: string; scopes: string[]; expiresAt: string; effectiveStatus: string; status: string }
export interface Grant { grantId: string; consentId: string; subjectId: string; scopes: string[]; expiresAt: string; effectiveStatus: string; status: string }
export interface Incident { incidentId: string; householdId: string; deviceId: string | null; kind: string; message: string; status: string; createdBy: string; createdAt: string }
export interface CommandRequest { requestId: string; householdId: string; deviceIds: string[]; desiredState: {state:boolean}; reason: string; requestedBy: string; status: string; effectiveStatus: string; expiresAt: string }
export interface Notification { notificationId: string; householdId: string; principalId: string; type: string; title: string; createdAt: string; readAt: string | null }
export interface LocationLease { leaseId:string; householdId:string; recipientId:string; deviceIds:string[]; purpose:string; incidentId:string; grantId:string; status:string; effectiveStatus?:string; expiresAt:string }
export interface PortalSnapshot {
  schemaVersion: '1.0.0'; generatedAt: string; principal: {principalId: string; role: PortalRole};
  households: Household[]; devices: PortalDevice[]; consents: Consent[]; grants: Grant[];
  incidents: Incident[]; commandRequests: CommandRequest[]; notifications: Notification[];
  locationLeases?: LocationLease[];
}
export interface PortalResponse { mode: 'demo' | 'live'; snapshot: PortalSnapshot }
function parseResponse(value: unknown): PortalResponse {
  if (!isRecord(value) || !['demo','live'].includes(String(value['mode'])) || !isRecord(value['snapshot'])) throw new Error('포털 응답 형식을 확인해 주세요.');
  const snapshot = value['snapshot'];
  if (snapshot['schemaVersion'] !== '1.0.0' || !isRecord(snapshot['principal']) ||
    !['households','devices','consents','grants','incidents','commandRequests','notifications'].every((key) => Array.isArray(snapshot[key]))) throw new Error('포털 데이터 형식을 확인해 주세요.');
  return value as unknown as PortalResponse;
}
export function usePortal(role: PortalRole) {
  const [data, setData] = useState<PortalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const retryKeys = useRef(new Map<string,string>());
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(()=>{setData(null);setNotice(null);setError(null);},[role]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function read() {
      try {
        const response = await fetch(`/api/portal/snapshot?role=${role}`, { signal: controller.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('사용자 포털 연결을 확인해 주세요.');
        const next = parseResponse(await response.json());
        if (active) { setData(next); setError(null); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : '사용자 정보를 확인해 주세요.'); }
      finally { if (active) timer = setTimeout(() => void read(), 5000); }
    }
    void read();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [role, generation]);
  const action = useCallback(async (path: string, input: Record<string, unknown>, success: string) => {
    const intent=JSON.stringify([role,path,input]);
    const idempotencyKey=retryKeys.current.get(intent)??crypto.randomUUID();
    retryKeys.current.set(intent,idempotencyKey);
    if(retryKeys.current.size>100)retryKeys.current.delete(retryKeys.current.keys().next().value!);
    setPending(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/portal/${path}`, { method: 'POST', credentials: 'same-origin', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ ...input, role, idempotencyKey }), signal: AbortSignal.timeout(15000) });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(isRecord(value) && typeof value['message'] === 'string' ? value['message'] : '입력값과 현재 권한을 확인해 주세요.');
      retryKeys.current.delete(intent); setNotice(success); reload(); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : '요청 상태를 확인해 주세요.'); return false; }
    finally { setPending(false); }
  }, [role, reload]);
  return { data, snapshot: data?.snapshot, error, pending, notice, action, reload, revision: generation };
}
export type PortalController = ReturnType<typeof usePortal>;
