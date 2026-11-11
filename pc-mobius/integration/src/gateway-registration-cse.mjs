import { approvalHash } from './integration-utils.mjs';

export class GatewayRegistrationCse {
  constructor({ endpoint, cseBase = '/Mobius', fetchImpl = globalThis.fetch, workloadHeaders = {}, workloadOriginator, allowLoopbackHttp = false, timeoutMs = 5000 }) {
    const url = new URL(endpoint);
    if ((url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !/^\/[A-Za-z0-9_-]+$/.test(cseBase) || !workloadOriginator) throw new Error('등록 CSE HTTPS origin과 workload identity를 설정하세요.');
    Object.assign(this, { endpoint: url.origin, cseBase, fetchImpl, workloadHeaders, workloadOriginator, timeoutMs });
  }
  async createAe({ gatewayId, registrationId, bootstrapToken }) {
    const rn = `gateway-${gatewayId}`, label = `pb-registration:${registrationId}`;
    const body = { 'm2m:ae': { rn, api: 'Nprivacy.bubble.gateway', rr: true, srv: ['4'], lbl: [label] } };
    const request = async (method, path, credential) => {
      const response = await this.fetchImpl(`${this.endpoint}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json', 'X-M2M-RI': registrationId, 'X-M2M-RVI': '4', 'X-M2M-Origin': method === 'POST' ? 'C' : this.workloadOriginator, ...(method === 'POST' ? { authorization: `Bearer ${credential}`, 'content-type': 'application/json;ty=2' } : this.workloadHeaders) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
      const chunks=[];let size=0;
      for await(const chunk of response.body??[]){size+=chunk.length;if(size>65536)throw new Error('등록 CSE 응답 크기를 확인하세요.');chunks.push(Buffer.from(chunk));}
      const text=Buffer.concat(chunks).toString('utf8');
      const rsc = Number(response.headers.get('X-M2M-RSC'));
      if (response.headers.get('X-M2M-RI') !== registrationId) throw new Error('등록 CSE 요청 식별자를 확인하세요.');
      if (method === 'POST' && (response.status === 409 || rsc === 4105)) return null;
      if (!response.ok || !(method === 'POST' ? rsc === 2001 : rsc === 2000)) throw new Error('등록 CSE 생성 receipt를 확인하세요.');
      return { payload: JSON.parse(text), rsc, status: response.status };
    };
    const result = await request('POST', this.cseBase, bootstrapToken) ?? await request('GET', `${this.cseBase}/${rn}`);
    const ae = result.payload['m2m:ae'];
    if (!ae || typeof ae.aei !== 'string' || !/^C[A-Za-z0-9._:-]{1,255}$/.test(ae.aei) || typeof ae.ri !== 'string' || ae.rn !== rn || ae.api !== body['m2m:ae'].api || !ae.lbl?.includes(label)) throw new Error('AE-ID·resource·등록 소유 label을 확인하세요.');
    return { aei: ae.aei, resourceId: ae.ri, resourcePath: `${this.cseBase}/${rn}`, requestId: registrationId, rsc: result.rsc, payloadHash: approvalHash(result.payload), endpoint: this.endpoint, evidenceMode: 'REAL_ONEM2M_PROTOCOL' };
  }
}
