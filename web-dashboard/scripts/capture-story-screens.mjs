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
  let nextId = 1; const pending = new Map(); const actionResponses = [];
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); return; }
    if (data.method === 'Network.responseReceived' && data.params?.response?.url?.includes('/api/story/action')) {
      actionResponses.push({ status: data.params.response.status, url: data.params.response.url });
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
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
  const shot = async (name, width = 390, height = 844) => {
    const result = await send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(result.result.data, 'base64');
    await writeFile(join(outDir, `${name}.png`), bytes);
    captured.push({ name, width, height, file: `${name}.png`, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  const clearStorySession = async () => {
    await send('Network.clearBrowserCookies');
    await send('Page.navigate', { url: 'about:blank' });
    await delay(120);
  };
  const clickCenter = async (selector) => {
    const point = await evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)return null; const rect=element.getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()`);
    if (!point) throw new Error(`Missing click target ${selector}`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const waitForAction200 = async (startIndex, label) => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const response = actionResponses.slice(startIndex).find((item) => item.status === 200);
      if (response) return response;
      await delay(120);
    }
    throw new Error(`Timed out waiting for HTTP 200: ${label}; responses=${JSON.stringify(actionResponses.slice(startIndex))}`);
  };
  for (const [name, scene, expected] of scenes) { await openScene(scene, expected); await shot(name); }

  // The public entry starts with one product, then the same keyring travels into the verified system layout.
  await clearStorySession();
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: 'light' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ] });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/login` });
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'intro' && !document.querySelector('.keyring-physical-button.confirm')?.disabled", 'desktop keyring intro');
  await delay(300);
  const introLayout = await evaluate(`(() => {
    const visible = (element) => { if(!element)return false; const rect=element.getBoundingClientRect(); const style=getComputedStyle(element); return rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity)>0; };
    const model=document.querySelector('.keyring-model')?.getBoundingClientRect();
    return {
      intro: visible(document.querySelector('.story-intro')),
      dock: visible(document.querySelector('.keyring-dock')),
      visiblePanels: [...document.querySelectorAll('.story-panel-card')].filter(visible).length,
      modelWidth: model?.width ?? 0,
    };
  })()`);
  if (!introLayout.intro || !introLayout.dock || introLayout.visiblePanels !== 0 || introLayout.modelWidth < 200) {
    throw new Error(`desktop intro contract failed: ${JSON.stringify(introLayout)}`);
  }
  let keyboardReachedConfirm = false;
  for (let index = 0; index < 12 && !keyboardReachedConfirm; index += 1) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    keyboardReachedConfirm = await evaluate("document.activeElement?.classList.contains('confirm') === true");
  }
  const focusOutline = await evaluate("(() => { const button=document.querySelector('.keyring-physical-button.confirm'); return button===document.activeElement ? parseFloat(getComputedStyle(button).outlineWidth)||0 : 0; })()");
  if (!keyboardReachedConfirm || focusOutline < 3) throw new Error(`intro keyboard focus contract failed: reached=${keyboardReachedConfirm}, outline=${focusOutline}`);
  await shot('story-intro-desktop', 1440, 900);
  const introResponseIndex = actionResponses.length;
  await clickCenter('.keyring-physical-button.confirm');
  await waitForAction200(introResponseIndex, 'intro keyring confirm');
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system'", 'desktop system transition');
  await delay(900);
  await waitFor("Boolean(document.querySelector('[data-event-type=\"RESIDENT_CONFIRMED\"]'))", 'resident confirmation record');
  await waitFor("Boolean(document.querySelector('[data-fresh=\"true\"]'))", 'fresh Mobius node');
  const desktopSystemLayout = await evaluate(`(() => {
    const rect = (selector) => { const value=document.querySelector(selector)?.getBoundingClientRect(); return value ? {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height} : null; };
    const dock=rect('.keyring-dock'); const mobius=rect('.story-mobius'); const app=rect('.story-app-column');
    const mobiusPanel=document.querySelector('.story-mobius');
    const mobiusText=mobiusPanel?.innerText ?? '';
    const requiredTerms=['CSEBase','m2m:ae','m2m:cnt','m2m:cin','CREATE','RETRIEVE','RSC'];
    const clippedText=[...(mobiusPanel?.querySelectorAll('code,h2,h3,strong,small,.mobius-node-name,.mobius-node-detail p') ?? [])].filter((element)=>element.clientWidth>0 && element.scrollWidth>element.clientWidth+1).map((element)=>element.textContent?.trim()).filter(Boolean);
    const freshNode=document.querySelector('[data-fresh="true"]')?.dataset.path ?? '';
    const freshRecord=document.querySelector('.story-mobius-events .is-fresh')?.dataset.path ?? '';
    const tracePaths=[...document.querySelectorAll('[data-trace-path]')].map((item)=>item.dataset.tracePath);
    const confirm=document.querySelector('.keyring-physical-button.confirm')?.getBoundingClientRect();
    const top=confirm ? document.elementFromPoint(confirm.left+confirm.width/2,confirm.top+confirm.height/2) : null;
    const style=getComputedStyle(document.querySelector('.keyring-dock'));
    return {
      dock,mobius,app,freshNode,freshRecord,tracePaths,
      dockLeft:dock?.left,dockBottom:innerHeight-(dock?.bottom??0),
      background:style.backgroundColor,border:parseFloat(style.borderTopWidth)||0,zIndex:style.zIndex,
      disjoint:!!dock&&!!mobius&&dock.right<=mobius.left,
      ordered:!!mobius&&!!app&&mobius.right<=app.left,
      hit:top?.classList.contains('confirm')===true,
      englishOnly:mobiusPanel?.getAttribute('lang')==='en' && !/[가-힣]/.test(mobiusText),
      standardTerms:requiredTerms.every((term)=>mobiusText.includes(term)),
      clippedText,
    };
  })()`);
  const transparentDock = ['rgba(0, 0, 0, 0)', 'transparent'].includes(desktopSystemLayout.background);
  const linkedPath = desktopSystemLayout.freshNode && desktopSystemLayout.freshNode === desktopSystemLayout.freshRecord && desktopSystemLayout.tracePaths.includes(desktopSystemLayout.freshNode);
  if (desktopSystemLayout.dockLeft > 48 || desktopSystemLayout.dockBottom > 48 || !transparentDock || desktopSystemLayout.border !== 0
    || desktopSystemLayout.zIndex !== '30' || !desktopSystemLayout.disjoint || !desktopSystemLayout.ordered || !linkedPath || !desktopSystemLayout.hit
    || !desktopSystemLayout.englishOnly || !desktopSystemLayout.standardTerms || desktopSystemLayout.clippedText.length > 0) {
    throw new Error(`desktop system contract failed: ${JSON.stringify(desktopSystemLayout)}`);
  }
  await shot('story-system-desktop', 1440, 900);
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ] });
  await delay(180);
  const darkOrder = await evaluate("(() => { const m=document.querySelector('.story-mobius')?.getBoundingClientRect(); const a=document.querySelector('.story-app-column')?.getBoundingClientRect(); return !!m&&!!a&&m.right<=a.left; })()");
  if (!darkOrder) throw new Error('dark desktop layout contract failed');
  await shot('story-system-desktop-dark', 1440, 900);
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: 'light' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ] });

  // The interactive mobile shell owns exactly one viewport. Its lower dock unfolds one panel at a time.
  await clearStorySession();
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/activity-away` });
  await waitFor("Boolean(document.querySelector('.story-panel-tabs'))", 'mobile panel dock');
  const mobileLayout = await evaluate(`(() => {
    const visibleTargets = [...document.querySelectorAll('button,a,summary')].map((element) => {
      const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return { width: rect.width, height: rect.height, visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 };
    }).filter((item) => item.visible);
    return {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      smallTargets: visibleTargets.filter((item) => item.width < 44 || item.height < 44).length,
      keyringWidth: document.querySelector('.keyring-model')?.getBoundingClientRect().width ?? 999,
    };
  })()`);
  if (mobileLayout.width !== mobileLayout.viewportWidth || mobileLayout.height !== mobileLayout.viewportHeight || mobileLayout.smallTargets !== 0) {
    throw new Error(`mobile viewport contract failed: ${JSON.stringify(mobileLayout)}`);
  }
  await waitFor("Boolean(document.querySelector('.keyring-physical-button.confirm.is-guided'))", 'guided keyring confirm button');
  if ((await evaluate("document.querySelector('.keyring-model')?.getBoundingClientRect().width")) > 140) throw new Error('mobile keyring is larger than its compact panel contract');
  await evaluate("document.querySelector('.keyring-physical-button.confirm')?.click()");
  await waitFor("document.querySelector('[data-firmware-screen]')?.dataset.firmwareScreen === 'confirm'", 'firmware confirm screen');
  await waitFor("document.querySelectorAll('.story-panel-tabs .has-new-event').length >= 2", 'panel event highlights');
  await evaluate("[...document.querySelectorAll('.story-panel-tabs button')].find((button)=>button.textContent.includes('Resource tree'))?.click()");
  await waitFor("Boolean(document.querySelector('.mobius-node-detail code'))", 'interactive Mobius tree');
  const pathLayout = await evaluate("(() => { const code=document.querySelector('.mobius-node-detail code'); return {text:code?.textContent, width:code?.clientWidth, scrollWidth:code?.scrollWidth}; })()");
  if (!pathLayout.text?.startsWith('/Mobius/') || pathLayout.scrollWidth > pathLayout.width) throw new Error(`Mobius full path layout failed: ${JSON.stringify(pathLayout)}`);

  await clearStorySession();
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: 'light' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ] });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/login` });
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'intro' && !document.querySelector('.keyring-physical-button.confirm')?.disabled", 'landscape keyring intro');
  await shot('story-intro-landscape', 844, 390);
  const landscapeResponseIndex = actionResponses.length;
  await clickCenter('.keyring-physical-button.confirm');
  await waitForAction200(landscapeResponseIndex, 'landscape keyring confirm');
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system'", 'landscape system');
  await delay(900);
  const landscapeLayout = await evaluate(`(() => {
    const rect = (selector) => { const value=document.querySelector(selector)?.getBoundingClientRect(); return value ? {left:value.left,right:value.right,top:value.top,bottom:value.bottom} : null; };
    const dock=rect('.keyring-dock'); const mobius=rect('.story-mobius'); const app=rect('.story-app-column');
    const visibleTargets=[...document.querySelectorAll('button,a,summary')].map((element)=>{const r=element.getBoundingClientRect();const s=getComputedStyle(element);return {width:r.width,height:r.height,visible:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight};}).filter((item)=>item.visible);
    return {
      width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,
      viewportWidth:innerWidth,viewportHeight:innerHeight,dock,mobius,app,
      ordered:!!dock&&!!mobius&&!!app&&dock.right<=mobius.left&&mobius.right<=app.left,
      smallTargets:visibleTargets.filter((item)=>item.width<44||item.height<44).length,
    };
  })()`);
  if (landscapeLayout.width !== 844 || landscapeLayout.height !== 390 || !landscapeLayout.ordered || landscapeLayout.smallTargets !== 0) {
    throw new Error(`landscape contract failed: ${JSON.stringify(landscapeLayout)}`);
  }
  await shot('story-system-landscape', 844, 390);

  await clearStorySession();
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/login` });
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'intro' && document.querySelector('.story-rotate')?.getAttribute('aria-hidden') === 'false' && document.activeElement?.classList.contains('story-rotate-continue')", 'portrait rotate prompt');
  const portraitIntro = await evaluate(`(() => {
    const rotate=document.querySelector('.story-rotate'); const button=document.querySelector('.story-rotate-continue'); const keyring=document.querySelector('.keyring-model');
    const rr=rotate?.getBoundingClientRect(); const br=button?.getBoundingClientRect(); const kr=keyring?.getBoundingClientRect();
    return { rotateVisible:!!rr&&rr.width>0&&rr.height>0, buttonWidth:br?.width??0, buttonHeight:br?.height??0, keyringVisible:!!kr&&kr.width>0&&kr.height>0, optimizedCopy:rotate?.textContent?.includes('optimized demo')===true, focusOnContinue:document.activeElement===button };
  })()`);
  if (!portraitIntro.rotateVisible || !portraitIntro.keyringVisible || !portraitIntro.optimizedCopy || !portraitIntro.focusOnContinue || portraitIntro.buttonWidth < 44 || portraitIntro.buttonHeight < 44) {
    throw new Error(`portrait intro contract failed: ${JSON.stringify(portraitIntro)}`);
  }
  await shot('story-intro-portrait', 390, 844);
  await clickCenter('.story-rotate-continue');
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system' && document.querySelector('.story-demo')?.dataset.portrait === 'continue' && document.querySelector('.story-rotate')?.getAttribute('aria-hidden') === 'true'", 'portrait fallback system');
  await delay(900);
  const portraitSystem = await evaluate(`(() => {
    const visibleTargets=[...document.querySelectorAll('button,a,summary')].map((element)=>{const r=element.getBoundingClientRect();const s=getComputedStyle(element);return {width:r.width,height:r.height,visible:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight};}).filter((item)=>item.visible);
    return {width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,smallTargets:visibleTargets.filter((item)=>item.width<44||item.height<44).length};
  })()`);
  if (portraitSystem.width !== 390 || portraitSystem.height !== 844 || portraitSystem.smallTargets !== 0) {
    throw new Error(`portrait system contract failed: ${JSON.stringify(portraitSystem)}`);
  }
  await shot('story-system-portrait', 390, 844);

  await clearStorySession();
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/activity-away` });
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system' && document.querySelector('.story-rotate')?.getAttribute('aria-hidden') === 'false' && document.activeElement?.classList.contains('story-rotate-continue')", 'portrait deep-link rotate prompt');
  const portraitGate = await evaluate("(() => ({mainInert:document.querySelector('.story-stage')?.inert===true,dockInert:document.querySelector('.keyring-dock')?.inert===true,dialog:document.querySelector('.story-rotate')?.getAttribute('role')}))()");
  if (!portraitGate.mainInert || !portraitGate.dockInert || portraitGate.dialog !== 'dialog') throw new Error(`portrait orientation gate failed: ${JSON.stringify(portraitGate)}`);
  await clickCenter('.story-rotate-continue');
  await waitFor("document.querySelector('.story-rotate')?.getAttribute('aria-hidden') === 'true' && document.querySelector('.story-stage')?.inert === false", 'portrait deep-link continue');

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

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
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
  await writeFile(join(outDir, 'story-system-desktop-interaction.png'), systemBytes);
  captured.push({ name: 'story-system-desktop-interaction', width: 1440, height: 900, file: 'story-system-desktop-interaction.png', sha256: createHash('sha256').update(systemBytes).digest('hex') });
  await evaluate("document.querySelector('.keyring-physical-button.panic')?.click()");
  await waitFor("location.hash === '#/story/check-in'", 'keyring panic to check-in transition');
  await waitFor("Boolean(document.querySelector('[data-event-type=\"PANIC_ALERT\"]'))", 'keyring panic Mobius receipt');

  await clearStorySession();
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: 'light' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ] });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/login` });
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'intro' && !document.querySelector('.keyring-physical-button.confirm')?.disabled", 'reduced-motion intro');
  await clickCenter('.keyring-physical-button.confirm');
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system'", 'reduced-motion system');
  await delay(200);
  const dockAnimations = await evaluate("document.querySelector('.keyring-dock')?.getAnimations({subtree:true}).filter((animation)=>animation.playState==='running').length ?? 0");
  if (dockAnimations !== 0) throw new Error(`reduced-motion contract failed: ${dockAnimations} running dock animations`);

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
    mode: 'browser-isolated replay CSE; keyring-first transition, landscape split, portrait fallback, guardian share and caregiver group command exercised',
    command: 'npm --prefix web-dashboard run capture:story',
    assertions: ['intro shows only the keyring product and guidance', 'real keyring input returns HTTP 200 and transitions into the system stage', 'floating dock is transparent, z-index 30 and disjoint from Mobius', 'fresh Mobius tree node, trace path and newest record share one resource path', 'Mobius browser is English-only and exposes oneM2M resource types, methods and RSC values without clipped text', 'desktop Mobius stays left of the phone in light and dark mode', 'phone landscape fits dock, Mobius and app side by side in one viewport', 'phone portrait and portrait deep links show the optimized landscape prompt with a 44px Continue upright path', 'all visible controls are at least 44px', 'reduced motion leaves no running dock animation', 'keyboard focus reaches the confirm button with a 3px outline', 'Mobius tree exposes a wrapping full resource path', 'keyring firmware screen mirrors READY/CONFIRM/PANIC states', 'keyring supports drag rotation and movement', 'care approval opens the caregiver view', 'All on returns three readbacks', 'draft review opens a five-minute location lease'],
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
