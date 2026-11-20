// Headless captures of the guardian alert card and the operator relocation view (replay mode, English UI).
// Usage: npm --prefix web-dashboard run build && node web-dashboard/scripts/capture-alert-card.mjs [--out=<dir>] [--lang=en]
// Starts the dashboard server (ALERT_SOURCE=replay) on a free port, serves dist/ with an /api and /events proxy
// (same-origin like the Vite dev proxy: the browser Origin of this preview port is not forwarded),
// and drives Chrome over CDP. Phone widths use Emulation.setDeviceMetricsOverride; SSE pages use fixed waits.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { once } from 'node:events';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const dashboard = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
const external = typeof args.api === 'string' ? args.api.replace(/\/$/, '') : null;
const outDir = typeof args.out === 'string' ? args.out : join(dashboard, 'evidence', '2026-11-20-alert-card', ...(external ? ['live'] : []));
const lang = args.lang === 'ko' ? 'ko' : 'en';
const dist = join(dashboard, 'dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/ is missing; run npm --prefix web-dashboard run build first');
async function freePort() { const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const { port } = probe.address(); await new Promise((done) => probe.close(done)); return port; }

const apiPort = external ? Number(new URL(external).port) : await freePort();
const api = external ? null : spawn(process.execPath, ['server/cli.ts'], { cwd: dashboard, env: { ...process.env, DASHBOARD_PORT: String(apiPort), ALERT_SOURCE: 'replay', ALERT_REPLAY_VARIANT: args.variant ?? 'claude', ALERT_REPLAY_START: 'alert' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
let apiLog = ''; if (api) { api.stdout.on('data', (chunk) => { apiLog += chunk; }); api.stderr.on('data', (chunk) => { apiLog += chunk; }); }
if (api) await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`server start timeout\n${apiLog}`)), 30000); api.on('message', (message) => { if (message?.type === 'ready') { clearTimeout(timer); resolve(); } }); api.once('exit', (code) => reject(new Error(`server exited ${code}\n${apiLog}`))); });
const apiUrl = `http://127.0.0.1:${apiPort}`;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const preview = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://preview');
  if (url.pathname.startsWith('/api') || url.pathname === '/events') {
    const proxied = httpRequest({ hostname: '127.0.0.1', port: apiPort, path: `${url.pathname}${url.search}`, method: request.method, headers: { ...Object.fromEntries(Object.entries(request.headers).filter(([key]) => !['origin', 'sec-fetch-site'].includes(key))), host: `127.0.0.1:${apiPort}` } }, (reply) => { response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response); });
    proxied.on('error', (error) => { console.error('proxy', url.pathname, error.message); if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(proxied); response.on('close', () => proxied.destroy());
    return;
  }
  const file = join(dist, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, ''));
  try { const info = await stat(file); if (!info.isFile()) throw new Error(); response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }); response.end(await readFile(file)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => preview.listen(0, '127.0.0.1', resolve));
const previewUrl = `http://127.0.0.1:${preview.address().port}`;
const step = async (name) => { const response = await fetch(`${apiUrl}/api/portal/alerts/replay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: name }) }); if (!response.ok) throw new Error(`replay ${name} ${response.status}`); };

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((path) => existsSync(path));
if (!chrome) throw new Error('Chrome or Edge not found');
const port = await freePort();
const profile = join(dashboard, '..', '.local', 'alert-card-capture', `chrome-${Date.now()}`);
await mkdir(profile, { recursive: true });
const browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const captured = [];
try {
  let version = null;
  for (let attempt = 0; attempt < 75 && !version; attempt += 1) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await delay(200); } }
  if (!version) throw new Error('chrome devtools did not start');
  async function page(width, height) {
    const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const socket = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let nextId = 1; const pending = new Map();
    socket.onmessage = (message) => { const data = JSON.parse(message.data); if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); } };
    const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Page.enable'); await send('Runtime.enable');
    return {
      send, close: () => socket.close(),
      async open(hash, wait = 3500) { await send('Page.navigate', { url: `${previewUrl}/?lang=${lang}${hash}` }); await delay(wait); },
      async click(selector, wait = 2500) { const result = await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`, returnByValue: true }); if (!result.result?.result?.value) throw new Error(`no element ${selector}`); await delay(wait); },
      async scrollTo(selector) { await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'})` }); await delay(400); },
      async shot(name, { full = true, clipSelector = null } = {}) {
        let clip;
        if (clipSelector) {
          const box = await send('Runtime.evaluate', { expression: `(() => { const r = document.querySelector(${JSON.stringify(clipSelector)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 16), y: Math.max(0, r.y + window.scrollY - 16), width: r.width + 32, height: r.height + 32 }; })()`, returnByValue: true });
          clip = { ...box.result.result.value, scale: 1 };
        }
        if (full) {
          const metrics = await send('Page.getLayoutMetrics');
          const fullHeight = Math.min(6000, Math.max(height, Math.ceil(metrics.result?.cssContentSize?.height ?? height)));
          await send('Emulation.setDeviceMetricsOverride', { width, height: fullHeight, deviceScaleFactor: 1, mobile: width < 600 }); await delay(600);
        }
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(clip), ...(clip ? { clip } : {}) });
        const bytes = Buffer.from(shot.result.data, 'base64');
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, `${name}.png`), bytes);
        captured.push({ name, width, lang, file: `${name}.png`, sha256: createHash('sha256').update(bytes).digest('hex') });
        if (full) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }); await delay(300); }
      },
    };
  }
  // 1-2. New alert (desktop and phone)
  const desk = await page(1440, 1000);
  await desk.open('#/user/overview');
  await desk.shot(`user-alert-new-1440-${lang}`);
  const phone = await page(390, 844);
  await phone.open('#/user/overview');
  await phone.shot(`user-alert-new-390-${lang}`);
  // 3. Share location 5 min (Emergency Rescue): server draft, exact draftHash approval, then the lease map
  await desk.click('.alert-actions button.primary', 4500);
  await desk.shot(`user-alert-approved-1440-${lang}`);
  await phone.open('#/user/overview', 4500);
  await phone.shot(`user-alert-approved-390-${lang}`);
  await desk.open('#/user/map', 5000);
  await desk.shot(`user-map-shared-1440-${lang}`, { full: false });
  await desk.open('#/user/overview', 3500);
  // 4. PANIC on the open incident
  await step('panic');
  await delay(1500);
  await desk.shot(`user-alert-escalated-1440-${lang}`);
  await phone.shot(`user-alert-escalated-390-${lang}`);
  // 5. Operator services: relocation timeline and triage audit (SSE stays open; fixed wait)
  const operator = await page(1440, 1000);
  await operator.open('#/operator/services', 4500);
  await operator.shot(`operator-services-1440-${lang}`);
  // 6. Dismissed state on a fresh story
  await step('reset'); await step('walk');
  await desk.open('#/user/overview', 3000);
  await desk.shot(`user-status-moving-1440-${lang}`, { full: false });
  await step('alert');
  await desk.open('#/user/overview', 3500);
  await desk.click('.alert-actions .quiet-button', 2500);
  await desk.shot(`user-alert-dismissed-1440-${lang}`);
  for (const item of [desk, phone, operator]) item.close();
  const manifest = { generatedAt: new Date().toISOString(), browser: version.Browser, mode: external ? `live (${external}, pc-mobius/scripts/run-video-live.mjs, real Mobius4, emulated devices and triage runtime, simulation true)` : 'replay (ALERT_SOURCE=replay, fixtures/guardian-alert-story.json, simulation true)', variant: args.variant ?? 'claude', lang, command: 'node web-dashboard/scripts/capture-alert-card.mjs', captured };
  await writeFile(join(outDir, `capture-manifest-${lang}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  browser.kill();
  preview.closeAllConnections(); preview.close();
  api?.send?.({ type: 'stop' });
  if (api) setTimeout(() => api.kill(), 2000).unref();
}
