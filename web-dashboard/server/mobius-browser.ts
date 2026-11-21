import type { ResourceFixture } from '../shared/index.ts';
import type { MobiusBrowserDetail, MobiusBrowserNode, MobiusBrowserSnapshot } from '../shared/mobius-browser.ts';
import type { DashboardEvent } from '../shared/types.ts';
import { discoveredUris, Onem2mClient } from './onem2m.ts';

const RESOURCE_TYPES = new Map<number, string>([
  [2, 'applicationEntity'], [3, 'container'], [4, 'contentInstance'], [5, 'CSEBase'], [9, 'group'],
  [23, 'subscription'], [28, 'flexContainer'],
]);
const DISCOVERY_TYPES = [2, 3, 4, 9, 23, 28] as const;
const DETAIL_KEYS = new Set(['rn', 'ri', 'pi', 'ty', 'ct', 'lt', 'et', 'st', 'cr', 'lbl', 'acpi', 'cni', 'cbs', 'mni', 'mbs', 'mia', 'mt', 'mnm', 'csy', 'mid', 'cnf', 'cs', 'con', 'loc']);

function resourceType(ty: number | null): string {
  return ty === null ? 'resource' : RESOURCE_TYPES.get(ty) ?? `resourceType ${ty}`;
}

function cleanPath(value: string): string | null {
  if (!value.startsWith('/') || value.length > 512 || value.includes('..') || /[?#\\]/.test(value)) return null;
  const path = value.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return path || '/';
}

function safeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 512);
  if (depth >= 2) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => safeValue(item, depth + 1));
  if (typeof value !== 'object') return String(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32).map(([key, item]) => [key, safeValue(item, depth + 1)]));
}

function selectedAttributes(payload: Record<string, unknown> | null): { envelope: string; attributes: Record<string, unknown> } | null {
  if (!payload) return null;
  const entry = Object.entries(payload).find(([, value]) => typeof value === 'object' && value !== null && !Array.isArray(value));
  if (!entry) return null;
  const source = entry[1] as Record<string, unknown>;
  return {
    envelope: entry[0],
    attributes: Object.fromEntries(Object.entries(source).filter(([key]) => DETAIL_KEYS.has(key)).map(([key, value]) => [key, safeValue(value)])),
  };
}

function tree(paths: ReadonlyMap<string, number | null>, cseBase: string): readonly MobiusBrowserNode[] {
  const normalizedBase = cleanPath(cseBase) ?? '/Mobius';
  const expanded = new Map<string, { ty: number | null; inferred: boolean }>();
  for (const [raw, ty] of paths) {
    const path = cleanPath(raw);
    if (!path || (path !== normalizedBase && !path.startsWith(`${normalizedBase}/`))) continue;
    const parts = path.split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const ancestor = `/${parts.slice(0, index + 1).join('/')}`;
      const existing = expanded.get(ancestor);
      const direct = ancestor === path;
      expanded.set(ancestor, { ty: direct ? ty : existing?.ty ?? null, inferred: direct ? false : existing?.inferred ?? true });
    }
  }
  if (!expanded.has(normalizedBase)) expanded.set(normalizedBase, { ty: 5, inferred: false });
  return [...expanded.entries()].map(([path, value]) => {
    const parts = path.split('/').filter(Boolean);
    const parentPath = parts.length <= 1 ? null : `/${parts.slice(0, -1).join('/')}`;
    const ty = path === normalizedBase ? 5 : value.ty;
    return { path, parentPath, name: parts.at(-1) ?? path, depth: Math.max(0, parts.length - 1), ty, type: resourceType(ty), inferred: value.inferred };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export async function browseMobiusCse(options: {
  readonly client: Onem2mClient;
  readonly cseBase: string;
  readonly cseId: string;
  readonly source: string;
  readonly simulation: boolean;
  readonly selected?: string | null;
  readonly knownPaths?: readonly string[];
}): Promise<MobiusBrowserSnapshot> {
  const cseBase = cleanPath(options.cseBase) ?? '/Mobius';
  const paths = new Map<string, number | null>([[cseBase, 5]]);
  for (const path of options.knownPaths ?? []) { const clean = cleanPath(path); if (clean) paths.set(clean, paths.get(clean) ?? null); }
  const results = await Promise.all(DISCOVERY_TYPES.map(async (ty) => {
    try { return { ty, result: await options.client.request('GET', cseBase, { query: { fu: 1, drt: 1, ty, lim: 80 } }) }; }
    catch { return { ty, result: null }; }
  }));
  let discoveryRsc = 5103;
  let partial = false;
  for (const { ty, result } of results) {
    if (!result) continue;
    if (result.rsc === 2000) discoveryRsc = 2000;
    else if (discoveryRsc !== 2000) discoveryRsc = result.rsc;
    const uris = discoveredUris(result.payload).slice(0, 80);
    if (uris.length === 80) partial = true;
    for (const uri of uris) { const path = cleanPath(uri); if (path) paths.set(path, ty); }
  }
  const nodes = tree(paths, cseBase).slice(0, 200);
  const requested = options.selected ? cleanPath(options.selected) : null;
  const selectedPath = requested && nodes.some((node) => node.path === requested) ? requested : null;
  let selected: MobiusBrowserDetail | null = null;
  if (selectedPath) {
    const read = await options.client.request('GET', selectedPath).catch(() => null);
    const parsed = read?.rsc === 2000 ? selectedAttributes(read.payload) : null;
    if (read && parsed) selected = { path: selectedPath, envelope: parsed.envelope, rsc: read.rsc, attributes: parsed.attributes };
  }
  return {
    schemaVersion: '1.0.0', source: options.source, actual: true, simulation: options.simulation,
    cseId: options.cseId, generatedAt: new Date().toISOString(), discoveryRsc, partial, nodes, selected,
  };
}

export function browseReplayResources(options: {
  readonly fixtures: readonly ResourceFixture[];
  readonly events: readonly DashboardEvent[];
  readonly source: string;
  readonly simulation: boolean;
  readonly selected?: string | null;
}): MobiusBrowserSnapshot {
  const paths = new Map<string, number | null>();
  for (const item of options.fixtures) paths.set(item.resourceUri, item.ty);
  for (const event of options.events.slice(-80)) {
    if (!paths.has(event.resourceUri)) paths.set(event.resourceUri, 4);
    const parent = event.resourceUri.slice(0, event.resourceUri.lastIndexOf('/'));
    if (parent && !paths.has(parent)) paths.set(parent, 3);
  }
  const nodes = tree(paths, '/Mobius');
  const requested = options.selected ? cleanPath(options.selected) : null;
  const selectedPath = requested && nodes.some((node) => node.path === requested) ? requested : null;
  const fixture = selectedPath ? options.fixtures.find((item) => item.resourceUri === selectedPath) : undefined;
  const event = selectedPath ? [...options.events].reverse().find((item) => item.resourceUri === selectedPath) : undefined;
  const attributes = fixture ? safeValue(fixture) as Record<string, unknown> : event ? safeValue({ sequence: event.sequence, type: event.type, receivedAt: event.receivedAt, roleScope: event.roleScope, simulation: event.simulation }) as Record<string, unknown> : null;
  return {
    schemaVersion: '1.0.0', source: options.source, actual: false, simulation: options.simulation, cseId: '/Mobius',
    generatedAt: new Date().toISOString(), discoveryRsc: 2000, partial: false, nodes,
    selected: selectedPath && attributes ? { path: selectedPath, envelope: fixture ? 'fixture:resource' : 'event:resource', rsc: 2000, attributes } : null,
  };
}
