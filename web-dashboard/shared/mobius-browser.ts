export interface MobiusBrowserNode {
  readonly path: string;
  readonly parentPath: string | null;
  readonly name: string;
  readonly depth: number;
  readonly ty: number | null;
  readonly type: string;
  readonly inferred: boolean;
}

export interface MobiusBrowserDetail {
  readonly path: string;
  readonly envelope: string;
  readonly rsc: number;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface MobiusBrowserSnapshot {
  readonly schemaVersion: '1.0.0';
  readonly source: string;
  readonly actual: boolean;
  readonly simulation: boolean;
  readonly cseId: string;
  readonly generatedAt: string;
  readonly discoveryRsc: number;
  readonly partial: boolean;
  readonly nodes: readonly MobiusBrowserNode[];
  readonly selected: MobiusBrowserDetail | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMobiusBrowserSnapshot(value: unknown): MobiusBrowserSnapshot {
  if (!record(value) || value['schemaVersion'] !== '1.0.0' || typeof value['source'] !== 'string'
    || typeof value['actual'] !== 'boolean' || typeof value['simulation'] !== 'boolean'
    || typeof value['cseId'] !== 'string' || typeof value['generatedAt'] !== 'string'
    || !Number.isSafeInteger(value['discoveryRsc']) || typeof value['partial'] !== 'boolean'
    || !Array.isArray(value['nodes']) || value['nodes'].length > 200) throw new TypeError('mobius-browser');
  const nodes = value['nodes'].map((item): MobiusBrowserNode => {
    if (!record(item) || typeof item['path'] !== 'string' || (item['parentPath'] !== null && typeof item['parentPath'] !== 'string')
      || typeof item['name'] !== 'string' || !Number.isSafeInteger(item['depth'])
      || (item['ty'] !== null && !Number.isSafeInteger(item['ty'])) || typeof item['type'] !== 'string'
      || typeof item['inferred'] !== 'boolean') throw new TypeError('mobius-browser-node');
    return {
      path: item['path'], parentPath: item['parentPath'] as string | null, name: item['name'], depth: item['depth'] as number,
      ty: item['ty'] as number | null, type: item['type'], inferred: item['inferred'],
    };
  });
  const detail = value['selected'];
  if (detail !== null && (!record(detail) || typeof detail['path'] !== 'string' || typeof detail['envelope'] !== 'string'
    || !Number.isSafeInteger(detail['rsc']) || !record(detail['attributes']))) throw new TypeError('mobius-browser-detail');
  return {
    schemaVersion: '1.0.0', source: value['source'], actual: value['actual'], simulation: value['simulation'],
    cseId: value['cseId'], generatedAt: value['generatedAt'], discoveryRsc: value['discoveryRsc'] as number,
    partial: value['partial'], nodes, selected: detail as MobiusBrowserDetail | null,
  };
}
