import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createPortalUpstream } from '../../web-dashboard/server/portal-upstream.ts';

const input=createInterface({input:process.stdin});
let ready;
for await(const line of input){ready=JSON.parse(line);break;}
input.close();process.stdin.destroy();
const ca=await readFile(join(process.argv[2],'trusted.pem'),'utf8');
const rogue=await readFile(join(process.argv[2],'rogue.pem'),'utf8');
const upstream=createPortalUpstream({baseUrl:ready.origin,ca});
const query={method:'GET',path:'/v1/portal/snapshot',accessToken:ready.token};
const result=await upstream(query);
assert.equal(result.status,200);
assert.equal(result.body.principal.principalId,'guardian-test');
assert.equal((await upstream({...query,accessToken:ready.expired})).status,401);
await assert.rejects(createPortalUpstream({baseUrl:ready.origin,ca:rogue})(query));
await assert.rejects(upstream({...query,path:'https://third-party.example/'}));
assert.throws(()=>createPortalUpstream({baseUrl:'http://127.0.0.1'}));
console.log(JSON.stringify({status:'PASS',checks:5,transport:'Node BFF → enrolled OIDC API / TLS1.3'}));
