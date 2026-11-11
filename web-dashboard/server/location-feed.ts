import { open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ingestLocationRecord, initialLocationState, parseGatewayAnchors,
} from '../shared/location.ts';
import type { GatewayAnchor, LocationSnapshot, LocationState } from '../shared/location.ts';

const MAX_LINE_BYTES = 64 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_DEVICES = 1000;
const DEFAULT_FIXTURE = fileURLToPath(new URL('../fixtures/location-demo.json', import.meta.url));

export class LocationFeedError extends Error {
  constructor(message: string) { super(message); this.name = 'LocationFeedError'; }
}

export interface LocationFeedOptions {
  readonly locationFile?: string;
  readonly gatewayLocationsFile?: string;
  /** File provenance defaults to simulation; explicit deployment settings enable measured inputs. */
  readonly simulation?: boolean;
  readonly emptyLive?: boolean;
}

export interface LocationFeed { readSnapshot(): Promise<LocationSnapshot> }

function boundedState(state: LocationState): LocationState {
  const entries = Object.entries(state);
  if (entries.length <= MAX_DEVICES) return state;
  const lastSeen = (entry: (typeof entries)[number]) => Math.max(
    Date.parse(entry[1].position?.observedAt ?? '') || 0,
    Date.parse(entry[1].ble?.observedAt ?? '') || 0,
  );
  entries.sort((left, right) => lastSeen(right) - lastSeen(left));
  return Object.fromEntries(entries.slice(0, MAX_DEVICES));
}

async function readAnchors(path: string): Promise<readonly GatewayAnchor[]> {
  try {
    const handle = await open(path, 'r');
    try {
      if ((await handle.stat()).size > MAX_CONFIG_BYTES) throw new Error('oversized');
      const raw: unknown = JSON.parse(await handle.readFile('utf8'));
      return parseGatewayAnchors(raw);
    } finally { await handle.close(); }
  } catch {
    throw new LocationFeedError('수신기 위치 설정을 확인하세요. 좌표·교정값을 포함한 JSON 배열이 필요합니다.');
  }
}

/** Bounded incremental reader. A newline commits a record; incomplete tails await the next read. */
class LocationJournal {
  private offset = 0;
  private identity = '';
  private prefix = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private modifiedAt = 0;
  private pending = Buffer.alloc(0);
  private discardingLine = false;
  private state: LocationState = initialLocationState;
  private rejectedRecords = 0;

  private reset(): void {
    this.offset = 0;
    this.prefix = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.modifiedAt = 0;
    this.pending = Buffer.alloc(0);
    this.discardingLine = false;
    this.state = initialLocationState;
    this.rejectedRecords = 0;
  }

  private accept(line: Buffer, simulation: boolean): void {
    const text = line.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (text.length === 0) return;
    try {
      const result = ingestLocationRecord(this.state, JSON.parse(text), { simulation });
      this.state = boundedState(result.state);
      if (!result.accepted) this.rejectedRecords += 1;
    } catch { this.rejectedRecords += 1; }
  }

  private consume(chunk: Buffer, simulation: boolean): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const segment = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (!this.discardingLine) {
        if (this.pending.length + segment.length > MAX_LINE_BYTES) {
          this.pending = Buffer.alloc(0);
          this.discardingLine = true;
          this.rejectedRecords += 1;
        } else {
          this.pending = Buffer.concat([this.pending, segment]);
        }
      }
      if (end < 0) break;
      if (!this.discardingLine) this.accept(this.pending, simulation);
      this.pending = Buffer.alloc(0);
      this.discardingLine = false;
      start = end + 1;
    }
  }

  async read(path: string, simulation: boolean) {
    try {
      const handle = await open(path, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('regular file required');
        const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        const prefixLength = Math.min(128, stat.size);
        const prefix = Buffer.alloc(prefixLength);
        if (prefixLength > 0) await handle.read(prefix, 0, prefixLength, 0);
        const priorTail = Buffer.alloc(this.tail.length);
        if (stat.size >= this.offset && this.tail.length > 0) {
          await handle.read(priorTail, 0, priorTail.length, this.offset - priorTail.length);
        }
        // Detect both same-size rewrites and copy-truncate growth between polls.
        const priorPrefixChanged = !prefix.subarray(0, this.prefix.length).equals(this.prefix);
        const priorTailChanged = !priorTail.equals(this.tail);
        const rewrittenSameSize = stat.size === this.offset && stat.mtimeMs !== this.modifiedAt;
        if (identity !== this.identity || stat.size < this.offset || priorPrefixChanged || priorTailChanged || rewrittenSameSize) this.reset();
        this.identity = identity;
        this.prefix = prefix;
        const limit = Math.min(stat.size, this.offset + MAX_READ_BYTES);
        const buffer = Buffer.alloc(64 * 1024);
        while (this.offset < limit) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - this.offset), this.offset);
          if (bytesRead === 0) break;
          this.consume(buffer.subarray(0, bytesRead), simulation);
          this.offset += bytesRead;
        }
        this.tail = Buffer.alloc(Math.min(128, this.offset));
        if (this.tail.length > 0) await handle.read(this.tail, 0, this.tail.length, this.offset - this.tail.length);
        this.modifiedAt = stat.mtimeMs;
        return { devices: Object.values(this.state), rejectedRecords: this.rejectedRecords, caughtUp: this.offset >= stat.size };
      } finally { await handle.close(); }
    } catch {
      throw new LocationFeedError('위치 기록 파일을 읽는 중입니다. LOCATION_FILE 경로와 파일 접근 권한을 확인하세요.');
    }
  }
}

export async function loadLocationFeed(options: LocationFeedOptions = {}): Promise<LocationFeed> {
  if(options.locationFile===undefined&&options.emptyLive)return {readSnapshot:async()=>({schemaVersion:'1.0.0',mode:'live',source:'portal-api',simulation:false,updatedAt:new Date().toISOString(),devices:[],gateways:options.gatewayLocationsFile?await readAnchors(options.gatewayLocationsFile):[],rejectedRecords:0,caughtUp:true})};
  if (options.locationFile === undefined) {
    const fixture = JSON.parse(await readFile(DEFAULT_FIXTURE, 'utf8')) as { gateways: unknown; records: unknown[] };
    const gateways = parseGatewayAnchors(fixture.gateways);
    let state: LocationState = initialLocationState;
    for (const record of fixture.records) state = ingestLocationRecord(state, record, { simulation: true }).state;
    const devices = Object.values(state);
    return { readSnapshot: async () => ({
      schemaVersion: '1.0.0', mode: 'demo', source: 'demo-fixture', simulation: true,
      updatedAt: new Date().toISOString(), devices, gateways, rejectedRecords: 0, caughtUp: true,
    }) };
  }

  const path = options.locationFile;
  const journal = new LocationJournal();
  const simulation = options.simulation !== false;
  let queue: Promise<unknown> = Promise.resolve();
  return { readSnapshot() {
    // Concurrent HTTP polls share a serialized cursor and one bounded device snapshot.
    const request = queue.then(async (): Promise<LocationSnapshot> => {
      const gateways = options.gatewayLocationsFile === undefined ? [] : await readAnchors(options.gatewayLocationsFile);
      const records = await journal.read(path, simulation);
      return {
        schemaVersion: '1.0.0', mode: 'live', source: 'local-jsonl', simulation,
        updatedAt: new Date().toISOString(), gateways, ...records,
      };
    });
    queue = request.catch(() => undefined);
    return request;
  } };
}
