import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.tsx';
import { getJson } from './client.ts';
import { parseMobiusBrowserSnapshot } from '../shared/mobius-browser.ts';
import type { MobiusBrowserSnapshot } from '../shared/mobius-browser.ts';
import './operator-mobius.css';

type BrowserView = 'tree' | 'record';

const displayValue = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);

export function OperatorMobiusBrowser({ refresh }: { readonly refresh: number }) {
  const [snapshot, setSnapshot] = useState<MobiusBrowserSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [view, setView] = useState<BrowserView>('tree');
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const query = selectedPath ? `?selected=${encodeURIComponent(selectedPath)}` : '';
      const { value } = await getJson(`/api/operator/mobius${query}`, signal);
      const next = parseMobiusBrowserSnapshot(value);
      setSnapshot(next);
      setError(null);
      if (!selectedPath) {
        const first = [...next.nodes].reverse().find((node) => !node.inferred) ?? next.nodes[0];
        if (first) setSelectedPath(first.path);
      }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'Mobius resource read failed.');
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [selectedPath]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => { void load(controller.signal); }, 15_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [generation, load, refresh]);

  const detailRows = useMemo(() => Object.entries(snapshot?.selected?.attributes ?? {}), [snapshot?.selected]);
  const actual = snapshot?.actual === true;
  const choose = (path: string) => {
    setSelectedPath(path);
    setView('record');
  };

  return <aside className="operator-mobius-browser" aria-label="Mobius Resource Browser" data-operator-mobius="true" data-source={actual ? 'live' : 'replay'}>
    <header className="operator-mobius-header">
      <div><span className="operator-mobius-kicker">oneM2M operator read</span><h2>Mobius Resource Browser</h2></div>
      <button type="button" className="operator-mobius-refresh" onClick={() => setGeneration((value) => value + 1)} aria-label="Refresh Mobius resources" title="Refresh Mobius resources"><Icon name="refresh" size={17} /></button>
    </header>
    <div className="operator-mobius-status" role="status"><span className={`operator-mobius-live${actual ? ' actual' : ''}`}><i />{actual ? 'Live Mobius CSE' : 'Replay data'}</span><code>RSC {snapshot?.discoveryRsc ?? '----'}</code><span>{snapshot?.nodes.length ?? 0} resources</span></div>
    <div className="operator-mobius-tabs" role="tablist" aria-label="Mobius browser view">
      <button type="button" role="tab" aria-selected={view === 'tree'} onClick={() => setView('tree')}>Resource tree</button>
      <button type="button" role="tab" aria-selected={view === 'record'} onClick={() => setView('record')}>Resource record</button>
    </div>
    {error && <div className="operator-mobius-error" role="alert"><span>{error}</span><button type="button" onClick={() => setGeneration((value) => value + 1)}>Retry</button></div>}
    <section className="operator-mobius-panel" role="tabpanel" data-view={view} aria-busy={loading}>
      {view === 'tree' ? <div className="operator-mobius-tree-scroll" tabIndex={0} data-scrollable="true" data-scroll-axis="vertical" aria-label="Vertically scrollable oneM2M resource tree" onScroll={(event) => { if (event.currentTarget.scrollLeft !== 0) event.currentTarget.scrollLeft = 0; }}>
        {snapshot?.nodes.map((node) => <button type="button" className="operator-mobius-node" key={node.path} aria-pressed={selectedPath === node.path} onClick={() => choose(node.path)} style={{ paddingInlineStart: `${10 + Math.min(node.depth, 7) * 13}px` }} title={node.path}>
          <span className="operator-mobius-branch" aria-hidden="true" />
          <span><strong>{node.name}</strong><small>{node.type}{node.ty === null ? '' : `, ty=${node.ty}`}</small></span>
          <code>{node.ty ?? '—'}</code>
        </button>)}
        {!snapshot?.nodes.length && !error && <p className="operator-mobius-empty">{loading ? 'Reading the CSE resource tree…' : 'No resources are visible to the operator AE.'}</p>}
      </div> : <div className="operator-mobius-record">
        <div className="operator-mobius-record-head"><span>Selected resource</span><code>{snapshot?.selected?.envelope ?? 'Select a resource from the tree'}</code></div>
        {snapshot?.selected ? <><p className="operator-mobius-path">{snapshot.selected.path}</p><dl>{detailRows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{displayValue(value)}</code></dd></div>)}</dl></>
          : <div className="operator-mobius-empty"><p>{loading ? 'RETRIEVE in progress…' : 'Choose a resource to run an operator-scoped RETRIEVE.'}</p><button type="button" onClick={() => setView('tree')}>Open resource tree</button></div>}
      </div>}
    </section>
    <footer className="operator-mobius-footer"><span>{snapshot?.cseId || '/Mobius'}</span><span>GET only, operator AE scope</span></footer>
  </aside>;
}
