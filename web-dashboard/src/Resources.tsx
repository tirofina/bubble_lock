import { useEffect, useState } from 'react';
import type { ResourceFixture } from '../shared/index.ts';
import {
  defaultMobiusSettings, discover, errorMessage, fixtureResources, retrieve,
} from './client.ts';
import type { Discovery, LiveResource, MobiusSettings } from './client.ts';
import { Badge, BooleanState } from './ui.tsx';

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
  return <ul className={parent === null ? 'tree' : undefined}>
    {nodes.filter((node) => node.parent === parent).map((node) => <li key={node.uri}>
      <button type="button" aria-pressed={selected === node.uri} onClick={() => onSelect(node.uri)}>
        <span>{node.name}{node.inferred && <span className="caption muted"> · 경로</span>}</span>
        <span className="caption selection-label">{selected === node.uri ? '선택됨' : ' '}</span>
        <span className="path">{node.uri}</span>
      </button>
      {nodes.some((child) => child.parent === node.uri) &&
        <Tree nodes={nodes} parent={node.uri} selected={selected} onSelect={onSelect} />}
    </li>)}
  </ul>;
}

const settingFields = [
  ['baseUrl', 'Mobius HTTP origin', 'http://127.0.0.1:7579'],
  ['originator', '운영자 Originator · X-M2M-Origin', '등록된 AE originator'],
  ['aePath', '운영자 AE / 검색할 하위 경로', '/Mobius/operator-ae'],
  ['acp', '운영자 ACP 참조 · 표시 전용', '/Mobius/operator-acp'],
  ['rvi', 'Release Version · X-M2M-RVI', '3'],
  ['ty', '자원 유형 필터 · ty', '28'],
  ['cnd', 'SDT 정의 필터 · cnd', 'org.onem2m.common.moduleclass.binarySwitch'],
  ['limit', '페이지 크기 · lim', '100'],
  ['offset', '페이지 시작 · ofst', '0'],
] as const;

export function Resources({ refresh }: { readonly refresh: number }) {
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
      <label>자원 데이터 소스
        <select value={mode} onChange={(event) => setMode(event.target.value === 'live' ? 'live' : 'fixture')}>
          <option value="fixture">모의 · fixture API</option><option value="live">실서버 · Mobius HTTP 조회</option>
        </select>
      </label>
      <Badge tone={mode === 'fixture' ? 'warning' : 'info'}>{mode === 'fixture' ? '모의 자원' : '실서버 조회 모드 · 연결 성공과 별개'}</Badge>
    </div>
    {mode === 'live' && <form className="panel stack" onSubmit={(event) => {
      event.preventDefault(); setSettings({ ...draft }); setRequest((value) => value + 1);
    }}>
      <h3>운영자 조회 설정</h3>
      <div className="field-grid">
        {settingFields.map(([key, label, placeholder]) => <label key={key} className={key === 'cnd' ? 'field-wide' : undefined}>
          {label}
          <input value={draft[key]} placeholder={placeholder} autoComplete="off"
            inputMode={key === 'baseUrl' ? 'url' : ['ty', 'limit', 'offset'].includes(key) ? 'numeric' : 'text'}
            required={key !== 'acp' && key !== 'cnd'}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
        </label>)}
      </div>
      <p className="small muted">설정은 이 탭의 메모리에만 유지됩니다. 비밀키·토큰을 입력하지 마세요.
        AE 경로는 discovery 시작점이며 ACP 참조는 운영 맥락입니다. 권한 부여·AE 등록·인증은 수행하지 않습니다.</p>
      <div className="cluster"><button type="submit">설정 적용 / discovery 조회</button><code>GET · fu=1 · drt=1</code></div>
    </form>}
    {mode === 'live' && <p className="notice">
      학교 PC의 endpoint, 운영자 AE/ACP, CORS, RVI 및 SDT 등록은 미확인입니다.{' '}
      <span className="keep-phrase">조회 실패 시</span> 모의 데이터로 대체하지 않습니다. <span className="keep-phrase">검색 결과는</span> ACP와 페이지 범위에 한정되며 전체 inventory가 아닙니다.
    </p>}
    <div className="resource-results stack" aria-busy={status === 'loading'}>
    {status === 'loading' && <div className="panel loading-placeholder"><p role="status">자원을 조회하고 있습니다…</p>{[1, 2, 3, 4].map((row) => <div className="placeholder-row" aria-hidden="true" key={row} />)}</div>}
    {status === 'idle' && <p className="notice">운영자 설정을 입력하고 discovery 조회를 실행하세요.</p>}
    {error !== null && <p className="notice error" role="alert">{error} · 설정과 서버 상태를 확인한 뒤 새로고침하세요.</p>}
    {status === 'ready' && nodes.length === 0 && <p className="notice">조회된 자원이 없습니다. AE 경로·필터·ACP 범위를 확인하거나 새로고침하세요.</p>}
    {discovery !== null && <p className="small muted">
      이 페이지 {discovery.uris.length}개 · {discovery.partial ? `부분 결과 · 다음 ofst ${discovery.nextOffset ?? '미노출'}` : '완전성 미확인'}
      {' · '}RSC {discovery.rsc ?? '미노출 (CORS 헤더 노출 확인 필요)'}
    </p>}
    {nodes.length > 0 && <div className="split">
      <div className="panel stack"><h3>자원 트리</h3><Tree nodes={nodes} selected={selected} onSelect={setSelected} /></div>
      <div className="panel stack" aria-live="polite">
        <div className="row"><h3>장치 / 자원 상태</h3><Badge tone={mode === 'fixture' ? 'warning' : 'info'}>{mode === 'fixture' ? '모의' : 'HTTP 조회'}</Badge></div>
        <code>{selected}</code>
        {mode === 'fixture' && fixture !== undefined && <>
          <dl>
            <dt>state</dt><dd><BooleanState value={fixture.state} /></dd>
            <dt>health</dt><dd>{fixture.health === 'healthy' ? '정상 · 모의' : fixture.health === 'degraded' ? '주의 · 모의' : '미확인'}</dd>
            <dt>장치</dt><dd>{fixture.deviceId ?? '해당 없음'}</dd>
            <dt>Gateway</dt><dd>{fixture.gatewayId ?? '해당 없음'}</dd>
            <dt>자원 유형</dt><dd>ty={fixture.ty}</dd>
            <dt>SDT cnd</dt><dd>{fixture.cnd ?? '해당 없음'}</dd>
          </dl>
          <p className="small muted">fixture snapshot입니다. 실제 장치의 최신 상태를 증명하지 않습니다.</p>
        </>}
        {mode === 'live' && <>
          {detailLoading && <p role="status">선택한 자원을 GET 조회하고 있습니다…</p>}
          {detailError !== null && <p className="notice error" role="alert">{detailError} · 자원 경로와 서버 상태를 확인한 뒤 다시 선택하거나 새로고침하세요.</p>}
          {detail !== null && <>
            <dl>
              <dt>state</dt><dd><BooleanState value={detail.attributes['state']} /></dd>
              <dt>JSON envelope</dt><dd><code>{detail.envelope}</code></dd>
              <dt>RSC</dt><dd>{detail.rsc ?? '미노출'}</dd>
              <dt>운영자 AE</dt><dd>{settings?.aePath}</dd>
              <dt>ACP 참조</dt><dd>{settings?.acp || '미입력 · 서버 권한 미확인'}</dd>
              <dt>health</dt><dd>미측정 · GET 성공은 장치 health가 아닙니다.</dd>
            </dl>
            <details><summary>원본 namespaced JSON</summary><pre>{JSON.stringify({ [detail.envelope]: detail.attributes }, null, 2)}</pre></details>
          </>}
        </>}
      </div>
    </div>}
    </div>
  </div>;
}
