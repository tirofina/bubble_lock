// Capture the seven mobile story screens and exercise login, keyring, approval, group-command and location-share actions.
// Usage: npm --prefix web-dashboard run build && npm --prefix web-dashboard run capture:story
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest, createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { once } from 'node:events';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const dashboard = fileURLToPath(new URL('..', import.meta.url));
const dist = join(dashboard, 'dist');
const outDir = join(dashboard, 'evidence', 'story-screens');
const scenes = [
  ['01-login', 'login', 'A safer day for your family'],
  ['02-activity-away', 'activity-away', 'Mom went out'],
  ['03-activity-home', 'activity-home', 'Mom is home'],
  ['04-care-request', 'care-request', 'Living room access for Mina'],
  ['05-caregiver-shared', 'caregiver-shared', 'Shared with you'],
  ['06-caregiver-ended', 'caregiver-ended', 'Access ended automatically'],
  ['07-check-in', 'check-in', 'Check on Mom'],
];
const galleryLabels = ['Auto sign-in', 'Went out', 'Returned home', 'Care approval', 'Room control', 'Automatic expiry', 'Keyring and check-in'];
if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ is missing; run npm --prefix web-dashboard run build first');

async function freePort() {
  const probe = netServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

const apiPort = await freePort();
const api = spawn(process.execPath, ['server/cli.ts'], {
  cwd: dashboard,
  env: { ...process.env, DASHBOARD_PORT: String(apiPort), ALERT_SOURCE: 'replay', ALERT_REPLAY_START: 'alert', CAREGIVER_DEMO: '1' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  windowsHide: true,
});
let apiLog = '';
api.stdout.on('data', (chunk) => { apiLog += chunk; });
api.stderr.on('data', (chunk) => { apiLog += chunk; });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`server start timeout\n${apiLog}`)), 30000);
  api.on('message', (message) => { if (message?.type === 'ready') { clearTimeout(timer); resolve(); } });
  api.once('exit', (code) => reject(new Error(`server exited ${code}\n${apiLog}`)));
});

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const gallery = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:56px;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{max-width:1170px;margin:0 auto 36px}p{margin:8px 0 0;color:#636366;font-size:20px}h1{margin:0;font-size:40px;letter-spacing:-.02em}.grid{width:1170px;margin:0 auto;display:grid;grid-template-columns:repeat(3,390px);gap:28px 0}.screen{display:grid;gap:10px}.screen img{display:block;width:360px;height:auto;border:1px solid #e0e0e0;border-radius:18px}.screen strong{font-size:17px}.screen span{color:#0066cc;font-size:13px;font-weight:600}
</style></head><body><header><h1>Privacy Bubble story screens</h1><p>Presence by default. Time-limited control. Five-minute location only on approval.</p></header><main class="grid">${scenes.map(([name], index) => `<figure class="screen"><img src="/story-evidence/${name}.png" alt="${galleryLabels[index]}"><figcaption><span>0${index + 1}</span> <strong>${galleryLabels[index]}</strong></figcaption></figure>`).join('')}</main></body></html>`;

const preview = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://preview');
  if (url.pathname.startsWith('/api') || url.pathname === '/events') {
    const proxied = httpRequest({ hostname: '127.0.0.1', port: apiPort, path: `${url.pathname}${url.search}`, method: request.method, headers: { ...Object.fromEntries(Object.entries(request.headers).filter(([key]) => !['origin', 'sec-fetch-site', 'host'].includes(key))), host: `127.0.0.1:${apiPort}`, origin: `http://127.0.0.1:${apiPort}`, 'sec-fetch-site': 'same-origin' } }, (reply) => { response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response); });
    proxied.on('error', (error) => { if (!response.headersSent) response.writeHead(502); response.end(error.message); });
    request.pipe(proxied); response.on('close', () => proxied.destroy());
    return;
  }
  if (url.pathname === '/story-gallery') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(gallery); return; }
  if (url.pathname.startsWith('/story-evidence/')) {
    try { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(await readFile(join(outDir, url.pathname.slice('/story-evidence/'.length)))); }
    catch { response.writeHead(404); response.end(); }
    return;
  }
  const file = join(dist, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, ''));
  try { const info = await stat(file); if (!info.isFile()) throw new Error(); response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }); response.end(await readFile(file)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => preview.listen(0, '127.0.0.1', resolve));
const previewUrl = `http://127.0.0.1:${preview.address().port}`;

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((path) => existsSync(path));
if (!chrome) throw new Error('Chrome or Edge is required');
const debugPort = await freePort();
const profile = join(dashboard, '..', '.local', 'story-screen-capture', `chrome-${Date.now()}`);
await mkdir(profile, { recursive: true });
await mkdir(outDir, { recursive: true });
const browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const captured = [];

try {
  let version = null;
  for (let attempt = 0; attempt < 75 && !version; attempt += 1) { try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await delay(200); } }
  if (!version) throw new Error('Chrome DevTools did not start');
  const created = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1; const pending = new Map();
  socket.onmessage = (message) => { const data = JSON.parse(message.data); if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); } };
  const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
  const waitFor = async (expression, label, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await evaluate(expression)) return; await delay(150); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const openScene = async (scene, expected) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Page.navigate', { url: `${previewUrl}/?lang=en&capture=1#/story/${scene}` });
    await waitFor(`document.body?.innerText.includes(${JSON.stringify(expected)})`, expected);
    await delay(400);
  };
  const shot = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(result.result.data, 'base64');
    await writeFile(join(outDir, `${name}.png`), bytes);
    captured.push({ name, width: 390, height: 844, file: `${name}.png`, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  for (const [name, scene, expected] of scenes) { await openScene(scene, expected); await shot(name); }

  await openScene('care-request', 'Living room access for Mina');
  await evaluate("document.querySelector('button.story-primary')?.click()");
  await waitFor("location.hash === '#/story/caregiver-shared'", 'care approval transition');
  await waitFor("document.querySelector('button.story-primary')?.textContent?.includes('All on')", 'caregiver controls');
  await evaluate("document.querySelector('button.story-primary')?.click()");
  await waitFor("document.querySelector('button.story-primary')?.textContent?.includes('3/3 verified')", 'group command result');

  await openScene('check-in', 'Prepare location share');
  await waitFor("Boolean(document.querySelector('button.story-secondary'))", 'location share action');
  await evaluate("document.querySelector('button.story-secondary')?.click()");
  await waitFor("document.querySelector('button.story-secondary')?.textContent?.includes('Review and share')", 'location draft');
  await evaluate("document.querySelector('button.story-secondary')?.click()");
  await waitFor("document.querySelector('button.story-secondary')?.textContent?.includes('Viewing location')", 'five-minute location share');

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/activity-away` });
  await waitFor("Boolean(document.querySelector('.keyring-physical-button.confirm:not(:disabled)'))", 'interactive virtual keyring');
  const beforeRotate = await evaluate("document.querySelector('.keyring-model')?.style.transform");
  const stage = await evaluate("(() => { const r=document.querySelector('.keyring-stage').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: stage.x, y: stage.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x + 46, y: stage.y + 20, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stage.x + 46, y: stage.y + 20, button: 'left', clickCount: 1 });
  await waitFor(`document.querySelector('.keyring-model')?.style.transform !== ${JSON.stringify(beforeRotate)}`, 'keyring drag rotation');
  await evaluate("[...document.querySelectorAll('.keyring-mode button')].find((button)=>button.textContent.includes('Move'))?.click()");
  const beforeMove = await evaluate("document.querySelector('.keyring-model')?.style.transform");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: stage.x, y: stage.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x - 34, y: stage.y + 16, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stage.x - 34, y: stage.y + 16, button: 'left', clickCount: 1 });
  await waitFor(`document.querySelector('.keyring-model')?.style.transform !== ${JSON.stringify(beforeMove)}`, 'keyring drag movement');
  await evaluate("document.querySelector('.keyring-physical-button.confirm')?.click()");
  await waitFor("Boolean(document.querySelector('[data-event-type=\"RESIDENT_CONFIRMED\"]'))", 'keyring confirm Mobius receipt');
  const systemShot = await send('Page.captureScreenshot', { format: 'png' });
  const systemBytes = Buffer.from(systemShot.result.data, 'base64');
  await writeFile(join(outDir, 'story-system-desktop.png'), systemBytes);
  captured.push({ name: 'story-system-desktop', width: 1440, height: 1000, file: 'story-system-desktop.png', sha256: createHash('sha256').update(systemBytes).digest('hex') });
  await evaluate("document.querySelector('.keyring-physical-button.panic')?.click()");
  await waitFor("location.hash === '#/story/check-in'", 'keyring panic to check-in transition');
  await waitFor("Boolean(document.querySelector('[data-event-type=\"PANIC_ALERT\"]'))", 'keyring panic Mobius receipt');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${previewUrl}/story-gallery` });
  await waitFor("document.images.length === 7 && [...document.images].every((image) => image.complete)", 'story gallery images');
  await delay(300);
  const galleryShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const galleryBytes = Buffer.from(galleryShot.result.data, 'base64');
  await writeFile(join(outDir, 'story-screens-overview.png'), galleryBytes);
  captured.push({ name: 'story-screens-overview', width: 1280, height: 1900, file: 'story-screens-overview.png', sha256: createHash('sha256').update(galleryBytes).digest('hex') });
  socket.close();

  const manifest = {
    generatedAt: new Date().toISOString(),
    browser: version.Browser,
    mode: 'browser-isolated replay CSE; auto-login, virtual keyring, guardian share and caregiver group command exercised',
    command: 'npm --prefix web-dashboard run capture:story',
    assertions: ['auto-login creates an isolated CSE session', 'keyring supports drag rotation and movement', 'keyring buttons create verified Mobius records', 'care approval opens the caregiver view', 'All on returns three readbacks', 'draft review opens a five-minute location lease'],
    captured,
  };
  await writeFile(join(outDir, 'capture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  browser.kill();
  preview.closeAllConnections(); preview.close();
  api.send?.({ type: 'stop' });
  setTimeout(() => api.kill(), 2000).unref();
}
