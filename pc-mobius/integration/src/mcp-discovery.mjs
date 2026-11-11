import { randomUUID } from 'node:crypto';

export function createMcpDiscoveryAdapter({ baseUrl, householdGroups, bindings, fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), allowLoopbackHttp = false }) {
  const base = new URL(baseUrl);
  if ((base.protocol !== 'https:' && !(allowLoopbackHttp && base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash) throw new Error('Pinned oneM2M HTTPS base URL required');
  if (!householdGroups || !Array.isArray(bindings)) throw new Error('Enrolled household groups and device resource bindings required');
  const path = (value) => {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /(?:^|\/)\.\.(?:\/|$)/.test(value) || /%(?:2e|2f|5c)/i.test(value)) throw new Error('Registered oneM2M resource path required');
    const url = new URL(value, base); if (url.origin !== base.origin || url.search || url.hash) throw new Error('Pinned oneM2M resource origin required'); return url.pathname;
  };
  for (const value of Object.values(householdGroups)) path(value);
  const known = bindings.map((binding) => ({ ...binding, resourcePath: path(binding.resourcePath) }));
  return async ({ groupId, subjectId, principal }) => {
    const groupPath = householdGroups[subjectId];
    if (!groupPath || (groupId !== undefined && groupId !== subjectId) || typeof principal?.originator !== 'string' || /[\r\n]/.test(principal.originator)) throw new Error('oneM2M subject group and originator binding required');
    const requestId = `mcp-${randomUUID()}`;
    const response = await fetchImpl(new URL(path(groupPath), base), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', 'X-M2M-Origin': principal.originator, 'X-M2M-RI': requestId, 'X-M2M-RVI': '4' } });
    if (!response.ok || response.headers.get('x-m2m-rsc') !== '2000' || response.headers.get('x-m2m-ri') !== requestId || !response.body) throw new Error('Successful oneM2M retrieve receipt required');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Bounded oneM2M discovery response required'); chunks.push(chunk); }
    const group = JSON.parse(Buffer.concat(chunks).toString('utf8'))['m2m:grp'];
    if (!group || !Array.isArray(group.mid) || group.mid.length > 256) throw new Error('oneM2M group member resource identities required');
    const discovered = new Set(group.mid.map(path));
    const allowed = known.filter((binding) => binding.householdId === subjectId && discovered.has(binding.resourcePath));
    return { deviceIds: allowed.map((binding) => binding.deviceId), resourcePaths: allowed.map((binding) => binding.resourcePath), observedAt: clock() };
  };
}
