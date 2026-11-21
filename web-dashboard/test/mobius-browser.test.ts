import assert from 'node:assert/strict';
import test from 'node:test';
import { browseMobiusCse } from '../server/mobius-browser.ts';
import { Onem2mClient } from '../server/onem2m.ts';

test('operator Mobius browser discovers standard resource types and retrieves the selected record through the BFF client', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const rqi = new Headers(init?.headers).get('X-M2M-RI') ?? '';
    calls.push(`${init?.method} ${url.pathname}${url.search}`);
    const selected = url.pathname === '/Mobius/Coperator/observations' && !url.search;
    const ty = url.searchParams.get('ty');
    const payload = selected
      ? { 'm2m:cnt': { rn: 'observations', ri: 'cnt-observations', pi: 'ae-operator', ty: 3, ct: '20261121T120000', lt: '20261121T120100', cni: 12, lbl: ['pb-observations'] } }
      : { 'm2m:uril': ty === '2' ? ['/Mobius/Coperator'] : ty === '3' ? ['/Mobius/Coperator/observations'] : ty === '4' ? ['/Mobius/Coperator/observations/cin-12'] : [] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json', 'X-M2M-RI': rqi, 'X-M2M-RSC': '2000' } });
  };
  const client = new Onem2mClient({ endpoint: 'http://127.0.0.1:7579', originator: 'Coperator', fetchImpl });
  const result = await browseMobiusCse({ client, cseBase: '/Mobius', cseId: '/id-in', source: 'onem2m-cse-live', simulation: false, selected: '/Mobius/Coperator/observations' });
  assert.equal(result.actual, true);
  assert.equal(result.simulation, false);
  assert.equal(result.discoveryRsc, 2000);
  assert.equal(result.selected?.envelope, 'm2m:cnt');
  assert.equal(result.selected?.attributes['rn'], 'observations');
  assert.ok(result.nodes.some((node) => node.path === '/Mobius/Coperator' && node.ty === 2 && node.type === 'applicationEntity'));
  assert.ok(result.nodes.some((node) => node.path === '/Mobius/Coperator/observations' && node.ty === 3 && node.type === 'container'));
  assert.ok(result.nodes.some((node) => node.path.endsWith('/cin-12') && node.ty === 4 && node.type === 'contentInstance'));
  assert.ok(calls.some((call) => call.includes('fu=1') && call.includes('drt=1') && call.includes('ty=3')));
  assert.ok(calls.includes('GET /Mobius/Coperator/observations'));
});

test('operator Mobius browser limits selected RETRIEVE to a node returned by the scoped tree', async () => {
  let selectedReads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const rqi = new Headers(init?.headers).get('X-M2M-RI') ?? '';
    if (!url.search) selectedReads += 1;
    return new Response(JSON.stringify({ 'm2m:uril': [] }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-M2M-RI': rqi, 'X-M2M-RSC': '2000' } });
  };
  const client = new Onem2mClient({ endpoint: 'http://127.0.0.1:7579', originator: 'Coperator', fetchImpl });
  const result = await browseMobiusCse({ client, cseBase: '/Mobius', cseId: '/id-in', source: 'onem2m-cse-live', simulation: false, selected: '/Mobius/private-secret' });
  assert.equal(result.selected, null);
  assert.equal(selectedReads, 0);
});
