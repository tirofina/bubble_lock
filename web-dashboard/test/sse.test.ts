import assert from 'node:assert/strict';
import { get } from 'node:http';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { parseDashboardEvent } from '../shared/index.ts';
import type { DashboardEvent } from '../shared/index.ts';
import { startReplayServer } from '../server/sse.ts';

/** Subscribe before response flow, resolve on the exact replay-complete comment. */
function subscribe(t: TestContext, url: string, headers: Readonly<Record<string, string>> = {}) {
  return new Promise<{ events: readonly DashboardEvent[]; response: IncomingMessage }>((resolve, reject) => {
    let text = '';
    const request = get(url, { headers, signal: AbortSignal.timeout(5000) }, (response) => {
      response.setEncoding('utf8');
      response.on('error', reject);
      response.on('data', (chunk: string) => {
        text += chunk;
        if (!text.includes(': replay-complete\n\n')) return;
        try {
          const frames = text.split('\n\n').filter((frame) => frame.startsWith('id: '));
          const events = frames.map((frame) => {
            const lines = frame.split('\n');
            const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            assert.ok(data);
            const event = parseDashboardEvent(JSON.parse(data));
            assert.equal(Number(id), event.sequence);
            return event;
          });
          resolve({ events, response });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    t.after(() => request.destroy());
  });
}

test('resumes strictly after Last-Event-ID and keeps finite replay open', { timeout: 5000 }, async (t) => {
  // Given
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  // When
  const result = await subscribe(t, `${service.url}/events`, { 'Last-Event-ID': '5' });
  // Then
  assert.equal(result.response.statusCode, 200);
  assert.match(result.response.headers['content-type'] ?? '', /text\/event-stream/);
  assert.deepEqual(result.events.map((event) => event.sequence), Array.from({ length: 13 }, (_, index) => index + 6));
  assert.equal(result.response.readableEnded, false);
  assert.equal(result.response.complete, false);
});

test('resumes strictly after the query cursor on manual EventSource reconnect', { timeout: 5000 }, async (t) => {
  // Given
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  // When
  const result = await subscribe(t, `${service.url}/events?lastSequence=16`);
  // Then
  assert.deepEqual(result.events.map((event) => event.sequence), [17, 18]);
});

test('prefers native Last-Event-ID over the stale reconnect query', { timeout: 5000 }, async (t) => {
  // Given
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  // When
  const result = await subscribe(t, `${service.url}/events?lastSequence=1`, { 'Last-Event-ID': '17' });
  // Then
  assert.deepEqual(result.events.map((event) => event.sequence), [18]);
});

test('keeps an exhausted resume cursor open without replaying duplicates', { timeout: 5000 }, async (t) => {
  // Given
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  // When
  const result = await subscribe(t, `${service.url}/events?lastSequence=18`);
  // Then
  assert.equal(result.events.length, 0);
  assert.equal(result.response.complete, false);
});

test('returns explicit cursor errors instead of accepting malformed or future IDs', { timeout: 5000 }, async (t) => {
  // Given
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  // When
  const responses = await Promise.all(['-1', '1.5', 'abc', '9007199254740992', '19'].map((cursor) =>
    fetch(`${service.url}/events?lastSequence=${cursor}`, { signal: AbortSignal.timeout(4000) })));
  // Then
  assert.deepEqual(responses.map((response) => response.status), [400, 400, 400, 400, 409]);
  for (const response of responses) await response.arrayBuffer();
});

test('serves simulated resources audit search and source metadata over HTTP', { timeout: 5000 }, async (t) => {
  // Given
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  // When
  const responses = await Promise.all(['/api/resources', '/api/audit?q=denied', '/api/source'].map(async (path) => {
    const response = await fetch(`${service.url}${path}`, { signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 200);
    return response.json();
  }));
  // Then
  assert.equal(responses[0].simulation, true);
  assert.equal(responses[0].resources.length, 5);
  assert.equal(responses[1].records.length, 1);
  assert.equal(responses[1].records[0].outcome, 'denied');
  assert.equal(responses[2].source, 'fixture-replay');
  assert.equal(responses[2].roleScopeIsAuthorization, false);
});
