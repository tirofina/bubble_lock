import { createServer } from 'node:http';
import { once } from 'node:events';

export async function localServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((close) => server.close(close)); });
  return `http://127.0.0.1:${server.address().port}`;
}
export async function body(request) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

export async function mockCse(t, edgeId) {
  const resources = new Map([['/Mobius', { 'm2m:cb': { rn: 'Mobius', ri: `cb-${edgeId}`, csi: `/${edgeId}` } }]]);
  let count = 0;
  const endpoint = await localServer(t, async (request, response) => {
    const send = (status, rsc, value) => {
      response.writeHead(status, { 'content-type': 'application/json', 'X-M2M-RSC': String(rsc), 'X-M2M-RI': request.headers['x-m2m-ri'] });
      response.end(value ? JSON.stringify(value) : undefined);
    };
    const path = request.url;
    const resource = resources.get(path);
    switch (request.method) {
      case 'GET': {
        const latest = path.endsWith('/la') ? [...resources.entries()].filter(([key]) => key.startsWith(path.slice(0, -2)) && !key.slice(path.length - 2).includes('/')).at(-1)?.[1] : null;
        const found = resource ?? latest;
        return send(found ? 200 : 404, found ? 2000 : 4004, found);
      }
      case 'DELETE': resources.delete(path); return send(200, 2002);
      case 'PUT': {
        if (!resource) return send(404, 4004);
        const patch = await body(request);
        Object.assign(Object.values(resource)[0], Object.values(patch)[0]); return send(200, 2004, resource);
      }
      case 'POST': {
        if (!resource) return send(404, 4004);
        const value = await body(request); const tag = Object.keys(value)[0]; const attrs = value[tag];
        const nextPath = `${path}/${attrs.rn}`;
        if (resources.has(nextPath)) return send(409, 4105);
        const ty = Number(request.headers['content-type'].match(/ty=(\d+)/)[1]);
        const stored = { [tag]: { ...attrs, ri: `${edgeId}-${++count}`, ty, ...(ty === 2 ? { aei: `C-${edgeId}-${count}` } : {}) } };
        resources.set(nextPath, stored); return send(201, 2001, stored);
      }
      default: return send(405, 4005);
    }
  });
  return { endpoint, resources, edgeId, simulation: true, cseBase: '/Mobius', cseId: `/${edgeId}`, originator: `admin-${edgeId}` };
}
