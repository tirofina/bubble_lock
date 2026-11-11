import test from 'node:test';
import assert from 'node:assert/strict';
import { getJson, ReadError } from '../src/client.ts';

test('BFF 조회는 같은 origin 세션을 사용하고 외부 CSE 조회는 별도 인증 경계를 유지',async(t)=>{
  const original=globalThis.fetch;
  const requests:RequestInit[]=[];
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(_url,options)=>{requests.push(options??{});return Response.json({status:'ok'});};
  await getJson('/api/portal/locations',new AbortController().signal);
  await getJson('/api/resources',new AbortController().signal);
  await getJson('https://cse.example.test/Mobius',new AbortController().signal);
  await getJson('//third-party.example/api/locations',new AbortController().signal);
  assert.deepEqual(requests.map((request)=>request.credentials),['same-origin','same-origin','omit','omit']);
});

test('인증 거부 응답은 위치 화면의 좌표 폐기에 사용할 상태 코드를 유지',async(t)=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>Response.json({message:'권한 확인'},{status:403});
  await assert.rejects(getJson('/api/portal/locations',new AbortController().signal),(error)=>error instanceof ReadError&&error.status===403);
});
