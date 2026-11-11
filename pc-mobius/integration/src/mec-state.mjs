import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { approvalHash, recordEnvelope } from './integration-utils.mjs';

export const MEC_RETENTION_MS = 24 * 60 * 60 * 1000;
export const serviceScope = (service) => service === 'Location' ? 'mec:location' : 'mec:rnis';
export const serviceNames = new Set(['Location', 'RNIS']);
export const millis = (clock) => Date.parse(clock());
export const isoAfter = (clock, duration) => new Date(millis(clock) + duration).toISOString();
export const digest = approvalHash;

export function validCoordinates(point) {
  return point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;
}

export function pointInGeofence(point, geofence) {
  if (!validCoordinates(point) || !geofence) return false;
  if (geofence.type === 'circle') {
    if (!validCoordinates(geofence) || !Number.isFinite(geofence.radiusM) || geofence.radiusM <= 0) return false;
    const rad = (value) => value * Math.PI / 180;
    const a = Math.sin(rad(point.lat - geofence.lat) / 2) ** 2 + Math.cos(rad(geofence.lat)) * Math.cos(rad(point.lat)) * Math.sin(rad(point.lon - geofence.lon) / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) <= geofence.radiusM;
  }
  if (geofence.type === 'bbox') {
    if (!validCoordinates({ lat: geofence.minLat, lon: geofence.minLon }) || !validCoordinates({ lat: geofence.maxLat, lon: geofence.maxLon }) || geofence.minLat > geofence.maxLat || geofence.minLon > geofence.maxLon) return false;
    return point.lat >= geofence.minLat && point.lat <= geofence.maxLat && point.lon >= geofence.minLon && point.lon <= geofence.maxLon;
  }
  return false;
}

export function distanceInsideGeofence(point,geofence) {
  if(!validCoordinates(point)||!pointInGeofence(point,geofence))return -1;
  const distance=(a,b)=>{const rad=(v)=>v*Math.PI/180;const h=Math.sin(rad(b.lat-a.lat)/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(rad(b.lon-a.lon)/2)**2;return 6371000*2*Math.asin(Math.sqrt(Math.min(1,h)));};
  if(geofence.type==='circle')return geofence.radiusM-distance(point,geofence);
  if(geofence.type==='bbox')return Math.min(distance(point,{lat:geofence.minLat,lon:point.lon}),distance(point,{lat:geofence.maxLat,lon:point.lon}),distance(point,{lat:point.lat,lon:geofence.minLon}),distance(point,{lat:point.lat,lon:geofence.maxLon}));
  return -1;
}

/** 암호 키는 상태 JSON과 분리한 0600 파일 또는 주입된 비밀 키에 둡니다. */
export class MecCipher {
  constructor({ store, encryptionKey } = {}) {
    this.ready = this.initialize(store, encryptionKey);
  }
  async initialize(store, encryptionKey) {
    let key = encryptionKey ? Buffer.from(encryptionKey, typeof encryptionKey === 'string' ? 'base64' : undefined) : null;
    if (!key && store.path) {
      const path = `${store.path}.mec-key`;
      try { key = await readFile(path); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const candidate = randomBytes(32);
        const temporaryPath = `${path}.${randomBytes(16).toString('hex')}.tmp`;
        let temporaryFile; let created = false;
        try {
          temporaryFile = await open(temporaryPath, 'wx', 0o600); created = true;
          await temporaryFile.writeFile(candidate);
          await temporaryFile.sync();
          await temporaryFile.close(); temporaryFile = null;
          // 완성된 키 inode를 배타적으로 게시하여 모든 동시 reader에 32바이트를 제공한다.
          try { await link(temporaryPath, path); key = candidate; }
          catch (publishError) { if (publishError.code !== 'EEXIST') throw publishError; key = await readFile(path); }
        } finally {
          try { await temporaryFile?.close(); }
          finally { if (created) await unlink(temporaryPath); }
        }
      }
    }
    this.key = key ?? randomBytes(32);
    if (this.key.length !== 32) throw new Error('MEC 암호 키는 32바이트로 설정하세요.');
  }
  seal(value, purpose) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { algorithm: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
  open(value, purpose) {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString());
  }
}

export function currentBinding({ store, policyService, route, clock }) {
  if (!route) return 'BINDING_REVIEW';
  if (['TOMBSTONED', 'CANCEL_REQUESTED', 'DELETE_UNCERTAIN', 'PROVIDER_DELETED'].includes(route.state)) return 'TOMBSTONE';
  if (!Number.isFinite(Date.parse(route.expiresAt)) || Date.parse(route.expiresAt) <= millis(clock)) return 'EXPIRED';
  const decision = policyService?.evaluateGrant(route.grantId, { scope: serviceScope(route.serviceId) });
  if (!decision?.allowed || decision.grant.revision !== route.grantRevision) return 'REVOKED';
  const intent = store.get('policies', route.intentId);
  if (!intent || intent.status !== 'APPROVED' || intent.revision !== route.intentRevision || intent.policy.grantId !== route.grantId || intent.principalId !== decision.grant.principalId) return 'INTENT_REVIEW';
  if (intent.policy.ueId !== route.ueSubject || (intent.policy.expiresAt && Date.parse(intent.policy.expiresAt) <= millis(clock))) return 'INTENT_REVIEW';
  if (route.state !== 'ACTIVE') return 'CORRELATION_PENDING';
  return null;
}

export async function auditMec(store, clock, status, details = {}) {
  const record = recordEnvelope({ type: 'MEC_CALLBACK_ACK', status, ...details, expiresAt: isoAfter(clock, 30 * MEC_RETENTION_MS) }, clock);
  await store.append('receipts', record);
  return { httpStatus: status === 'SCHEMA_REVIEW' ? 400 : status === 'BINDING_REVIEW' ? 403 : 202, ack: true, status, receiptId: record.eventId, ...details };
}

function sourceTimestamp(value) {
  if (typeof value === 'string') return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  if (!value || !Number.isSafeInteger(value.seconds) || value.seconds < 0 || !Number.isInteger(value.nanoSeconds ?? 0) || (value.nanoSeconds ?? 0) < 0 || (value.nanoSeconds ?? 0) >= 1e9) return null;
  const time = value.seconds * 1000 + Math.floor((value.nanoSeconds ?? 0) / 1e6);
  return Number.isFinite(time) && time <= 8640000000000000 ? new Date(time).toISOString() : null;
}

/** 배포 manifest에서 고정한 schema를 검증한 뒤 사용하는 정규화 계약입니다. */
export function normalizeCallback(payload, route, adapter) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('SCHEMA_REVIEW');
  if (payload.service && payload.service !== route.serviceId) throw new Error('BINDING_REVIEW');
  const locationBody = payload.zonalPresenceNotification ?? payload.userTrackingNotification;
  if ((route.serviceId === 'Location' && (payload.subscriptionType?.includes('Cell') || payload.cellChangeNotification)) || (route.serviceId === 'RNIS' && locationBody)) throw new Error('BINDING_REVIEW');
  const body = locationBody ?? payload.cellChangeNotification ?? payload;
  const ue = body.ueId ?? body.subject ?? body.address ?? body.userInfo?.[0]?.address ?? body.associateId?.[0]?.value;
  if (ue !== route.ueSubject) throw new Error('BINDING_REVIEW');
  const correlator = body.clientCorrelator ?? body.callbackData;
  if (correlator !== undefined && correlator !== route.clientCorrelator) throw new Error('BINDING_REVIEW');
  const href = body.subscription ?? body.subscriptionId ?? body._links?.subscription?.href ?? body.link?.find?.((link) => link.rel === 'subscription')?.href;
  if (href) {
    let normalized;
    try { normalized = adapter.resourceUrl(href); } catch { throw new Error('BINDING_REVIEW'); }
    if (normalized !== route.resourceUrl) throw new Error('BINDING_REVIEW');
  }
  const observedAt = sourceTimestamp(body.observedAt ?? body.timeStamp ?? body.timestamp);
  const location = body.location ?? body.position ?? (body.currentLocation ? { lat: body.currentLocation.latitude, lon: body.currentLocation.longitude } : null);
  if (route.serviceId === 'Location' && !validCoordinates(location)) throw new Error('SCHEMA_REVIEW');
  const eventId = body.eventId;
  const sequence = body.sequence;
  if ((eventId !== undefined && (typeof eventId !== 'string' || eventId.length > 256 || !eventId)) || (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0))) throw new Error('SCHEMA_REVIEW');
  const source = structuredClone(payload);
  delete source.receivedAt; delete source.httpMetadata; delete source.transportMetadata;
  const sourceHash = digest(source);
  return { eventId: eventId ?? null, sequence: sequence ?? null, service: route.serviceId, sourceType: route.serviceId === 'Location' ? 'MEC_UE_LOCATION' : 'MEC_RNIS', ueId: ue, observedAt, clockQuality: observedAt && adapter.capabilities.verifiedSourceTime ? 'VERIFIED' : observedAt ? 'ESTIMATED' : 'UNKNOWN', location, health: body.health ?? null, uncertainty: body.uncertainty ?? null, simulation: adapter.simulation, sourceHash, source };
}
