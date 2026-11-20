import { useEffect, useState } from 'react';
import { Icon } from './Icon.tsx';
import { Badge } from './ui.tsx';
import { isRecord } from './client.ts';
import { useLang } from './i18n.tsx';

interface RoleAccess { originator: string; binding: string; lastRsc: number | null; accessDenied: string[] }

/**
 * Which oneM2M originator each dashboard role reads with (R10). The BFF never uses the admin originator once role
 * bindings are configured; a 4103 on a container shows here as "No permission" instead of an error page.
 */
export function CseAccess({ refresh }: { readonly refresh: number }) {
  const { tr } = useLang();
  const [roles, setRoles] = useState<Record<string, RoleAccess> | 'single' | null>(null);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const read = () => void fetch('/api/source', { signal: controller.signal, credentials: 'same-origin' })
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((value: unknown) => {
        const live = isRecord(value) && isRecord(value['live']) ? value['live'] : null;
        const originators = live?.['originators'];
        setRoles(isRecord(originators) ? originators as unknown as Record<string, RoleAccess> : 'single'); setFailed(false);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    read();
    const timer = setInterval(read, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh, generation]);
  const roleName = (role: string) => role === 'operator' ? tr('운영자', 'Operator') : role === 'guardian' ? tr('보호자', 'Guardian') : role === 'visitor' ? tr('방문자', 'Visitor') : role;
  return <div className="content-card stack">
    <div className="card-heading"><div><h2>{tr('역할별 CSE 접근', 'CSE access by role')}</h2><p>{tr('화면마다 자기 역할의 AE와 인증서로만 CSE를 읽어요.', 'Each view reads the CSE only with its own role AE and certificate.')}</p></div><Icon name="shield" /></div>
    {failed && <p className="notice error" role="alert">{tr('접근 상태를 불러오지 못했어요.', 'Access status could not be loaded.')}<button type="button" onClick={() => setGeneration((value) => value + 1)}>{tr('다시 시도', 'Try again')}</button></p>}
    {roles === null && !failed && <p role="status">{tr('불러오는 중…', 'Loading…')}</p>}
    {roles === 'single' && <p className="small muted">{tr('역할별 연결이 설정되지 않아 하나의 읽기 연결을 써요.', 'No role bindings are configured, so one reader is used.')}</p>}
    {roles && roles !== 'single' && Object.entries(roles).map(([role, access]) => {
      const denied = access.lastRsc === 4103 || access.accessDenied.length > 0;
      return <article className="permission-item" key={role}>
        <div className="row"><strong>{roleName(role)}</strong><Badge tone={denied ? 'warning' : access.lastRsc === 2000 ? 'success' : ''}>{denied ? tr('권한 없음 (4103)', 'No permission (4103)') : access.lastRsc === 2000 ? tr('읽기 정상', 'Reading') : tr('확인 중', 'Checking')}</Badge></div>
        <p className="small muted"><code>{access.originator}</code>, {tr('클라이언트 인증서로 연결', 'bound by client certificate')}</p>
        {denied && <p className="caption muted">{tr('이 역할에 권한이 없는 자원은 화면에 보이지 않아요: ', 'Resources this role has no right to stay hidden: ')}{access.accessDenied.map((path) => <code key={path}>{path} </code>)}</p>}
      </article>;
    })}
  </div>;
}
