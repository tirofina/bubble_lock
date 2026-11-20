// In-memory oneM2M CSE subset for unit tests of the FL coordination plane (real HTTP, fake storage).
// Semantics mirror what the real run relies on in Mobius4: pre-assigned AE-IDs, rn conflicts (4105),
// cnt acpi without inheritance, parent-governed cin access, ACP pvs, 'all' acor, mni, la/ol,
// rcn=4 child listing, fu=1 discovery with ty/lbl filters, cr:null creator, and net=3 notifications.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

const KEY = { 1: 'm2m:acp', 2: 'm2m:ae', 3: 'm2m:cnt', 4: 'm2m:cin', 23: 'm2m:sub' };
const STATUS = { 2000: 200, 2001: 201, 2002: 200, 2004: 200, 4000: 400, 4004: 404, 4103: 403, 4105: 409, 5000: 500 };
const OP = { CREATE: 1, RETRIEVE: 2, UPDATE: 4, DELETE: 8, DISCOVERY: 32 };

export async function startFakeCse({ cseBase = '/Mobius' } = {}) {
  const nodes = new Map(); const byRi = new Map(); let st = 0; const log = [];
  const ri = () => randomBytes(5).toString('hex');
  const add = (path, ty, attrs, parent) => { const node = { path, ty, attrs, parent, children: [] }; nodes.set(path, node); byRi.set(attrs.ri, node); if (parent) nodes.get(parent).children.push(path); return node; };
  const remove = (path) => { const node = nodes.get(path); if (!node) return; for (const child of [...node.children]) remove(child); nodes.delete(path); byRi.delete(node.attrs.ri); const parent = nodes.get(node.parent); if (parent) parent.children = parent.children.filter((c) => c !== path); };
  add(cseBase, 5, { ri: 'cb', rn: cseBase.slice(1) }, null);
  const allows = (acr, originator, op) => (acr ?? []).some((rule) => (rule.acor.includes(originator) || rule.acor.includes('all')) && (rule.acop & op));
  const permitted = (node, originator, op) => {
    if (!node) return false;
    if (node.ty === 5) return op === OP.CREATE || op === OP.DISCOVERY || op === OP.RETRIEVE;
    if (node.ty === 1) return allows(node.attrs.pvs?.acr, originator, op);
    if (node.ty === 4 || node.ty === 23) return permitted(nodes.get(node.parent), originator, op);
    // acpi entries are unstructured ri or CSE-relative structured IDs (Mobius4 resolves both).
    if (node.attrs.acpi?.length) return node.attrs.acpi.some((id) => allows((byRi.get(id) ?? nodes.get(`/${id}`))?.attrs.pv?.acr, originator, op));
    return node.attrs.int_cr === originator;
  };
  const view = (node) => { const { int_cr, ...attrs } = node.attrs; return { [KEY[node.ty] ?? 'm2m:cb']: { ty: node.ty, ...attrs } }; };
  const notify = (parent, created) => {
    for (const childPath of parent.children) {
      const sub = nodes.get(childPath); if (sub?.ty !== 23 || !sub.attrs.enc?.net?.includes(3)) continue;
      for (const nu of sub.attrs.nu) if (nu.startsWith('http')) fetch(nu, { method: 'POST', headers: { 'content-type': 'application/json', 'X-M2M-Origin': '/fake-cse', 'X-M2M-RI': ri() }, body: JSON.stringify({ 'm2m:sgn': { sur: sub.path.slice(1), nev: { net: 3, rep: view(created) } } }) }).catch(() => {});
    }
  };
  const handle = (method, path, query, originator, ty, body) => {
    const virtual = path.match(/^(.*)\/(la|ol)$/);
    if (method === 'GET' && virtual && nodes.get(virtual[1])?.ty === 3) {
      const parent = nodes.get(virtual[1]); if (!permitted(parent, originator, OP.RETRIEVE)) return [4103];
      const cins = parent.children.map((p) => nodes.get(p)).filter((n) => n.ty === 4);
      const pick = virtual[2] === 'la' ? cins.at(-1) : cins[0]; return pick ? [2000, view(pick)] : [4004];
    }
    const node = nodes.get(path); if (!node) return [4004];
    if (method === 'GET' && query.get('fu') === '1') {
      if (!permitted(node, originator, OP.DISCOVERY)) return [4103];
      const found = [...nodes.values()].filter((n) => n.path.startsWith(`${path}/`) && (!query.get('ty') || String(n.ty) === query.get('ty')) && (!query.get('lbl') || n.attrs.lbl?.includes(query.get('lbl'))) && permitted(n, originator, OP.DISCOVERY));
      return [2000, { 'm2m:uril': found.map((n) => n.path.slice(1)) }];
    }
    if (method === 'GET') {
      if (!permitted(node, originator, OP.RETRIEVE)) return [4103];
      const value = view(node);
      if (query.get('rcn') === '4') { const kids = node.children.map((p) => nodes.get(p)).filter((n) => n.ty === 4).reverse().map((n) => view(n)['m2m:cin']); value[KEY[node.ty]]['m2m:cin'] = kids; }
      return [2000, value];
    }
    if (method === 'PUT') {
      if (!permitted(node, originator, OP.UPDATE)) return [4103];
      Object.assign(node.attrs, Object.values(body)[0]); return [2004, view(node)];
    }
    if (method === 'DELETE') { if (!permitted(node, originator, OP.DELETE)) return [4103]; remove(path); return [2002]; }
    if (method === 'POST') {
      const attrs = { ...Object.values(body)[0] };
      if (ty === 2) { if (node.ty !== 5) return [4000]; attrs.aei = !originator || originator === 'C' ? `C${ri()}` : originator; attrs.ri = attrs.aei; if ([...nodes.values()].some((n) => n.ty === 2 && n.attrs.aei === attrs.aei)) return [4105]; }
      else { if (!permitted(node, originator, OP.CREATE)) return [4103]; attrs.ri = ri(); }
      attrs.rn ??= `${KEY[ty].slice(4)}-${ri()}`;
      const childPath = `${path}/${attrs.rn}`; if (nodes.has(childPath)) return [4105];
      attrs.int_cr = ty === 2 ? attrs.aei : originator; attrs.pi = node.attrs.ri; attrs.ct = new Date().toISOString();
      if (ty === 4) { attrs.st = ++st; if (attrs.cr === null) attrs.cr = originator; else delete attrs.cr; }
      const created = add(childPath, ty, attrs, path);
      if (ty === 4 && node.ty === 3) {
        const cins = node.children.filter((p) => nodes.get(p).ty === 4);
        while (node.attrs.mni && cins.length > node.attrs.mni) remove(cins.shift());
        notify(node, created);
      }
      return [2001, view(created)];
    }
    return [4000];
  };
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://fake'); const originator = request.headers['x-m2m-origin'];
    const ty = Number(/ty=(\d+)/.exec(request.headers['content-type'] ?? '')?.[1]) || null;
    let result;
    try { result = handle(request.method, decodeURIComponent(url.pathname), url.searchParams, originator, ty, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null); }
    catch (error) { result = [5000, { 'm2m:dbg': error.message }]; }
    const [rsc, payload] = result; log.push({ method: request.method, path: url.pathname, originator, rsc });
    response.writeHead(STATUS[rsc] ?? 500, { 'content-type': 'application/json', 'X-M2M-RSC': String(rsc), 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' });
    response.end(payload ? JSON.stringify(payload) : '');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`, cseBase, nodes, log,
    contents: () => [...nodes.values()].filter((n) => n.ty === 4).map((n) => ({ path: n.path, con: n.attrs.con, cr: n.attrs.cr ?? null })),
    close: async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  };
}
