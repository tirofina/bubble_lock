import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile } from 'node:fs/promises';
import { get } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env['RUN_ROOT'];
assert.ok(root, 'RUN_ROOT must be an owned mktemp directory');
for (const key of ['TMPDIR', 'NODE_COMPILE_CACHE', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH']) {
  assert.ok(process.env[key]?.startsWith(`${root}/`), `${key} must be isolated`);
}
const repo = fileURLToPath(new URL('../../', import.meta.url));
const script = fileURLToPath(import.meta.url);

if (process.argv[2] === '--child') {
  const { startReplayServer } = await import('../../web-dashboard/server/sse.ts');
  const service = await startReplayServer({
    port: 0, maxEventStreams: Number(process.env['SSE_MAX_STREAMS']),
    portalStatePath: join(root, 'events-state.json'),
  });
  service.server.on('request', (request, response) => {
    if (request.url?.startsWith('/events')) {
      response.once('close', () => process.send?.({ type: 'closed', path: request.url }));
    }
  });
  process.send?.({ type: 'ready', pid: process.pid, url: service.url });
  process.once('message', async () => {
    await service.close();
    process.disconnect();
  });
} else {
  const evidence = process.env['EVIDENCE_DIR'];
  assert.ok(evidence, 'EVIDENCE_DIR is required');
  const record = async (kind, value) => {
    const row = { at: new Date().toISOString(), ...value };
    await appendFile(join(evidence, `${kind}-after-live.jsonl`), `${JSON.stringify(row)}\n`);
    console.log(JSON.stringify(row));
  };
  const environment = {
    ...process.env, BFF_HOST: '0.0.0.0', LOCATION_SIMULATION: 'false',
    LOCATION_FILE: join(root, 'measured.jsonl'), PORTAL_CONFIG_FILE: '',
    PORTAL_DEMO_STATE: join(root, 'cli-state.json'), SSE_MAX_STREAMS: '1',
  };
  const rejected = spawn(process.execPath, ['web-dashboard/server/cli.ts'], {
    cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(10000),
  });
  let output = '';
  rejected.stdout.on('data', (chunk) => { output += chunk; });
  rejected.stderr.on('data', (chunk) => { output += chunk; });
  const [code, signal] = await once(rejected, 'exit');
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.match(output, /Measured demo locations require a loopback bind/);
  assert.equal(output.includes('이벤트 재생:'), false);
  await record('demo', { check: 'cli-rejects-before-bind', pid: rejected.pid, code,
    BFF_HOST: environment.BFF_HOST, LOCATION_FILE: environment.LOCATION_FILE,
    LOCATION_SIMULATION: environment.LOCATION_SIMULATION, output });

  for (const value of ['0', '1.5', '1025', '', 'NaN']) {
    const child = spawn(process.execPath, ['web-dashboard/server/cli.ts'], {
      cwd: repo, env: { ...environment, BFF_HOST: '127.0.0.1', SSE_MAX_STREAMS: value },
      stdio: ['ignore', 'ignore', 'pipe'], signal: AbortSignal.timeout(10000),
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [exit] = await once(child, 'exit');
    assert.equal(exit, 1);
    assert.match(stderr, /SSE_MAX_STREAMS|maxEventStreams/);
    await record('events', { check: 'cli-invalid-limit', value, code: exit });
  }

  const child = spawn(process.execPath, [script, '--child'], {
    cwd: repo, env: { ...process.env, SSE_MAX_STREAMS: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], signal: AbortSignal.timeout(15000),
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const requests = [];
  const message = (type, path) => new Promise((resolve) => {
    const listener = (value) => {
      if (value.type !== type || (path !== undefined && value.path !== path)) return;
      child.off('message', listener);
      resolve(value);
    };
    child.on('message', listener);
  });
  const subscribe = (url) => new Promise((resolve, reject) => {
    const request = get(url, { signal: AbortSignal.timeout(10000) }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('error', reject);
      response.on('data', (chunk) => {
        text += chunk;
        if (text.includes(': replay-complete\n\n')) resolve({ response, text });
      });
    });
    request.on('error', reject);
    requests.push(request);
  });
  try {
    const ready = await message('ready');
    const first = await subscribe(`${ready.url}/events?lastSequence=17`);
    assert.equal(first.response.statusCode, 200);
    assert.match(first.text, /id: 18\n/);
    await record('events', { check: 'live-stream', ...ready, status: 200, text: first.text });
    const overflow = await fetch(`${ready.url}/events`, { signal: AbortSignal.timeout(5000) });
    assert.equal(overflow.status, 503);
    const body = await overflow.json();
    assert.deepEqual(body, { error: 'event_stream_limit' });
    await record('events', { check: 'overflow', status: overflow.status, body });
    const closed = message('closed', '/events?lastSequence=17');
    first.response.destroy();
    await closed;
    const replacement = await subscribe(`${ready.url}/events?lastSequence=18`);
    assert.equal(replacement.response.statusCode, 200);
    assert.equal(replacement.text.includes('id: '), false);
    await record('events', { check: 'release-and-reconnect', status: 200, text: replacement.text });
  } finally {
    for (const request of requests) request.destroy();
    const exited = once(child, 'exit');
    if (child.connected) child.send('stop');
    else child.kill();
    const [exit, signal] = await exited;
    assert.equal(exit, 0, stderr);
    assert.equal(signal, null);
    await record('events', { check: 'child-cleanup', pid: child.pid, code: exit });
  }
}
