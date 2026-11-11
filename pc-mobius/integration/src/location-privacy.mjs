import { approvalHash, recordEnvelope } from './integration-utils.mjs';
import { validCoordinates } from './mec-state.mjs';

const DAY = 86400000;
const ident = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const future = (value, now) => Number.isFinite(Date.parse(value)) && Date.parse(value) > now;
export function distanceMeters(a, b) {
  if (!validCoordinates(a) || !validCoordinates(b)) return Infinity;
  const r = (value) => value * Math.PI / 180;
  const x = Math.sin(r(b.lat-a.lat)/2)**2 + Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(r(b.lon-a.lon)/2)**2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1,x)));
}

/** 정밀 위치의 암호화 보관과 수신자별 단기 조회 권한을 같은 정본에서 검사합니다. */
export class LocationPrivacyService {
  constructor({ store, policyService, portalService, cipher, clock = () => new Date().toISOString() }) {
    Object.assign(this, { store, policyService, portalService, cipher, clock });
  }
  now() { return Date.parse(this.clock()); }
  async audit(type, details) {
    return this.store.append('receipts', recordEnvelope({ type, ...details, expiresAt:new Date(this.now()+30*DAY).toISOString() },this.clock));
  }
  current(lease, principalId = lease?.recipientId, deviceId = null) {
    if (!lease || lease.status !== 'ACTIVE' || lease.recipientId !== principalId || !future(lease.expiresAt,this.now()) || (deviceId && !lease.deviceIds.includes(deviceId))) return false;
    const home = this.store.get('households',lease.householdId);
    if (!home?.members.some((member)=>member.principalId===principalId) || !home.members.some((member)=>member.principalId===lease.approvedBy&&member.role==='guardian')) return false;
    const decision = this.policyService.evaluateGrant(lease.grantId,{scope:'location:read'});
    const consent = this.store.get('consents',decision.grant?.consentId);
    const incident = this.store.get('portalIncidents',lease.incidentId);
    return Boolean(decision.allowed && decision.grant.subjectId===lease.householdId && decision.grant.principalId===lease.approvedBy
      && decision.grant.revision===lease.grantRevision && consent?.revision===lease.consentRevision
      && decision.grant.purpose===lease.purpose && incident?.status==='OPEN' && incident.householdId===lease.householdId
      && lease.deviceIds.every((id)=>this.store.get('portalDevices',id)?.householdId===lease.householdId && (!incident.deviceId||incident.deviceId===id)));
  }
  leaseFor(principal,deviceId) {
    this.policyService.authorize(principal,'portal:read');
    return this.store.list('locationLeases').filter((lease)=>this.current(lease,principal.principalId,deviceId)).sort((a,b)=>Date.parse(b.expiresAt)-Date.parse(a.expiresAt))[0]??null;
  }
  deviceIds(principal) {
    this.policyService.authorize(principal,'portal:read');
    return [...new Set(this.store.list('locationLeases').filter((lease)=>this.current(lease,principal.principalId)).flatMap((lease)=>lease.deviceIds))];
  }
  list(principal) {
    return this.store.list('locationLeases').filter((lease)=>lease.recipientId===principal.principalId||this.store.get('households',lease.householdId)?.members.some((member)=>member.principalId===principal.principalId&&member.role==='guardian'))
      .map((lease)=>({...lease,effectiveStatus:this.current(lease)?'ACTIVE':lease.status==='ACTIVE'?'INACTIVE':lease.status}));
  }
  createLease(principal,input) {
    this.policyService.authorize(principal,'grant:write');
    return this.portalService.mutate(principal,'location.lease',input,async(key)=>{
      const decision=this.policyService.evaluateGrant(input.grantId,{scope:'location:read'});
      if (!decision.allowed || decision.grant.principalId!==principal.principalId) throw Error('보호자의 현재 위치 grant를 선택하세요.');
      const home=this.portalService.household(principal,decision.grant.subjectId,true);
      if (!ident(input.recipientId)||!home.members.some((member)=>member.principalId===input.recipientId)) throw Error('등록된 가구 수신자를 선택하세요.');
      if (!Array.isArray(input.deviceIds)||!input.deviceIds.length||input.deviceIds.length>1000||new Set(input.deviceIds).size!==input.deviceIds.length||input.deviceIds.some((deviceId)=>!ident(deviceId)||this.store.get('portalDevices',deviceId)?.householdId!==home.householdId)) throw Error('가구의 위치 공유 기기를 선택하세요.');
      const incident=this.store.get('portalIncidents',input.incidentId);
      if (!incident||incident.status!=='OPEN'||incident.householdId!==home.householdId||input.deviceIds.some((deviceId)=>incident.deviceId&&incident.deviceId!==deviceId)) throw Error('같은 가구의 진행 중인 사건을 선택하세요.');
      if (typeof input.purpose!=='string'||input.purpose!==decision.grant.purpose||!input.purpose.trim()) throw Error('승인 grant와 같은 조회 목적을 선택하세요.');
      const ttlSec=input.ttlSec??60;if(!Number.isInteger(ttlSec)||ttlSec<1||ttlSec>300)throw Error('위치 공유 유효기간을 1~300초로 설정하세요.');
      const consent=this.store.get('consents',decision.grant.consentId);
      const lease={leaseId:`location-${key.slice(0,32)}`,householdId:home.householdId,recipientId:input.recipientId,deviceIds:[...input.deviceIds],purpose:input.purpose,incidentId:incident.incidentId,grantId:decision.grant.grantId,grantRevision:decision.grant.revision,consentRevision:consent.revision,approvedBy:principal.principalId,status:'ACTIVE',createdAt:this.clock(),expiresAt:new Date(Math.min(this.now()+ttlSec*1000,Date.parse(decision.grant.expiresAt))).toISOString()};
      await this.store.put('locationLeases',lease.leaseId,lease);await this.audit('LOCATION_LEASE_APPROVED',{leaseId:lease.leaseId,recipientId:lease.recipientId,grantId:lease.grantId,incidentId:lease.incidentId});return lease;
    });
  }
  revokeLease(principal,input) {
    return this.portalService.mutate(principal,'location.revoke',input,async()=>{
      const lease=this.store.get('locationLeases',input.leaseId);
      if(!lease)throw Error('위치 공유 승인을 선택하세요.');
      if(lease.recipientId!==principal.principalId)this.portalService.household(principal,lease.householdId,true);
      const next={...lease,status:'REVOKED',revokedAt:this.clock()};await this.store.put('locationLeases',lease.leaseId,next);
      await this.audit('LOCATION_LEASE_REVOKED',{leaseId:lease.leaseId});return next;
    });
  }
  async seal({ payload, deviceId, householdId, observedAt, sourceType, payloadRef, sourceGrantId=null, expiresAt=new Date(this.now()+DAY).toISOString() }) {
    await this.cipher.ready;
    const payloadHash=approvalHash(payload);
    const reference=payloadRef??`location-${approvalHash({deviceId,sourceType,payloadHash}).slice(0,48)}`;
    const prior=this.store.get('locationPayloads',reference);
    if(prior){if(prior.payloadHash!==payloadHash)throw Error('위치 참조의 원본 내용을 유지하세요.');return this.reference(prior);}
    const sourceGrant=sourceGrantId?this.policyService.evaluateGrant(sourceGrantId):null;
    if(sourceGrantId&&!sourceGrant.allowed)throw Error('현재 수집 승인 grant를 확인하세요.');
    const row={payloadRef:reference,payloadHash,householdId,deviceId,sourceType,observedAt,sourceGrantId,sourceGrantRevision:sourceGrant?.grant?.revision??null,expiresAt:new Date(Math.min(Date.parse(expiresAt),this.now()+DAY)).toISOString(),cipher:this.cipher.seal(payload,reference)};
    await this.store.put('locationPayloads',reference,row);return this.reference(row);
  }
  reference(row) {return {type:'encrypted-location-reference',payloadRef:row.payloadRef,payloadHash:row.payloadHash,sourceType:row.sourceType,observedAt:row.observedAt,expiresAt:row.expiresAt};}
  async open(reference,{principal,leaseId,purpose,incidentId,deviceId}) {
    return this.store.transaction(`location-read:${leaseId}`,async()=>{
      this.policyService.authorize(principal,'portal:read');
      const row=this.store.get('locationPayloads',reference?.payloadRef);const lease=this.store.get('locationLeases',leaseId);
      if(!row||!this.current(lease,principal.principalId,deviceId)||lease.purpose!==purpose||lease.incidentId!==incidentId||row.householdId!==lease.householdId||row.deviceId!==deviceId||!future(row.expiresAt,this.now())||row.payloadHash!==reference.payloadHash)return null;
      if(row.sourceGrantId){const decision=this.policyService.evaluateGrant(row.sourceGrantId);if(!decision.allowed||decision.grant.revision!==row.sourceGrantRevision)return null;}
      await this.cipher.ready;const payload=this.cipher.open(row.cipher,row.payloadRef);
      if(approvalHash(payload)!==row.payloadHash)throw Error('암호화 위치 원본 hash를 확인하세요.');
      return {payload,leaseId:lease.leaseId,readExpiresAt:new Date(Math.min(this.now()+5000,Date.parse(lease.expiresAt))).toISOString()};
    });
  }
  async readMec(eventKey,{principal,leaseId,purpose,incidentId,deviceId,bleObservation}) {
    return this.store.transaction(`location-mec-read:${leaseId}`,async()=>{
      this.policyService.authorize(principal,'portal:read');
      const row=this.store.get('mecPayloads',eventKey);const lease=this.store.get('locationLeases',leaseId);
      if(!row||!this.current(lease,principal.principalId,deviceId)||lease.purpose!==purpose||lease.incidentId!==incidentId||!future(row.expiresAt,this.now()))return null;
      const source=this.policyService.evaluateGrant(row.grantId,{scope:'mec:location'});
      if(!source.allowed||source.grant.revision!==row.grantRevision||source.grant.subjectId!==lease.householdId)return null;
      await this.cipher.ready;const event=this.cipher.open(row.cipher,eventKey);
      if(event.service!=='Location'||event.intent?.grantId!==row.grantId)return null;
      return this.associate(event,{principal,lease,bleObservation});
    });
  }
  approveAssociation(principal,input) {
    this.policyService.authorize(principal,'grant:write');
    return this.portalService.mutate(principal,'location.association',input,async(key)=>{
      const decision=this.policyService.evaluateGrant(input.grantId,{scope:'mec:location'});
      if(!decision.allowed||decision.grant.principalId!==principal.principalId)throw Error('보호자의 현재 MEC 위치 grant를 선택하세요.');
      this.portalService.household(principal,decision.grant.subjectId,true);
      const device=this.store.get('portalDevices',input.deviceId);const gateway=this.store.get('gateways',input.gatewayId);
      if(!device||device.householdId!==decision.grant.subjectId||gateway?.devices?.[input.deviceId]!==device.householdId||gateway.status!=='ACTIVE'||typeof input.ueId!=='string'||!input.ueId||input.ueId.length>256)throw Error('등록된 키링·Gateway·릴레이 UE 연결을 확인하세요.');
      if(!Number.isFinite(input.maxDistanceM)||input.maxDistanceM<1||input.maxDistanceM>1000||!Number.isInteger(input.maxAgeMs)||input.maxAgeMs<100||input.maxAgeMs>30000)throw Error('릴레이 결합 거리 1~1000m와 관측 시차 100~30000ms를 설정하세요.');
      if(!validCoordinates(input.gatewayPosition)||!Number.isFinite(input.referenceRssiDbm)||input.referenceRssiDbm< -127||input.referenceRssiDbm>=0||!Number.isFinite(input.pathLossExponent)||input.pathLossExponent<1||input.pathLossExponent>6)throw Error('수신기 좌표와 RSSI 거리 교정값을 확인하세요.');
      const row={associationId:`relay-${key.slice(0,32)}`,householdId:device.householdId,ueId:input.ueId,deviceId:input.deviceId,gatewayId:input.gatewayId,grantId:decision.grant.grantId,grantRevision:decision.grant.revision,policyRevision:1,maxDistanceM:input.maxDistanceM,maxAgeMs:input.maxAgeMs,referenceRssiDbm:input.referenceRssiDbm,pathLossExponent:input.pathLossExponent,approvedBy:principal.principalId,status:'ACTIVE',createdAt:this.clock(),expiresAt:new Date(Math.min(this.now()+DAY,Date.parse(decision.grant.expiresAt))).toISOString()};
      row.anchorCipher=this.cipher.seal(input.gatewayPosition,row.associationId);
      await this.store.put('relayAssociations',row.associationId,row);await this.audit('RELAY_ASSOCIATION_APPROVED',{associationId:row.associationId,grantId:row.grantId});
      const {anchorCipher,...publicRow}=row;return publicRow;
    });
  }
  async associate(event,{principal,lease,bleObservation}) {
    const candidates=this.store.list('relayAssociations').filter((row)=>row.ueId===event.ueId&&row.deviceId===bleObservation?.deviceId&&row.gatewayId===bleObservation.gatewayId&&row.status==='ACTIVE'&&future(row.expiresAt,this.now()));
    for(const row of candidates){
      const decision=this.policyService.evaluateGrant(row.grantId,{scope:'mec:location'});
      if(!decision.allowed||decision.grant.revision!==row.grantRevision||event.intent?.grantId!==row.grantId||!this.current(lease,principal.principalId,row.deviceId)||row.householdId!==lease.householdId||!this.policyService.subjectAuthority(row.approvedBy,row.householdId))continue;
      if(Math.abs(Date.parse(event.observedAt)-Date.parse(bleObservation.observedAt))>row.maxAgeMs||this.now()-Date.parse(event.observedAt)>row.maxAgeMs||this.now()-Date.parse(bleObservation.observedAt)>row.maxAgeMs)continue;
      const point=event.location??event.position;const anchor=this.cipher.open(row.anchorCipher,row.associationId);
      const radius=10**((row.referenceRssiDbm-bleObservation.rssiDbm)/(10*row.pathLossExponent));
      const ueAccuracy=point?.accuracyM??event.uncertainty?.accuracyM??event.uncertainty?.radiusM;
      if(!Number.isFinite(radius)||!Number.isFinite(ueAccuracy)||ueAccuracy<0||distanceMeters(anchor,point)+ueAccuracy+radius>row.maxDistanceM)continue;
      return {deviceId:row.deviceId,observedAt:event.observedAt,simulation:event.simulation===true||bleObservation.simulation===true,service:'Location',sourceType:'BLE_RELAY_OBSERVATION',associationId:row.associationId,location:{lat:point.lat,lon:point.lon,source:'mec',accuracyM:radius+ueAccuracy}};
    }
    return null;
  }
}
