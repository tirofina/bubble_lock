import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

/** Self-hosted password accounts: scrypt hashes from LOCAL_ACCOUNTS_FILE, sessions kept in server memory. */
export type LocalRole = 'guardian' | 'operator';
export interface LocalAccount { username: string; role: LocalRole; passwordHash: string }
export interface LocalIdentity { username: string; role: LocalRole; scopes: string[]; expiresAt: string }
export interface LocalAccountManager {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  authenticate(request: IncomingMessage): LocalIdentity | null;
  assertMutationOrigin(request: IncomingMessage): void;
  close(): void;
}
export interface LocalAccountOptions {
  accounts: LocalAccount[];
  scopes: Record<LocalRole, string[]>;
  sessionTtlSec?: number; maxSessions?: number; maxFailures?: number; failureWindowSec?: number; clock?: () => number;
}
interface Session { username: string; role: LocalRole; expiresAt: number }

const sessionCookie = 'bubble_local_session';
const usernamePattern = /^[A-Za-z0-9._-]{1,64}$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function json(response: ServerResponse, status: number, body: unknown, cookie?: string) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(cookie ? { 'Set-Cookie': cookie } : {}) });
  response.end(JSON.stringify(body));
}
function cookieValue(request: IncomingMessage): string | null {
  const values = String(request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${sessionCookie}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(sessionCookie.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
const setCookie = (value: string, maxAgeSec: number) => `${sessionCookie}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, length, { N: n, r, p, maxmem: 256 * n * r }, (error, key) => error ? reject(error) : resolve(key)));
}
/** Format: scrypt$N$r$p$saltBase64url$hashBase64url (written by scripts/add-local-account.mjs). */
async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![n, r, p].every(Number.isSafeInteger) || n < 1024 || n > 1048576 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 16 || expected.length < 32) return false;
  const actual = await derive(password, salt, n, r, p, expected.length);
  return timingSafeEqual(actual, expected);
}

export async function loadLocalAccounts(file: string): Promise<LocalAccount[]> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('LOCAL_ACCOUNTS_FILE에 계정을 하나 이상 등록하세요.');
  const accounts = value.map((entry: unknown) => {
    if (!object(entry) || typeof entry['username'] !== 'string' || !usernamePattern.test(entry['username'])
      || (entry['role'] !== 'guardian' && entry['role'] !== 'operator') || typeof entry['passwordHash'] !== 'string' || !entry['passwordHash'].startsWith('scrypt$')) {
      throw new TypeError('LOCAL_ACCOUNTS_FILE 계정 형식을 확인하세요: {username, role, passwordHash}');
    }
    return { username: entry['username'], role: entry['role'], passwordHash: entry['passwordHash'] } as LocalAccount;
  });
  if (new Set(accounts.map((account) => account.username)).size !== accounts.length) throw new TypeError('LOCAL_ACCOUNTS_FILE 사용자 이름이 겹치지 않게 등록하세요.');
  return accounts;
}

function clientAddress(request: IncomingMessage): string {
  const remote = request.socket.remoteAddress ?? 'unknown';
  const loopback = remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.');
  // The Vite dev proxy (xfwd) appends the browser's address as the last entry; only a loopback peer may supply it.
  const forwarded = request.headers['x-forwarded-for'];
  if (loopback && typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',').at(-1)!.trim();
  return remote;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 4096) throw Error('size'); chunks.push(bytes); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!object(value)) throw Error('shape');
  return value;
}

export function createLocalAccountManager(options: LocalAccountOptions): LocalAccountManager {
  const clock = options.clock ?? Date.now;
  const ttl = (options.sessionTtlSec ?? 43200) * 1000;
  const maxSessions = options.maxSessions ?? 1000;
  const maxFailures = options.maxFailures ?? 10;
  const failureWindow = (options.failureWindowSec ?? 300) * 1000;
  const accounts = new Map(options.accounts.map((account) => [account.username, account]));
  const sessions = new Map<string, Session>();
  const failures = new Map<string, { count: number; resetAt: number }>();
  // A fixed dummy hash keeps unknown usernames on the same scrypt cost as known ones.
  const dummyHash = `scrypt$16384$8$1$${randomBytes(16).toString('base64url')}$${randomBytes(64).toString('base64url')}`;
  const prune = () => {
    const now = clock();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    for (const [ip, entry] of failures) if (entry.resetAt <= now) failures.delete(ip);
  };
  const timer = setInterval(prune, 60_000); timer.unref();
  const assertMutationOrigin = (request: IncomingMessage) => {
    if (request.headers['sec-fetch-site'] === 'cross-site') throw Error('cross-site');
    const origin = request.headers.origin;
    if (origin === undefined) return;
    let host: string;
    try { host = new URL(origin).host; } catch { throw Error('origin'); }
    if (host !== request.headers.host) throw Error('origin');
  };
  const authenticate = (request: IncomingMessage): LocalIdentity | null => {
    const id = cookieValue(request);
    const session = id ? sessions.get(id) : undefined;
    if (!id || !session) return null;
    if (session.expiresAt <= clock() || !accounts.has(session.username)) { sessions.delete(id); return null; }
    return { username: session.username, role: session.role, scopes: [...options.scopes[session.role]], expiresAt: new Date(session.expiresAt).toISOString() };
  };
  return {
    authenticate,
    assertMutationOrigin,
    close() { clearInterval(timer); sessions.clear(); failures.clear(); },
    async handle(request, response) {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/api/auth/session' && request.method === 'GET') {
        const identity = authenticate(request);
        json(response, 200, identity
          ? { mode: 'live', authenticated: true, method: 'password', principal: { principalId: identity.username, scopes: identity.scopes }, expiresAt: identity.expiresAt }
          : { mode: 'live', authenticated: false, method: 'password' });
        return true;
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        try { assertMutationOrigin(request); } catch { json(response, 403, { message: '로그인한 화면에서 요청하세요.' }); return true; }
        const id = cookieValue(request);
        if (id) sessions.delete(id);
        json(response, 200, { logoutUrl: '/#/' }, setCookie('', 0));
        return true;
      }
      if (path === '/api/auth/local-login' && request.method === 'POST') {
        try { assertMutationOrigin(request); } catch { json(response, 403, { message: '로그인한 화면에서 요청하세요.' }); return true; }
        if (!String(request.headers['content-type']).startsWith('application/json')) { json(response, 415, { message: 'JSON 요청 형식을 사용해 주세요.' }); return true; }
        const ip = clientAddress(request);
        const now = clock();
        const entry = failures.get(ip);
        if (entry && entry.resetAt > now && entry.count >= maxFailures) {
          response.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
          json(response, 429, { message: '로그인 시도가 많아요. 잠시 후 다시 시도해 주세요.' });
          return true;
        }
        let input: Record<string, unknown>;
        try { input = await readJson(request); } catch { json(response, 400, { message: '입력값과 요청 형식을 확인해 주세요.' }); return true; }
        const username = typeof input['username'] === 'string' ? input['username'] : '';
        const password = typeof input['password'] === 'string' && input['password'].length <= 1024 ? input['password'] : '';
        const account = usernamePattern.test(username) ? accounts.get(username) : undefined;
        const valid = await verifyPassword(password, account?.passwordHash ?? dummyHash).catch(() => false);
        if (!account || !valid || !password) {
          const current = entry && entry.resetAt > now ? entry : { count: 0, resetAt: now + failureWindow };
          current.count += 1; failures.set(ip, current);
          json(response, 401, { message: '아이디 또는 비밀번호를 확인해 주세요.' });
          return true;
        }
        failures.delete(ip);
        prune();
        if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value!);
        const id = randomBytes(32).toString('base64url');
        sessions.set(id, { username: account.username, role: account.role, expiresAt: now + ttl });
        json(response, 200, { authenticated: true, principal: { principalId: account.username, scopes: [...options.scopes[account.role]] } }, setCookie(id, ttl / 1000));
        return true;
      }
      return false;
    },
  };
}
