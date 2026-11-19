import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

/**
 * In-memory oneM2M CSE for unit tests: AE/ACP/CNT/CIN/GRP/SUB/FLX, la, discovery with
 * geo-query (point in polygon), notifications net 2/3/4 with verification. ACP is not enforced.
 */
const TAGS = { 1: 'm2m:acp', 2: 'm2m:ae', 3: 'm2m:cnt', 4: 'm2m:cin', 9: 'm2m:grp', 23: 'm2m:sub' };
function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

export async function startFakeCse({ cseId = '/fake-cse', cseBase = 'Mobius', specializations = {} } = {}) {
  const resources = new Map([[cseBase, { ty: 5, ri: 'cb', rn: cseBase, attrs: { csi: cseId } }]]);
  const notifications = []; const requests = [];
  let counter = 0;
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const view = (path) => { const item = resources.get(path); return { [item.tag ?? TAGS[item.ty]]: { ...item.attrs, rn: item.rn, ri: item.ri, ty: item.ty, pi: item.pi ?? null } }; };
  async function notify(sub, net, rep) {
    const body = { 'm2m:sgn': { sur: sub.path, nev: { net, rep } } };
    for (const nu of sub.attrs.nu) {
      try { const response = await fetch(nu, { method: 'POST', headers: { 'content-type': 'application/json', 'X-M2M-Origin': cseId, 'X-M2M-RI': `n-${++counter}` }, body: JSON.stringify(body) }); notifications.push({ sur: sub.path, net, status: response.status }); }
      catch { notifications.push({ sur: sub.path, net, status: 0 }); }
    }
  }
  const subsOf = (parent) => [...resources.entries()].filter(([path, item]) => item.ty === 23 && path.startsWith(`${parent}/`) && path.slice(parent.length + 1).split('/').length === 1).map(([path, item]) => ({ path, ...item }));
  server.on('request', async (request, response) => {
    const url = new URL(request.url, endpoint);
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const origin = request.headers['x-m2m-origin'];
    const reply = (status, rsc, body) => { response.writeHead(status, { 'content-type': 'application/json', 'X-M2M-RSC': String(rsc), 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end(body ? JSON.stringify(body) : undefined); };
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    requests.push({ method: request.method, path, origin });
    const target = resources.get(path);
    if (request.method === 'POST') {
      if (!target) return reply(404, 4004, { 'm2m:dbg': 'parent' });
      const ty = Number(/ty=(\d+)/.exec(request.headers['content-type'] ?? '')?.[1]);
      const tag = Object.keys(body)[0]; const attrs = { ...body[tag] };
      if (ty === 28 && !specializations[attrs.cnd]) return reply(501, 4125, { 'm2m:dbg': 'specialization' });
      const rn = attrs.rn ?? `${ty}-${Date.now()}${String(++counter).padStart(4, '0')}`; delete attrs.rn;
      const childPath = `${path}/${rn}`;
      if (resources.has(childPath)) return reply(409, 4105, { 'm2m:dbg': 'exists' });
      if (ty === 2) { const aei = origin && origin !== 'C' ? origin : `C${randomBytes(4).toString('hex')}`; if ([...resources.values()].some((item) => item.ty === 2 && item.attrs.aei === aei)) return reply(403, 4106, { 'm2m:dbg': 'registered' }); attrs.aei = aei; }
      if (attrs.cr === null) attrs.cr = origin;
      if (ty === 23) {
        for (const nu of attrs.nu) { const check = await fetch(nu, { method: 'POST', headers: { 'content-type': 'application/json', 'X-M2M-Origin': cseId }, body: JSON.stringify({ 'm2m:sgn': { vrq: true, sur: childPath, cr: origin } }) }).catch(() => null); if (!check || check.status !== 200) return reply(403, 4101, { 'm2m:dbg': 'verification' }); }
      }
      resources.set(childPath, { ty, tag, rn, ri: `ri${++counter}`, pi: target.ri, attrs, ct: Date.now(), creator: origin });
      const created = view(childPath);
      if (ty !== 23) for (const sub of subsOf(path)) if (sub.attrs.enc?.net?.includes(3)) await notify(sub, 3, created);
      return reply(201, 2001, created);
    }
    if (request.method === 'GET') {
      if (url.searchParams.get('fu') === '1') {
        if (!target) return reply(404, 4004);
        const ty = Number(url.searchParams.get('ty')); const geom = url.searchParams.get('geom') ? JSON.parse(url.searchParams.get('geom')) : null;
        const uril = [...resources.entries()].filter(([key, item]) => key.startsWith(`${path}/`) && (!ty || item.ty === ty) && (!geom || (item.attrs.loc && inside(JSON.parse(item.attrs.loc.crd), geom[0])))).map(([key]) => key);
        return reply(200, 2000, { 'm2m:uril': uril });
      }
      if (path.endsWith('/la')) {
        const parent = path.slice(0, -3);
        const latest = [...resources.entries()].filter(([key, item]) => item.ty === 4 && key.startsWith(`${parent}/`)).sort((a, b) => a[1].ct - b[1].ct).at(-1);
        return latest ? reply(200, 2000, view(latest[0])) : reply(404, 4004);
      }
      return target ? reply(200, 2000, view(path)) : reply(404, 4004);
    }
    if (request.method === 'PUT') {
      if (!target) return reply(404, 4004);
      Object.assign(target.attrs, Object.values(body)[0]);
      return reply(200, 2004, view(path));
    }
    if (request.method === 'DELETE') {
      if (!target) return reply(404, 4004);
      const removed = view(path);
      for (const sub of subsOf(path)) if (sub.attrs.enc?.net?.includes(2)) await notify(sub, 2, removed);
      const parent = path.split('/').slice(0, -1).join('/');
      for (const sub of subsOf(parent)) if (sub.attrs.enc?.net?.includes(4) && target.ty !== 23) await notify(sub, 4, removed);
      for (const key of [...resources.keys()]) if (key === path || key.startsWith(`${path}/`)) resources.delete(key);
      return reply(200, 2002);
    }
    reply(405, 4005);
  });
  return {
    endpoint, cseId, cseBase: `/${cseBase}`, resources, notifications, requests,
    children: (parent, ty) => [...resources.entries()].filter(([key, item]) => key.startsWith(`${parent.replace(/^\//, '')}/`) && key.slice(parent.replace(/^\//, '').length + 1).split('/').length === 1 && (!ty || item.ty === ty)).map(([key, item]) => ({ path: key, ...item })),
    async close() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}
