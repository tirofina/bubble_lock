import { timingSafeEqual } from 'node:crypto';
import { approvalHash, recordEnvelope, sha256 } from './integration-utils.mjs';

const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
const matchSecret = (secret, expected) => typeof secret === 'string' && secret.length >= 32 && secret.length <= 1024 && typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(sha256(secret), 'hex'), Buffer.from(expected, 'hex'));

export class GatewayRegistrationService {
  constructor({ store, policyService, gatewayControl, clock, createAe, issueCredential, terminateSessions = null }) {
    Object.assign(this, { store, policyService, gatewayControl, clock, createAe, issueCredential, terminateSessions });
    this.operations = new Map();
  }
  async provisionBootstrap({ bootstrapId, gatewayId, principalId, fingerprint, devices, tokenHash, expiresAt }) {
    if (![bootstrapId,gatewayId,principalId].every(identifier) || typeof fingerprint !== 'string' || !fingerprint || !/^[a-f0-9]{64}$/.test(tokenHash) || !Number.isFinite(Date.parse(expiresAt)) || !devices || Array.isArray(devices) || !Object.entries(devices).length || !Object.entries(devices).every(([deviceId,subjectId]) => identifier(deviceId) && identifier(subjectId))) throw new Error('신뢰 설정의 bootstrap·기기·가구·credential을 확인하세요.');
    return this.store.transaction(`bootstrap:${bootstrapId}`, async () => {
      const intended = { bootstrapId,gatewayId,principalId,fingerprint,devices,tokenHash,expiresAt, scope:'AE_CREATE' };
      const previous = this.store.get('gatewayBootstraps', bootstrapId);
      if (previous) { if (previous.configurationHash !== approvalHash(intended)) throw new Error('기존 bootstrap 설정 revision을 확인하세요.'); return { bootstrapId,status:previous.status }; }
      if (this.store.list('gatewayBootstraps').some((entry) => entry.fingerprint === fingerprint || entry.gatewayId === gatewayId || entry.principalId === principalId)
        || this.store.list('gateways').some((entry)=>entry.gatewayId===gatewayId || entry.principalId===principalId || entry.fingerprint===fingerprint)) throw new Error('독립된 새 Gateway bootstrap을 사용하세요.');
      await this.store.put('gatewayBootstraps', bootstrapId, { ...intended, configurationHash:approvalHash(intended), status:'AVAILABLE', createdAt:this.clock() });
      return { bootstrapId,status:'AVAILABLE' };
    });
  }
  register(input) {
    const key = input?.bootstrapId;
    const preceding = this.operations.get(key) ?? Promise.resolve();
    const operation = preceding.catch(() => {}).then(() => this.registerPhases(input));
    this.operations.set(key, operation);
    return operation.finally(() => { if (this.operations.get(key) === operation) this.operations.delete(key); });
  }
  async registerPhases({ principal, bootstrapId, bootstrapToken, requestId, csrPem }) {
    this.policyService.authorize(principal, 'gateway:register');
    if (!identifier(requestId) || !identifier(bootstrapId) || typeof csrPem !== 'string' || Buffer.byteLength(csrPem)>8192 || typeof this.createAe !== 'function' || typeof this.issueCredential !== 'function') throw new Error('등록 식별자·CSR·CSE·인증서 발급 설정을 확인하세요.');
    const intentHash = approvalHash({ bootstrapId,requestId,csrPem,principalId:principal.principalId });
    let record = await this.store.transaction(`bootstrap:${bootstrapId}`, async () => {
      const bootstrap = this.store.get('gatewayBootstraps', bootstrapId);
      if (!bootstrap || bootstrap.principalId !== principal.principalId || bootstrap.fingerprint !== principal.mtlsFingerprint || !matchSecret(bootstrapToken,bootstrap.tokenHash)) throw new Error('서버에 등록한 bootstrap 주체·인증서·token을 확인하세요.');
      if (bootstrap.registrationId) {
        const prior = this.store.get('gatewayRegistrations',bootstrap.registrationId);
        if (!prior || prior.intentHash !== intentHash || ['LOST','REVOKED'].includes(this.store.get('gateways',bootstrap.gatewayId)?.status)) throw new Error('원래 등록 요청과 현재 Gateway 자격을 확인하세요.');
        return prior;
      }
      if (bootstrap.status !== 'AVAILABLE' || Date.parse(bootstrap.expiresAt)<=Date.parse(this.clock())) throw new Error('유효한 bootstrap 등록 기간을 확인하세요.');
      const registrationId = approvalHash({ bootstrapId,intentHash });
      const created = { registrationId,bootstrapId,gatewayId:bootstrap.gatewayId,principalId:bootstrap.principalId,intentHash,phase:'PREPARED',createdAt:this.clock() };
      await this.store.put('gatewayRegistrations',registrationId,created);
      await this.store.put('gatewayBootstraps',bootstrapId,{...bootstrap,status:'RESERVED',registrationId});
      return created;
    });
    if (record.phase === 'ACTIVE') return this.registrationResult(record);
    if (record.phase === 'PREPARED') {
      const receipt = await this.createAe({ gatewayId:record.gatewayId,registrationId:record.registrationId,bootstrapToken });
      if (!receipt || !/^C[A-Za-z0-9._:-]{1,255}$/.test(receipt.aei) || receipt.requestId !== record.registrationId || ![2000,2001].includes(receipt.rsc) || !receipt.resourceId || !/^[a-f0-9]{64}$/.test(receipt.payloadHash)) throw new Error('AE CREATE registration receipt를 확인하세요.');
      record = await this.store.transaction(`bootstrap:${bootstrapId}`,async () => {
        const current = this.store.get('gatewayRegistrations',record.registrationId);
        if (current.phase !== 'PREPARED') return current;
        if (this.store.list('principalBindings').some((binding) => binding.aei === receipt.aei && binding.principalId !== record.principalId)) throw new Error('AE-ID의 고유 principal binding을 확인하세요.');
        await this.store.put('principalBindings',record.principalId,{principalId:record.principalId,gatewayId:record.gatewayId,aei:receipt.aei,revision:1,status:'CREDENTIAL_PENDING',registrationId:record.registrationId,registrationReceipt:receipt});
        const bootstrap = this.store.get('gatewayBootstraps',bootstrapId);
        await this.store.put('gatewayBootstraps',bootstrapId,{...bootstrap,status:'CONSUMED',consumedAt:this.clock()});
        const next = {...current,phase:'REGISTERED',registrationReceipt:receipt};
        await this.store.put('gatewayRegistrations',record.registrationId,next);
        await this.store.append('receipts',recordEnvelope({type:'GATEWAY_AE_BOUND',registrationId:record.registrationId,principalId:record.principalId,aei:receipt.aei,bootstrapConsumed:true},this.clock));
        return next;
      });
    }
    const credential = await this.issueCredential({csrPem,principalId:record.principalId,aei:record.registrationReceipt.aei,registrationId:record.registrationId});
    if (!credential?.fingerprint || !credential.certificatePem || !credential.credentialId || Date.parse(credential.expiresAt)<=Date.parse(this.clock())) throw new Error('발급된 AE 전용 인증서를 확인하세요.');
    record = await this.store.transaction(`bootstrap:${bootstrapId}`,async () => {
      const current = this.store.get('gatewayRegistrations',record.registrationId);
      if (current.phase === 'ACTIVE') return current;
      const bootstrap = this.store.get('gatewayBootstraps',bootstrapId);
      const binding = this.store.get('principalBindings',record.principalId);
      if (binding?.status !== 'CREDENTIAL_PENDING' || binding.registrationId !== record.registrationId) throw new Error('현재 등록 binding 상태를 확인하세요.');
      if (this.store.get('gateways',record.gatewayId)) throw new Error('Gateway 등록 활성화의 독립된 소유권을 확인하세요.');
      await this.gatewayControl.enroll({gatewayId:record.gatewayId,principalId:record.principalId,fingerprint:credential.fingerprint,devices:bootstrap.devices,credentialRevision:String(binding.revision)});
      await this.store.put('gatewayCredentials',credential.credentialId,{...credential,principalId:record.principalId,gatewayId:record.gatewayId,status:'ACTIVE',bindingRevision:binding.revision});
      await this.store.put('principalBindings',record.principalId,{...binding,status:'ACTIVE',credentialId:credential.credentialId,fingerprint:credential.fingerprint});
      const next = {...current,phase:'ACTIVE',credentialId:credential.credentialId,activatedAt:this.clock()};
      await this.store.put('gatewayRegistrations',record.registrationId,next);
      await this.store.append('receipts',recordEnvelope({type:'GATEWAY_CREDENTIAL_ISSUED',gatewayId:record.gatewayId,principalId:record.principalId,credentialId:credential.credentialId,bindingRevision:binding.revision},this.clock));
      return next;
    });
    return this.registrationResult(record);
  }
  registrationResult(record) {
    const credential = this.store.get('gatewayCredentials',record.credentialId);
    return {gatewayId:record.gatewayId,registrationId:record.registrationId,aei:record.registrationReceipt.aei,status:'ACTIVE',credential:{certificatePem:credential.certificatePem,caPem:credential.caPem,expiresAt:credential.expiresAt,credentialRevision:String(credential.bindingRevision)}};
  }
  async resolveCertificatePrincipal(fingerprint) {
    return this.store.transaction('gateway:certificate-identity',async () => {
      const binding = this.store.list('principalBindings').find((entry)=>entry.fingerprint===fingerprint);
      if (binding) {
        const credential = this.store.get('gatewayCredentials',binding.credentialId);
        const status = binding.status==='ACTIVE' && credential?.status==='ACTIVE' && Date.parse(credential.expiresAt)>Date.parse(this.clock()) ? 'ACTIVE' : binding.status==='LOST' ? 'LOST' : 'REVOKED';
        return {status,principal:{principalId:binding.principalId,originator:binding.aei,scopes:[],mtlsFingerprint:fingerprint}};
      }
      const bootstrap = this.store.list('gatewayBootstraps').find((entry)=>entry.fingerprint===fingerprint);
      if (bootstrap) return {status:'BOOTSTRAP',principal:{principalId:bootstrap.principalId,scopes:['gateway:register'],mtlsFingerprint:fingerprint}};
      const gateway = this.store.list('gateways').find((entry)=>entry.fingerprint===fingerprint);
      if (gateway && gateway.status!=='ACTIVE') return {status:gateway.status,principal:{principalId:gateway.principalId,scopes:[],mtlsFingerprint:fingerprint}};
      return {status:'UNKNOWN'};
    });
  }
  async markLost({principal,gatewayId,reason='reported-lost',idempotencyKey}) {
    this.policyService.authorize(principal,'gateway:manage');
    if (!identifier(gatewayId) || !identifier(idempotencyKey) || typeof reason!=='string' || reason.length>512) throw new Error('상실 요청 식별자·사유를 확인하세요.');
    const intentHash=approvalHash({gatewayId,reason,idempotencyKey,principalId:principal.principalId});
    const key=`${gatewayId}:${idempotencyKey}`;
    const result=await this.store.transaction(`gateway:lifecycle:${gatewayId}`,async()=>{
      const gateway=this.gatewayControl.gateway(gatewayId);
      const subjects=new Set(Object.values(gateway.devices));
      if (!principal.scopes.includes('gateway:admin') && [...subjects].some((subject)=>!this.store.get('households',subject)?.members.some((member)=>member.principalId===principal.principalId && member.role==='guardian'))) throw new Error('등록 가구 Guardian 권한을 확인하세요.');
      const prior=this.store.get('gatewayLifecycleIntents',key);
      if(prior){if(prior.intentHash!==intentHash)throw new Error('기존 상실 요청의 내용을 유지하세요.');return prior;}
      const binding=this.store.get('principalBindings',gateway.principalId);
      const revision=(binding?.revision??(Number(gateway.credentialRevision)||1))+1;
      await this.store.put('gateways',gatewayId,{...gateway,status:'LOST',credentialRevision:String(revision)});
      await this.store.put('principalBindings',gateway.principalId,{...(binding??{principalId:gateway.principalId,gatewayId,aei:null,fingerprint:gateway.fingerprint,source:'TRUSTED_PROVISIONING'}),status:'LOST',revision});
      for(const credential of this.store.list('gatewayCredentials').filter((entry)=>entry.gatewayId===gatewayId))await this.store.put('gatewayCredentials',credential.credentialId,{...credential,status:'REVOKED',revokedAt:this.clock()});
      const revokedGrantIds=[];
      for(const grant of this.store.list('grants').filter((entry)=>subjects.has(entry.subjectId)&&entry.status==='ACTIVE')){
        await this.store.put('grants',grant.grantId,{...grant,status:'REVOKED',revision:grant.revision+1,revokedAt:this.clock(),revokedBy:principal.principalId,revokeReason:`gateway-lost:${gatewayId}`});
        await this.store.append('receipts',recordEnvelope({type:'GRANT_REVOKED',grantId:grant.grantId,principalId:principal.principalId,reason:`gateway-lost:${gatewayId}`},this.clock));
        revokedGrantIds.push(grant.grantId);
      }
      const next={key,intentHash,gatewayId,fingerprint:gateway.fingerprint,status:'LOST',bindingRevision:revision,revokedGrantIds,sessionTermination:'PENDING',observedAt:this.clock()};
      await this.store.put('gatewayLifecycleIntents',key,next);
      await this.store.append('receipts',recordEnvelope({type:'GATEWAY_LOST',...next,principalId:principal.principalId},this.clock));
      return next;
    });
    if(result.sessionTermination==='PENDING'&&this.terminateSessions){
      let closed;
      try { closed=await this.terminateSessions({fingerprint:result.fingerprint,gatewayId}); }
      catch {
        await this.store.append('receipts',recordEnvelope({type:'GATEWAY_SESSION_TERMINATION_RETRY',gatewayId,bindingRevision:result.bindingRevision},this.clock));
        return result;
      }
      return this.store.transaction(`gateway:lifecycle:${gatewayId}`,async()=>{
        const next={...this.store.get('gatewayLifecycleIntents',key),sessionTermination:'COMPLETED',sessionsClosed:typeof closed==='number'?closed:Number.isInteger(closed?.terminated)?closed.terminated:null};
        await this.store.put('gatewayLifecycleIntents',key,next);
        await this.store.append('receipts',recordEnvelope({type:'GATEWAY_SESSIONS_TERMINATED',gatewayId,bindingRevision:next.bindingRevision,sessionsClosed:next.sessionsClosed},this.clock));
        return next;
      });
    }
    return result;
  }
}
