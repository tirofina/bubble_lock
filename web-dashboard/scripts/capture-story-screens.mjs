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
    // Park the pointer in the empty top-left corner so no :hover tint survives into the next screenshot.
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
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
  const assertViewportFit = async (label) => {
    const metrics = await evaluate(`(() => {
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      };
      const root = document.querySelector('.story-demo');
      const rootRect = root?.getBoundingClientRect();
      const major = [...document.querySelectorAll('.story-demo,.story-stage,.story-mobius,.story-panel-card.is-mobile-open,.story-app-column,.story-device,.story-phone,.story-content,.story-coach')].filter(visible);
      const overflow = major.filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1).map((element) => ({
        selector: element.className,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      const scrollContainers = [...(root?.querySelectorAll('*') ?? [])].filter(visible).filter((element) => {
        const style = getComputedStyle(element);
        const scrollX = (style.overflowX === 'auto' || style.overflowX === 'scroll') && element.scrollWidth > element.clientWidth + 1;
        const scrollY = (style.overflowY === 'auto' || style.overflowY === 'scroll') && element.scrollHeight > element.clientHeight + 1;
        return scrollX || scrollY;
      }).filter((element) => !element.matches('.mobius-tree-scroll[data-scrollable="true"]')).map((element) => element.className || element.tagName);
      const outside = major.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1;
      }).map((element) => element.className);
      const overflowChildren = [...(root?.querySelectorAll('*') ?? [])].filter(visible).filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1).slice(0, 12).map((element) => ({
        selector:element.className||element.tagName,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,
      }));
      const metaChildren=[...(document.querySelector('.story-location-meta')?.children??[])].map((element)=>({selector:element.className||element.tagName,display:getComputedStyle(element).display,width:element.getBoundingClientRect().width,scrollWidth:element.scrollWidth,text:element.textContent}));
      return {
        docWidth: document.documentElement.scrollWidth,
        docHeight: document.documentElement.scrollHeight,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        fullScreen: !!rootRect && Math.abs(rootRect.left) < 1 && Math.abs(rootRect.top) < 1 && Math.abs(rootRect.width - innerWidth) < 1 && Math.abs(rootRect.height - innerHeight) < 1,
        overflow,
        scrollContainers,
        outside,
        overflowChildren,
        metaChildren,
      };
    })()`);
    if (!metrics.fullScreen || metrics.docWidth !== metrics.viewportWidth || metrics.docHeight !== metrics.viewportHeight
      || metrics.overflow.length > 0 || metrics.scrollContainers.length > 0 || metrics.outside.length > 0) {
      throw new Error(`${label} viewport fit failed: ${JSON.stringify(metrics)}`);
    }
    return metrics;
  };
  const assertCoach = async (label, expectedTarget) => {
    const coach = await evaluate(`(() => {
      const visible=(element)=>{if(!element)return false;const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0;};
      const rect=(element)=>{const value=element?.getBoundingClientRect();return value?{left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}:null;};
      const root=document.querySelector('.story-demo');
      const card=document.querySelector('.story-coach');
      const target=[...document.querySelectorAll('[data-demo-target=${JSON.stringify(expectedTarget)}]')].find(visible);
      const cardRect=rect(card);const targetRect=rect(target);
      const rootStyle=root?getComputedStyle(root):null;
      const safeLeft=parseFloat(rootStyle?.getPropertyValue('--safe-left')||'0');
      const safeRight=parseFloat(rootStyle?.getPropertyValue('--safe-right')||'0');
      const safeTop=parseFloat(rootStyle?.getPropertyValue('--safe-top')||'0');
      const safeBottom=parseFloat(rootStyle?.getPropertyValue('--safe-bottom')||'0');
      const hit=targetRect?document.elementFromPoint(targetRect.left+targetRect.width/2,targetRect.top+targetRect.height/2):null;
      const targetStyle=target?getComputedStyle(target):null;
      const before=target?getComputedStyle(target,'::before'):null;
      const after=target?getComputedStyle(target,'::after'):null;
      const highlighted=!!targetStyle&&(
        parseFloat(targetStyle.outlineWidth)>0||targetStyle.boxShadow!=='none'||
        (!!before&&before.content!=='none'&&(before.boxShadow!=='none'||parseFloat(before.outlineWidth)>0||before.animationName!=='none'))||
        (!!after&&after.content!=='none'&&(after.boxShadow!=='none'||parseFloat(after.outlineWidth)>0||after.animationName!=='none'))
      );
      return {
        rootTarget:root?.dataset.coachTarget,cardTarget:card?.dataset.target,
        visible:visible(card),targetVisible:visible(target),cardRect,targetRect,
        insideSafe:!!cardRect&&cardRect.left>=safeLeft-1&&cardRect.right<=innerWidth-safeRight+1&&cardRect.top>=safeTop-1&&cardRect.bottom<=innerHeight-safeBottom+1,
        fits:!!card&&card.scrollWidth<=card.clientWidth+1&&card.scrollHeight<=card.clientHeight+1,
        pointerEvents:card?getComputedStyle(card).pointerEvents:null,
        copy:card?.textContent??'',
        targetReachable:!!target&&!!hit&&(target===hit||target.contains(hit)||hit.closest('[data-demo-target]')===target),
        highlighted,
      };
    })()`);
    if (coach.rootTarget !== expectedTarget || coach.cardTarget !== expectedTarget || !coach.visible || !coach.targetVisible
      || !coach.insideSafe || !coach.fits || coach.pointerEvents !== 'none' || !coach.copy.includes('Next action')
      || !coach.targetReachable || !coach.highlighted) {
      throw new Error(`${label} coach contract failed: ${JSON.stringify(coach)}`);
    }
    return coach;
  };
  const assertReadableLayout = async (label) => {
    const result = await evaluate(`(() => {
      const rendered=(element)=>{if(!element)return false;const rect=element.getBoundingClientRect();if(rect.width<=2||rect.height<=2)return false;for(let node=element;node;node=node.parentElement){const style=getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return false;}return true;};
      const rect=(element)=>{const value=element?.getBoundingClientRect();return value?{left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}:null;};
      const overlaps=(a,b)=>!!a&&!!b&&a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
      const selectors='.story-app-column h1,.story-app-column h2,.story-app-column p,.story-app-column strong,.story-app-column small,.story-app-column button,.story-app-column code,.story-mobius h2,.story-mobius h3,.story-mobius p,.story-mobius strong,.story-mobius small,.story-mobius button,.story-mobius code,.story-mobius .mobius-node-name,.story-bottom-nav a,.story-bottom-nav span,.lang-switch button,.story-coach p,.story-coach strong';
      const textElements=[...document.querySelectorAll(selectors)].filter(rendered);
      const clipped=[];const obscured=[];
      for(const element of textElements){
        const own=rect(element);if(!own)continue;
        const nodes=[...element.childNodes].filter((node)=>node.nodeType===Node.TEXT_NODE&&(node.textContent??'').trim());
        for(const node of nodes){
          const range=document.createRange();range.selectNodeContents(node);
          for(const value of range.getClientRects()){
            if(value.width<2||value.height<2)continue;
            if(value.left<own.left-1||value.right>own.right+1||value.top<own.top-1||value.bottom>own.bottom+1){clipped.push({text:(node.textContent??'').trim(),owner:element.className||element.tagName});continue;}
            if(element.closest('.story-coach'))continue;
            const hit=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,value.left+value.width/2)),Math.max(0,Math.min(innerHeight-1,value.top+value.height/2)));
            const sameControl=element.closest('button,a')&&hit?.closest('button,a')===element.closest('button,a');
            if(hit&&!element.contains(hit)&&!hit.contains(element)&&!sameControl)obscured.push({text:(node.textContent??'').trim(),owner:element.className||element.tagName,hit:hit.className||hit.tagName});
          }
        }
      }
      const language=rect(document.querySelector('.lang-switch'));
      const coach=rect(document.querySelector('.story-coach'));
      const navigation=rect(document.querySelector('.story-bottom-nav'));
      const appBlocks=[...document.querySelectorAll('.story-content > *,.story-inline-error')].filter(rendered).map((element)=>({name:element.className||element.tagName,value:rect(element)}));
      const systemBlocks=[
        {name:'Mobius tabs',value:rect(document.querySelector('.story-panel-tabs'))},
        {name:'open Mobius panel',value:rect(document.querySelector('.story-panel-card.is-mobile-open'))},
        {name:'app column',value:rect(document.querySelector('.story-app-column'))},
      ];
      const overlapsFound=[];
      for(const block of appBlocks){if(overlaps(language,block.value))overlapsFound.push('language / '+block.name);if(overlaps(navigation,block.value))overlapsFound.push('navigation / '+block.name);}
      for(const block of systemBlocks){if(overlaps(coach,block.value))overlapsFound.push('coach / '+block.name);}
      return {clipped:clipped.slice(0,12),obscured:obscured.slice(0,12),overlaps:[...new Set(overlapsFound)]};
    })()`);
    if (result.clipped.length > 0 || result.obscured.length > 0 || result.overlaps.length > 0) {
      throw new Error(`${label} readable layout contract failed: ${JSON.stringify(result)}`);
    }
    return result;
  };
  const assertEvidenceGuide = async (label, expectedEvidence, expectedStrength, expectedProgress) => {
    const result = await evaluate(`(() => {
      const root=document.querySelector('.story-demo');
      const tab=document.querySelector('.story-panel-tabs [data-evidence-target=${JSON.stringify(expectedEvidence)}]');
      const panel=document.querySelector('.story-panel-card[data-evidence-target=${JSON.stringify(expectedEvidence)}]');
      const pressed=tab?.getAttribute('aria-pressed')==='true';
      const tabStyle=tab?getComputedStyle(tab):null;
      const alert=tab?.querySelector('.story-panel-alert');
      const alertStyle=alert?getComputedStyle(alert):null;
      const region=${JSON.stringify(expectedEvidence)}==='tree'
        ? panel?.querySelector('.mobius-tree-scroll')
        : ${JSON.stringify(expectedEvidence)}==='events'
          ? panel?.querySelector('li')
          : panel;
      const regionStyle=region?getComputedStyle(region):null;
      const mobiusAfter=getComputedStyle(document.querySelector('.story-mobius'),'::after');
      const tabMarked=!!tabStyle&&(tabStyle.color!==getComputedStyle(document.documentElement).color||mobiusAfter.animationName==='story-guide-tab'||mobiusAfter.boxShadow!=='none');
      const regionMarked=!!regionStyle&&(parseFloat(regionStyle.outlineWidth)>0||regionStyle.boxShadow!=='none'||regionStyle.animationName==='story-guide-region');
      const dotMarked=!!alertStyle&&alertStyle.backgroundColor!=='rgba(0, 0, 0, 0)'&&alertStyle.backgroundColor!=='transparent';
      return {
        evidence:root?.dataset.coachEvidence,progress:root?.dataset.evidenceProgress,
        tabStrength:tab?.dataset.guideStrength,panelStrength:panel?.dataset.guideStrength,
        pressed,tabMarked,regionMarked,dotMarked,
      };
    })()`);
    const marked = expectedStrength === 'primary'
      ? (result.pressed ? result.regionMarked : result.tabMarked)
      : (result.dotMarked || result.regionMarked || result.tabMarked);
    if (result.evidence !== expectedEvidence || (expectedProgress !== undefined && result.progress !== expectedProgress)
      || result.tabStrength !== expectedStrength || result.panelStrength !== expectedStrength || !marked) {
      throw new Error(`${label} evidence guide contract failed: ${JSON.stringify(result)}`);
    }
    return result;
  };
  const assertSingleGuide = async (label, expectedTarget, expectedEvidence = null) => {
    const result = await evaluate(`(() => {
      const visible=(element)=>{if(!element)return false;const rect=element.getBoundingClientRect();const style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0;};
      const unique=(values)=>[...new Set(values.filter(Boolean))];
      const root=document.querySelector('.story-demo');
      const targetName=root?.dataset.coachTarget??null;
      const evidence=root?.dataset.coachEvidence??null;
      const keyringGuides=[...document.querySelectorAll('.keyring-physical-button.is-guided')].filter(visible);
      const primaryEvidence=unique([...document.querySelectorAll('[data-guide-strength="primary"]')].filter(visible).map((element)=>element.dataset.evidenceTarget));
      const secondaryEvidence=unique([...document.querySelectorAll('[data-guide-strength="secondary"]')].filter(visible).map((element)=>element.dataset.evidenceTarget));
      const noticeEvidence=unique([...document.querySelectorAll('.has-new-event[data-evidence-target]')].filter(visible).map((element)=>element.dataset.evidenceTarget));
      const orphanPrimary=document.querySelectorAll('[data-guide-strength="primary"]:not([data-evidence-target])').length;
      const mobiusAfter=getComputedStyle(document.querySelector('.story-mobius'),'::after');
      const strayMobiusGuide=targetName!=='mobius'&&mobiusAfter.content!=='none'&&mobiusAfter.content!=='normal';
      let animationStyle=null;
      if(targetName==='keyring'){
        animationStyle=keyringGuides[0]?getComputedStyle(keyringGuides[0],'::after'):null;
      }else if(targetName==='mobius'){
        const tab=document.querySelector('.story-panel-tabs [data-guide-strength="primary"]');
        const panel=document.querySelector('.story-panel-card[data-guide-strength="primary"]');
        const open=tab?.getAttribute('aria-pressed')==='true';
        if(!open) animationStyle=getComputedStyle(document.querySelector('.story-mobius'),'::after');
        else if(evidence==='tree') animationStyle=getComputedStyle(panel?.querySelector('.mobius-tree-scroll'));
        else if(evidence==='events') animationStyle=getComputedStyle(panel?.querySelector('li'));
        else animationStyle=getComputedStyle(panel?.querySelector('.story-trace-steps'),'::before');
      }else{
        const target=[...document.querySelectorAll('[data-demo-target]')].find((element)=>element.dataset.demoTarget===targetName&&visible(element));
        animationStyle=targetName==='proof'&&target?getComputedStyle(target,'::after'):target?getComputedStyle(target):null;
      }
      return {
        target:targetName,evidence,keyringGuides:keyringGuides.length,primaryEvidence,secondaryEvidence,noticeEvidence,orphanPrimary,strayMobiusGuide,
        animationName:animationStyle?.animationName??'none',iterations:animationStyle?.animationIterationCount??'0',
        reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
      };
    })()`);
    const expectedPrimary = expectedTarget === 'mobius' && expectedEvidence ? [expectedEvidence] : [];
    const expectedKeyring = expectedTarget === 'keyring' ? 1 : 0;
    const samePrimary = JSON.stringify(result.primaryEvidence) === JSON.stringify(expectedPrimary);
    const noticeMatchesQueue = result.noticeEvidence.every((evidence) => expectedPrimary.includes(evidence));
    const persistent = result.reduced || (result.animationName !== 'none' && result.iterations.split(',').every((value) => value.trim() === 'infinite'));
    if (result.target !== expectedTarget || result.evidence !== expectedEvidence || result.keyringGuides !== expectedKeyring
      || !samePrimary || result.secondaryEvidence.length > 0 || !noticeMatchesQueue || result.orphanPrimary > 0 || result.strayMobiusGuide || !persistent) {
      throw new Error(`${label} single persistent guide contract failed: ${JSON.stringify(result)}`);
    }
    return result;
  };
  const openMobiusPanel = async (label) => {
    await evaluate(`[...document.querySelectorAll('.story-panel-tabs button')].find((button)=>button.textContent.trim()===${JSON.stringify(label)})?.click()`);
    await waitFor(`[...document.querySelectorAll('.story-panel-tabs button')].some((button)=>button.textContent.trim()===${JSON.stringify(label)} && button.getAttribute('aria-pressed')==='true')`, `${label} panel`);
    await delay(120);
  };
  const assertStoryScenesFit = async (label) => {
    for (const [, scene, expected] of scenes) {
      await evaluate(`window.location.hash=${JSON.stringify(`#/story/${scene}`)}`);
      await waitFor(`document.body?.innerText.includes(${JSON.stringify(expected)})`, `${label} ${scene}`);
      await delay(180);
      await assertViewportFit(`${label} ${scene}`);
      await assertReadableLayout(`${label} ${scene}`);
    }
  };
  const assertLandscapeLoginErrorFit = async () => {
    await evaluate("window.location.hash='#/story/login'");
    await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system' && document.body?.innerText.includes('A safer day for your family')", 'landscape login error state');
    await evaluate(`(() => {
      document.querySelector('[data-capture-error]')?.remove();
      const phone=document.querySelector('.story-phone');
      const content=phone?.querySelector('.story-content');
      if(!phone||!content)return false;
      const banner=document.createElement('div');
      banner.className='story-inline-error';
      banner.dataset.captureError='true';
      banner.setAttribute('role','status');
      const copy=document.createElement('span');
      copy.textContent='The browser demo session is reconnecting to Mobius4. Your isolated session remains available.';
      const button=document.createElement('button');
      button.type='button';
      button.textContent='Reconnect';
      banner.append(copy,button);
      phone.insertBefore(banner,content);
      return true;
    })()`);
    await delay(120);
    await assertViewportFit('landscape login error');
    const layout = await evaluate(`(() => {
      const phone=document.querySelector('.story-phone')?.getBoundingClientRect();
      const banner=document.querySelector('[data-capture-error]');
      const bannerRect=banner?.getBoundingClientRect();
      const content=document.querySelector('.story-login');
      const button=banner?.querySelector('button')?.getBoundingClientRect();
      const contentRect=content?.getBoundingClientRect();
      return {
        bannerFits:!!phone&&!!bannerRect&&bannerRect.left>=phone.left-1&&bannerRect.right<=phone.right+1&&bannerRect.top>=phone.top-1&&bannerRect.bottom<=phone.bottom+1,
        bannerOverflow:!!banner&&(banner.scrollWidth>banner.clientWidth+1||banner.scrollHeight>banner.clientHeight+1),
        contentOverflow:!!content&&(content.scrollWidth>content.clientWidth+1||content.scrollHeight>content.clientHeight+1),
        buttonWidth:button?.width??0,
        buttonHeight:button?.height??0,
        disjoint:!!bannerRect&&!!contentRect&&bannerRect.bottom<=contentRect.top+1,
      };
    })()`);
    await evaluate("document.querySelector('[data-capture-error]')?.remove()");
    if (!layout.bannerFits || layout.bannerOverflow || layout.contentOverflow || layout.buttonWidth < 44 || layout.buttonHeight < 44 || !layout.disjoint) {
      throw new Error(`landscape login error contract failed: ${JSON.stringify(layout)}`);
    }
  };
  const assertShallowLandscape = async (width, height) => {
    await clearStorySession();
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: 'light' },
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ] });
    await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/login` });
    await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'intro' && !document.querySelector('.keyring-physical-button.panic')?.disabled", `${width}x${height} shallow intro`);
    const responseIndex = actionResponses.length;
    await clickCenter('.keyring-physical-button.panic');
    await waitForAction200(responseIndex, `${width}x${height} shallow panic`);
    await waitFor("location.hash === '#/story/check-in' && document.querySelector('.story-demo')?.dataset.stage === 'system'", `${width}x${height} shallow check-in`);
    await waitFor("document.querySelector('.story-trace-title')?.textContent?.includes('Keyring emergency alert stored') === true", `${width}x${height} shallow Mobius receipt`);
    await delay(900);
    await openMobiusPanel('Transaction');
    await assertViewportFit(`${width}x${height} shallow Transaction`);
    const layout = await evaluate(`(() => {
      const rect=(selector)=>{const value=document.querySelector(selector)?.getBoundingClientRect();return value?{left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}:null;};
      const overlaps=(a,b)=>!!a&&!!b&&a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
      const dock=rect('.keyring-dock');
      const mobius=rect('.story-mobius');
      const app=rect('.story-app-column');
      const traceElement=document.querySelector('#story-panel-trace');
      const phoneContent=document.querySelector('.story-content');
      const tabs=rect('.story-panel-tabs');
      const navigation=rect('.story-bottom-nav');
      const language=rect('.lang-switch');
      const brand=rect('.story-brand');
      const visibleTargets=[...document.querySelectorAll('button,a,summary')].map((element)=>{const value=element.getBoundingClientRect();const style=getComputedStyle(element);return{width:value.width,height:value.height,visible:style.display!=='none'&&style.visibility!=='hidden'&&value.width>0&&value.height>0&&value.right>0&&value.bottom>0&&value.left<innerWidth&&value.top<innerHeight};}).filter((item)=>item.visible);
      return {
        width:innerWidth,height:innerHeight,docWidth:document.documentElement.scrollWidth,docHeight:document.documentElement.scrollHeight,
        dock,mobius,app,
        rightGap:dock?innerWidth-dock.right:null,
        dockClear:!!dock&&!!mobius&&!!app&&dock.left>=mobius.right&&dock.left>=app.right,
        controlClear:[tabs,navigation,language,brand].every((item)=>!overlaps(dock,item)),
        traceFits:!!traceElement&&traceElement.scrollWidth<=traceElement.clientWidth+1&&traceElement.scrollHeight<=traceElement.clientHeight+1,
        contentFits:!!phoneContent&&phoneContent.scrollWidth<=phoneContent.clientWidth+1&&phoneContent.scrollHeight<=phoneContent.clientHeight+1,
        hasPanicReceipt:(traceElement?.textContent??'').includes('keyring-panic')&&(traceElement?.textContent??'').includes('CREATE')&&(traceElement?.textContent??'').includes('RETRIEVE')&&(traceElement?.textContent??'').includes('RSC 2001')&&(traceElement?.textContent??'').includes('RSC 2000'),
        smallTargets:visibleTargets.filter((item)=>item.width<44||item.height<44).length,
      };
    })()`);
    if (layout.width !== width || layout.height !== height || layout.docWidth !== width || layout.docHeight !== height
      || !layout.dockClear || !layout.controlClear || layout.rightGap > 48 || !layout.traceFits || !layout.contentFits
      || !layout.hasPanicReceipt || layout.smallTargets !== 0) {
      throw new Error(`${width}x${height} shallow landscape contract failed: ${JSON.stringify(layout)}`);
    }
    await shot(`story-system-landscape-${width}x${height}`, width, height);
    await assertStoryScenesFit(`${width}x${height} shallow scene`);
    await assertLandscapeLoginErrorFit();
    return layout;
  };
  const assertIPhone13MiniLandscape = async () => {
    const width = 812;
    const screenHeight = 375;
    const browserHeight = 265;
    const safe = { top: 0, right: 44, bottom: 21, left: 44 };
    const iPhoneUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    const desktopUserAgent = await evaluate('navigator.userAgent');
    const installManifest = JSON.parse(await readFile(join(dist, 'manifest.webmanifest'), 'utf8'));
    if (installManifest.display !== 'fullscreen' || installManifest.orientation !== 'landscape'
      || installManifest.start_url !== '/?app=bubblelock-story#/story/login'
      || !installManifest.display_override?.includes('standalone')) {
      throw new Error(`installed web app manifest contract failed: ${JSON.stringify(installManifest)}`);
    }
    const safeArea = await send('Emulation.setSafeAreaInsetsOverride', { insets: safe });
    if (safeArea.error) throw new Error(`iPhone 13 mini safe-area emulation unavailable: ${JSON.stringify(safeArea.error)}`);
    await send('Emulation.setUserAgentOverride', { userAgent: iPhoneUserAgent });
    await send('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': '192.0.2.13' } });
    await send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: 'light' },
      { name: 'prefers-reduced-motion', value: 'no-preference' },
    ] });

    const setMetrics = async (height) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        screenWidth: width,
        screenHeight,
        deviceScaleFactor: 3,
        mobile: true,
        screenOrientation: { type: 'landscapePrimary', angle: 90 },
      });
    };
    const exercisePanic = async (label) => {
      const responseIndex = actionResponses.length;
      await clickCenter('.keyring-physical-button.panic');
      await waitForAction200(responseIndex, `${label} panic`);
      await waitFor("location.hash === '#/story/check-in' && document.querySelector('.story-demo')?.dataset.stage === 'system'", `${label} check-in`);
      await waitFor("document.querySelector('.story-trace-title')?.textContent?.includes('Keyring emergency alert stored') === true", `${label} Mobius receipt`);
      await delay(900);
      await openMobiusPanel('Transaction');
      await assertViewportFit(`${label} Transaction`);
    };
    const readLayout = async () => evaluate(`(() => {
      const rect=(selector)=>{const value=document.querySelector(selector)?.getBoundingClientRect();return value?{left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}:null;};
      const overlaps=(a,b)=>!!a&&!!b&&a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
      const root=document.querySelector('.story-demo');
      const rootStyle=getComputedStyle(root);
      const safeTop=parseFloat(rootStyle.getPropertyValue('--safe-top'));
      const safeRight=parseFloat(rootStyle.getPropertyValue('--safe-right'));
      const safeBottom=parseFloat(rootStyle.getPropertyValue('--safe-bottom'));
      const safeLeft=parseFloat(rootStyle.getPropertyValue('--safe-left'));
      const rightLimit=innerWidth-safeRight;
      const bottomLimit=innerHeight-safeBottom;
      const dock=rect('.keyring-dock');
      const model=rect('.keyring-model');
      const firmwareScreen=rect('.keyring-screen-live');
      const mobius=rect('.story-mobius');
      const app=rect('.story-app-column');
      const navigation=rect('.story-bottom-nav');
      const language=rect('.lang-switch');
      const brand=rect('.story-brand');
      const navigationControls=[...document.querySelectorAll('.story-bottom-nav a,.story-bottom-nav .story-stepper-compact')].map((element)=>{const value=element.getBoundingClientRect();return{left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height};});
      const trace=document.querySelector('#story-panel-trace');
      const mobiusElement=document.querySelector('.story-mobius');
      const mobiusText=mobiusElement?.textContent??'';
      const tabs=[...document.querySelectorAll('.story-panel-tabs button')].filter((button)=>getComputedStyle(button).display!=='none').map((button)=>{
        const value=button.getBoundingClientRect();
        return {label:button.textContent?.trim(),left:value.left,right:value.right,width:value.width,height:value.height,scrollWidth:button.scrollWidth,clientWidth:button.clientWidth,scrollHeight:button.scrollHeight,clientHeight:button.clientHeight};
      });
      const tabsDisjoint=tabs.every((tab,index)=>index===0||tabs[index-1].right<=tab.left+1);
      const clippedTabs=tabs.filter((tab)=>tab.scrollWidth>tab.clientWidth+1||tab.scrollHeight>tab.clientHeight+1);
      const visibleTargets=[...document.querySelectorAll('button,a,summary')].map((element)=>{const value=element.getBoundingClientRect();const style=getComputedStyle(element);return{className:element.className,width:value.width,height:value.height,visible:style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0&&value.width>0&&value.height>0&&value.right>0&&value.bottom>0&&value.left<innerWidth&&value.top<innerHeight};}).filter((item)=>item.visible);
      const screenLabel=document.querySelector('.keyring-screen-live b');
      const screenMeta=document.querySelector('.keyring-screen-live small');
      const screenStyle=screenLabel?getComputedStyle(screenLabel):null;
      const screenMetaStyle=screenMeta?getComputedStyle(screenMeta):null;
      const flagButtons=[...document.querySelectorAll('.lang-switch button')].filter((button)=>getComputedStyle(button).display!=='none');
      const flagsOnTop=flagButtons.every((button)=>{const value=button.getBoundingClientRect();return document.elementFromPoint(value.left+value.width/2,value.top+value.height/2)===button;});
      return {
        displayMode:root?.dataset.displayMode,
        viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,screenWidth:window.screen.width,screenHeight:window.screen.height},
        safe:{top:safeTop,right:safeRight,bottom:safeBottom,left:safeLeft},
        dock,model,screen:firmwareScreen,mobius,app,navigation,navigationControls,language,brand,tabs,
        safeBounds:!!mobius&&!!app&&!!dock&&!!navigation&&mobius.left>=safeLeft-1&&app.right<=rightLimit+1&&dock.right<=rightLimit+1&&dock.bottom<=bottomLimit+1&&navigationControls.length===3&&navigationControls.every((control)=>control.left>=safeLeft-1&&control.right<=rightLimit+1&&control.top>=safeTop-1&&control.bottom<=bottomLimit+1),
        columnsDisjoint:!!mobius&&!!app&&!!dock&&mobius.right<=app.left+1&&app.right<=dock.left+1,
        controlsDisjoint:!overlaps(dock,navigation)&&!overlaps(dock,language)&&!overlaps(dock,brand),
        tabsDisjoint,clippedTabs,
        traceFits:!!trace&&trace.scrollWidth<=trace.clientWidth+1&&trace.scrollHeight<=trace.clientHeight+1,
        completeReceipt:['BFF request','CREATE','RETRIEVE','RSC 2001','RSC 2000','keyring-panic'].every((term)=>(trace?.textContent??'').includes(term)),
        englishOnly:mobiusElement?.getAttribute('lang')==='en'&&!/[가-힣]/.test(mobiusText),
        firmwareState:document.querySelector('.keyring-screen-live')?.getAttribute('data-firmware-screen'),
        screenLabel:screenLabel?.textContent?.trim(),screenMeta:screenMeta?.textContent?.trim(),
        screenLabelFont:parseFloat(screenStyle?.fontSize??'0'),screenMetaFont:parseFloat(screenMetaStyle?.fontSize??'0'),
        screenPhysicalWidth:(firmwareScreen?.width??0)*devicePixelRatio,screenPhysicalHeight:(firmwareScreen?.height??0)*devicePixelRatio,
        flagsOnTop,
        launchCount:document.querySelectorAll('.story-fullscreen-launch').length,
        guideCount:document.querySelectorAll('.story-fullscreen-guide').length,
        guideVisible:document.querySelector('.story-fullscreen-guide')?.hidden===false,
        smallTargets:visibleTargets.filter((item)=>item.width<44||item.height<44),
      };
    })()`);
    const assertLayout = (layout, { label, height, mode, minDock, minModel, minScreenWidth, minScreenHeight }) => {
      if (layout.viewport.width !== width || layout.viewport.height !== height || layout.viewport.dpr !== 3
        || layout.viewport.screenWidth !== width || layout.viewport.screenHeight !== screenHeight
        || layout.safe.top !== safe.top || layout.safe.right !== safe.right || layout.safe.bottom !== safe.bottom || layout.safe.left !== safe.left
        || layout.displayMode !== mode || !layout.safeBounds || !layout.columnsDisjoint || !layout.controlsDisjoint
        || !layout.tabsDisjoint || layout.clippedTabs.length > 0 || layout.tabs.length !== 3
        || layout.tabs.some((tab) => tab.width < 90 || tab.height < 44)
        || !layout.traceFits || !layout.completeReceipt || !layout.englishOnly || layout.firmwareState !== 'panic'
        || !layout.dock || layout.dock.width < minDock || !layout.model || layout.model.width < minModel
        || !layout.screen || layout.screen.width < minScreenWidth || layout.screen.height < minScreenHeight
        || layout.screenPhysicalWidth < minScreenWidth * 3 || layout.screenPhysicalHeight < minScreenHeight * 3
        || layout.screenLabel !== 'PANIC' || !layout.screenMeta || layout.screenLabelFont < 6 || layout.screenMetaFont < 3.5
        || !layout.flagsOnTop || layout.smallTargets.length > 0 || layout.launchCount !== 0 || layout.guideVisible) {
        throw new Error(`${label} layout contract failed: ${JSON.stringify(layout)}`);
      }
      if (mode === 'standalone' && (!layout.brand || layout.guideCount !== 0)) {
        throw new Error(`${label} installed-app chrome contract failed: ${JSON.stringify(layout)}`);
      }
    };
    const assertPanels = async (label) => {
      await openMobiusPanel('Resource tree');
      await assertViewportFit(`${label} Resource tree`);
      const tree = await evaluate(`(() => {
        const panel=document.querySelector('#story-panel-tree');
        const box=document.querySelector('.mobius-tree-scroll');
        const path=[...(panel?.querySelectorAll('code')??[])].find((item)=>(item.textContent??'').startsWith('/Mobius'));
        const bounds=box?.getBoundingClientRect();
        return {
          panelFits:!!panel&&panel.scrollWidth<=panel.clientWidth+1&&panel.scrollHeight<=panel.clientHeight+1,
          pathFits:!!path&&path.scrollWidth<=path.clientWidth+1&&path.scrollHeight<=path.clientHeight+1,
          axis:box?.getAttribute('data-scroll-axis'),overflowX:box?getComputedStyle(box).overflowX:null,overflowY:box?getComputedStyle(box).overflowY:null,touch:box?getComputedStyle(box).touchAction:null,
          left:bounds?.left??0,top:bounds?.top??0,width:bounds?.width??0,height:bounds?.height??0,
          scrollLeft:box?.scrollLeft??-1,scrollTop:box?.scrollTop??0,scrollWidth:box?.scrollWidth??0,clientWidth:box?.clientWidth??0,scrollHeight:box?.scrollHeight??0,clientHeight:box?.clientHeight??0,
        };
      })()`);
      if (!tree.panelFits || !tree.pathFits || tree.axis !== 'vertical' || !['hidden','clip'].includes(tree.overflowX)
        || !['auto','scroll'].includes(tree.overflowY) || tree.touch !== 'pan-y' || tree.scrollLeft !== 0 || tree.scrollWidth > tree.clientWidth + 1) {
        throw new Error(`${label} vertical Resource tree contract failed: ${JSON.stringify(tree)}`);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tree.left + tree.width / 2, y: tree.top + tree.height / 2 });
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: tree.left + tree.width / 2, y: tree.top + tree.height / 2, deltaX: 240, deltaY: 0 });
      await delay(100);
      const horizontal = await evaluate("(() => { const box=document.querySelector('.mobius-tree-scroll'); return {treeLeft:box?.scrollLeft??-1,documentLeft:document.documentElement.scrollLeft,bodyLeft:document.body.scrollLeft}; })()");
      if (horizontal.treeLeft !== 0 || horizontal.documentLeft !== 0 || horizontal.bodyLeft !== 0) {
        throw new Error(`${label} horizontal Resource tree movement detected: ${JSON.stringify(horizontal)}`);
      }
      if (tree.scrollHeight > tree.clientHeight + 1) {
        const deltaY = tree.scrollTop > 1 ? -Math.min(120, tree.scrollTop) : 120;
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: tree.left + tree.width / 2, y: tree.top + tree.height / 2, deltaX: 0, deltaY });
        await delay(120);
        const vertical = Number((await evaluate("document.querySelector('.mobius-tree-scroll')?.scrollTop")) ?? 0);
        if (Math.abs(vertical - tree.scrollTop) < 1) throw new Error(`${label} vertical Resource tree did not move: before=${tree.scrollTop}, after=${vertical}`);
      }
      await openMobiusPanel('CSE records');
      await assertViewportFit(`${label} CSE records`);
      const recordsFit = await evaluate("(() => { const panel=document.querySelector('#story-panel-events'); const root=panel?.querySelector('.story-mobius-root'); const path=root?.querySelector('code'); return !!panel&&panel.scrollWidth<=panel.clientWidth+1&&panel.scrollHeight<=panel.clientHeight+1&&(root?.textContent??'').includes('CSE-ID')&&(path?.textContent??'').startsWith('/Mobius'); })()");
      if (!recordsFit) throw new Error(`${label} CSE records contract failed`);
      await openMobiusPanel('Transaction');
    };
    const assertSharedMap = async (label, captureName, height, minimumMapHeight) => {
      await evaluate("window.location.hash='#/story/check-in'");
      await waitFor("Boolean(document.querySelector('button.story-secondary'))", `${label} location action`);
      await assertCoach(`${label} location preparation`, 'app-secondary');
      await assertSingleGuide(`${label} location preparation`, 'app-secondary');
      await clickCenter('button.story-secondary');
      await waitFor("document.querySelector('button.story-secondary')?.textContent?.includes('Review and share')", `${label} location draft`);
      await assertCoach(`${label} location review`, 'app-secondary');
      await assertSingleGuide(`${label} location review`, 'app-secondary');
      await assertViewportFit(`${label} location review`);
      await assertReadableLayout(`${label} location review`);
      await shot(captureName.replace('story-location-', 'story-location-review-'), width, height);
      await clickCenter('button.story-secondary');
      await waitFor("document.querySelector('[data-location-shared=\"true\"]') && document.querySelector('[data-story-location-map=\"true\"]')?.dataset.locationReady === 'true'", `${label} approved map`);
      await delay(700);
      await assertViewportFit(`${label} approved map`);
      await assertReadableLayout(`${label} approved map`);
      await assertCoach(`${label} approved map`, 'map');
      await assertSingleGuide(`${label} approved map`, 'map');
      const map = await evaluate(`(() => {
        const rect=(selector)=>{const value=document.querySelector(selector)?.getBoundingClientRect();return value?{left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}:null;};
        const phone=rect('.story-phone');
        const canvas=rect('.location-story .location-canvas');
        const mapRoot=document.querySelector('[data-story-location-map="true"]');
        const countdown=document.querySelector('.story-location-countdown')?.textContent??'';
        return {phone,canvas,ready:mapRoot?.getAttribute('data-location-ready'),pin:document.querySelectorAll('.location-story .keyring-marker').length,countdown,overflow:!!mapRoot&&(mapRoot.scrollWidth>mapRoot.clientWidth+1||mapRoot.scrollHeight>mapRoot.clientHeight+1),inside:!!phone&&!!canvas&&canvas.left>=phone.left-1&&canvas.right<=phone.right+1&&canvas.top>=phone.top-1&&canvas.bottom<=phone.bottom+1};
      })()`);
      if (!map.canvas || map.canvas.height < minimumMapHeight || map.ready !== 'true' || map.pin < 1 || !/^4:|^5:/.test(map.countdown) || map.overflow || !map.inside) {
        throw new Error(`${label} approved map contract failed: ${JSON.stringify(map)}`);
      }
      await shot(captureName, width, height);
      await clickCenter('.story-location-map-target');
      await waitFor("document.querySelector('.story-demo')?.dataset.coachTarget === 'app-primary' && document.querySelector('.story-location-actions .story-primary')?.disabled === false", `${label} map inspection`);
      await assertCoach(`${label} call action`, 'app-primary');
      await assertSingleGuide(`${label} call action`, 'app-primary');
      await clickCenter('.story-location-actions .story-primary');
      await waitFor("document.querySelector('.story-demo')?.dataset.coachTarget === 'keyring' && document.querySelector('.story-location-actions .story-primary')?.textContent?.includes('Call requested')", `${label} call completion`);
      await assertCoach(`${label} PANIC action`, 'keyring');
      await assertSingleGuide(`${label} PANIC action`, 'keyring');
      await waitFor("document.querySelector('.keyring-physical-button.panic')?.classList.contains('is-guided') === true", `${label} guided PANIC button`);
      await clickCenter('.keyring-physical-button.panic');
      await waitFor("document.querySelector('.story-demo')?.dataset.coachTarget === 'next' && document.querySelector('.story-check-in-shared')?.dataset.emergency === 'true' && document.querySelector('.story-trace-title')?.textContent?.includes('Keyring emergency alert stored') === true", `${label} PANIC escalation`);
      await assertViewportFit(`${label} PANIC escalation`);
      await assertCoach(`${label} system proof action`, 'next');
      await assertSingleGuide(`${label} system proof action`, 'next');
    };
    const assertFinale = async (label, captureName, height) => {
      await evaluate("window.location.hash='#/story/check-in'");
      await waitFor("document.querySelector('.story-stepper-next')?.dataset.special === 'true'", `${label} finale entry`);
      await evaluate("document.querySelector('.story-stepper-next')?.click()");
      await waitFor("location.hash === '#/story/finale' && document.querySelector('.story-demo')?.dataset.finale === 'true' && Boolean(document.querySelector('[data-finale-receipt=\"true\"]'))", `${label} finale route`);
      await delay(240);
      await assertViewportFit(`${label} finale`);
      await assertCoach(`${label} finale`, 'proof');
      await assertSingleGuide(`${label} finale`, 'proof');
      const finale = await evaluate(`(() => {
        const receipt=document.querySelector('[data-finale-receipt="true"]');
        const next=document.querySelector('.story-stepper-next');
        const previous=document.querySelector('.story-stepper-prev');
        return {
          proofs:receipt?.querySelectorAll('[data-proof]').length??0,
          hasMobius:(receipt?.textContent??'').includes('CREATE RSC 2001')&&(receipt?.textContent??'').includes('RETRIEVE RSC 2000'),
          hasBoundary:(receipt?.textContent??'').includes('Browser session, purpose, scope and expiry bound'),
          next:next?.getAttribute('href'),previous:previous?.getAttribute('href'),
          contentFits:!!receipt&&receipt.scrollWidth<=receipt.clientWidth+1&&receipt.scrollHeight<=receipt.clientHeight+1,
        };
      })()`);
      if (finale.proofs !== 3 || !finale.hasMobius || !finale.hasBoundary || finale.next !== '#/story/login'
        || finale.previous !== '#/story/check-in' || !finale.contentFits) {
        throw new Error(`${label} finale contract failed: ${JSON.stringify(finale)}`);
      }
      await shot(captureName, width, height);
    };

    await clearStorySession();
    await setMetrics(browserHeight);
    await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/login` });
    await waitFor("document.querySelector('.story-fullscreen-guide')?.getAttribute('aria-hidden') === 'false' && document.activeElement?.classList.contains('story-fullscreen-continue')", 'iPhone Safari full-screen guide');
    await delay(180);
    await assertViewportFit('iPhone Safari full-screen guide');
    const guideLayout = await evaluate(`(() => {
      const rect=(selector)=>{const value=document.querySelector(selector)?.getBoundingClientRect();return value?{left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}:null;};
      const dialog=document.querySelector('.story-fullscreen-guide');
      const button=document.querySelector('.story-fullscreen-continue');
      const dialogRect=rect('.story-fullscreen-guide');
      const buttonRect=rect('.story-fullscreen-continue');
      return {
        dialog:dialogRect,button:buttonRect,
        focused:document.activeElement===button,
        copy:(dialog?.textContent??'').includes('Add to Home Screen'),
        overflow:!!dialog&&(dialog.scrollWidth>dialog.clientWidth+1||dialog.scrollHeight>dialog.clientHeight+1),
        safe:!!dialogRect&&dialogRect.left>=44&&dialogRect.right<=768&&dialogRect.top>=0&&dialogRect.bottom<=244,
        underlyingInert:document.querySelector('.story-topbar')?.inert===true&&document.querySelector('.story-intro')?.inert===true&&document.querySelector('.story-stage')?.inert===true&&document.querySelector('.keyring-dock')?.inert===true,
        capable:document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content')==='yes',
      };
    })()`);
    if (!guideLayout.dialog || !guideLayout.button || guideLayout.button.width < 44 || guideLayout.button.height < 44
      || !guideLayout.focused || !guideLayout.copy || guideLayout.overflow || !guideLayout.safe || !guideLayout.underlyingInert || !guideLayout.capable) {
      throw new Error(`iPhone Safari full-screen guide contract failed: ${JSON.stringify(guideLayout)}`);
    }
    await shot('story-iphone13mini-fullscreen-guide', width, browserHeight);
    await clickCenter('.story-fullscreen-continue');
    await waitFor("document.querySelector('.story-fullscreen-guide')?.hidden === true && document.querySelector('.story-fullscreen-launch')?.getAttribute('aria-expanded') === 'false'", 'iPhone Safari guide dismissal');
    const launchLayout = await evaluate("(() => { const button=document.querySelector('.story-fullscreen-launch'); const r=button?.getBoundingClientRect(); const top=r?document.elementFromPoint(r.left+r.width/2,r.top+r.height/2):null; return {width:r?.width??0,height:r?.height??0,left:r?.left??0,right:r?.right??0,top:r?.top??0,bottom:r?.bottom??0,hit:top===button}; })()");
    if (launchLayout.width < 44 || launchLayout.height < 44 || launchLayout.left < 44 || launchLayout.right > 768 || launchLayout.bottom > 244 || !launchLayout.hit) {
      throw new Error(`iPhone Safari full-screen launch contract failed: ${JSON.stringify(launchLayout)}`);
    }
    await assertViewportFit('iPhone 13 mini browser intro');
    await assertCoach('iPhone 13 mini browser intro', 'keyring');
    await assertSingleGuide('iPhone 13 mini browser intro', 'keyring');
    await exercisePanic('iPhone 13 mini browser');
    const browserLayout = await readLayout();
    assertLayout(browserLayout, { label: 'iPhone 13 mini browser', height: browserHeight, mode: 'browser', minDock: 146, minModel: 136, minScreenWidth: 52, minScreenHeight: 25 });
    await shot('story-system-iphone13mini-landscape', width, browserHeight);
    await assertPanels('iPhone 13 mini browser');
    await assertStoryScenesFit('iPhone 13 mini browser scene');
    await assertSharedMap('iPhone 13 mini browser', 'story-location-iphone13mini-landscape', browserHeight, 72);
    await assertFinale('iPhone 13 mini browser', 'story-finale-iphone13mini-landscape', browserHeight);
    await assertLandscapeLoginErrorFit();

    const standaloneScript = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(window.navigator, 'standalone', { configurable: true, get: () => true });",
    });
    if (standaloneScript.error || !standaloneScript.result?.identifier) {
      throw new Error(`installed web app emulation unavailable: ${JSON.stringify(standaloneScript.error)}`);
    }
    await clearStorySession();
    await setMetrics(screenHeight);
    await send('Page.navigate', { url: `${previewUrl}/?lang=en&app=bubblelock-story#/story/login` });
    await waitFor("document.querySelector('.story-demo')?.dataset.displayMode === 'standalone' && document.querySelector('.story-demo')?.dataset.stage === 'intro' && !document.querySelector('.keyring-physical-button.panic')?.disabled", 'iPhone installed web app intro');
    await delay(180);
    await assertViewportFit('iPhone installed web app intro');
    await assertCoach('iPhone installed web app intro', 'keyring');
    await assertSingleGuide('iPhone installed web app intro', 'keyring');
    const installedIntro = await evaluate("(() => { const model=document.querySelector('.keyring-model')?.getBoundingClientRect(); return {modelWidth:model?.width??0,launch:document.querySelectorAll('.story-fullscreen-launch').length,guide:document.querySelectorAll('.story-fullscreen-guide').length}; })()");
    if (installedIntro.modelWidth < 190 || installedIntro.launch !== 0 || installedIntro.guide !== 0) {
      throw new Error(`iPhone installed web app intro contract failed: ${JSON.stringify(installedIntro)}`);
    }
    await exercisePanic('iPhone installed web app');
    const standaloneLayout = await readLayout();
    assertLayout(standaloneLayout, { label: 'iPhone installed web app', height: screenHeight, mode: 'standalone', minDock: 172, minModel: 164, minScreenWidth: 64, minScreenHeight: 35 });
    await shot('story-system-iphone13mini-fullscreen', width, screenHeight);
    await assertPanels('iPhone installed web app');
    await assertStoryScenesFit('iPhone installed web app scene');
    await assertSharedMap('iPhone installed web app', 'story-location-iphone13mini-fullscreen', screenHeight, 112);
    await assertFinale('iPhone installed web app', 'story-finale-iphone13mini-fullscreen', screenHeight);
    await assertLandscapeLoginErrorFit();

    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: standaloneScript.result.identifier });
    await send('Network.setExtraHTTPHeaders', { headers: {} });
    await send('Emulation.setUserAgentOverride', { userAgent: desktopUserAgent });
    await send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    return { browser: browserLayout, standalone: standaloneLayout };
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
  await assertCoach('desktop intro', 'keyring');
  await assertSingleGuide('desktop intro', 'keyring');
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
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'sending'", 'desktop keyring sending transition');
  await assertEvidenceGuide('desktop live Transaction guide', 'trace', 'primary', 'closed');
  await assertSingleGuide('desktop live Transaction guide', 'mobius', 'trace');
  await waitForAction200(introResponseIndex, 'intro keyring confirm');
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system'", 'desktop system transition');
  await delay(900);
  await assertCoach('desktop Mobius explanation', 'mobius');
  await assertEvidenceGuide('desktop Resource tree tab guide', 'tree', 'primary', 'closed');
  await assertSingleGuide('desktop Resource tree tab guide', 'mobius', 'tree');
  await waitFor("document.querySelector('.story-trace-title')?.textContent?.includes('Resident confirmation stored') === true", 'resident confirmation record');
  await waitFor("Boolean(document.querySelector('[data-fresh=\"true\"]'))", 'fresh Mobius node');
  await evaluate("[...document.querySelectorAll('.story-panel-tabs button')].find((button)=>button.textContent.includes('Resource tree'))?.click()");
  await waitFor("document.querySelector('#story-panel-tree')?.classList.contains('is-mobile-open') === true", 'desktop resource tree panel');
  await waitFor("document.querySelector('.story-demo')?.dataset.evidenceProgress === 'open'", 'desktop Resource tree opened');
  await assertEvidenceGuide('desktop Resource tree inspection guide', 'tree', 'primary', 'open');
  await assertSingleGuide('desktop Resource tree inspection guide', 'mobius', 'tree');
  await delay(320);
  const treeCoverage = String((await evaluate("document.querySelector('#story-panel-tree')?.textContent")) ?? '');
  const treeScrollBefore = await evaluate(`(() => {
    const box=document.querySelector('.mobius-tree-scroll');
    const fresh=box?.querySelector('[data-fresh="true"]');
    const bounds=box?.getBoundingClientRect(); const freshBounds=fresh?.getBoundingClientRect();
    return {
      left:bounds?.left??0, top:bounds?.top??0, width:bounds?.width??0, height:bounds?.height??0,
      scrollTop:box?.scrollTop??0, scrollHeight:box?.scrollHeight??0, clientHeight:box?.clientHeight??0,
      pagerPresent:Boolean(document.querySelector('.mobius-tree-pager')),
      freshVisible:!!bounds&&!!freshBounds&&freshBounds.top>=bounds.top-1&&freshBounds.bottom<=bounds.bottom+1,
    };
  })()`);
  if (treeScrollBefore.scrollHeight <= treeScrollBefore.clientHeight || treeScrollBefore.pagerPresent || !treeScrollBefore.freshVisible) {
    throw new Error(`desktop resource tree scroll contract failed before wheel: ${JSON.stringify(treeScrollBefore)}`);
  }
  const treeWheelDelta = treeScrollBefore.scrollTop > 1 ? -Math.min(160, treeScrollBefore.scrollTop) : 320;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: treeScrollBefore.left + treeScrollBefore.width / 2, y: treeScrollBefore.top + treeScrollBefore.height / 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: treeScrollBefore.left + treeScrollBefore.width / 2, y: treeScrollBefore.top + treeScrollBefore.height / 2, deltaX: 0, deltaY: treeWheelDelta });
  await delay(180);
  const treeScrollAfter = Number((await evaluate("document.querySelector('.mobius-tree-scroll')?.scrollTop")) ?? 0);
  if (Math.abs(treeScrollAfter - treeScrollBefore.scrollTop) < 1) throw new Error(`desktop resource tree wheel did not scroll: before=${treeScrollBefore.scrollTop}, after=${treeScrollAfter}`);
  await waitFor("document.querySelector('.story-demo')?.dataset.coachTarget === 'next' && !document.querySelector('.story-demo')?.dataset.coachEvidence", 'desktop guide advances to Next');
  await assertCoach('desktop next scene action', 'next');
  await assertSingleGuide('desktop next scene action', 'next');
  await assertViewportFit('desktop resource tree');
  await openMobiusPanel('CSE records');
  await assertViewportFit('desktop CSE records');
  while (await evaluate("document.querySelector('[aria-label=\"Previous CSE record page\"]')?.disabled === false")) {
    await evaluate("document.querySelector('[aria-label=\"Previous CSE record page\"]')?.click()");
    await delay(30);
  }
  const eventPageCount = Number((await evaluate("document.querySelector('.story-events-pager span')?.textContent?.split('/')[1]?.trim()")) ?? 1);
  let freshRecordCovered = '';
  for (let page = 1; page <= eventPageCount; page += 1) {
    freshRecordCovered ||= (await evaluate("document.querySelector('.story-mobius-events .is-fresh')?.dataset.path")) ?? '';
    if (page < eventPageCount) {
      await evaluate("document.querySelector('[aria-label=\"Next CSE record page\"]')?.click()");
      await delay(30);
    }
  }
  const requiredTerms = ['CSEBase','m2m:ae','m2m:cnt','m2m:cin','CREATE','RETRIEVE','RSC'];
  const standardTermsCovered = requiredTerms.every((term) => treeCoverage.includes(term));
  await openMobiusPanel('Transaction');
  await delay(320);
  await assertViewportFit('desktop system');
  const desktopSystemLayout = await evaluate(`(() => {
    const rect = (selector) => { const value=document.querySelector(selector)?.getBoundingClientRect(); return value ? {left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height} : null; };
    const dock=rect('.keyring-dock'); const mobius=rect('.story-mobius'); const app=rect('.story-app-column');
    const dockElement=document.querySelector('.keyring-dock'); const stageElement=document.querySelector('.story-stage');
    const mobiusPanel=document.querySelector('.story-mobius');
    const mobiusText=mobiusPanel?.textContent ?? '';
    const clippedText=[...(mobiusPanel?.querySelectorAll('code,h2,h3,strong,small,.mobius-node-name,.mobius-node-detail p') ?? [])].filter((element)=>element.clientWidth>0 && element.scrollWidth>element.clientWidth+1).map((element)=>element.textContent?.trim()).filter(Boolean);
    const freshNode=document.querySelector('[data-fresh="true"]')?.dataset.path ?? '';
    const freshRecord=document.querySelector('.story-mobius-events .is-fresh')?.dataset.path ?? '';
    const tracePaths=[...document.querySelectorAll('[data-trace-path]')].map((item)=>item.dataset.tracePath);
    const confirm=document.querySelector('.keyring-physical-button.confirm')?.getBoundingClientRect();
    const top=confirm ? document.elementFromPoint(confirm.left+confirm.width/2,confirm.top+confirm.height/2) : null;
    const style=getComputedStyle(document.querySelector('.keyring-dock'));
    return {
      dock,mobius,app,freshNode,freshRecord,tracePaths,
      dockRight:innerWidth-(dock?.right??innerWidth),dockBottom:innerHeight-(dock?.bottom??0),
      background:style.backgroundColor,border:parseFloat(style.borderTopWidth)||0,zIndex:style.zIndex,position:style.position,
      outsideStage:!!dockElement&&!!stageElement&&!stageElement.contains(dockElement),
      disjoint:!!dock&&!!app&&dock.left>=app.right,
      ordered:!!mobius&&!!app&&mobius.right<=app.left,
      hit:top?.classList.contains('confirm')===true,
      englishOnly:mobiusPanel?.getAttribute('lang')==='en' && !/[가-힣]/.test(mobiusText),
      clippedText,
    };
  })()`);
  const transparentDock = ['rgba(0, 0, 0, 0)', 'transparent'].includes(desktopSystemLayout.background);
  const linkedPath = desktopSystemLayout.freshNode && desktopSystemLayout.freshNode === freshRecordCovered && desktopSystemLayout.tracePaths.includes(desktopSystemLayout.freshNode);
  if (desktopSystemLayout.dockRight > 48 || desktopSystemLayout.dockBottom > 48 || !transparentDock || desktopSystemLayout.border !== 0
    || desktopSystemLayout.zIndex !== '30' || desktopSystemLayout.position !== 'fixed' || !desktopSystemLayout.outsideStage
    || !desktopSystemLayout.disjoint || !desktopSystemLayout.ordered || !linkedPath || !desktopSystemLayout.hit
    || !desktopSystemLayout.englishOnly || !standardTermsCovered || desktopSystemLayout.clippedText.length > 0) {
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
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/login` });
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'intro' && Boolean(document.querySelector('.story-panel-tabs'))", 'mobile panel dock');
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
  await assertSingleGuide('mobile keyring intro', 'keyring');
  if ((await evaluate("document.querySelector('.keyring-model')?.getBoundingClientRect().width")) < 104) throw new Error('mobile keyring is smaller than its readable system contract');
  await evaluate("document.querySelector('.keyring-physical-button.confirm')?.click()");
  await waitFor("document.querySelector('[data-firmware-screen]')?.dataset.firmwareScreen === 'confirm'", 'firmware confirm screen');
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'sending'", 'mobile transaction guide');
  await assertSingleGuide('mobile transaction guide', 'mobius', 'trace');
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system' && location.hash === '#/story/activity-away'", 'mobile resource guide');
  await assertSingleGuide('mobile resource guide', 'mobius', 'tree');
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
  await assertViewportFit('landscape system');
  await assertCoach('landscape Mobius explanation', 'mobius');
  await assertSingleGuide('landscape Mobius explanation', 'mobius', 'tree');
  await openMobiusPanel('Resource tree');
  await assertViewportFit('landscape resource tree');
  await openMobiusPanel('CSE records');
  await assertViewportFit('landscape CSE records');
  await openMobiusPanel('Transaction');
  const landscapeLayout = await evaluate(`(() => {
    const rect = (selector) => { const value=document.querySelector(selector)?.getBoundingClientRect(); return value ? {left:value.left,right:value.right,top:value.top,bottom:value.bottom} : null; };
    const dock=rect('.keyring-dock'); const mobius=rect('.story-mobius'); const app=rect('.story-app-column'); const navigation=rect('.story-bottom-nav');
    const keyring=rect('.keyring-model');
    const trace=document.querySelector('#story-panel-trace');
    const parents=[...document.querySelectorAll('.story-trace-parent')];
    const originalParents=parents.map((element)=>element.textContent);
    parents.forEach((element,index)=>{element.textContent='/Mobius/dash-operator/story-demo/s-13bd1f81b260c3b6c07/'+(index%2===0?'keyring-observation/':'');});
    const livePathFits=!!trace&&trace.scrollHeight<=trace.clientHeight+1;
    parents.forEach((element,index)=>{element.textContent=originalParents[index]??'';});
    const visibleTargets=[...document.querySelectorAll('button,a,summary')].map((element)=>{const r=element.getBoundingClientRect();const s=getComputedStyle(element);return {width:r.width,height:r.height,visible:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight};}).filter((item)=>item.visible);
    return {
      width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,
      viewportWidth:innerWidth,viewportHeight:innerHeight,dock,mobius,app,navigation,keyring,
      overlaid:!!dock&&!!mobius&&!!app&&dock.left>=app.right&&dock.left>=mobius.right&&innerWidth-dock.right<=48,
      ordered:!!mobius&&!!app&&mobius.right<=app.left,
      navigationAtBottom:!!navigation&&navigation.bottom<=innerHeight&&innerHeight-navigation.bottom<=16&&navigation.top>=innerHeight-80,
      navigationClear:!!navigation&&!!dock&&(navigation.left>=dock.right||navigation.right<=dock.left||navigation.top>=dock.bottom||navigation.bottom<=dock.top),
      topbarNavigation:document.querySelector('.story-topbar .story-stepper')!==null,livePathFits,
      toolChrome:document.querySelectorAll('.keyring-tools,.keyring-mode,.keyring-reset,.keyring-foot,.keyring-counters').length,
      smallTargets:visibleTargets.filter((item)=>item.width<44||item.height<44).length,
    };
  })()`);
  if (landscapeLayout.width !== 844 || landscapeLayout.height !== 390 || !landscapeLayout.overlaid || !landscapeLayout.ordered
    || !landscapeLayout.navigationAtBottom || !landscapeLayout.navigationClear || landscapeLayout.topbarNavigation || !landscapeLayout.livePathFits
    || landscapeLayout.toolChrome !== 0 || !landscapeLayout.keyring || landscapeLayout.keyring.right - landscapeLayout.keyring.left < 104 || landscapeLayout.smallTargets !== 0) {
    throw new Error(`landscape contract failed: ${JSON.stringify(landscapeLayout)}`);
  }
  await shot('story-system-landscape', 844, 390);
  await assertStoryScenesFit('landscape scene');
  await assertLandscapeLoginErrorFit();
  await assertShallowLandscape(844, 320);
  await assertShallowLandscape(1000, 327);
  await assertIPhone13MiniLandscape();

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
  await assertViewportFit('portrait rotate prompt');
  await shot('story-intro-portrait', 390, 844);
  await clickCenter('.story-rotate-continue');
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system' && document.querySelector('.story-demo')?.dataset.portrait === 'continue' && document.querySelector('.story-rotate')?.getAttribute('aria-hidden') === 'true'", 'portrait fallback system');
  await delay(900);
  await assertViewportFit('portrait fallback system');
  await assertCoach('portrait Mobius explanation', 'mobius');
  await assertSingleGuide('portrait Mobius explanation', 'mobius', 'tree');
  await openMobiusPanel('Resource tree');
  await assertViewportFit('portrait resource tree');
  await openMobiusPanel('CSE records');
  await assertViewportFit('portrait CSE records');
  await openMobiusPanel('Scenes');
  await assertViewportFit('portrait scenes');
  await openMobiusPanel('Transaction');
  const portraitSystem = await evaluate(`(() => {
    const visibleTargets=[...document.querySelectorAll('button,a,summary')].map((element)=>{const r=element.getBoundingClientRect();const s=getComputedStyle(element);return {width:r.width,height:r.height,visible:s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight};}).filter((item)=>item.visible);
    return {width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,smallTargets:visibleTargets.filter((item)=>item.width<44||item.height<44).length};
  })()`);
  if (portraitSystem.width !== 390 || portraitSystem.height !== 844 || portraitSystem.smallTargets !== 0) {
    throw new Error(`portrait system contract failed: ${JSON.stringify(portraitSystem)}`);
  }
  await shot('story-system-portrait', 390, 844);
  await assertStoryScenesFit('portrait scene');

  await clearStorySession();
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/activity-away` });
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system' && document.querySelector('.story-rotate')?.getAttribute('aria-hidden') === 'false' && document.activeElement?.classList.contains('story-rotate-continue')", 'portrait deep-link rotate prompt');
  const portraitGate = await evaluate("(() => ({mainInert:document.querySelector('.story-stage')?.inert===true,dockInert:document.querySelector('.keyring-dock')?.inert===true,dialog:document.querySelector('.story-rotate')?.getAttribute('role')}))()");
  if (!portraitGate.mainInert || !portraitGate.dockInert || portraitGate.dialog !== 'dialog') throw new Error(`portrait orientation gate failed: ${JSON.stringify(portraitGate)}`);
  await clickCenter('.story-rotate-continue');
  await waitFor("document.querySelector('.story-rotate')?.getAttribute('aria-hidden') === 'true' && document.querySelector('.story-stage')?.inert === false", 'portrait deep-link continue');

  const portraitSafeArea = await send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, right: 0, bottom: 34, left: 0 } });
  if (portraitSafeArea.error) throw new Error(`safe-area emulation unavailable: ${JSON.stringify(portraitSafeArea.error)}`);
  await clearStorySession();
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/login` });
  await waitFor("document.querySelector('.story-rotate')?.getAttribute('aria-hidden') === 'false'", 'iPhone portrait safe-area prompt');
  await delay(180);
  await assertViewportFit('iPhone portrait safe area');
  const portraitSafeLayout = await evaluate(`(() => {
    const brand=document.querySelector('.story-brand')?.getBoundingClientRect();
    const button=document.querySelector('.story-rotate-continue')?.getBoundingClientRect();
    const keyring=document.querySelector('.keyring-dock')?.getBoundingClientRect();
    const navigation=document.querySelector('.story-bottom-nav')?.getBoundingClientRect();
    const root=getComputedStyle(document.querySelector('.story-demo'));
    return {safeTop:parseFloat(root.getPropertyValue('--safe-top')),safeBottom:parseFloat(root.getPropertyValue('--safe-bottom')),brandTop:brand?.top,buttonBottom:button?.bottom,keyringBottom:keyring?.bottom,navigationBottom:navigation?.bottom};
  })()`);
  if (portraitSafeLayout.safeTop !== 47 || portraitSafeLayout.safeBottom !== 34 || portraitSafeLayout.brandTop < 47
    || portraitSafeLayout.buttonBottom > 810 || portraitSafeLayout.keyringBottom > 810 || portraitSafeLayout.navigationBottom > 810) {
    throw new Error(`iPhone portrait safe-area contract failed: ${JSON.stringify(portraitSafeLayout)}`);
  }

  const landscapeSafeArea = await send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, right: 47, bottom: 21, left: 47 } });
  if (landscapeSafeArea.error) throw new Error(`landscape safe-area emulation unavailable: ${JSON.stringify(landscapeSafeArea.error)}`);
  await clearStorySession();
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/activity-away` });
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system'", 'iPhone landscape safe-area system');
  await delay(500);
  await assertViewportFit('iPhone landscape safe area');
  const landscapeSafeLayout = await evaluate(`(() => {
    const brand=document.querySelector('.story-brand')?.getBoundingClientRect();
    const mobius=document.querySelector('.story-mobius')?.getBoundingClientRect();
    const app=document.querySelector('.story-app-column')?.getBoundingClientRect();
    const dock=document.querySelector('.keyring-dock')?.getBoundingClientRect();
    const navigation=document.querySelector('.story-bottom-nav')?.getBoundingClientRect();
    const root=getComputedStyle(document.querySelector('.story-demo'));
    return {safeLeft:parseFloat(root.getPropertyValue('--safe-left')),safeRight:parseFloat(root.getPropertyValue('--safe-right')),brandLeft:brand?.left,mobiusLeft:mobius?.left,appRight:app?.right,dockLeft:dock?.left,dockBottom:dock?.bottom,navigationLeft:navigation?.left,navigationRight:navigation?.right,navigationBottom:navigation?.bottom};
  })()`);
  if (landscapeSafeLayout.safeLeft !== 47 || landscapeSafeLayout.safeRight !== 47 || landscapeSafeLayout.brandLeft < 47
    || landscapeSafeLayout.mobiusLeft < 47 || landscapeSafeLayout.appRight > 797 || landscapeSafeLayout.dockLeft < 47 || landscapeSafeLayout.dockBottom > 369
    || landscapeSafeLayout.navigationLeft < 47 || landscapeSafeLayout.navigationRight > 797 || landscapeSafeLayout.navigationBottom > 369) {
    throw new Error(`iPhone landscape safe-area contract failed: ${JSON.stringify(landscapeSafeLayout)}`);
  }
  await assertStoryScenesFit('iPhone landscape scene');
  await assertLandscapeLoginErrorFit();
  await send('Emulation.setSafeAreaInsetsOverride', { insets: {} });

  await openScene('care-request', 'Living room access for Mina');
  await evaluate("document.querySelector('button.story-primary')?.click()");
  await waitFor("location.hash === '#/story/caregiver-shared'", 'care approval transition');
  await waitFor("document.querySelector('button.story-primary')?.textContent?.includes('All on')", 'caregiver controls');
  await evaluate("document.querySelector('button.story-primary')?.click()");
  await waitFor("document.querySelector('button.story-primary')?.textContent?.includes('3/3 verified')", 'group command result');

  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/check-in` });
  await waitFor("document.querySelector('.story-demo')?.dataset.stage === 'system' && document.body?.innerText.includes('Prepare location share')", 'landscape location scene');
  await waitFor("Boolean(document.querySelector('button.story-secondary'))", 'location share action');
  await assertSingleGuide('landscape location preparation', 'app-secondary');
  await evaluate("document.querySelector('button.story-secondary')?.click()");
  await waitFor("document.querySelector('button.story-secondary')?.textContent?.includes('Review and share')", 'location draft');
  await assertSingleGuide('landscape location review', 'app-secondary');
  await evaluate("document.querySelector('button.story-secondary')?.click()");
  await waitFor("document.querySelector('[data-location-shared=\"true\"]') && document.querySelector('[data-story-location-map=\"true\"]')?.dataset.locationReady === 'true'", 'five-minute location map');
  await delay(700);
  await assertViewportFit('five-minute location map');
  const sharedMap = await evaluate("(() => { const canvas=document.querySelector('.location-story .location-canvas'); return {pin:document.querySelectorAll('.location-story .keyring-marker').length,canvasHeight:canvas?.getBoundingClientRect().height??0,countdown:document.querySelector('.story-location-countdown')?.textContent??'',ready:document.querySelector('[data-story-location-map=\"true\"]')?.getAttribute('data-location-ready')}; })()");
  if (sharedMap.pin < 1 || sharedMap.canvasHeight < 100 || sharedMap.ready !== 'true' || !/^4:|^5:/.test(sharedMap.countdown)) throw new Error(`five-minute location map contract failed: ${JSON.stringify(sharedMap)}`);
  await assertCoach('landscape approved map', 'map');
  await assertSingleGuide('landscape approved map', 'map');
  await shot('story-location-landscape', 844, 390);
  await delay(3500);
  await assertSingleGuide('landscape approved map after two pulse cycles', 'map');
  await clickCenter('.story-location-map-target');
  await waitFor("document.querySelector('.story-demo')?.dataset.coachTarget === 'app-primary' && document.querySelector('.story-location-actions .story-primary')?.disabled === false", 'landscape map inspection');
  await assertSingleGuide('landscape call action', 'app-primary');
  await clickCenter('.story-location-actions .story-primary');
  await waitFor("document.querySelector('.story-demo')?.dataset.coachTarget === 'keyring'", 'landscape call completion');
  await assertSingleGuide('landscape PANIC action', 'keyring');
  await clickCenter('.keyring-physical-button.panic');
  await waitFor("document.querySelector('.story-demo')?.dataset.coachTarget === 'next' && document.querySelector('.story-check-in-shared')?.dataset.emergency === 'true'", 'landscape PANIC escalation');
  await shot('story-panic-landscape', 844, 390);
  await assertSingleGuide('landscape system proof action', 'next');

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/story/activity-away` });
  await waitFor("Boolean(document.querySelector('.keyring-physical-button.confirm:not(:disabled)'))", 'interactive virtual keyring');
  const beforeRotate = await evaluate("document.querySelector('.keyring-model')?.style.transform");
  const stage = await evaluate("(() => { const r=document.querySelector('.keyring-stage').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: stage.x, y: stage.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stage.x + 46, y: stage.y + 20, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stage.x + 46, y: stage.y + 20, button: 'left', clickCount: 1 });
  await waitFor(`document.querySelector('.keyring-model')?.style.transform !== ${JSON.stringify(beforeRotate)}`, 'keyring drag rotation');
  const keyringChrome = await evaluate("document.querySelectorAll('.keyring-tools,.keyring-mode,.keyring-reset,.keyring-foot,.keyring-counters').length");
  if (keyringChrome !== 0) throw new Error(`keyring control chrome remains: ${keyringChrome}`);
  await evaluate("document.querySelector('.keyring-physical-button.confirm')?.click()");
  await waitFor("document.querySelector('.story-trace-title')?.textContent?.includes('Resident confirmation stored') === true", 'keyring confirm Mobius receipt');
  const systemShot = await send('Page.captureScreenshot', { format: 'png' });
  const systemBytes = Buffer.from(systemShot.result.data, 'base64');
  await writeFile(join(outDir, 'story-system-desktop-interaction.png'), systemBytes);
  captured.push({ name: 'story-system-desktop-interaction', width: 1440, height: 900, file: 'story-system-desktop-interaction.png', sha256: createHash('sha256').update(systemBytes).digest('hex') });
  await evaluate("document.querySelector('.keyring-physical-button.panic')?.click()");
  await waitFor("location.hash === '#/story/check-in'", 'keyring panic to check-in transition');
  await waitFor("document.querySelector('.story-trace-title')?.textContent?.includes('Keyring emergency alert stored') === true", 'keyring panic Mobius receipt');
  await waitFor("document.querySelector('.story-stepper-next')?.dataset.special === 'true'", 'desktop finale entry');
  await evaluate("document.querySelector('.story-stepper-next')?.click()");
  await waitFor("location.hash === '#/story/finale' && document.querySelector('.story-demo')?.dataset.finale === 'true'", 'desktop finale route');
  await delay(320);
  await assertViewportFit('desktop finale');
  const desktopFinale = await evaluate("(() => { const receipt=document.querySelector('[data-finale-receipt=\"true\"]'); return {proofs:receipt?.querySelectorAll('[data-proof]').length??0,hasMobius:(receipt?.textContent??'').includes('CREATE RSC 2001')&&(receipt?.textContent??'').includes('RETRIEVE RSC 2000'),hasBoundary:(receipt?.textContent??'').includes('Browser session, purpose, scope and expiry bound'),next:document.querySelector('.story-stepper-next')?.getAttribute('href'),previous:document.querySelector('.story-stepper-prev')?.getAttribute('href')}; })()");
  if (desktopFinale.proofs !== 3 || !desktopFinale.hasMobius || !desktopFinale.hasBoundary || desktopFinale.next !== '#/story/login' || desktopFinale.previous !== '#/story/check-in') {
    throw new Error(`desktop finale contract failed: ${JSON.stringify(desktopFinale)}`);
  }
  await shot('story-finale-desktop', 1440, 900);

  await send('Page.navigate', { url: `${previewUrl}/?lang=en#/operator/map` });
  await waitFor("document.querySelectorAll('.operator-mobius-node').length >= 5 && Boolean(document.querySelector('.location-operator .location-canvas'))", 'operator map with Mobius browser');
  await delay(700);
  const operatorBrowser = await evaluate(`(() => {
    const rect=(selector)=>{const value=document.querySelector(selector)?.getBoundingClientRect();return value?{left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height}:null;};
    const workspace=rect('.operator-workspace');
    const browser=rect('.operator-mobius-browser');
    const tree=document.querySelector('.operator-mobius-tree-scroll');
    const pane=document.querySelector('.operator-mobius-browser');
    const node=[...document.querySelectorAll('.operator-mobius-node')].find((item)=>(item.textContent??'').includes('applicationEntity'));
    const nodeRect=node?.getBoundingClientRect();
    return {workspace,browser,sideBySide:!!workspace&&!!browser&&workspace.right<=browser.left+1,source:pane?.getAttribute('data-source'),englishOnly:!!pane&&!/[가-힣]/.test(pane.textContent??''),hasTerms:['Mobius Resource Browser','Resource tree','applicationEntity','flexContainer','group','RSC 2000'].every((term)=>(pane?.textContent??'').includes(term)),treeAxis:tree?.getAttribute('data-scroll-axis'),treeOverflowX:getComputedStyle(tree).overflowX,treeOverflow:getComputedStyle(tree).overflowY,treeTouch:getComputedStyle(tree).touchAction,treeLeft:tree?.scrollLeft??-1,treeWidth:tree?.clientWidth??0,treeScrollWidth:tree?.scrollWidth??0,nodeTarget:nodeRect?{width:nodeRect.width,height:nodeRect.height}:null};
  })()`);
  if (!operatorBrowser.sideBySide || operatorBrowser.source !== 'replay' || !operatorBrowser.englishOnly || !operatorBrowser.hasTerms
    || operatorBrowser.treeAxis !== 'vertical' || !['hidden','clip'].includes(operatorBrowser.treeOverflowX)
    || !['auto','scroll'].includes(operatorBrowser.treeOverflow) || operatorBrowser.treeTouch !== 'pan-y'
    || operatorBrowser.treeLeft !== 0 || operatorBrowser.treeScrollWidth > operatorBrowser.treeWidth + 1
    || !operatorBrowser.nodeTarget || operatorBrowser.nodeTarget.height < 44) {
    throw new Error(`operator Mobius browser contract failed: ${JSON.stringify(operatorBrowser)}`);
  }
  await evaluate("[...document.querySelectorAll('.operator-mobius-node')].find((item)=>(item.textContent??'').includes('applicationEntity'))?.click()");
  await waitFor("document.querySelector('.operator-mobius-panel')?.dataset.view === 'record' && Boolean(document.querySelector('.operator-mobius-record dl'))", 'operator Mobius selected record');
  await shot('operator-map-mobius-desktop', 1440, 900);

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
    mode: 'browser-isolated replay CSE; full-viewport shell, fixed keyring overlay, iPhone 13 mini Safari visual viewport plus installed fullscreen web app and safe areas, landscape split, portrait fallback, guardian share and caregiver group command exercised',
    command: 'npm --prefix web-dashboard run capture:story',
    assertions: [
      'intro shows only the keyring product and guidance',
      'real keyring input returns HTTP 200 and transitions into the system stage',
      'story shell exactly fills 100vw by 100dvh with zero document or panel overflow',
      'floating keyring is a transparent fixed overlay outside the content grid at z-index 30',
      'all seven story scenes fit landscape and portrait viewports without clipping',
      '844x320 and 1000x327 shallow Safari landscapes fit every scene, the full panic receipt and reconnect state without internal scrolling',
      'iPhone 13 mini Safari at 812x265, DPR 3 and 44/44/21 safe-area insets fits all seven scenes, full panic receipt and reconnect state without scrolling',
      'iPhone Safari full-screen guide fits the safe area, owns focus and explains Share, Add to Home Screen and Open BubbleLock',
      'web app manifest launches the story in fullscreen landscape mode with standalone fallback',
      'installed iPhone 13 mini web app at 812x375 fits all seven scenes, the full panic receipt and reconnect state without scrolling',
      'installed iPhone 13 mini keyring is at least 172 CSS px wide and its live firmware screen is at least 192x105 physical pixels',
      'iPhone 13 mini Mobius tabs are disjoint 90x44px controls with complete labels',
      'landscape login keeps a full reconnect message and 44px action inside the app without overlap',
      'all seven landscape scenes and the reconnect state fit inside iPhone sensor-housing and home-indicator insets',
      'iPhone portrait notch and home-indicator insets keep controls inside the safe area',
      'fresh Mobius tree node, trace path and newest record share one resource path',
      'Mobius browser is English-only and exposes oneM2M resource types, methods and RSC values without clipped text',
      'Mobius tree uses vertical-only touch and wheel scrolling with zero horizontal movement while CSE records keep compact paging',
      'every story stage shows a safe-area overlay that explains the single highlighted system element and names the next real action',
      'exactly one guidance owner is visible at a time and its pulse remains active until the required click or inspection advances the queue',
      'scenario actions, Mobius evidence, the approved map, Call, the guided PANIC press and the next arrow advance in order; inspecting the tree advances guidance to Next',
      'visible story text remains fully readable and language, coach and navigation overlays do not cover app or Mobius content',
      'desktop Mobius stays left of the phone in light and dark mode',
      'phone landscape fits Mobius, app and overlay keyring in one viewport',
      'phone portrait and portrait deep links show the optimized landscape prompt with a 44px Continue upright path',
      'scene arrows use a compact bottom navigation outside the top bar',
      'keyring has no Rotate, Move or Reset chrome and every drag rotates it directly',
      'system keyring remains large enough to read its firmware screen and physical buttons',
      'all visible controls are at least 44px',
      'reduced motion leaves no running dock animation',
      'keyboard focus reaches the confirm button with a 3px outline',
      'Mobius tree exposes a wrapping full resource path',
      'keyring firmware screen mirrors READY/CONFIRM/PANIC states',
      'care approval opens the caregiver view',
      'All on returns three readbacks',
      'guided draft review opens a visible five-minute location map and moves the highlight onto the map',
      'scene seven Next opens a distinct end-to-end system proof and Replay returns to the keyring',
    ],
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
