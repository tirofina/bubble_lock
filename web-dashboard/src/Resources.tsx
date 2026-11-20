import { useEffect, useState } from 'react';
import type { ResourceFixture } from '../shared/index.ts';
import {
  defaultMobiusSettings, discover, errorMessage, fixtureResources, retrieve,
} from './client.ts';
import type { Discovery, LiveResource, MobiusSettings } from './client.ts';
import { Badge, BooleanState } from './ui.tsx';
import { useLang } from './i18n.tsx';

interface TreeNode {
  readonly uri: string;
  readonly name: string;
  readonly parent: string | null;
  readonly inferred: boolean;
}

function liveTree(uris: readonly string[]): readonly TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const uri of uris) {
    const parts = uri.split('/').filter(Boolean);
    parts.forEach((name, index) => {
      const path = `/${parts.slice(0, index + 1).join('/')}`;
      nodes.set(path, {
        uri: path, name,
        parent: index === 0 ? null : `/${parts.slice(0, index).join('/')}`,
        inferred: !uris.includes(path),
      });
    });
  }
  return [...nodes.values()];
}

function Tree({ nodes, parent = null, selected, onSelect }: {
  readonly nodes: readonly TreeNode[];
  readonly parent?: string | null;
  readonly selected: string;
  readonly onSelect: (uri: string) => void;
}) {
  const { tr } = useLang();
  return <ul className={parent === null ? 'tree' : undefined}>
    {nodes.filter((node) => node.parent === parent).map((node) => <li key={node.uri}>
      <button type="button" aria-pressed={selected === node.uri} onClick={() => onSelect(node.uri)}>
        <span>{node.name}{node.inferred && <span className="caption muted"> {tr('(상위 경로)', '(parent path)')}</span>}</span>
        <span className="caption selection-label">{selected === node.uri ? tr('선택됨', 'Selected') : ' '}</span>
        <span className="path">{node.uri}</span>
      </button>
      {nodes.some((child) => child.parent === node.uri) &&
        <Tree nodes={nodes} parent={node.uri} selected={selected} onSelect={onSelect} />}
    </li>)}
  </ul>;
}

const settingFields = [
  ['baseUrl', 'Mobius 서버 주소', 'Mobius server address', 'http://127.0.0.1:7579', 'http://127.0.0.1:7579'],
  ['originator', '운영자 식별자 (X-M2M-Origin)', 'Operator originator (X-M2M-Origin)', '등록된 AE originator', 'Registered AE originator'],
  ['aePath', '검색 시작 경로 (운영자 AE)', 'Search start path (operator AE)', '/Mobius/operator-ae', '/Mobius/operator-ae'],
  ['acp', '접근 정책 참조 (ACP, 표시용)', 'Access policy reference (ACP, display only)', '/Mobius/operator-acp', '/Mobius/operator-acp'],
  ['rvi', '규격 버전 (X-M2M-RVI)', 'Release version (X-M2M-RVI)', '3', '3'],
  ['ty', '자원 유형 (ty)', 'Resource type (ty)', '28', '28'],
  ['cnd', '장치 기능 정의 (cnd)', 'Device class definition (cnd)', 'org.onem2m.common.moduleclass.binarySwitch', 'org.onem2m.common.moduleclass.binarySwitch'],
  ['limit', '한 번에 가져올 개수 (lim)', 'Results per request (lim)', '100', '100'],
  ['offset', '건너뛸 개수 (ofst)', 'Results to skip (ofst)', '0', '0'],
] as const;

export function Resources({ refresh }: { readonly refresh: number }) {
  const { tr } = useLang();
  const [mode, setMode] = useState<'fixture' | 'live'>('fixture');
  const [draft, setDraft] = useState<MobiusSettings>(defaultMobiusSettings);
  const [settings, setSettings] = useState<MobiusSettings | null>(null);
  const [request, setRequest] = useState(0);
  const [fixtures, setFixtures] = useState<readonly ResourceFixture[]>([]);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [selected, setSelected] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LiveResource | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setFixtures([]); setDiscovery(null); setSelected(''); setError(null); setDetail(null);
    if (mode === 'live' && settings === null) {
      setStatus('idle');
      return () => controller.abort();
    }
    setStatus('loading');
    async function load() {
      try {
        if (mode === 'fixture') {
          const resources = await fixtureResources(controller.signal);
          if (!active) return;
          setFixtures(resources);
          setSelected(resources.find((resource) => resource.state !== undefined)?.resourceUri ?? resources[0]?.resourceUri ?? '');
        } else if (settings !== null) {
          const result = await discover(settings, controller.signal);
          if (!active) return;
          setDiscovery(result);
          setSelected(result.uris[0] ?? '');
        }
        if (active) setStatus('ready');
      } catch (cause) {
        if (active) { setError(errorMessage(cause)); setStatus('error'); }
      }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [mode, settings, request, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setDetail(null); setDetailError(null); setDetailLoading(false);
    if (mode !== 'live' || settings === null || !selected) return () => controller.abort();
    setDetailLoading(true);
    void retrieve(settings, selected, controller.signal).then((resource) => {
      if (active) setDetail(resource);
    }).catch((cause: unknown) => {
      if (active) setDetailError(errorMessage(cause));
    }).finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [mode, settings, selected, request, refresh]);

  const nodes: readonly TreeNode[] = mode === 'fixture'
    ? fixtures.map((resource) => ({ uri: resource.resourceUri, name: resource.name, parent: resource.parentUri, inferred: false }))
    : liveTree(discovery?.uris ?? []);
  const fixture = fixtures.find((resource) => resource.resourceUri === selected);

  return <div className="stack">
    <div className="row">
      <label>{tr('데이터 출처', 'Data source')}
        <select value={mode} onChange={(event) => setMode(event.target.value === 'live' ? 'live' : 'fixture')}>
          <option value="fixture">{tr('모의 데이터', 'Simulated data')}</option><option value="live">{tr('실제 서버 (Mobius)', 'Real server (Mobius)')}</option>
        </select>
      </label>
      <Badge tone={mode === 'fixture' ? 'warning' : 'info'}>{mode === 'fixture' ? tr('모의 데이터', 'Simulated data') : tr('실제 서버 조회 모드', 'Real server read mode')}</Badge>
    </div>
    {mode === 'live' && <form className="panel stack" onSubmit={(event) => {
      event.preventDefault(); setSettings({ ...draft }); setRequest((value) => value + 1);
    }}>
      <h3>{tr('서버 연결 설정', 'Server connection')}</h3>
      <div className="field-grid">
        {settingFields.map(([key, title, titleEn, placeholder, placeholderEn]) => <label key={key} className={key === 'cnd' ? 'field-wide' : undefined}>
          {tr(title, titleEn)}
          <input value={draft[key]} placeholder={tr(placeholder, placeholderEn)} autoComplete="off"
            inputMode={key === 'baseUrl' ? 'url' : ['ty', 'limit', 'offset'].includes(key) ? 'numeric' : 'text'}
            required={key !== 'acp' && key !== 'cnd'}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
        </label>)}
      </div>
      <p className="small muted">{tr('설정은 이 탭을 닫으면 사라져요. 주소와 경로만 입력하세요. 비밀키와 토큰은 필요 없어요. 이 화면은 자원을 읽기만 해요. 권한 부여, AE 등록, 인증은 서버 설정에서 처리해요.', 'Settings are cleared when you close this tab. Enter only addresses and paths; no keys or tokens are needed. This page only reads resources. Permissions, AE registration and authentication are set up on the server.')}</p>
      <div className="cluster"><button type="submit" className="primary">{tr('자원 찾기', 'Find resources')}</button><code className="caption muted">GET, fu=1, drt=1</code></div>
    </form>}
    {mode === 'live' && <p className="notice">
      {tr('학교 PC 서버의 주소, 운영자 AE와 ACP, CORS, RVI, SDT 등록은 아직 실제로 확인하기 전이에요. 조회에 실패하면 오류를 그대로 보여 드려요. 모의 데이터로 바꿔 채우지 않아요. 결과에는 접근 권한과 페이지 범위 안에 있는 자원만 담겨요.', 'The school PC server address, operator AE and ACP, CORS, RVI and SDT registration have not been checked live yet. If a read fails, the error is shown as is and is never replaced with simulated data. Results include only resources within your access rights and page range.')}
    </p>}
    <div className="resource-results stack" aria-busy={status === 'loading'}>
    {status === 'loading' && <div className="panel loading-placeholder"><p role="status">{tr('자원을 불러오고 있어요…', 'Loading resources…')}</p>{[1, 2, 3, 4].map((row) => <div className="placeholder-row" aria-hidden="true" key={row} />)}</div>}
    {status === 'idle' && <p className="notice">{tr('서버 연결 설정을 입력하고 자원 찾기를 눌러 주세요.', 'Enter the server connection settings and press Find resources.')}</p>}
    {error !== null && <p className="notice error" role="alert">{error} {tr('설정을 확인하고 새로고침해 주세요.', 'Check the settings and refresh.')}</p>}
    {status === 'ready' && nodes.length === 0 && <p className="notice">{tr('찾은 자원이 없어요. 검색 시작 경로, 필터, 접근 권한 범위를 확인해 주세요.', 'No resources found. Check the search start path, filters and access scope.')}</p>}
    {discovery !== null && <p className="small muted">
      {tr(`이번에 가져온 자원 ${discovery.uris.length}개`, `${discovery.uris.length} resources loaded`)}, {discovery.partial ? tr(`더 있음 (다음 시작 위치 ${discovery.nextOffset ?? '서버 미제공'})`, `more available (next offset ${discovery.nextOffset ?? 'not provided'})`) : tr('전체 여부는 서버가 알려 주지 않았어요', 'the server did not say whether this is complete')}
      {', '}{tr('응답 코드', 'response code')} {discovery.rsc ?? tr('확인 불가 (CORS 헤더 노출 설정 필요)', 'unavailable (expose the CORS header)')}
    </p>}
    {nodes.length > 0 && <div className="split">
      <div className="panel stack"><h3>{tr('자원 목록', 'Resources')}</h3><Tree nodes={nodes} selected={selected} onSelect={setSelected} /></div>
      <div className="panel stack" aria-live="polite">
        <div className="row"><h3>{tr('선택한 자원', 'Selected resource')}</h3><Badge tone={mode === 'fixture' ? 'warning' : 'info'}>{mode === 'fixture' ? tr('모의 데이터', 'Simulated data') : tr('실제 서버', 'Real server')}</Badge></div>
        <code>{selected}</code>
        {mode === 'fixture' && fixture !== undefined && <>
          <dl>
            <dt>{tr('보호 상태', 'Protection')}</dt><dd><BooleanState value={fixture.state} /></dd>
            <dt>{tr('장치 상태', 'Device health')}</dt><dd>{fixture.health === 'healthy' ? tr('정상 (모의)', 'Healthy (simulated)') : fixture.health === 'degraded' ? tr('점검 필요 (모의)', 'Needs a check (simulated)') : tr('확인 전', 'Not yet')}</dd>
            <dt>{tr('장치', 'Device')}</dt><dd>{fixture.deviceId ?? tr('해당 없음', 'None')}</dd>
            <dt>{tr('수신기 (Gateway)', 'Receiver (Gateway)')}</dt><dd>{fixture.gatewayId ?? tr('해당 없음', 'None')}</dd>
            <dt>{tr('자원 유형', 'Resource type')}</dt><dd><code>ty={fixture.ty}</code></dd>
            <dt>{tr('장치 기능 정의', 'Device class definition')}</dt><dd>{fixture.cnd ? <code>{fixture.cnd}</code> : tr('해당 없음', 'None')}</dd>
          </dl>
          <p className="small muted">{tr('모의 데이터 스냅숏이에요. 장치의 최신 상태는 실제 서버를 조회해 확인하세요.', 'This is a simulated snapshot. Read the real server for the latest device state.')}</p>
        </>}
        {mode === 'live' && <>
          {detailLoading && <p role="status">{tr('선택한 자원을 불러오고 있어요…', 'Loading the selected resource…')}</p>}
          {detailError !== null && <p className="notice error" role="alert">{detailError} {tr('자원 경로를 확인하고 다시 선택해 주세요.', 'Check the resource path and select it again.')}</p>}
          {detail !== null && <>
            <dl>
              <dt>{tr('보호 상태', 'Protection')}</dt><dd><BooleanState value={detail.attributes['state']} /></dd>
              <dt>{tr('응답 형식 (envelope)', 'Response envelope')}</dt><dd><code>{detail.envelope}</code></dd>
              <dt>{tr('응답 코드 (RSC)', 'Response code (RSC)')}</dt><dd>{detail.rsc ?? tr('확인 불가', 'Unavailable')}</dd>
              <dt>{tr('검색 시작 경로', 'Search start path')}</dt><dd>{settings?.aePath}</dd>
              <dt>{tr('접근 정책 참조', 'Access policy reference')}</dt><dd>{settings?.acp || tr('입력 안 함 (권한은 서버가 판단해요)', 'Not entered (the server decides access)')}</dd>
              <dt>{tr('장치 상태', 'Device health')}</dt><dd>{tr('측정 전. 성공 응답이 와도 장치가 정상이라는 뜻은 아니에요.', 'Not measured. A successful response does not mean the device is healthy.')}</dd>
            </dl>
            <details><summary>{tr('원본 JSON 보기', 'Show raw JSON')}</summary><pre>{JSON.stringify({ [detail.envelope]: detail.attributes }, null, 2)}</pre></details>
          </>}
        </>}
      </div>
    </div>}
    </div>
  </div>;
}
