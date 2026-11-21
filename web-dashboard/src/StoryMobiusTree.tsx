import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon.tsx';
import { useLang } from './i18n.tsx';
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

const DEVICE_NAMES = [
  ['living-room-light', '거실 조명', 'Living-room light'],
  ['living-room-tv', '거실 TV', 'Living-room TV'],
  ['living-room-fan', '거실 선풍기', 'Living-room fan'],
] as const;

const EVENT_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  SESSION_STARTED: ['브라우저 세션', 'Browser session'],
  PRESENCE_CHANGED: ['외출·귀가 상태', 'Presence state'],
  CARE_GRANT_APPROVED: ['돌봄 권한 승인', 'Care grant'],
  ROOM_GROUP_ON: ['거실 그룹 켜기', 'Room group on'],
  ROOM_GROUP_OFF: ['거실 그룹 끄기', 'Room group off'],
  GRANT_EXPIRED: ['돌봄 권한 만료', 'Grant expiry'],
  ROUTINE_ALERT: ['안부 확인 알림', 'Check-in alert'],
  CHECK_IN_CALL_STARTED: ['안부 전화', 'Check-in call'],
  SHARE_DRAFT: ['위치 공유 초안', 'Share draft'],
  GUARDIAN_DECISION: ['보호자 승인', 'Guardian decision'],
  LOCATION_LEASE: ['5분 위치 공유', 'Five-minute location lease'],
  LOCATION_LEASE_EXPIRED: ['위치 공유 만료', 'Location lease expiry'],
  KEYRING_BUTTON_OBSERVATION: ['키링 버튼 관측', 'Keyring button observation'],
  RESIDENT_CONFIRMED: ['거주자 안전 확인', 'Resident confirmed'],
  PANIC_ALERT: ['키링 비상 알림', 'Keyring panic alert'],
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
  return node(path, resourceName(path), 'contentInstance', event.detail, {
    rsc: event.retrieveRsc,
    verified: event.verified,
    eventType: event.type,
  });
}

function buildTree(snapshot: StorySessionSnapshot): MobiusTreeNode[] {
  const rootPath = snapshot.mobius.root;
  const parts = rootPath.split('/').filter(Boolean);
  const csePath = `/${parts[0] ?? snapshot.mobius.cse}`;
  const storyPath = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : rootPath;
  const aePath = parts.length > 2 ? `/${parts.slice(0, -2).join('/')}` : csePath;
  const cse = node(csePath, snapshot.mobius.cse, 'cse', '실제 oneM2M CSE 바인딩');
  const ae = node(aePath, resourceName(aePath), 'ae', '스토리 데모 AE');
  const story = node(storyPath, resourceName(storyPath), 'container', '브라우저별 세션 상위 컨테이너');
  const session = node(rootPath, resourceName(rootPath), 'container', `${snapshot.browserSession.id} 전용 세션 컨테이너`);
  cse.children.push(ae);
  ae.children.push(story);
  story.children.push(session);

  const devices = new Map<string, MobiusTreeNode>();
  for (const [resource, ko] of DEVICE_NAMES) {
    const device = node(`${rootPath}/${resource}`, ko, 'container', '그룹 명령 대상 컨테이너');
    devices.set(resource, device);
    session.children.push(device);
  }
  const keyring = node(`${rootPath}/keyring-observation`, '키링 관측', 'container', '펌웨어가 전달한 키링 버튼 관측');
  session.children.push(keyring);

  let group: MobiusTreeNode | null = null;
  let fanout: MobiusTreeNode | null = null;
  for (const event of [...snapshot.mobius.events].reverse()) {
    const fanoutAt = event.resource.indexOf('/fopt/');
    if (fanoutAt >= 0) {
      const groupPath = event.resource.slice(0, fanoutAt);
      if (!group) {
        const removed = snapshot.care.status === 'expired';
        group = node(groupPath, resourceName(groupPath), 'group', removed ? '서버 마감 후 RETRIEVE RSC 4004 확인' : '승인 범위에 묶인 임시 그룹', {
          rsc: removed ? 4004 : 2000,
          status: removed ? 'removed' : 'active',
        });
        fanout = node(`${groupPath}/fopt`, 'fopt', 'fanout', '한 번의 CREATE를 세 구성원에 배포');
        group.children.push(fanout);
        ae.children.push(group);
      }
      fanout?.children.push(eventNode(event));
      const rn = event.resource.slice(fanoutAt + '/fopt/'.length).split('/')[0];
      event.members.forEach((member, index) => {
        const deviceName = DEVICE_NAMES[index]?.[0];
        const device = deviceName ? devices.get(deviceName) : undefined;
        if (device && rn) device.children.push(node(`${device.path}/${rn}`, rn, 'contentInstance', `${member.label} ${member.state ? 'ON' : 'OFF'} readback`, {
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

function kindLabel(kind: NodeKind, ko: boolean): string {
  const labels: Record<NodeKind, readonly [string, string]> = {
    cse: ['CSE', 'CSE'], ae: ['AE', 'AE'], container: ['컨테이너', 'container'], group: ['그룹', 'group'],
    fanout: ['팬아웃', 'fan-out'], contentInstance: ['기록', 'contentInstance'],
  };
  return labels[kind][ko ? 0 : 1];
}

function TreeBranch({ item, depth, selected, onSelect }: {
  readonly item: MobiusTreeNode;
  readonly depth: number;
  readonly selected: string;
  readonly onSelect: (item: MobiusTreeNode) => void;
}) {
  const { lang } = useLang();
  const [open, setOpen] = useState(depth < 4);
  const label = item.eventType ? EVENT_LABELS[item.eventType]?.[lang === 'en' ? 1 : 0] ?? item.eventType : item.name;
  const line = <>
    <span className={`mobius-node-dot kind-${item.kind}`} aria-hidden="true" />
    <span className="mobius-node-name">{label}</span>
    <small>{kindLabel(item.kind, lang === 'ko')}</small>
    <b className={item.verified ? 'verified' : ''}>RSC {item.rsc}</b>
  </>;
  if (item.children.length === 0) return <li className="mobius-tree-leaf">
    <button type="button" className={selected === item.id ? 'selected' : ''} onClick={() => onSelect(item)}>{line}</button>
  </li>;
  return <li>
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={selected === item.id ? 'selected' : ''} onClick={() => onSelect(item)}>{line}</summary>
      <ul>{item.children.map((child) => <TreeBranch key={child.id} item={child} depth={depth + 1} selected={selected} onSelect={onSelect} />)}</ul>
    </details>
  </li>;
}

export function StoryMobiusTree({ snapshot, onRefresh }: {
  readonly snapshot: StorySessionSnapshot | null;
  readonly onRefresh?: () => Promise<unknown> | unknown;
}) {
  const { lang, tr } = useLang();
  const roots = useMemo(() => snapshot ? buildTree(snapshot) : [], [snapshot]);
  const nodes = useMemo(() => flatten(roots), [roots]);
  const preferred = nodes.find((item) => item.path === snapshot?.mobius.root) ?? nodes[0] ?? null;
  const [selectedId, setSelectedId] = useState('');
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const selected = nodes.find((item) => item.id === selectedId) ?? preferred;

  useEffect(() => {
    if (preferred && !nodes.some((item) => item.id === selectedId)) setSelectedId(preferred.id);
  }, [nodes, preferred, selectedId]);

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

  return <div className="mobius-tree-view">
    <div className="mobius-tree-toolbar">
      <p><strong>{tr('실제 CSE 자원', 'Live CSE resources')}</strong><span>{tr(`${nodes.length}개 노드`, `${nodes.length} nodes`)}</span></p>
      <button type="button" onClick={() => void refresh()} disabled={!snapshot || refreshing} aria-label={tr('Mobius 트리 다시 읽기', 'Read the Mobius tree again')}><Icon name="refresh" size={16} />{refreshing ? tr('동기화 중', 'Syncing') : tr('동기화', 'Sync')}</button>
    </div>
    {roots.length > 0 ? <div className="mobius-tree-scroll"><ul className="mobius-tree" role="tree">
      {roots.map((item) => <TreeBranch key={item.id} item={item} depth={0} selected={selected?.id ?? ''} onSelect={(next) => { setSelectedId(next.id); setCopied(false); }} />)}
    </ul></div> : <p className="story-server-wait">{tr('Mobius 세션 트리를 연결하고 있어요.', 'Connecting the Mobius session tree.')}</p>}
    {selected ? <div className="mobius-node-detail" aria-live="polite">
      <div><span>{kindLabel(selected.kind, lang === 'ko')}</span><b>{selected.status === 'removed' ? tr('만료·삭제 확인', 'Expiry and deletion verified') : selected.verified ? tr('RETRIEVE 확인', 'RETRIEVE verified') : tr('확인 중', 'Verifying')}</b></div>
      <code>{selected.path}</code>
      <p>{selected.detail}</p>
      <button type="button" onClick={() => void copyPath()}>{copied ? tr('경로 복사 완료', 'Path copied') : tr('전체 경로 복사', 'Copy full path')}</button>
    </div> : null}
  </div>;
}
