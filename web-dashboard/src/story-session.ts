import { useCallback, useEffect, useRef, useState } from 'react';
import { isRecord } from './client.ts';

export type StoryServerAction =
  | 'activity-away' | 'activity-home' | 'care-approve' | 'room-all-on' | 'care-expire'
  | 'check-in' | 'call' | 'location-draft' | 'location-approve' | 'keyring-confirm' | 'keyring-panic';
export type StoryActionPhase = 'ready' | 'sending' | 'verified';

export interface StoryTrace {
  readonly sequence: number;
  readonly action: string;
  readonly type: string;
  readonly at: string;
  readonly resource: string;
  readonly createRsc: number;
  readonly retrieveRsc: number;
  readonly verified: boolean;
  readonly detail: string;
  readonly members: readonly { readonly label: string; readonly state: boolean; readonly rsc: number; readonly verified: boolean }[];
}

export interface StorySessionSnapshot {
  readonly mode: 'live' | 'replay';
  readonly browserSession: {
    readonly id: string;
    readonly account: string;
    readonly csrfToken: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
  readonly budget: { readonly actionsLeft: number; readonly limit: number };
  readonly mobius: {
    readonly actual: boolean;
    readonly connected: boolean;
    readonly cse: string;
    readonly source: string;
    readonly root: string;
    readonly createRetrieveVerified: number;
    readonly events: readonly StoryTrace[];
  };
  readonly care: { readonly status: 'ready' | 'approved' | 'active' | 'expiring' | 'expired'; readonly expiresAt: string | null };
  readonly location: {
    readonly status: 'ready' | 'drafted' | 'approved' | 'expired';
    readonly draftHash: string | null;
    readonly sharedUntil: string | null;
  };
  readonly keyring: {
    readonly lastButton: 'released' | 'confirm' | 'panic';
    readonly confirmPresses: number;
    readonly panicPresses: number;
    readonly sequence: number;
  };
}

function parseTrace(value: unknown): StoryTrace | null {
  if (!isRecord(value) || !Number.isSafeInteger(value['sequence']) || typeof value['sequence'] !== 'number'
    || typeof value['action'] !== 'string' || typeof value['type'] !== 'string' || typeof value['at'] !== 'string'
    || typeof value['resource'] !== 'string' || typeof value['createRsc'] !== 'number' || typeof value['retrieveRsc'] !== 'number'
    || typeof value['verified'] !== 'boolean' || typeof value['detail'] !== 'string') return null;
  const members = Array.isArray(value['members']) ? value['members'].flatMap((item) => isRecord(item)
    && typeof item['label'] === 'string' && typeof item['state'] === 'boolean'
    && typeof item['rsc'] === 'number' && typeof item['verified'] === 'boolean'
    ? [{ label: item['label'], state: item['state'], rsc: item['rsc'], verified: item['verified'] }] : []) : [];
  return {
    sequence: value['sequence'], action: value['action'], type: value['type'], at: value['at'], resource: value['resource'],
    createRsc: value['createRsc'], retrieveRsc: value['retrieveRsc'], verified: value['verified'], detail: value['detail'], members,
  };
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseStorySession(value: unknown): StorySessionSnapshot {
  if (!isRecord(value) || !['live', 'replay'].includes(String(value['mode'])) || !isRecord(value['browserSession'])
    || !isRecord(value['budget']) || !isRecord(value['mobius']) || !isRecord(value['care'])
    || !isRecord(value['location']) || !isRecord(value['keyring'])) throw new TypeError('story-session');
  const browser = value['browserSession'];
  const budget = value['budget'];
  const mobius = value['mobius'];
  const care = value['care'];
  const location = value['location'];
  const keyring = value['keyring'];
  if (typeof browser['id'] !== 'string' || typeof browser['account'] !== 'string' || typeof browser['csrfToken'] !== 'string'
    || typeof browser['createdAt'] !== 'string' || typeof browser['expiresAt'] !== 'string'
    || !safeInteger(budget['actionsLeft']) || !safeInteger(budget['limit'])
    || typeof mobius['actual'] !== 'boolean' || typeof mobius['connected'] !== 'boolean' || typeof mobius['cse'] !== 'string'
    || typeof mobius['source'] !== 'string' || typeof mobius['root'] !== 'string' || !safeInteger(mobius['createRetrieveVerified'])
    || !Array.isArray(mobius['events']) || !['ready', 'approved', 'active', 'expiring', 'expired'].includes(String(care['status']))
    || (care['expiresAt'] !== null && typeof care['expiresAt'] !== 'string')
    || !['ready', 'drafted', 'approved', 'expired'].includes(String(location['status']))
    || (location['draftHash'] !== null && typeof location['draftHash'] !== 'string')
    || (location['sharedUntil'] !== null && typeof location['sharedUntil'] !== 'string')
    || !['released', 'confirm', 'panic'].includes(String(keyring['lastButton']))
    || !safeInteger(keyring['confirmPresses']) || !safeInteger(keyring['panicPresses']) || !safeInteger(keyring['sequence'])) {
    throw new TypeError('story-session');
  }
  return {
    mode: value['mode'] as 'live' | 'replay',
    browserSession: {
      id: browser['id'], account: browser['account'], csrfToken: browser['csrfToken'],
      createdAt: browser['createdAt'], expiresAt: browser['expiresAt'],
    },
    budget: { actionsLeft: budget['actionsLeft'], limit: budget['limit'] },
    mobius: {
      actual: mobius['actual'], connected: mobius['connected'], cse: mobius['cse'], source: mobius['source'], root: mobius['root'],
      createRetrieveVerified: mobius['createRetrieveVerified'],
      events: mobius['events'].flatMap((item) => { const parsed = parseTrace(item); return parsed ? [parsed] : []; }),
    },
    care: { status: care['status'] as StorySessionSnapshot['care']['status'], expiresAt: care['expiresAt'] as string | null },
    location: {
      status: location['status'] as StorySessionSnapshot['location']['status'],
      draftHash: location['draftHash'] as string | null,
      sharedUntil: location['sharedUntil'] as string | null,
    },
    keyring: {
      lastButton: keyring['lastButton'] as StorySessionSnapshot['keyring']['lastButton'],
      confirmPresses: keyring['confirmPresses'], panicPresses: keyring['panicPresses'], sequence: keyring['sequence'],
    },
  };
}

async function responseJson(response: Response): Promise<StorySessionSnapshot> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(isRecord(value) && typeof value['message'] === 'string'
    ? value['message'] : '브라우저 데모 세션을 준비하고 있습니다.');
  return parseStorySession(value);
}

export function useStorySession(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<StorySessionSnapshot | null>(null);
  const [phase, setPhase] = useState<StoryActionPhase>('ready');
  const [message, setMessage] = useState<string | null>(null);
  const current = useRef<StorySessionSnapshot | null>(null);
  const ensurePromise = useRef<Promise<StorySessionSnapshot> | null>(null);

  const publish = useCallback((next: StorySessionSnapshot) => {
    current.current = next;
    setSnapshot(next);
    setMessage(null);
    return next;
  }, []);

  const ensure = useCallback(async () => {
    if (current.current) return current.current;
    const pending = ensurePromise.current ?? fetch('/api/story/session', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(20_000),
    }).then(responseJson).then(publish);
    ensurePromise.current = pending;
    try { return await pending; }
    catch (error) {
      setMessage(error instanceof Error ? error.message : '브라우저 데모 세션을 준비하고 있습니다.');
      throw error;
    } finally {
      if (ensurePromise.current === pending) ensurePromise.current = null;
    }
  }, [publish]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/story/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (response.status === 404) {
        current.current = null;
        setSnapshot(null);
        return enabled ? await ensure() : null;
      }
      return publish(await responseJson(response));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Mobius4 상태를 다시 맞추고 있습니다.');
      return current.current;
    }
  }, [enabled, ensure, publish]);

  const runAction = useCallback(async (action: StoryServerAction, idempotencyKey: string) => {
    const session = await ensure();
    setPhase('sending');
    try {
      const next = await responseJson(await fetch('/api/story/action', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Story-CSRF': session.browserSession.csrfToken,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(20_000),
      }));
      publish(next);
      setPhase('verified');
      return next;
    } catch (error) {
      setPhase('ready');
      setMessage(error instanceof Error ? error.message : 'Mobius4가 다음 동작을 준비하고 있습니다.');
      throw error;
    }
  }, [ensure, publish]);

  useEffect(() => {
    if (!enabled) return;
    void ensure().catch(() => undefined);
  }, [enabled, ensure]);

  useEffect(() => {
    if (!enabled || !snapshot) return;
    const deadlines = [snapshot.care.expiresAt, snapshot.location.sharedUntil]
      .filter((value): value is string => value !== null)
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value) && value > Date.now());
    if (deadlines.length === 0) return;
    const delay = Math.min(...deadlines) - Date.now() + 1200;
    const timer = setTimeout(() => { void refresh(); }, Math.max(500, delay));
    return () => clearTimeout(timer);
  }, [enabled, refresh, snapshot]);

  return { snapshot, phase, message, ensure, refresh, runAction };
}
