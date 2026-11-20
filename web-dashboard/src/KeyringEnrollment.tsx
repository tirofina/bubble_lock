import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';
import { Badge } from './ui.tsx';
import { isRecord } from './client.ts';
import { useLang } from './i18n.tsx';
import { translateServerMessage } from './server-messages.ts';

interface EnrolledDevice { deviceId: string; householdId: string; connected: boolean; label: string | null }
interface GatewayEnrollment { gatewayId: string; status: string; devices: EnrolledDevice[] }
interface Enrollments { gateways: GatewayEnrollment[]; households: { householdId: string; name: string }[] }

function parse(value: unknown): Enrollments | null {
  if (!isRecord(value) || !isRecord(value['enrollments'])) return null;
  const body = value['enrollments'];
  return Array.isArray(body['gateways']) && Array.isArray(body['households']) ? body as unknown as Enrollments : null;
}

/**
 * Operator keyring enrollment: adds a keyring to a receiver (Gateway) allow-list for one family space. The guardian
 * then connects it from the Family and keyrings page; the portal rejects a connection the operator has not enrolled.
 */
export function KeyringEnrollment({ refresh }: { readonly refresh: number }) {
  const { lang, tr } = useLang();
  const [data, setData] = useState<Enrollments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [generation, setGeneration] = useState(0);
  const retryKey = useRef<{ intent: string; key: string } | null>(null);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/portal/enrollments', { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        const value: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(isRecord(value) && typeof value['message'] === 'string' ? value['message'] : 'Keyring enrollment is not available.');
        const parsed = parse(value);
        if (!parsed) throw new Error('Keyring enrollment is not available.');
        setData(parsed); setError(null);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Keyring enrollment is not available.'); });
    return () => controller.abort();
  }, [refresh, generation]);

  const householdName = (id: string) => data?.households.find((home) => home.householdId === id)?.name ?? id;
  const activeGateways = data?.gateways.filter((gateway) => gateway.status === 'ACTIVE') ?? [];

  const submit = async (form: HTMLFormElement) => {
    const values = new FormData(form);
    const input = { gatewayId: String(values.get('gatewayId') ?? ''), householdId: String(values.get('householdId') ?? ''), deviceId: String(values.get('deviceId') ?? '').trim() };
    const intent = JSON.stringify(input);
    if (retryKey.current?.intent !== intent) retryKey.current = { intent, key: crypto.randomUUID() };
    setPending(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/portal/devices/enroll', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, role: 'operator', idempotencyKey: retryKey.current.key }), signal: AbortSignal.timeout(15000) });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(isRecord(value) && typeof value['message'] === 'string' ? value['message'] : 'The keyring was not enrolled.');
      retryKey.current = null; form.reset();
      setNotice(tr(`${input.deviceId} 키링을 등록했어요. 보호자가 가족과 키링 화면에서 연결할 수 있어요.`, `Keyring ${input.deviceId} enrolled. A guardian can now connect it on the Family and keyrings page.`));
      reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The keyring was not enrolled.'); }
    finally { setPending(false); }
  };

  return <div className="two-columns keyring-enrollment">
    <form className="content-card stack" onSubmit={(event) => { event.preventDefault(); void submit(event.currentTarget); }}>
      <div className="card-heading"><div><h2>{tr('키링 등록하기', 'Enroll a keyring')}</h2><p>{tr('수신기 허용 목록에 키링을 추가하고 가족 공간에 묶어요.', 'Add a keyring to a receiver allow-list and bind it to a family space.')}</p></div><Icon name="plus" /></div>
      {error && <div className="notice error" role="alert">{translateServerMessage(error, lang)}<button type="button" onClick={reload}>{tr('다시 불러오기', 'Reload')}</button></div>}
      {notice && <div className="notice success-notice" role="status"><Icon name="check" />{notice}<a href="#/user/devices">{tr('가족 화면에서 연결하기', 'Connect in the family view')}</a></div>}
      <label>{tr('수신기(Gateway)', 'Receiver (Gateway)')}<select name="gatewayId" required disabled={!activeGateways.length} defaultValue="">
        <option value="">{activeGateways.length ? tr('수신기를 선택하세요', 'Choose a receiver') : tr('사용 중인 수신기가 없어요', 'No active receiver')}</option>
        {activeGateways.map((gateway) => <option key={gateway.gatewayId} value={gateway.gatewayId}>{gateway.gatewayId}</option>)}</select></label>
      <label>{tr('가족 공간', 'Family space')}<select name="householdId" required disabled={!data?.households.length} defaultValue="">
        <option value="">{data?.households.length ? tr('가족 공간을 선택하세요', 'Choose a family space') : tr('가족 공간이 없어요', 'No family space yet')}</option>
        {data?.households.map((home) => <option key={home.householdId} value={home.householdId}>{home.name}</option>)}</select></label>
      <label>{tr('키링 ID', 'Keyring ID')}<input name="deviceId" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}" placeholder={tr('예: keyring-D', 'e.g. keyring-D')} />
        <span className="field-hint">{tr('키링 뒷면이나 펌웨어 설정에 있는 ID예요. 영문, 숫자, 점, 밑줄, 하이픈, 콜론을 쓸 수 있어요.', 'The ID printed on the keyring or set in its firmware. Letters, digits, dot, underscore, hyphen and colon.')}</span></label>
      <button className="primary" disabled={pending || !activeGateways.length || !data?.households.length}>{pending ? tr('등록하는 중', 'Enrolling') : tr('키링 등록하기', 'Enroll keyring')}</button>
      {!activeGateways.length && data && <p className="caption muted">{tr('수신기는 서버 설정으로 먼저 등록해요.', 'Receivers are enrolled through the server configuration first.')}</p>}
    </form>
    <div className="content-card stack">
      <div className="card-heading"><h2>{tr('수신기별 등록 키링', 'Enrolled keyrings by receiver')}</h2><button type="button" className="icon-button" onClick={reload} aria-label={tr('새로고침', 'Refresh')} title={tr('새로고침', 'Refresh')}><Icon name="refresh" /></button></div>
      {!data && !error && <p role="status">{tr('등록 목록을 불러오고 있어요…', 'Loading enrollments…')}</p>}
      {data?.gateways.map((gateway) => <section className="household-block" key={gateway.gatewayId}>
        <div className="row"><h3 className="mono">{gateway.gatewayId}</h3><Badge tone={gateway.status === 'ACTIVE' ? 'success' : 'danger'}>{gateway.status === 'ACTIVE' ? tr('사용 중', 'Active') : gateway.status === 'LOST' ? tr('분실', 'Lost') : tr('폐기', 'Revoked')}</Badge></div>
        <ul className="enrollment-list">{gateway.devices.map((device) => <li key={device.deviceId}>
          <a className="mini-device" href={device.connected ? '#/operator/map' : '#/user/devices'} title={device.connected ? tr('위치 지도에서 보기', 'See it on the location map') : tr('가족 화면에서 연결하기', 'Connect it in the family view')}>
            <span className="device-glyph"><Icon name="key" size={20} /></span>
            <div><h4>{device.label ?? device.deviceId}</h4><p>{device.deviceId}, {householdName(device.householdId)}</p></div>
            <Badge tone={device.connected ? 'success' : 'warning'}>{device.connected ? tr('연결됨', 'Connected') : tr('연결 대기', 'Awaiting connection')}</Badge></a></li>)}</ul>
      </section>)}
      <p className="caption muted">{tr('등록한 키링은 보호자가 연결해야 위치와 명령에 쓰여요. 다른 가족 공간으로 옮기려면 소유권 이전(handover)이 필요해요.', 'An enrolled keyring is used for location and commands once a guardian connects it. Moving it to another family space needs an ownership handover.')}</p>
    </div>
  </div>;
}
