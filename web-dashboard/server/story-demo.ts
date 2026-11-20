import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { CseLiveConfig } from './cse-live.ts';
import { createMtlsFetch } from './mtls-fetch.ts';
import { Onem2mClient } from './onem2m.ts';

export const storyActions = [
  'activity-away', 'activity-home', 'care-approve', 'room-all-on', 'care-expire', 'check-in', 'call',
  'location-draft', 'location-approve', 'keyring-confirm', 'keyring-panic',
] as const;
export type StoryAction = (typeof storyActions)[number];

type CareStatus = 'ready' | 'approved' | 'active' | 'expiring' | 'expired';
type ShareStatus = 'ready' | 'drafted' | 'approved' | 'expired';
type KeyringButton = 'released' | 'confirm' | 'panic';

interface StoryMemberProof {
  readonly label: string;
  readonly state: boolean;
  readonly rsc: number;
  readonly verified: boolean;
}

interface BackendProof {
  readonly resource: string;
  readonly createRsc: number;
  readonly retrieveRsc: number;
  readonly verified: boolean;
  readonly detail: string;
  readonly members?: readonly StoryMemberProof[];
}

interface StoryTrace extends BackendProof {
  readonly sequence: number;
  readonly action: StoryAction | 'session-start' | 'care-auto-expire' | 'location-auto-expire';
  readonly type: string;
  readonly at: string;
}

interface StorySession {
  readonly id: string;
  readonly csrfToken: string;
  readonly resourceKey: string;
  readonly rn: string;
  readonly displayId: string;
  readonly account: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  resourceRoot: string;
  nextSequence: number;
  events: StoryTrace[];
  care: { status: CareStatus; expiresAtMs: number | null; expireAttempts: number; retryAtMs: number };
  share: { status: ShareStatus; draftHash: string | null; expiresAtMs: number | null };
  keyring: { lastButton: KeyringButton; confirmPresses: number; panicPresses: number; sequence: number };
  actionCount: number;
  disposed: boolean;
  readonly idempotency: Map<string, StoryAction>;
  chain: Promise<unknown>;
}

interface StoryBackend {
  readonly actual: boolean;
  readonly source: string;
  readonly cseId: string;
  readonly rootPath: string;
  provision(session: StorySession): Promise<string>;
  append(session: StorySession, sequence: number, type: string, payload: Readonly<Record<string, unknown>>): Promise<BackendProof>;
  group(session: StorySession, sequence: number, state: boolean, reason: string, deadlineMs: number): Promise<BackendProof>;
  revokeGroup(session: StorySession): Promise<number>;
  cleanup(session: StorySession): Promise<void>;
}

export interface StoryDemoHandler {
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  close(): Promise<void>;
  describe(): Readonly<Record<string, unknown>>;
}

const SECURE_COOKIE = '__Host-bl_story';
const DEV_COOKIE = 'bl_story_dev';
const DEFAULT_SESSION_TTL_SEC = 20 * 60;
const DEFAULT_CARE_GRANT_SEC = 30;
const DEFAULT_MAX_SESSIONS = 64;
const MAX_BODY_BYTES = 4096;
const MAX_ACTIONS_PER_SESSION = 40;
const MAX_ACTIVE_ACTIONS = 8;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_CREATIONS = 12;
const DEVICE_MEMBERS = [
  ['living-room-light', '거실 조명'],
  ['living-room-tv', '거실 TV'],
  ['living-room-fan', '거실 선풍기'],
] as const;

class StoryHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(response: ServerResponse, status: number, value: unknown, headers: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function oneM2mTime(value: number): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

function digest(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : record(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function safeRn(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40);
  return normalized.length > 0 ? normalized : fallback;
}

function secureRequest(request: IncomingMessage): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim().toLowerCase() === 'https'
    || Boolean((request.socket as { encrypted?: boolean }).encrypted);
}

function cookieValue(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  const expected = secureRequest(request) ? SECURE_COOKIE : DEV_COOKIE;
  if (!header || header.length > 4096) return null;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1 || item.slice(0, separator).trim() !== expected) continue;
    const value = item.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32}$/.test(value) ? value : null;
  }
  return null;
}

function sessionCookie(request: IncomingMessage, id: string, ttlSec: number): string {
  const secure = secureRequest(request);
  const name = secure ? SECURE_COOKIE : DEV_COOKIE;
  return `${name}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlSec}${secure ? '; Secure' : ''}`;
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  const fetchSite = request.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin') return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
}

function jsonContentType(request: IncomingMessage): boolean {
  const value = request.headers['content-type'];
  return typeof value === 'string' && /^application\/json(?:\s*;|$)/i.test(value);
}

function csrfMatches(request: IncomingMessage, expected: string): boolean {
  const value = request.headers['x-story-csrf'];
  if (typeof value !== 'string' || value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Buffer);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new StoryHttpError(413, '요청 크기를 4KB 안으로 맞춰 주세요.');
    chunks.push(bytes);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!record(parsed)) throw new StoryHttpError(400, 'JSON 객체 형식을 사용하세요.');
    return parsed;
  } catch (error) {
    if (error instanceof StoryHttpError) throw error;
    throw new StoryHttpError(400, 'JSON 객체 형식을 사용하세요.');
  }
}

function clientKey(request: IncomingMessage): string {
  const cf = request.headers['cf-connecting-ip'];
  const forwarded = request.headers['x-forwarded-for'];
  const candidate = String(Array.isArray(cf) ? cf[0] : cf ?? (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]) ?? '').trim();
  return isIP(candidate) ? candidate : String(request.socket.remoteAddress ?? 'local').trim().slice(0, 96);
}

class MemoryStoryBackend implements StoryBackend {
  readonly actual = false;
  readonly source = 'fixture-replay';
  readonly cseId = 'local-contract-cse';
  readonly rootPath = '/Mobius/Cpb-story/story-demo';

  async provision(session: StorySession): Promise<string> { return `${this.rootPath}/${session.rn}`; }

  async append(session: StorySession, sequence: number, type: string): Promise<BackendProof> {
    const parent = type === 'KEYRING_BUTTON_OBSERVATION' ? `${session.resourceRoot}/keyring-observation` : session.resourceRoot;
    return { resource: `${parent}/e-${sequence}`, createRsc: 2001, retrieveRsc: 2000, verified: true, detail: 'CREATE → RETRIEVE 해시 검증' };
  }

  async group(session: StorySession, sequence: number, state: boolean): Promise<BackendProof> {
    const members = DEVICE_MEMBERS.map(([, label]) => ({ label, state, rsc: 2000, verified: true }));
    return { resource: `/Mobius/Cpb-story/g-${session.resourceKey}/fopt/e-${sequence}`, createRsc: 2000, retrieveRsc: 2000, verified: true, detail: '3/3 그룹 구성원 readback 확인', members };
  }

  async revokeGroup(): Promise<number> { return 2002; }
  async cleanup(): Promise<void> {}
}

class CseStoryBackend implements StoryBackend {
  readonly actual = true;
  readonly source = 'onem2m-cse-live';
  readonly cseId: string;
  readonly rootPath: string;
  private readonly client: Onem2mClient;
  private readonly parentPath: string;
  private rootReady: Promise<void> | null = null;

  constructor(config: CseLiveConfig) {
    const story = config.story;
    const binding = story?.binding ?? config.roles?.operator;
    const endpoint = binding?.endpoint ?? config.cse.endpoint;
    const originator = story?.originator ?? binding?.originator ?? config.operator.aeId;
    this.client = new Onem2mClient({
      endpoint,
      originator,
      ...(config.cse.rvi ? { rvi: config.cse.rvi } : {}),
      ...(binding ? { fetchImpl: createMtlsFetch(binding) } : config.cse.allowLanHttp ? { allowLanHttp: true } : {}),
    });
    const cseBase = config.cse.cseBase.replace(/\/$/, '');
    this.parentPath = story?.parentPath ?? `${cseBase}/${config.operator.rn}`;
    if (!this.parentPath.startsWith(`${cseBase}/`) || /[?#\\]|\.\./.test(this.parentPath)) throw new TypeError('스토리 데모 AE 경로를 확인하세요.');
    const rootRn = safeRn(story?.rootRn ?? 'story-demo', 'story-demo');
    this.rootPath = `${this.parentPath}/${rootRn}`;
    this.cseId = config.cse.cseId;
  }

  private groupPath(session: StorySession): string { return `${this.parentPath}/g-${session.resourceKey}`; }

  private async ensureContainer(parent: string, rn: string, expiresAtMs?: number): Promise<string> {
    const path = `${parent}/${rn}`;
    const created = await this.client.request('POST', parent, { ty: 3, body: { 'm2m:cnt': {
      rn,
      mni: 64,
      mbs: 262144,
      lbl: ['pb-story-demo'],
      ...(expiresAtMs ? { et: oneM2mTime(expiresAtMs) } : {}),
    } } });
    if (created.rsc !== 2001) await this.client.expect('GET', path, [2000]);
    return path;
  }

  private async ensureRoot(): Promise<void> {
    if (!this.rootReady) {
      const pending = this.ensureContainer(this.parentPath, this.rootPath.split('/').at(-1) ?? 'story-demo')
        .then(() => undefined)
        .catch((error: unknown) => {
          if (this.rootReady === pending) this.rootReady = null;
          throw error;
        });
      this.rootReady = pending;
    }
    return this.rootReady;
  }

  private async ensureGroup(session: StorySession, members: readonly string[], deadlineMs: number): Promise<string> {
    const path = this.groupPath(session);
    const created = await this.client.request('POST', this.parentPath, { ty: 9, body: { 'm2m:grp': {
      rn: path.split('/').at(-1),
      mt: 3,
      mnm: members.length,
      mid: members.map((item) => item.replace(/^\//, '')),
      csy: 1,
      et: oneM2mTime(Math.max(deadlineMs, Date.now() + 5000)),
      lbl: ['pb-story-demo', 'pb-browser-isolated'],
    } } });
    if (created.rsc !== 2001) await this.client.expect('GET', path, [2000]);
    return path;
  }

  private async deleteResource(path: string): Promise<number> {
    const result = await this.client.request('DELETE', path);
    if (![2002, 4004].includes(result.rsc)) throw Object.assign(new Error(`DELETE ${path} → ${result.rsc}`), { rsc: result.rsc });
    if (result.rsc === 2002) {
      const readback = await this.client.request('GET', path);
      if (readback.rsc !== 4004) throw Object.assign(new Error(`DELETE readback ${path} → ${readback.rsc}`), { rsc: readback.rsc });
    }
    return result.rsc;
  }

  async provision(session: StorySession): Promise<string> {
    await this.ensureRoot();
    const root = await this.ensureContainer(this.rootPath, session.rn, session.expiresAtMs);
    session.resourceRoot = root;
    for (const [name] of DEVICE_MEMBERS) await this.ensureContainer(root, name, session.expiresAtMs);
    await this.ensureContainer(root, 'keyring-observation', session.expiresAtMs);
    return root;
  }

  async append(session: StorySession, sequence: number, type: string, payload: Readonly<Record<string, unknown>>): Promise<BackendProof> {
    const rn = `e-${sequence}-${randomBytes(3).toString('hex')}`;
    const keyringObservation = type === 'KEYRING_BUTTON_OBSERVATION';
    const parent = keyringObservation ? `${session.resourceRoot}/keyring-observation` : session.resourceRoot;
    const con = keyringObservation ? payload : {
      schemaVersion: '1.0.0', type, browserSession: session.displayId, sequence, at: new Date().toISOString(), ...payload,
    };
    const created = await this.client.expect('POST', parent, [2001], { ty: 4, body: { 'm2m:cin': {
      rn,
      cnf: 'application/json:0',
      con,
      cr: null,
      et: oneM2mTime(session.expiresAtMs),
      lbl: ['pb-story-event', `pb-action-${safeRn(type.toLowerCase(), 'event')}`],
    } } });
    const resource = `${parent}/${rn}`;
    const retrieved = await this.client.expect('GET', resource, [2000]);
    const cin = record(retrieved.payload?.['m2m:cin']) ? retrieved.payload['m2m:cin'] : null;
    const verified = cin !== null && digest(cin['con']) === digest(con);
    if (!verified) throw new Error('Mobius CREATE와 RETRIEVE 해시 검증이 필요합니다.');
    return { resource, createRsc: created.rsc, retrieveRsc: retrieved.rsc, verified, detail: 'Mobius4 CREATE → RETRIEVE 해시 확인' };
  }

  async group(session: StorySession, sequence: number, state: boolean, reason: string, deadlineMs: number): Promise<BackendProof> {
    const memberPaths = DEVICE_MEMBERS.map(([name]) => `${session.resourceRoot}/${name}`);
    const groupPath = await this.ensureGroup(session, memberPaths, deadlineMs);
    const rn = `g-${sequence}-${randomBytes(3).toString('hex')}`;
    const con = { schemaVersion: '1.0.0', type: 'ROOM_GROUP_STATE', browserSession: session.displayId, state, reason, sequence, at: new Date().toISOString() };
    const fanout = await this.client.expect('POST', `${groupPath}/fopt`, [2000], { ty: 4, body: { 'm2m:cin': {
      rn,
      cnf: 'application/json:0',
      con,
      cr: null,
      et: oneM2mTime(session.expiresAtMs),
      lbl: ['pb-story-group-command'],
    } } });
    const members: StoryMemberProof[] = [];
    for (const [name, label] of DEVICE_MEMBERS) {
      const read = await this.client.expect('GET', `${session.resourceRoot}/${name}/la`, [2000]);
      const cin = record(read.payload?.['m2m:cin']) ? read.payload['m2m:cin'] : null;
      const memberState = record(cin?.['con']) ? cin['con']['state'] : undefined;
      members.push({ label, state, rsc: read.rsc, verified: memberState === state });
    }
    const verified = members.every((item) => item.verified);
    if (!verified) throw new Error('Mobius 그룹 구성원 readback 검증이 필요합니다.');
    return {
      resource: `${groupPath}/fopt/${rn}`,
      createRsc: fanout.rsc,
      retrieveRsc: 2000,
      verified,
      detail: `${members.filter((item) => item.verified).length}/${members.length} 그룹 구성원 readback 확인`,
      members,
    };
  }

  async revokeGroup(session: StorySession): Promise<number> { return this.deleteResource(this.groupPath(session)); }

  async cleanup(session: StorySession): Promise<void> {
    await this.deleteResource(this.groupPath(session)).catch(() => undefined);
    if (session.resourceRoot) await this.deleteResource(session.resourceRoot).catch(() => undefined);
  }
}

export async function createStoryDemoService(options: {
  readonly mode: 'live' | 'replay';
  readonly cse?: CseLiveConfig;
  readonly secret?: string;
}): Promise<StoryDemoHandler> {
  if (options.mode === 'live' && !options.cse) throw new TypeError('실제 스토리 데모에는 CSE 설정을 연결하세요.');
  if (options.secret !== undefined && Buffer.byteLength(options.secret) < 32) throw new TypeError('STORY_SESSION_SECRET에 32바이트 이상의 값을 설정하세요.');
  const backend: StoryBackend = options.mode === 'live' ? new CseStoryBackend(options.cse!) : new MemoryStoryBackend();
  const resourceSecret = options.secret ?? randomBytes(32).toString('base64url');
  const sessionTtlSec = options.cse?.story?.sessionTtlSec ?? DEFAULT_SESSION_TTL_SEC;
  const careGrantSec = options.cse?.story?.careGrantSec ?? DEFAULT_CARE_GRANT_SEC;
  const maxSessions = options.cse?.story?.maxSessions ?? DEFAULT_MAX_SESSIONS;
  if (!Number.isInteger(sessionTtlSec) || sessionTtlSec < 300 || sessionTtlSec > 7200) throw new TypeError('스토리 세션 수명을 300~7200초로 설정하세요.');
  if (!Number.isInteger(careGrantSec) || careGrantSec < 10 || careGrantSec > 600) throw new TypeError('돌봄 승인 시간을 10~600초로 설정하세요.');
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 512) throw new TypeError('스토리 세션 수를 1~512로 설정하세요.');

  const sessions = new Map<string, StorySession>();
  const rates = new Map<string, number[]>();
  const cleanupTasks = new Set<Promise<void>>();
  let cleanupChain = Promise.resolve();
  let activeActions = 0;

  const enqueue = <T>(session: StorySession, work: () => Promise<T>): Promise<T> => {
    const result = session.chain.then(work, work);
    session.chain = result.then(() => undefined, () => undefined);
    return result;
  };

  const scheduleCleanup = (session: StorySession): Promise<void> => {
    if (session.disposed) return Promise.resolve();
    session.disposed = true;
    sessions.delete(session.id);
    const task = enqueue(session, async () => {
      cleanupChain = cleanupChain.then(() => backend.cleanup(session), () => backend.cleanup(session));
      await cleanupChain;
    }).catch(() => undefined);
    cleanupTasks.add(task);
    void task.then(() => cleanupTasks.delete(task));
    return task;
  };

  const cleanupRates = (now: number) => {
    for (const [key, values] of rates) {
      const current = values.filter((value) => value > now - RATE_WINDOW_MS);
      if (current.length > 0) rates.set(key, current); else rates.delete(key);
    }
  };

  const cleanupExpired = () => {
    const now = Date.now();
    for (const session of sessions.values()) if (session.expiresAtMs <= now) void scheduleCleanup(session);
    cleanupRates(now);
  };

  const trace = async (session: StorySession, action: StoryTrace['action'], type: string, payload: Readonly<Record<string, unknown>>): Promise<StoryTrace> => {
    const sequence = session.nextSequence++;
    const proof = await backend.append(session, sequence, type, payload);
    const event: StoryTrace = { sequence, action, type, at: new Date().toISOString(), ...proof };
    session.events.push(event);
    session.events.splice(0, Math.max(0, session.events.length - 48));
    return event;
  };

  const groupTrace = async (session: StorySession, action: StoryTrace['action'], state: boolean, reason: string): Promise<StoryTrace> => {
    const sequence = session.nextSequence++;
    const deadline = session.care.expiresAtMs ?? Date.now() + 5000;
    const proof = await backend.group(session, sequence, state, reason, deadline);
    const event: StoryTrace = { sequence, action, type: state ? 'ROOM_GROUP_ON' : 'ROOM_GROUP_OFF', at: new Date().toISOString(), ...proof };
    session.events.push(event);
    session.events.splice(0, Math.max(0, session.events.length - 48));
    return event;
  };

  const snapshot = (session: StorySession) => ({
    mode: backend.actual ? 'live' : 'replay',
    browserSession: {
      id: session.displayId,
      account: session.account,
      csrfToken: session.csrfToken,
      createdAt: new Date(session.createdAtMs).toISOString(),
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    },
    budget: { actionsLeft: Math.max(0, MAX_ACTIONS_PER_SESSION - session.actionCount), limit: MAX_ACTIONS_PER_SESSION },
    mobius: {
      actual: backend.actual,
      connected: true,
      cse: backend.cseId,
      source: backend.source,
      root: session.resourceRoot,
      createRetrieveVerified: session.events.filter((item) => item.verified).length,
      events: [...session.events].reverse(),
    },
    care: {
      status: session.care.status,
      expiresAt: session.care.expiresAtMs === null ? null : new Date(session.care.expiresAtMs).toISOString(),
    },
    location: {
      status: session.share.status,
      draftHash: session.share.draftHash,
      sharedUntil: session.share.expiresAtMs === null ? null : new Date(session.share.expiresAtMs).toISOString(),
    },
    keyring: {
      lastButton: session.keyring.lastButton,
      confirmPresses: session.keyring.confirmPresses,
      panicPresses: session.keyring.panicPresses,
      sequence: session.keyring.sequence,
    },
  });

  const expireCare = async (session: StorySession, action: StoryTrace['action'] = 'care-auto-expire') => {
    if (!['approved', 'active'].includes(session.care.status)) return;
    session.care.status = 'expiring';
    try {
      await groupTrace(session, action, false, 'grant-deadline');
      const groupDeleteRsc = await backend.revokeGroup(session);
      await trace(session, action, 'GRANT_EXPIRED', {
        expiredAt: new Date().toISOString(), enforcement: 'server-deadline', groupDeleteRsc,
      });
      session.care.status = 'expired';
      session.care.expireAttempts = 0;
    } catch (error) {
      session.care.expireAttempts += 1;
      session.care.retryAtMs = Date.now() + Math.min(30_000, 1000 * (2 ** session.care.expireAttempts));
      session.care.status = 'active';
      throw error;
    }
  };

  const keyringObservation = async (session: StorySession, action: 'keyring-confirm' | 'keyring-panic', buttonState: 'confirm' | 'panic') => {
    if (buttonState === 'confirm') session.keyring.confirmPresses += 1; else session.keyring.panicPresses += 1;
    session.keyring.sequence += 1;
    session.keyring.lastButton = buttonState;
    const now = new Date().toISOString();
    await trace(session, action, 'KEYRING_BUTTON_OBSERVATION', {
      version: 1,
      gatewayId: `story-gateway-${session.displayId.toLowerCase()}`,
      deviceId: `story-keyring-${session.displayId.toLowerCase()}`,
      bootId: `story-${session.resourceKey.slice(0, 12)}`,
      sequence: session.keyring.sequence,
      observedAt: now,
      receivedAt: now,
      rssi: -54,
      battery: 86,
      buttonState,
      sensorValues: {
        batteryAlert: false,
        buttonPresses: [session.keyring.confirmPresses, session.keyring.panicPresses],
      },
      state: true,
      firmwareRevision: 'story-r26-1.0.0',
      timestampSource: 'gateway-received',
    });
    await trace(session, action, buttonState === 'panic' ? 'PANIC_ALERT' : 'RESIDENT_CONFIRMED', {
      source: 'virtual-keyring', buttonState, browserSession: session.displayId,
    });
    session.keyring.lastButton = 'released';
  };

  const execute = async (session: StorySession, action: StoryAction) => {
    switch (action) {
      case 'activity-away':
        await trace(session, action, 'PRESENCE_CHANGED', { state: 'AWAY', disclosure: 'presence-only' });
        break;
      case 'activity-home':
        await trace(session, action, 'PRESENCE_CHANGED', { state: 'HOME', disclosure: 'presence-only' });
        break;
      case 'care-approve': {
        await backend.revokeGroup(session);
        session.care.expiresAtMs = Date.now() + careGrantSec * 1000;
        session.care.status = 'approved';
        session.care.expireAttempts = 0;
        await trace(session, action, 'CARE_GRANT_APPROVED', {
          scope: DEVICE_MEMBERS.map(([name]) => name),
          expiresAt: new Date(session.care.expiresAtMs).toISOString(),
          leastPrivilege: true,
        });
        break;
      }
      case 'room-all-on': {
        const activeGrant = ['approved', 'active'].includes(session.care.status)
          && session.care.expiresAtMs !== null && session.care.expiresAtMs > Date.now();
        if (!activeGrant) throw new StoryHttpError(409, '보호자 승인을 먼저 완료해 주세요.');
        await groupTrace(session, action, true, 'caregiver-approved-group-command');
        session.care.status = 'active';
        break;
      }
      case 'care-expire':
        await expireCare(session, action);
        break;
      case 'check-in':
        await trace(session, action, 'ROUTINE_ALERT', { kind: 'WANDERING', severity: 'watch', disclosure: 'explanation-first' });
        break;
      case 'call':
        await trace(session, action, 'CHECK_IN_CALL_STARTED', { recipient: 'resident', purpose: 'safety-check', channel: 'demo-call' });
        break;
      case 'location-draft': {
        const draft = { purpose: 'emergency-rescue', scope: ['location:read'], durationMinutes: 5, recipient: 'guardian-browser' };
        session.share.draftHash = digest(draft);
        session.share.status = 'drafted';
        session.share.expiresAtMs = null;
        await trace(session, action, 'SHARE_DRAFT', { ...draft, draftHash: session.share.draftHash });
        break;
      }
      case 'location-approve': {
        if (session.share.status !== 'drafted' || session.share.draftHash === null) throw new StoryHttpError(409, '위치 공유 초안을 먼저 확인해 주세요.');
        const until = Date.now() + 300_000;
        await trace(session, action, 'GUARDIAN_DECISION', {
          decision: 'APPROVE', reviewedDraftHash: session.share.draftHash, scope: ['location:read'], durationMinutes: 5,
        });
        await trace(session, action, 'LOCATION_LEASE', {
          purpose: 'emergency-rescue', reviewedDraftHash: session.share.draftHash,
          expiresAt: new Date(until).toISOString(), recipient: 'guardian-browser',
        });
        session.share.expiresAtMs = until;
        session.share.status = 'approved';
        break;
      }
      case 'keyring-confirm':
        await keyringObservation(session, action, 'confirm');
        break;
      case 'keyring-panic':
        await keyringObservation(session, action, 'panic');
        break;
    }
    return snapshot(session);
  };

  const createSession = async (request: IncomingMessage): Promise<StorySession> => {
    cleanupExpired();
    if (sessions.size >= maxSessions) throw new StoryHttpError(503, '스토리 데모 세션 순서를 준비하고 있습니다.');
    const key = createHmac('sha256', resourceSecret).update(clientKey(request)).digest('base64url');
    const now = Date.now();
    const recent = (rates.get(key) ?? []).filter((value) => value > now - RATE_WINDOW_MS);
    if (recent.length >= RATE_CREATIONS) throw new StoryHttpError(429, '브라우저 데모 세션을 순서대로 준비하고 있습니다.');
    recent.push(now);
    rates.set(key, recent);
    const id = randomBytes(24).toString('base64url');
    const resourceKey = createHmac('sha256', resourceSecret).update(id).digest('hex').slice(0, 20);
    const displayId = randomBytes(3).toString('hex').toUpperCase();
    const session: StorySession = {
      id,
      csrfToken: randomBytes(24).toString('base64url'),
      resourceKey,
      rn: `s-${resourceKey}`,
      displayId,
      account: `guardian.demo-${displayId.toLowerCase()}`,
      createdAtMs: now,
      expiresAtMs: now + sessionTtlSec * 1000,
      resourceRoot: '',
      nextSequence: 1,
      events: [],
      care: { status: 'ready', expiresAtMs: null, expireAttempts: 0, retryAtMs: 0 },
      share: { status: 'ready', draftHash: null, expiresAtMs: null },
      keyring: { lastButton: 'released', confirmPresses: 0, panicPresses: 0, sequence: 0 },
      actionCount: 0,
      disposed: false,
      idempotency: new Map(),
      chain: Promise.resolve(),
    };
    sessions.set(id, session);
    try {
      session.resourceRoot = await backend.provision(session);
      await trace(session, 'session-start', 'SESSION_STARTED', {
        isolation: 'http-only-browser-cookie', ttlSec: sessionTtlSec,
        csrf: 'session-bound-header', dataMinimization: true,
      });
      return session;
    } catch (error) {
      await scheduleCleanup(session);
      throw error;
    }
  };

  const lookup = (request: IncomingMessage): StorySession | null => {
    cleanupExpired();
    const id = cookieValue(request);
    return id ? sessions.get(id) ?? null : null;
  };

  const timer = setInterval(() => {
    cleanupExpired();
    const now = Date.now();
    for (const session of sessions.values()) {
      if (['approved', 'active'].includes(session.care.status) && session.care.expiresAtMs !== null
        && session.care.expiresAtMs <= now && session.care.retryAtMs <= now) {
        void enqueue(session, () => expireCare(session)).catch(() => undefined);
      }
      if (session.share.status === 'approved' && session.share.expiresAtMs !== null && session.share.expiresAtMs <= now) {
        session.share.status = 'expired';
        void enqueue(session, () => trace(session, 'location-auto-expire', 'LOCATION_LEASE_EXPIRED', {
          expiredAt: new Date().toISOString(), enforcement: 'server-deadline',
        })).catch(() => undefined);
      }
    }
  }, 1000);
  timer.unref();

  return {
    async handle(request, response, url) {
      if (url.pathname !== '/api/story/session' && url.pathname !== '/api/story/action') return false;
      try {
        if (request.method === 'POST') {
          if (!sameOrigin(request)) throw new StoryHttpError(403, '현재 데모 화면의 동일 출처 요청을 사용하세요.');
          if (!jsonContentType(request)) throw new StoryHttpError(415, 'application/json 형식을 사용하세요.');
        }
        if (url.pathname === '/api/story/session' && request.method === 'POST') {
          const existing = lookup(request);
          const session = existing ?? await createSession(request);
          json(response, existing ? 200 : 201, snapshot(session), { 'Set-Cookie': sessionCookie(request, session.id, sessionTtlSec) });
          return true;
        }
        if (url.pathname === '/api/story/session' && request.method === 'GET') {
          const session = lookup(request);
          if (!session) throw new StoryHttpError(404, '브라우저 전용 데모 세션을 준비해 주세요.');
          json(response, 200, snapshot(session));
          return true;
        }
        if (url.pathname === '/api/story/action' && request.method === 'POST') {
          const session = lookup(request);
          if (!session) throw new StoryHttpError(409, '브라우저 전용 데모 세션을 먼저 준비해 주세요.');
          if (!csrfMatches(request, session.csrfToken)) throw new StoryHttpError(403, '이 브라우저 세션의 CSRF 토큰을 사용하세요.');
          const idempotencyKey = request.headers['idempotency-key'];
          if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{4,96}$/.test(idempotencyKey)) throw new StoryHttpError(400, 'Idempotency-Key 요청 헤더를 확인하세요.');
          const body = await readJson(request);
          const action = body['action'];
          if (!storyActions.includes(action as StoryAction)) throw new StoryHttpError(400, '데모 동작을 확인하세요.');
          const previous = session.idempotency.get(idempotencyKey);
          if (previous !== undefined) {
            if (previous !== action) throw new StoryHttpError(409, '요청 식별자와 동작을 같은 조합으로 사용하세요.');
            json(response, 200, snapshot(session));
            return true;
          }
          if (session.actionCount >= MAX_ACTIONS_PER_SESSION) throw new StoryHttpError(429, '이 세션의 데모 동작 예산을 모두 사용했습니다.');
          const result = await enqueue(session, async () => {
            if (activeActions >= MAX_ACTIVE_ACTIONS) throw new StoryHttpError(503, 'Mobius 동작을 순서대로 검증하고 있습니다.');
            activeActions += 1;
            session.actionCount += 1;
            try { return await execute(session, action as StoryAction); }
            finally { activeActions -= 1; }
          });
          session.idempotency.set(idempotencyKey, action as StoryAction);
          json(response, 200, result);
          return true;
        }
        response.setHeader('Allow', url.pathname.endsWith('/action') ? 'POST' : 'GET, POST');
        throw new StoryHttpError(405, '이 데모 경로에 맞는 요청 방식을 사용하세요.');
      } catch (error) {
        const status = error instanceof StoryHttpError ? error.status : 503;
        const message = error instanceof StoryHttpError ? error.message : 'Mobius4가 이 브라우저의 다음 동작을 준비하고 있습니다.';
        json(response, status, { message });
        return true;
      }
    },
    async close() {
      clearInterval(timer);
      for (const session of [...sessions.values()]) await scheduleCleanup(session);
      await Promise.allSettled([...cleanupTasks]);
      rates.clear();
    },
    describe() {
      return {
        mode: backend.actual ? 'live' : 'replay', source: backend.source, cseId: backend.cseId,
        root: backend.rootPath, sessions: sessions.size, maxSessions, sessionTtlSec, careGrantSec,
        maxActionsPerSession: MAX_ACTIONS_PER_SESSION,
      };
    },
  };
}
