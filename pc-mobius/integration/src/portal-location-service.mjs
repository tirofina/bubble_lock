import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import observationSchema from '../../../contracts/keyring/observation.schema.json' with { type: 'json' };
import { approvalHash, recordEnvelope } from './integration-utils.mjs';

const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv);
const validateObservation = ajv.compile(observationSchema);
const validPoint = (point) => point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;
const accuracy = (value) => Number.isFinite(value) && value >= 0 && value <= 100000 ? value : undefined;
const rssi = (value) => Number.isInteger(value) && value >= -127 && value <= 20;

export class PortalLocationService {
  constructor({ store, policyService, portalService, gatewayControl, mecIngress, handoverCoordinator, privacy, deviceIncidents, clock = () => new Date().toISOString(), deviceBindings = {}, retentionMs = 86400000 }) {
    if (!deviceBindings || typeof deviceBindings !== 'object' || Array.isArray(deviceBindings) || Object.entries(deviceBindings).some(([ueId, deviceId]) => !ueId || ueId.length > 256 || typeof deviceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId))) throw new Error('서버의 UE·키링 등록 연결을 확인하세요.');
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1000 || retentionMs > 86400000) throw new Error('위치 보관 기간을 1초~24시간으로 설정하세요.');
    Object.assign(this, { store, policyService, portalService, gatewayControl, mecIngress, handoverCoordinator, privacy, deviceIncidents, clock, retentionMs });
    this.deviceBindings = structuredClone(deviceBindings);
  }

  async ingestGateway({ gatewayId, principal, observation }) {
    const gateway = this.gatewayControl.authenticate(gatewayId, principal);
    if (gateway.status !== 'ACTIVE' || !validateObservation(observation) || Buffer.byteLength(JSON.stringify(observation)) > 8192
      || observation.gatewayId !== gatewayId || !gateway.devices[observation.deviceId]) throw new Error('등록된 Gateway의 관측 계약을 확인하세요.');
    const now = Date.parse(this.clock()); const observed = Date.parse(observation.observedAt); const received = Date.parse(observation.receivedAt);
    if (observed > now + 2000 || observed < now - this.retentionMs || received < observed || received > now + 2000) throw new Error('관측 시각과 위치 보관 기간을 확인하세요.');
    const householdId = gateway.devices[observation.deviceId];
    const device = this.store.get('portalDevices', observation.deviceId);
    if (device && device.householdId !== householdId) throw new Error('기기·가구 연결을 확인하세요.');
    const key = `${gatewayId}:${observation.deviceId}`;
    const observationId = approvalHash({ gatewayId, deviceId: observation.deviceId, bootId: observation.bootId, sequence: observation.sequence });
    const payloadHash = approvalHash(observation);
    return this.store.transaction(`gateway-telemetry:${key}`, async () => {
      const currentGateway=this.gatewayControl.authenticate(gatewayId,principal);
      if(currentGateway.status!=='ACTIVE'||currentGateway.devices[observation.deviceId]!==householdId||this.store.get('portalDevices',observation.deviceId)?.householdId!==householdId)throw Error('현재 Gateway·기기·가구 등록을 확인하세요.');
      const prior = this.store.get('gatewayTelemetry', key);
      if (prior?.observationId === observationId) {
        if (prior.payloadHash !== payloadHash) throw new Error('원래 관측 식별자의 내용을 유지하세요.');
        return { status: 'DUPLICATE', deviceId: observation.deviceId, observationId };
      }
      if (prior && ((prior.bootId === observation.bootId && prior.firmwareSequence >= observation.sequence) || Date.parse(prior.observedAt) > observed)) return { status: 'STALE', deviceId: observation.deviceId, observationId };
      const watermark = this.store.get('gatewayTelemetrySequences', observation.deviceId)?.sequence ?? -1;
      const sequence = watermark + 1;
      const reference=await this.privacy.seal({payload:observation,deviceId:observation.deviceId,householdId,observedAt:observation.observedAt,sourceType:'GATEWAY_OBSERVATION',payloadRef:`gateway-${observationId}`,expiresAt:new Date(observed+this.retentionMs).toISOString()});
      const row = { observationId, payloadHash, gatewayId, deviceId: observation.deviceId, householdId, reference, bootId:observation.bootId,firmwareSequence:observation.sequence,observedAt:observation.observedAt,
        simulation: gateway.simulation === true || principal.simulation === true, acceptedAt: this.clock(), expiresAt: new Date(observed + this.retentionMs).toISOString() };
      await this.store.put('gatewayTelemetry', key, row);
      await this.store.put('gatewayTelemetrySequences', observation.deviceId, { sequence });
      await this.deviceIncidents?.ingest({gatewayId,principal,observation,observationId});
      if (typeof this.handoverCoordinator?.acceptObservation === 'function') await this.handoverCoordinator.acceptObservation({ ueId: observation.deviceId, sequence, payload: reference, acceptedAt: this.clock() });
      await this.store.append('receipts', recordEnvelope({ type: 'GATEWAY_TELEMETRY_ACCEPTED', gatewayId, deviceId: observation.deviceId, observationId, payloadHash, sequence, observedAt: observation.observedAt, simulation: row.simulation }, this.clock));
      return { status: 'ACCEPTED', deviceId: observation.deviceId, observationId };
    });
  }

  async read(principal) {
    return this.store.transaction(`portal-locations:${principal.principalId}`, async () => {
      await this.prune();
      const access = this.portalService.locationAccess(principal);
      const allowed = new Set(this.privacy.deviceIds(principal).filter((deviceId)=>access.deviceIds.includes(deviceId)));
      const now = Date.parse(this.clock()); const observations = [];
      const activeTime = (value) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 2000 && Date.parse(value) > now - this.retentionMs;
      for (const row of this.store.list('gatewayTelemetry')) {
        const device = this.store.get('portalDevices', row.deviceId); const gateway = this.store.get('gateways', row.gatewayId);
        if (!allowed.has(row.deviceId) || !device || gateway?.status !== 'ACTIVE' || row.householdId !== device.householdId || gateway?.devices?.[row.deviceId] !== device.householdId
          || Date.parse(row.expiresAt) <= now || !activeTime(row.observedAt)) continue;
        const lease=this.privacy.leaseFor(principal,row.deviceId);
        const decrypted=await this.privacy.open(row.reference,{principal,leaseId:lease?.leaseId,purpose:lease?.purpose,incidentId:lease?.incidentId,deviceId:row.deviceId});
        if(!decrypted)continue;
        const native=decrypted.payload;
        const point = native.sensorValues?.location ?? native.sensorValues?.gps;
        const observation = { deviceId: row.deviceId, gatewayId: row.gatewayId, observedAt: row.observedAt, simulation: row.simulation === true };
        if (validPoint(point) && (point.source === undefined || point.source === 'gps')) observation.location = { lat: point.lat, lon: point.lon, source: 'gps', ...(accuracy(point.accuracyM) === undefined ? {} : { accuracyM: point.accuracyM }) };
        if (rssi(native.rssi)) observation.rssiDbm = native.rssi;
        if (observation.location || observation.rssiDbm !== undefined) observations.push(observation);
      }
      const latestMec = new Map();
      for (const row of this.store.list('mecPayloads')) {
        if (Date.parse(row.expiresAt) <= now) continue;
        for(const deviceId of allowed){
          const lease=this.privacy.leaseFor(principal,deviceId);
          const bleObservation=observations.filter((item)=>item.deviceId===deviceId&&item.rssiDbm!==undefined).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0];
          const observation=await this.privacy.readMec(row.eventKey,{principal,leaseId:lease?.leaseId,purpose:lease?.purpose,incidentId:lease?.incidentId,deviceId,bleObservation});
          if(!observation||!activeTime(observation.observedAt))continue;
          const previous=latestMec.get(deviceId);if(!previous||Date.parse(previous.observedAt)<Date.parse(observation.observedAt))latestMec.set(deviceId,observation);
        }
      }
      observations.push(...latestMec.values());
      observations.sort((left, right) => left.observedAt.localeCompare(right.observedAt));
      const leases=[...allowed].map((deviceId)=>this.privacy.leaseFor(principal,deviceId));
      return { deviceIds: [...allowed], observations,readExpiresAt:new Date(Math.min(now+5000,...leases.map((lease)=>Date.parse(lease.expiresAt)))).toISOString() };
    });
  }

  async prune() {
    return this.store.transaction('gateway-telemetry-retention', async () => {
      const now = Date.parse(this.clock()); const records = this.store.collection('gatewayTelemetry');
      for (const [key, row] of Object.entries(records)) if (!Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= now) delete records[key];
    });
  }

  async migrateLegacy() {
    return this.store.transaction('location-privacy-migration',async()=>{
      let count=0;
      for(const [key,row] of Object.entries(this.store.collection('gatewayTelemetry'))){
        if(!row.observation)continue;
        const {observation,...metadata}=row;
        const reference=await this.privacy.seal({payload:observation,deviceId:row.deviceId,householdId:row.householdId,observedAt:observation.observedAt,sourceType:'GATEWAY_OBSERVATION',payloadRef:`gateway-${row.observationId}`,expiresAt:row.expiresAt});
        await this.store.put('gatewayTelemetry',key,{...metadata,reference,bootId:observation.bootId,firmwareSequence:observation.sequence,observedAt:observation.observedAt});count++;
      }
      if(count)await this.privacy.audit('LOCATION_LEGACY_ENCRYPTED',{count});return {count};
    });
  }

  start() { this.timer ??= setInterval(() => { void this.prune().catch(() => {}); }, 60000); this.timer.unref?.(); }
  close() { clearInterval(this.timer); this.timer = null; }
}
