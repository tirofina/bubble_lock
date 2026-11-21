import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';
import type { StorySessionSnapshot, StoryTrace } from './story-session.ts';

type NodeKind = 'cse' | 'ae' | 'container' | 'group' | 'fanout' | 'contentInstance';

interface MobiusTreeNode {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: NodeKind;
  readonly rsc: number;
  readonly verified: boolean;
  readonly detail: string;
  readonly eventType?: string;
  readonly status?: 'active' | 'removed';
  readonly children: MobiusTreeNode[];
}

const KIND: Record<NodeKind, { readonly name: string; readonly tag: string; readonly ty: number | null }> = {
  cse: { name: 'CSEBase', tag: 'm2m:cb', ty: 5 },
  ae: { name: 'applicationEntity', tag: 'm2m:ae', ty: 2 },
  container: { name: 'container', tag: 'm2m:cnt', ty: 3 },
  contentInstance: { name: 'contentInstance', tag: 'm2m:cin', ty: 4 },
  group: { name: 'group', tag: 'm2m:grp', ty: 9 },
  fanout: { name: 'fanOutPoint', tag: 'fopt', ty: null },
};

const DEVICE_NAMES = [
  ['living-room-light', 'Living-room light'],
  ['living-room-tv', 'Living-room TV'],
  ['living-room-fan', 'Living-room fan'],
] as const;

const EVENT_LABELS: Readonly<Record<string, string>> = {
  SESSION_STARTED: 'Browser session',
  PRESENCE_CHANGED: 'Presence state',
  CARE_GRANT_APPROVED: 'Care grant',
  ROOM_GROUP_ON: 'Room group ON',
  ROOM_GROUP_OFF: 'Room group OFF',
  GRANT_EXPIRED: 'Grant expiry',
  ROUTINE_ALERT: 'Check-in alert',
  CHECK_IN_CALL_STARTED: 'Check-in call',
  SHARE_DRAFT: 'Location-share draft',
  GUARDIAN_DECISION: 'Guardian decision',
  LOCATION_LEASE: 'Five-minute location lease',
  LOCATION_LEASE_EXPIRED: 'Location lease expiry',
  KEYRING_BUTTON_OBSERVATION: 'Keyring button observation',
  RESIDENT_CONFIRMED: 'Resident confirmation',
  PANIC_ALERT: 'Keyring PANIC alert',
};

function resourceName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function node(path: string, name: string, kind: NodeKind, detail: string, options: {
  rsc?: number;
  verified?: boolean;
  eventType?: string;
  status?: 'active' | 'removed';
} = {}): MobiusTreeNode {
  return {
    id: `${kind}:${path}`,
    path,
    name,
    kind,
    rsc: options.rsc ?? 2000,
    verified: options.verified ?? true,
    detail,
    ...(options.eventType ? { eventType: options.eventType } : {}),
    ...(options.status ? { status: options.status } : {}),
    children: [],
  };
}

function eventNode(event: StoryTrace, path = event.resource): MobiusTreeNode {
  return node(path, resourceName(path), 'contentInstance', `CREATE RSC ${event.createRsc}; RETRIEVE RSC ${event.retrieveRsc}; payload readback ${event.verified ? 'verified' : 'pending'}.`, {
    rsc: event.retrieveRsc,
    verified: event.verified,
    eventType: event.type,
  });
}

function buildTree(snapshot: StorySessionSnapshot): MobiusTreeNode[] {
  const rootPath = snapshot.mobius.root;
  const parts = rootPath.split('/').filter(Boolean);
  const csePath = `/${parts[0] ?? 'Mobius'}`;
  const storyPath = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : rootPath;
  const aePath = parts.length > 2 ? `/${parts.slice(0, -2).join('/')}` : csePath;
  const cse = node(csePath, resourceName(csePath), 'cse', `Mobius4 CSEBase; CSE-ID ${snapshot.mobius.cse}.`);
  const ae = node(aePath, resourceName(aePath), 'ae', 'Story-demo application entity registered on this CSE.');
  const story = node(storyPath, resourceName(storyPath), 'container', 'Parent container for browser-isolated story sessions.');
  const session = node(rootPath, resourceName(rootPath), 'container', `Container bound to browser session ${snapshot.browserSession.id}.`);
  cse.children.push(ae);
  ae.children.push(story);
  story.children.push(session);

  const devices = new Map<string, MobiusTreeNode>();
  for (const [resource, label] of DEVICE_NAMES) {
    const device = node(`${rootPath}/${resource}`, label, 'container', 'Target container for oneM2M group fan-out readback.');
    devices.set(resource, device);
    session.children.push(device);
  }
  const keyring = node(`${rootPath}/keyring-observation`, 'Keyring observations', 'container', 'Container for button observations delivered by the keyring path.');
  session.children.push(keyring);

  let group: MobiusTreeNode | null = null;
  let fanout: MobiusTreeNode | null = null;
  for (const event of [...snapshot.mobius.events].reverse()) {
    const fanoutAt = event.resource.indexOf('/fopt/');
    if (fanoutAt >= 0) {
      const groupPath = event.resource.slice(0, fanoutAt);
      if (!group) {
        const removed = snapshot.care.status === 'expired';
        group = node(groupPath, resourceName(groupPath), 'group', removed
          ? 'The temporary group was deleted at the server deadline; RETRIEVE returns RSC 4004.'
          : 'Temporary group whose memberIDs are limited to the approved living-room resources.', {
          rsc: removed ? 4004 : 2000,
          status: removed ? 'removed' : 'active',
        });
        fanout = node(`${groupPath}/fopt`, 'fopt', 'fanout', 'Virtual fanOutPoint: one request is distributed to every group member.');
        group.children.push(fanout);
        ae.children.push(group);
      }
      fanout?.children.push(eventNode(event));
      const rn = event.resource.slice(fanoutAt + '/fopt/'.length).split('/')[0];
      event.members.forEach((member, index) => {
        const deviceName = DEVICE_NAMES[index]?.[0];
        const device = deviceName ? devices.get(deviceName) : undefined;
        if (device && rn) device.children.push(node(`${device.path}/${rn}`, rn, 'contentInstance', `${member.label}: ${member.state ? 'ON' : 'OFF'}; member readback RSC ${member.rsc}.`, {
          rsc: member.rsc,
          verified: member.verified,
          eventType: event.type,
        }));
      });
      continue;
    }
    if (event.resource.startsWith(`${keyring.path}/`)) {
      keyring.children.push(eventNode(event));
      continue;
    }
    const device = [...devices.values()].find((candidate) => event.resource.startsWith(`${candidate.path}/`));
    (device ?? session).children.push(eventNode(event));
  }
  return [cse];
}

function flatten(nodes: readonly MobiusTreeNode[]): MobiusTreeNode[] {
  return nodes.flatMap((item) => [item, ...flatten(item.children)]);
}

interface MobiusTreeRow {
  readonly item: MobiusTreeNode;
  readonly depth: number;
}

function flattenRows(nodes: readonly MobiusTreeNode[], depth = 0): MobiusTreeRow[] {
  return nodes.flatMap((item) => [{ item, depth }, ...flattenRows(item.children, depth + 1)]);
}

function kindLabel(kind: NodeKind): string {
  const value = KIND[kind];
  return value.ty === null ? `${value.name} <${value.tag}>` : `${value.name} / ${value.tag} / ty=${value.ty}`;
}

function TreeRow({ item, depth, selected, freshPath, onSelect }: {
  readonly item: MobiusTreeNode;
  readonly depth: number;
  readonly selected: string;
  readonly freshPath: string | null;
  readonly onSelect: (item: MobiusTreeNode) => void;
}) {
  const fresh = item.path === freshPath;
  const label = item.eventType ? EVENT_LABELS[item.eventType] ?? item.eventType : item.name;
  const className = `${selected === item.id ? 'selected' : ''}${fresh ? ' is-fresh' : ''}`.trim();
  return <li className="mobius-tree-leaf" role="treeitem" aria-level={depth + 1}>
    <button
      type="button"
      className={className}
      data-path={item.path}
      data-fresh={fresh || undefined}
      style={{ paddingInlineStart: `${8 + Math.min(depth, 6) * 14}px` }}
      onClick={() => onSelect(item)}
    >
      <span className={`mobius-node-dot kind-${item.kind}`} aria-hidden="true" />
      <span className="mobius-node-name">{label}</span>
      <small>{kindLabel(item.kind)}</small>
      <b className={item.verified ? 'verified' : ''}>RETRIEVE / RSC {item.rsc}</b>
    </button>
  </li>;
}

export function StoryMobiusTree({ snapshot, freshPath = null, onRefresh }: {
  readonly snapshot: StorySessionSnapshot | null;
  readonly freshPath?: string | null;
  readonly onRefresh?: () => Promise<unknown> | unknown;
}) {
  const roots = useMemo(() => snapshot ? buildTree(snapshot) : [], [snapshot]);
  const nodes = useMemo(() => flatten(roots), [roots]);
  const rows = useMemo(() => flattenRows(roots), [roots]);
  const preferred = nodes.find((item) => item.path === freshPath)
    ?? nodes.find((item) => item.path === snapshot?.mobius.root) ?? nodes[0] ?? null;
  const [selectedId, setSelectedId] = useState('');
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const scroll = useRef<HTMLDivElement | null>(null);
  const selected = nodes.find((item) => item.id === selectedId) ?? preferred;

  useEffect(() => {
    if (preferred && !nodes.some((item) => item.id === selectedId)) setSelectedId(preferred.id);
  }, [nodes, preferred, selectedId]);

  useEffect(() => {
    const target = freshPath ? rows.findIndex(({ item }) => item.path === freshPath) : -1;
    if (target >= 0) {
      setSelectedId(rows[target]!.item.id);
    }
  }, [freshPath, rows]);

  useEffect(() => {
    if (!freshPath) return;
    const box = scroll.current;
    if (!box) return;
    const centerFresh = () => {
      const target = box.querySelector<HTMLElement>('[data-fresh="true"]');
      if (!target || box.clientHeight === 0) return;
      const boxRect = box.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetTop = targetRect.top - boxRect.top + box.scrollTop;
      const top = Math.max(0, targetTop - (box.clientHeight - targetRect.height) / 2);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      box.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    };
    const frame = window.requestAnimationFrame(centerFresh);
    const observer = new ResizeObserver(centerFresh);
    observer.observe(box);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [freshPath, rows]);

  const copyPath = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  };
  const refresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };

  return <div className="mobius-tree-view" lang="en">
    <div className="mobius-tree-toolbar">
      <p><strong>CSE resource tree</strong><span>{nodes.length} resources</span></p>
      <button type="button" onClick={() => void refresh()} disabled={!snapshot || refreshing} aria-label="Retrieve the Mobius resource tree again"><Icon name="refresh" size={16} />{refreshing ? 'Retrieving' : 'Sync'}</button>
    </div>
    {roots.length > 0 ? <div
      ref={scroll}
      className="mobius-tree-scroll"
      data-scrollable="true"
      data-scroll-axis="vertical"
      tabIndex={0}
      aria-label={`Vertically scrollable oneM2M resource tree, ${nodes.length} resources`}
      onScroll={(event) => { if (event.currentTarget.scrollLeft !== 0) event.currentTarget.scrollLeft = 0; }}
    ><ul className="mobius-tree" role="tree">
      {rows.map(({ item, depth }) => <TreeRow key={item.id} item={item} depth={depth} selected={selected?.id ?? ''} freshPath={freshPath} onSelect={(next) => { setSelectedId(next.id); setCopied(false); }} />)}
    </ul></div> : <p className="story-server-wait">Connecting to the Mobius CSE resource tree.</p>}
    {selected ? <div className="mobius-node-detail" aria-live="polite">
      <div><span>{kindLabel(selected.kind)}</span><b>{selected.status === 'removed' ? 'DELETE verified, RETRIEVE RSC 4004' : selected.verified ? `RETRIEVE verified, RSC ${selected.rsc}` : 'RETRIEVE pending'}</b></div>
      <code>{selected.path}</code>
      <p>{selected.detail}</p>
      <button type="button" onClick={() => void copyPath()}>{copied ? 'Path copied' : 'Copy full path'}</button>
    </div> : null}
  </div>;
}
