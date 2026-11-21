import assert from 'node:assert/strict';
import test from 'node:test';
import { startReplayServer } from '../server/sse.ts';

interface StoryFixture {
  readonly cookie: string;
  readonly csrf: string;
  readonly snapshot: any;
}

async function openSession(base: string): Promise<StoryFixture> {
  const response = await fetch(`${base}/api/story/session`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie?.startsWith('bl_story_dev=')) throw new Error('story session cookie');
  const snapshot = await response.json() as any;
  return { cookie, csrf: snapshot.browserSession.csrfToken, snapshot };
}

async function action(base: string, fixture: StoryFixture, name: string, key: string) {
  const response = await fetch(`${base}/api/story/action`, {
    method: 'POST',
    headers: {
      Origin: base,
      Cookie: fixture.cookie,
      'Content-Type': 'application/json',
      'X-Story-CSRF': fixture.csrf,
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ action: name }),
  });
  return { response, body: await response.json() as any };
}

test('isolates story state and Mobius resource roots by browser cookie', async (t) => {
  const service = await startReplayServer({ port: 0, storyMode: 'replay', storySecret: 'story-test-secret-that-is-at-least-32-bytes' });
  t.after(async () => service.close());
  const first = await openSession(service.url);
  const second = await openSession(service.url);
  assert.notEqual(first.snapshot.browserSession.id, second.snapshot.browserSession.id);
  assert.notEqual(first.snapshot.mobius.root, second.snapshot.mobius.root);
  assert.match(first.snapshot.mobius.root, /\/s-[a-f0-9]{20}$/);
  assert.doesNotMatch(first.snapshot.mobius.root, new RegExp(first.snapshot.browserSession.id, 'i'));

  const pressed = await action(service.url, first, 'keyring-panic', 'keyring:panic:1');
  assert.equal(pressed.response.status, 200);
  assert.equal(pressed.body.keyring.panicPresses, 1);
  assert.deepEqual(pressed.body.mobius.events.slice(0, 2).map((item: any) => item.type), ['PANIC_ALERT', 'KEYRING_BUTTON_OBSERVATION']);

  const untouched = await fetch(`${service.url}/api/story/session`, { headers: { Cookie: second.cookie } });
  assert.equal(untouched.status, 200);
  const secondSnapshot = await untouched.json() as any;
  assert.equal(secondSnapshot.keyring.panicPresses, 0);
  assert.equal(secondSnapshot.mobius.events.length, 1);
});

test('requires same-origin JSON, session CSRF, and an idempotency header', async (t) => {
  const service = await startReplayServer({ port: 0, storyMode: 'replay' });
  t.after(async () => service.close());
  const noOrigin = await fetch(`${service.url}/api/story/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  const foreign = await fetch(`${service.url}/api/story/session`, { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(foreign.status, 403);
  const crossSite = await fetch(`${service.url}/api/story/session`, {
    method: 'POST',
    headers: { Origin: service.url, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(crossSite.status, 403);
  const wrongType = await fetch(`${service.url}/api/story/session`, { method: 'POST', headers: { Origin: service.url, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);

  const secure = await fetch(`${service.url}/api/story/session`, {
    method: 'POST',
    headers: {
      Origin: service.url.replace('http:', 'https:'),
      'X-Forwarded-Proto': 'https',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(secure.status, 201);
  assert.match(secure.headers.get('set-cookie') ?? '', /^__Host-bl_story=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);

  const fixture = await openSession(service.url);
  const missingCsrf = await fetch(`${service.url}/api/story/action`, {
    method: 'POST', headers: { Origin: service.url, Cookie: fixture.cookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'presence:away:1' }, body: '{"action":"activity-away"}',
  });
  assert.equal(missingCsrf.status, 403);
  const missingKey = await fetch(`${service.url}/api/story/action`, {
    method: 'POST', headers: { Origin: service.url, Cookie: fixture.cookie, 'Content-Type': 'application/json', 'X-Story-CSRF': fixture.csrf }, body: '{"action":"activity-away"}',
  });
  assert.equal(missingKey.status, 400);
});

test('runs care group fan-out, explicit expiry, and three-member readback', async (t) => {
  const service = await startReplayServer({ port: 0, storyMode: 'replay' });
  t.after(async () => service.close());
  const fixture = await openSession(service.url);
  const approved = await action(service.url, fixture, 'care-approve', 'care:approve:1');
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.care.status, 'approved');
  const on = await action(service.url, fixture, 'room-all-on', 'care:on:1');
  assert.equal(on.response.status, 200);
  assert.equal(on.body.care.status, 'active');
  assert.equal(on.body.mobius.events[0].members.length, 3);
  assert.equal(on.body.mobius.events[0].detail, '3/3 그룹 구성원 readback 확인');
  const expired = await action(service.url, fixture, 'care-expire', 'care:expire:1');
  assert.equal(expired.response.status, 200);
  assert.equal(expired.body.care.status, 'expired');
  assert.deepEqual(expired.body.mobius.events.slice(0, 2).map((item: any) => item.type), ['GRANT_EXPIRED', 'ROOM_GROUP_OFF']);
});

test('binds location approval to the exact draft hash and keeps actions idempotent', async (t) => {
  const service = await startReplayServer({ port: 0, storyMode: 'replay' });
  t.after(async () => service.close());
  const fixture = await openSession(service.url);
  const otherBrowser = await openSession(service.url);
  const beforeApproval = await fetch(`${service.url}/api/story/location?lang=en`, { headers: { Cookie: fixture.cookie } });
  assert.equal(beforeApproval.status, 403);
  const drafted = await action(service.url, fixture, 'location-draft', 'location:draft:1');
  assert.equal(drafted.response.status, 200);
  assert.equal(drafted.body.location.status, 'drafted');
  assert.match(drafted.body.location.draftHash, /^[a-f0-9]{64}$/);
  const approved = await action(service.url, fixture, 'location-approve', 'location:approve:1');
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.location.status, 'approved');
  assert.ok(Date.parse(approved.body.location.sharedUntil) > Date.now());
  assert.deepEqual(approved.body.mobius.events.slice(0, 2).map((item: any) => item.type), ['LOCATION_LEASE', 'GUARDIAN_DECISION']);

  const map = await fetch(`${service.url}/api/story/location?lang=en`, { headers: { Cookie: fixture.cookie } });
  assert.equal(map.status, 200);
  const location = await map.json() as any;
  assert.equal(location.mode, 'demo');
  assert.equal(location.source, 'demo-fixture');
  assert.equal(location.devices.length, 1);
  assert.equal(location.devices[0].label, "Mom's keyring");
  assert.equal(location.readExpiresAt, approved.body.location.sharedUntil);
  const isolated = await fetch(`${service.url}/api/story/location?lang=en`, { headers: { Cookie: otherBrowser.cookie } });
  assert.equal(isolated.status, 403);
  const wrongMethod = await fetch(`${service.url}/api/story/location`, { method: 'POST', headers: { Origin: service.url, Cookie: fixture.cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');

  const before = approved.body.mobius.events.length;
  const replayed = await action(service.url, fixture, 'location-approve', 'location:approve:1');
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.body.mobius.events.length, before);
  const conflict = await action(service.url, fixture, 'call', 'location:approve:1');
  assert.equal(conflict.response.status, 409);
});
